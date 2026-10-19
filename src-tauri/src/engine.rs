use std::{env, fs, io::{Read, Write}, path::{Path, PathBuf}, process::Stdio, time::Duration};
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;
use tempfile::TempDir;
use tokio::{io::AsyncReadExt, process::Command};

// Both metadata probing and execution must refuse demuxers that can resolve
// playlists or secondary resources selected by untrusted media contents.
pub const SAFE_DEMUXERS: &str = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,flac,mp3,ogg,aac,mpegts,mpegvideo,h264,hevc,png_pipe,jpeg_pipe,bmp_pipe,webp_pipe";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    pub has_video: bool,
    pub has_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<f64>,
    pub probe_source: &'static str,
}

pub fn local_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw == "-" || raw.contains('\0') || raw.contains('%') {
        return Err("首版只支持明确的普通本地文件路径，不支持管道或序列模板。".to_owned());
    }
    let path = PathBuf::from(raw);
    #[cfg(windows)]
    let verbatim_disk = matches!(path.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_)));
    #[cfg(windows)]
    let protocol_like = raw.contains(':') && !verbatim_disk && !(raw.as_bytes().get(1) == Some(&b':') && raw.as_bytes()[0].is_ascii_alphabetic());
    #[cfg(not(windows))]
    let protocol_like = raw.contains(':');
    #[cfg(windows)]
    let shared_or_device = raw.starts_with("\\\\") && !verbatim_disk;
    #[cfg(not(windows))]
    let shared_or_device = raw.starts_with("\\\\");
    // Windows canonicalize returns \\?\C:\… even for an ordinary local file.
    // Preserve those disk paths for the runner's second metadata check, while
    // continuing to reject UNC shares, named pipes and device namespaces.
    if protocol_like || shared_or_device || raw.starts_with("//") {
        return Err("首版暂不执行网络地址、协议 URL 或共享目录输出。".to_owned());
    }
    Ok(path)
}

fn media_path(raw: &str) -> Result<PathBuf, String> {
    let path = local_path(raw)?.canonicalize().map_err(|error| format!("无法访问素材：{error}"))?;
    if !fs::metadata(&path).map_err(|error| error.to_string())?.is_file() {
        return Err("输入必须是普通本地媒体文件。".to_owned());
    }
    Ok(path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub path: String,
    pub version: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    pub encoders: Vec<String>,
}

pub fn resolve_executable(requested: Option<&str>) -> Result<PathBuf, String> {
    let name = requested.filter(|value| !value.trim().is_empty()).unwrap_or("ffmpeg");
    let supplied = Path::new(name);
    let mut candidates = Vec::new();
    if supplied.components().count() > 1 || supplied.is_absolute() {
        candidates.push(supplied.to_path_buf());
    } else {
        if let Some(paths) = env::var_os("PATH") {
            for directory in env::split_paths(&paths) {
                candidates.push(directory.join(name));
                #[cfg(windows)]
                candidates.push(directory.join(format!("{name}.exe")));
            }
        }
        if name == "ffmpeg" {
            candidates.extend(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].map(PathBuf::from));
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            return candidate.canonicalize().map_err(|error| format!("无法解析引擎路径：{error}"));
        }
    }
    Err("没有找到 FFmpeg。请先安装 FFmpeg，或在引擎设置中填写完整可执行路径。".to_owned())
}

const MAX_CACHED_ENGINE_BYTES: u64 = 512 * 1024 * 1024;

struct StagedEngineCopy {
    directory: TempDir,
    path: PathBuf,
}

