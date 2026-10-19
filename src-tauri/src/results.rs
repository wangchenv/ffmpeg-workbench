use std::{collections::BTreeMap, ffi::OsString, fs, path::{Path, PathBuf}, time::{Duration, SystemTime}};
use serde::Serialize;
use tauri::State;

use crate::runner::RunnerState;

#[derive(Clone, Debug)]
pub(crate) struct CompletedOutput {
    pub(crate) path: PathBuf,
    pub(crate) size_bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl CompletedOutput {
    pub(crate) fn new(path: PathBuf, metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            path,
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }

    pub(crate) fn matches_metadata(&self, metadata: &fs::Metadata) -> bool {
        let mut unchanged = metadata.is_file() && metadata.len() == self.size_bytes && metadata.modified().ok() == self.modified;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            unchanged &= metadata.dev() == self.device && metadata.ino() == self.inode;
        }
        unchanged
    }

    fn validate(&self) -> Result<(), String> {
        let metadata = fs::symlink_metadata(&self.path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "结果文件已移动或删除，请重新处理后再查看。".to_owned(),
            _ => format!("无法读取结果文件：{error}"),
        })?;
        if !metadata.file_type().is_file() {
            return Err("结果位置已被替换，当前不是普通文件。".to_owned());
        }
        let canonical = self.path.canonicalize().map_err(|error| format!("无法确认结果文件位置：{error}"))?;
        if canonical != self.path || !self.matches_metadata(&metadata) {
            return Err("结果文件已被修改或替换，请重新处理后再查看。".to_owned());
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct OutputRegistry {
    // In-memory records only: restoring a project cannot authorize a path.
    completed: BTreeMap<String, CompletedOutput>,
}

impl OutputRegistry {
    pub(crate) fn contains(&self, id: &str) -> bool { self.completed.contains_key(id) }

    pub(crate) fn insert(&mut self, id: String, output: CompletedOutput) {
        self.completed.insert(id, output);
    }

    pub(crate) fn resolve(&self, id: &str) -> Result<CompletedOutput, String> {
        let output = self.completed.get(id).ok_or("仅能查看本次运行中已成功完成的任务结果。")?;
        output.validate()?;
        Ok(output.clone())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPreview {
    path: String,
    size_bytes: u64,
    url: String,
}

#[tauri::command]
pub async fn prepare_media_preview(state: State<'_, RunnerState>, job_id: String) -> Result<MediaPreview, String> {
    let output = state.completed_output(&job_id)?;
    let path = output.path.to_str().ok_or("首版不支持非 Unicode 结果路径。")?.to_owned();
    let service = state.preview_service.get_or_try_init(|| crate::preview::PreviewServer::start(state.output_registry())).await?;
    let url = service.url_for_job(&job_id)?;
    Ok(MediaPreview { path, size_bytes: output.size_bytes, url })
}

struct RevealCommand {
    program: &'static str,
    args: Vec<OsString>,
}

fn reveal_command(platform: &str, path: &Path) -> Result<RevealCommand, String> {
    match platform {
        "macos" => Ok(RevealCommand { program: "/usr/bin/open", args: vec!["-R".into(), path.as_os_str().to_owned()] }),
        "windows" => {
            let mut selection = OsString::from("/select,");
            // The runner stores canonical Windows paths (\\?\C:\…). Explorer
            // expects the ordinary drive spelling for its /select argument.
            // Only strip a local disk prefix; never turn a UNC/device path
            // into a different location. The filename stays one OS argument.
            let shell_path = path.to_str().and_then(|raw| raw.strip_prefix(r"\\?\")).filter(|raw| {
                let bytes = raw.as_bytes();
                bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':') && bytes.get(2) == Some(&b'\\')
            }).map(OsString::from).unwrap_or_else(|| path.as_os_str().to_owned());
            selection.push(shell_path);
            Ok(RevealCommand { program: "explorer.exe", args: vec![selection] })
        }
        "linux" => Ok(RevealCommand { program: "xdg-open", args: vec![path.parent().ok_or("结果路径没有所在文件夹。")?.as_os_str().to_owned()] }),
        _ => Err("当前系统暂不支持打开所在文件夹。".to_owned()),
    }
}

#[tauri::command]
pub async fn reveal_output_file(state: State<'_, RunnerState>, job_id: String) -> Result<(), String> {
    let output = state.completed_output(&job_id)?;
    let specification = reveal_command(std::env::consts::OS, &output.path)?;
    // Each path is an independent OS argument. No shell interprets filenames.
    let mut command = tokio::process::Command::new(specification.program);
    command.args(specification.args).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(15), command.output()).await
        .map_err(|_| "打开所在文件夹超时，请稍后重试。".to_owned())?
        .map_err(|error| format!("无法打开所在文件夹：{error}"))?;
    if !result.status.success() {
        let detail = String::from_utf8_lossy(&result.stderr).trim().chars().take(500).collect::<String>();
        return Err(if detail.is_empty() { format!("系统无法打开所在文件夹（{}）。", result.status) } else { format!("系统无法打开所在文件夹：{detail}") });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed(path: &Path) -> CompletedOutput {
        CompletedOutput::new(path.canonicalize().unwrap(), &fs::metadata(path).unwrap())
    }

    #[test]
    fn registry_accepts_only_known_successful_outputs_and_keeps_multiple_jobs() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("one.mp4");
        let second = directory.path().join("two.wav");
        fs::write(&first, b"first output").unwrap();
        fs::write(&second, b"second output").unwrap();
        let mut registry = OutputRegistry::default();
        assert!(registry.resolve("queued").unwrap_err().contains("已成功完成"));
        assert!(registry.resolve(first.to_str().unwrap()).is_err());
        registry.insert("one".into(), completed(&first));
        registry.insert("two".into(), completed(&second));
        assert!(registry.contains("one"));
        assert_eq!(registry.resolve("one").unwrap().size_bytes, 12);
        assert_eq!(registry.resolve("two").unwrap().size_bytes, 13);
        fs::remove_file(&first).unwrap();
        assert!(registry.resolve("one").unwrap_err().contains("移动或删除"));
        assert!(registry.resolve("two").is_ok());
    }

    #[test]
    fn modified_file_and_directory_replacements_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("output.mp4");
        fs::write(&path, b"original output").unwrap();
        let output = completed(&path);
        fs::write(&path, b"changed").unwrap();
        assert!(output.validate().unwrap_err().contains("修改或替换"));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(output.validate().unwrap_err().contains("不是普通文件"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_same_size_new_file_cannot_substitute_a_result() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("output.mp4");
        let other = directory.path().join("private.mp4");
        fs::write(&path, b"original output").unwrap();
        fs::write(&other, b"private content").unwrap();
        let output = completed(&path);
        fs::rename(&path, directory.path().join("old.mp4")).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(output.validate().unwrap_err().contains("不是普通文件"));
        fs::remove_file(&path).unwrap();
        fs::copy(&other, &path).unwrap();
        assert!(output.validate().unwrap_err().contains("修改或替换"));
    }

    #[test]
    fn preview_policy_allows_only_loopback_media_without_disk_asset_access() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(config["app"]["security"].get("assetProtocol").is_none());
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("media-src 'self' blob: http://127.0.0.1:*"));
        assert!(!csp.contains("asset:"));
    }

    #[test]
    fn reveal_arguments_preserve_special_names_without_shell_interpretation() {
        let path = Path::new("/tmp/含 空格 [a]#%;$(touch surprise).mp4");
        let mac = reveal_command("macos", path).unwrap();
        assert_eq!(mac.program, "/usr/bin/open");
        assert_eq!(mac.args, vec![OsString::from("-R"), path.as_os_str().to_owned()]);
        let windows = reveal_command("windows", path).unwrap();
        assert_eq!(windows.program, "explorer.exe");
        assert_eq!(windows.args, vec![OsString::from(format!("/select,{}", path.display()))]);
        let linux = reveal_command("linux", path).unwrap();
        assert_eq!(linux.program, "xdg-open");
        assert_eq!(linux.args, vec![OsString::from("/tmp")]);
        assert!(reveal_command("unsupported", path).is_err());
    }

    #[test]
    fn explorer_selection_uses_drive_paths_for_canonical_local_results() {
        let canonical = Path::new(r"\\?\C:\Users\Test User\含 空格 [a]#;$(literal).mp4");
        let command = reveal_command("windows", canonical).unwrap();
        assert_eq!(command.program, "explorer.exe");
        assert_eq!(command.args, vec![OsString::from(r"/select,C:\Users\Test User\含 空格 [a]#;$(literal).mp4")]);
        for raw in [r"\\?\UNC\server\share\file.mp4", r"\\?\GLOBALROOT\Device\file.mp4", r"\\.\pipe\file"] {
            let command = reveal_command("windows", Path::new(raw)).unwrap();
            assert_eq!(command.args, vec![OsString::from(format!("/select,{raw}"))]);
        }
    }
}