fn stage_engine_copy(source: &Path, cache_root: &Path) -> Result<StagedEngineCopy, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // The resolved source must still be a regular file when opened; do not
        // follow a last-moment symlink or block opening a substituted FIFO.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut original = options.open(source).map_err(|error| format!("无法读取原引擎，原文件未修改：{error}"))?;
    let metadata = original.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CACHED_ENGINE_BYTES {
        return Err("仅可复制非空的普通引擎文件，大小不得超过 512 MiB。".to_owned());
    }
    let engines = cache_root.join("engines");
    fs::create_dir_all(&engines).map_err(|error| format!("无法创建应用引擎缓存：{error}"))?;
    let directory = tempfile::Builder::new().prefix("engine-").tempdir_in(engines).map_err(|error| format!("无法创建独立的引擎缓存目录：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(|error| format!("无法设置私有缓存目录权限：{error}"))?;
    }
    let path = directory.path().join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    let mut copied = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|error| format!("无法写入引擎副本：{error}"))?;
    let bytes = std::io::copy(&mut (&mut original).take(MAX_CACHED_ENGINE_BYTES + 1), &mut copied).map_err(|error| format!("引擎复制失败，原文件未修改：{error}"))?;
    if bytes > MAX_CACHED_ENGINE_BYTES || bytes != metadata.len() || original.metadata().map_err(|error| error.to_string())?.len() != metadata.len() {
        return Err("复制期间原引擎大小发生变化或超过限制，请等待原文件稳定后重试。".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // Preserve all extended attributes, including quarantine. This action
        // relocates a user-selected binary; it must not bypass system checks by
        // silently stripping download/security metadata.
        let result = unsafe { libc::fcopyfile(original.as_raw_fd(), copied.as_raw_fd(), std::ptr::null_mut(), libc::COPYFILE_XATTR) };
        if result != 0 {
            return Err(format!("无法保留引擎的系统安全属性，已放弃复制：{}", std::io::Error::last_os_error()));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        copied.set_permissions(fs::Permissions::from_mode(0o700)).map_err(|error| format!("无法设置引擎副本的私有权限：{error}"))?;
    }
    copied.flush().map_err(|error| error.to_string())?;
    copied.sync_all().map_err(|error| error.to_string())?;
    drop(copied);
    Ok(StagedEngineCopy { directory, path })
}

async fn copy_engine_to_directory(raw: &str, cache_root: &Path) -> Result<EngineInfo, String> {
    if raw.trim().is_empty() || raw.len() > 16 * 1024 || raw.contains('\0') {
        return Err("请先选择有效的 FFmpeg 文件；引擎路径不得为空、包含 NUL 或超过 16 KiB。".to_owned());
    }
    local_path(raw)?;
    let source = resolve_executable(Some(raw))?;
    let cache_root = cache_root.to_owned();
    let staged = tauri::async_runtime::spawn_blocking(move || stage_engine_copy(&source, &cache_root)).await.map_err(|error| error.to_string())??;
    let path = staged.path.to_str().ok_or("应用缓存路径不是有效 Unicode，未保存引擎副本。")?.to_owned();
    let info = get_engine(Some(path)).await;
    if !info.available {
        return Err(format!("引擎副本未通过运行检测，已清理本次缓存，原文件未修改。动态依赖或系统安全检查可能使此引擎无法迁移。{}", info.error.unwrap_or_else(|| "未返回有效的 FFmpeg 版本信息。".to_owned())));
    }
    // Keep only a verified executable. Every failure above drops the fresh
    // TempDir and removes the entire incomplete copy.
    let _ = staged.directory.keep();
    Ok(info)
}

#[tauri::command]
pub async fn copy_engine_to_cache(app: tauri::AppHandle, path: String) -> Result<EngineInfo, String> {
    let cache = app.path().app_cache_dir().map_err(|error| format!("无法定位应用缓存目录：{error}"))?;
    copy_engine_to_directory(&path, &cache).await
}

pub fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command.kill_on_drop(true).env_remove("FFREPORT").env_remove("AV_LOG_FORCE_COLOR").env("AV_LOG_FORCE_NOCOLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Diagnostics::Debug::{GetErrorMode, SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX};
        static BACKGROUND_ERROR_MODE: std::sync::Once = std::sync::Once::new();
        BACKGROUND_ERROR_MODE.call_once(|| unsafe {
            // Keep existing process flags and prevent child fault dialogs from
            // silently blocking background FFmpeg. Children inherit this local
            // process mode; no system-wide error-reporting settings are changed.
            let _ = SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
        });
        command.as_std_mut().creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

async fn query_output(path: &Path, args: &[&str], limit: u64) -> Result<(std::process::ExitStatus, String, String), String> {
    let mut child = command(path).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    let mut stdout = child.stdout.take().ok_or("无法读取引擎标准输出。")?.take(limit + 1);
    let mut stderr = child.stderr.take().ok_or("无法读取引擎错误输出。")?.take(limit + 1);
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (status, out_read, err_read) = tokio::join!(child.wait(), stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        out_read.map_err(|error| error.to_string())?;
        err_read.map_err(|error| error.to_string())?;
        let status = status.map_err(|error| error.to_string())?;
        if out.len() as u64 > limit || err.len() as u64 > limit {
            return Err("引擎探测输出超过允许大小。".to_owned());
        }
        Ok((status, String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
    }).await;
    match result {
        Ok(value) => value,
        Err(_) => { let _ = child.kill().await; Err("FFmpeg 探测超过 15 秒，已停止。".to_owned()) }
    }
}

async fn query(path: &Path, args: &[&str], limit: u64) -> Result<String, String> {
    let (status, out, err) = query_output(path, args, limit).await?;
    if !status.success() { return Err(format!("引擎探测失败：{err}")); }
    Ok(out + &err)
}

pub fn parse_seconds(raw: &str) -> Option<f64> {
    let mut total = 0.0;
    let parts = raw.trim().split(':').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 3 { return None; }
    for part in parts {
        let value = part.parse::<f64>().ok()?;
        if !value.is_finite() || value < 0.0 { return None; }
        total = total * 60.0 + value;
    }
    (total.is_finite() && total > 0.0).then_some(total)
}

fn rate(raw: &str) -> Option<f64> {
    if let Some((numerator, denominator)) = raw.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        let value = numerator / denominator;
        (value.is_finite() && value > 0.0).then_some(value)
    } else {
        parse_seconds(raw)
    }
}

fn parse_probe_json(text: &str) -> Result<MediaInfo, String> {
    let document: Value = serde_json::from_str(text).map_err(|error| format!("媒体探测结果无效：{error}"))?;
    let streams = document["streams"].as_array().ok_or("素材没有可识别的流信息。")?;
    let video = streams.iter().find(|stream| stream["codec_type"] == "video");
    let has_audio = streams.iter().any(|stream| stream["codec_type"] == "audio");
    if video.is_none() && !has_audio { return Err("素材没有可识别的音视频流。".to_owned()); }
    let duration_seconds = document["format"]["duration"].as_str().and_then(parse_seconds)
        .or_else(|| streams.iter().filter_map(|stream| stream["duration"].as_str().and_then(parse_seconds)).reduce(f64::max));
    Ok(MediaInfo {
        duration_seconds, has_video: video.is_some(), has_audio,
        width: video.and_then(|stream| stream["width"].as_u64()).and_then(|value| u32::try_from(value).ok()),
        height: video.and_then(|stream| stream["height"].as_u64()).and_then(|value| u32::try_from(value).ok()),
        frame_rate: video.and_then(|stream| stream["avg_frame_rate"].as_str().and_then(rate).or_else(|| stream["r_frame_rate"].as_str().and_then(rate))),
        probe_source: "ffprobe",
    })
}

fn parse_ffmpeg_header(text: &str) -> Result<MediaInfo, String> {
    if !text.lines().any(|line| line.starts_with("Input #0,")) {
        return Err(format!("无法读取素材信息：{}", text.chars().take(1600).collect::<String>()));
    }
    let mut info = MediaInfo { duration_seconds: None, has_video: false, has_audio: false, width: None, height: None, frame_rate: None, probe_source: "ffmpeg" };
    for line in text.lines().map(str::trim) {
        if let Some(duration) = line.strip_prefix("Duration: ") {
            info.duration_seconds = duration.split(',').next().and_then(parse_seconds);
        }
        if !line.starts_with("Stream #") { continue; }
        if line.contains("Audio:") { info.has_audio = true; }
        if line.contains("Video:") {
            info.has_video = true;
            if info.width.is_none() {
                for token in line.split_whitespace() {
                    let token = token.trim_matches(',');
                    if let Some((width, height)) = token.split_once('x') {
                        if let (Ok(width), Ok(height)) = (width.parse::<u32>(), height.parse::<u32>()) {
                            if width > 0 && height > 0 { info.width = Some(width); info.height = Some(height); break; }
                        }
                    }
                }
                let tokens = line.split_whitespace().collect::<Vec<_>>();
                info.frame_rate = tokens.windows(2).find_map(|pair| (pair[1].trim_matches(',') == "fps").then(|| rate(pair[0])).flatten());
            }
        }
    }
    if !info.has_video && !info.has_audio { return Err("素材没有可识别的音视频流。".to_owned()); }
    Ok(info)
}

pub async fn probe_media_path(executable: &Path, raw: &str) -> Result<MediaInfo, String> {
    let path = media_path(raw)?;
    let path_text = path.to_str().ok_or("首版不支持非 Unicode 路径。")?;
    #[cfg(windows)]
    let probe_name = "ffprobe.exe";
    #[cfg(not(windows))]
    let probe_name = "ffprobe";
    let sibling = executable.with_file_name(probe_name);
    if sibling.is_file() {
        if let Ok(version) = query(&sibling, &["-version"], 256 * 1024).await {
            if version.starts_with("ffprobe version ") {
                if let Ok(output) = query(&sibling, &["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", SAFE_DEMUXERS, "-show_streams", "-show_format", "-of", "json", path_text], 1024 * 1024).await {
                    if let Ok(info) = parse_probe_json(&output) { return Ok(info); }
                }
            }
        }
    }
    // With no output specified FFmpeg reads only the input header. Exit 1 is
    // expected here; no decoder, encoder, output file or network protocol runs.
    let (_, _, stderr) = query_output(executable, &["-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-format_whitelist", SAFE_DEMUXERS, "-i", path_text], 1024 * 1024).await?;
    parse_ffmpeg_header(&stderr)
}

#[tauri::command]
pub async fn probe_media(executable: String, path: String) -> Result<MediaInfo, String> {
    let executable = resolve_executable(Some(&executable))?;
    verify(&executable).await?;
    probe_media_path(&executable, &path).await
}

pub async fn verify(path: &Path) -> Result<String, String> {
    let output = query(path, &["-version"], 256 * 1024).await?;
    let first = output.lines().next().unwrap_or_default().trim();
    if !first.starts_with("ffmpeg version ") {
        return Err("所选可执行文件没有返回有效的 FFmpeg 版本信息。".to_owned());
    }
    Ok(first.to_owned())
}

#[tauri::command]
pub async fn get_engine(path: Option<String>) -> EngineInfo {
    let fallback_path = path.clone().unwrap_or_else(|| "ffmpeg".to_owned());
    let resolved = match resolve_executable(path.as_deref()) {
        Ok(value) => value,
        Err(error) => return EngineInfo { path: fallback_path, version: String::new(), available: false, error: Some(error), help: None, encoders: Vec::new() },
    };
    let shown = resolved.to_string_lossy().into_owned();
    match verify(&resolved).await {
        Ok(version) => {
            let (help, encoders) = tokio::join!(query(&resolved, &["-hide_banner", "-h", "full"], 4 * 1024 * 1024), query(&resolved, &["-hide_banner", "-encoders"], 1024 * 1024));
            let mut warnings = Vec::new();
            let help = match help { Ok(value) => Some(value), Err(error) => { warnings.push(error); None } };
            let encoders = match encoders {
                Ok(value) => value.lines().filter_map(|line| {
                    let mut tokens = line.split_whitespace();
                    let flags = tokens.next()?;
                    if flags.len() == 6 && matches!(flags.chars().next(), Some('V' | 'A' | 'S')) {
                        let name = tokens.next()?;
                        if name != "=" { return Some(name.to_owned()); }
                    }
                    None
                }).collect(),
                Err(error) => { warnings.push(error); Vec::new() },
            };
            EngineInfo { path: shown, version, available: true, error: (!warnings.is_empty()).then(|| warnings.join("；")), help, encoders }
        }
        Err(error) => EngineInfo { path: shown, version: String::new(), available: false, error: Some(error), help: None, encoders: Vec::new() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_cache_staging_rejects_empty_nonregular_and_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("cache");
        let empty = directory.path().join("empty-engine");
        fs::write(&empty, []).unwrap();
        assert!(stage_engine_copy(&empty, &cache).is_err());
        assert!(stage_engine_copy(directory.path(), &cache).is_err());
        let oversized = directory.path().join("oversized-engine");
        let file = fs::File::create(&oversized).unwrap();
        file.set_len(MAX_CACHED_ENGINE_BYTES + 1).unwrap();
        assert!(stage_engine_copy(&oversized, &cache).is_err());
        assert!(!cache.exists(), "Rejected files must not create a cache copy");
    }

    #[tokio::test]
    async fn invalid_engine_cache_copy_preserves_source_and_removes_incomplete_directory() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("cache");
        for raw in [String::new(), "a\0b".into(), "a".repeat(16 * 1024 + 1), "pipe:1".into()] {
            assert!(copy_engine_to_directory(&raw, &cache).await.is_err());
        }
        assert!(!cache.exists());
        let source = directory.path().join("invalid-engine");
        let bytes = b"This is not an executable FFmpeg engine.";
        fs::write(&source, bytes).unwrap();
        let error = copy_engine_to_directory(source.to_str().unwrap(), &cache).await.unwrap_err();
        assert!(error.contains("已清理本次缓存") && error.contains("原文件未修改"), "{error}");
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(fs::read_dir(cache.join("engines")).unwrap().count(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn engine_cache_copy_preserves_quarantine_without_executing_the_test_file() {
        use std::os::fd::AsRawFd;
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("quarantined-test-file");
        fs::write(&source, b"Test data only; never executed.").unwrap();
        let file = fs::File::open(&source).unwrap();
        let name = std::ffi::CString::new("com.apple.quarantine").unwrap();
        let value = b"0081;66abc000;FFmpeg Workbench regression;";
        assert_eq!(unsafe { libc::fsetxattr(file.as_raw_fd(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) }, 0);
        let mut source_value = [0_u8; 512];
        let source_count = unsafe { libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), source_value.as_mut_ptr().cast(), source_value.len(), 0, 0) };
        assert!(source_count > 0);
        let staged = stage_engine_copy(&source, &directory.path().join("cache")).unwrap();
        let copy = fs::File::open(&staged.path).unwrap();
        let mut copied_value = [0_u8; 512];
        let count = unsafe { libc::fgetxattr(copy.as_raw_fd(), name.as_ptr(), copied_value.as_mut_ptr().cast(), copied_value.len(), 0, 0) };
        assert!(count > 0);
        // Apple's copyfile serializes spaces in the quarantine agent field as
        // \x20. The flags, timestamp and metadata must otherwise be retained.
        let copied_attribute = String::from_utf8_lossy(&copied_value[..count as usize]).replace("\\x20", " ");
        assert_eq!(copied_attribute.as_bytes(), &source_value[..source_count as usize]);
        assert_eq!(fs::read(&source).unwrap(), b"Test data only; never executed.");
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH pointing to an installed engine"]
    async fn real_engine_cache_copy_is_identical_private_executable_and_verified() {
        let executable = std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH");
        let original = fs::read(&executable).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("cache");
        let info = copy_engine_to_directory(&executable, &cache).await.unwrap();
        assert!(info.available && info.version.starts_with("ffmpeg version "));
        assert!(info.help.as_ref().is_some_and(|help| !help.is_empty()));
        let copied = Path::new(&info.path);
        assert!(copied.starts_with(cache.canonicalize().unwrap()));
        assert_eq!(fs::read(copied).unwrap(), original);
        assert_eq!(fs::read(&executable).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(copied).unwrap().permissions().mode() & 0o7777, 0o700);
            assert_eq!(fs::metadata(copied.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        assert!(verify(copied).await.unwrap().starts_with("ffmpeg version "));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires FFMPEG_PATH pointing to an installed engine"]
    async fn repeated_native_engine_scan_matches_desktop_command_path() {
        let executable = std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH");
        for attempt in 1..=5 {
            let started = std::time::Instant::now();
            let result = get_engine(Some(executable.clone())).await;
            println!("{}", serde_json::json!({ "attempt": attempt, "elapsedMs": started.elapsed().as_millis(), "available": result.available, "version": result.version, "helpBytes": result.help.as_ref().map(String::len), "encoders": result.encoders.len(), "error": result.error }));
            assert!(result.available, "attempt {attempt}: {:?}", result.error);
            assert!(result.error.is_none(), "attempt {attempt}: {:?}", result.error);
            assert!(result.help.as_ref().is_some_and(|help| help.len() > 100_000));
            assert!(result.encoders.len() > 10);
        }
    }

    #[test]
    fn parses_durations_and_frame_rates_without_non_finite_values() {
        assert_eq!(parse_seconds("01:02:03.5"), Some(3723.5));
        assert_eq!(parse_seconds("2.25"), Some(2.25));
        for invalid in ["N/A", "NaN", "inf", "-1", "", "1:2:3:4", "0"] {
            assert!(parse_seconds(invalid).is_none(), "{invalid}");
        }
        assert!((rate("30000/1001").unwrap() - 29.97002997).abs() < 0.0001);
        assert!(rate("0/0").is_none());
    }

    #[test]
    fn parses_probe_json_and_ffmpeg_fallback_headers() {
        let info = parse_probe_json(r#"{"format":{"duration":"3.25"},"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30000/1001"},{"codec_type":"audio"}]}"#).unwrap();
        assert_eq!(info.duration_seconds, Some(3.25));
        assert!(info.has_video && info.has_audio);
        assert_eq!((info.width, info.height), (Some(1920), Some(1080)));
        let info = parse_ffmpeg_header("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/local.mp4':\n  Duration: 00:00:03.25, start: 0.000000, bitrate: 100 kb/s\n  Stream #0:0(und): Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 100 kb/s, 29.97 fps, 30 tbr\n  Stream #0:1(und): Audio: aac (LC), 48000 Hz, stereo\nAt least one output file must be specified\n").unwrap();
        assert_eq!(info.duration_seconds, Some(3.25));
        assert!(info.has_video && info.has_audio);
        assert_eq!(info.frame_rate, Some(29.97));
        let audio = parse_ffmpeg_header("Input #0, mp3, from 'audio.mp3':\n Duration: N/A, start: 0.0\n Stream #0:0: Audio: mp3, 48000 Hz, stereo\n").unwrap();
        assert!(!audio.has_video && audio.has_audio && audio.duration_seconds.is_none());
        assert!(parse_ffmpeg_header("Invalid data found when processing input").is_err());
        assert!(parse_probe_json(r#"{"streams":[]}"#).is_err());
    }

    #[test]
    fn metadata_paths_reject_protocols_templates_and_non_files() {
        for raw in ["", "-", "pipe:1", "https://example.com/a.mp4", "file:/tmp/a.mp4", "frame-%03d.png", "//server/share.mp4", "a\0b"] {
            assert!(media_path(raw).is_err(), "{raw}");
        }
        let directory = tempfile::tempdir().unwrap();
        assert!(media_path(directory.path().to_str().unwrap()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn canonical_windows_local_files_remain_valid_but_shared_and_device_paths_do_not() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("含 空格.mp4");
        fs::write(&source, b"metadata path regression fixture").unwrap();
        let canonical = source.canonicalize().unwrap();
        assert!(matches!(canonical.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))));
        assert_eq!(local_path(canonical.to_str().unwrap()).unwrap(), canonical);
        assert_eq!(media_path(canonical.to_str().unwrap()).unwrap(), canonical);
        for raw in [r"\\server\share\media.mp4", r"\\?\UNC\server\share\media.mp4", r"\\.\pipe\media", r"\\?\GLOBALROOT\Device\HarddiskVolume1\media.mp4", "//server/share/media.mp4"] {
            assert!(local_path(raw).is_err(), "{raw}");
        }
    }
}
