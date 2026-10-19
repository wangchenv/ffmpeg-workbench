mod engine;
mod preview;
mod results;
mod runner;

use std::{fs, io::Write, path::PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

fn native_path(path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    path.into_path().map_err(|error| error.to_string())
}

fn display_path(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| "首版暂不支持非 Unicode 文件路径。".to_owned())
}

#[tauri::command]
async fn choose_engine_file(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("选择 FFmpeg 可执行文件").blocking_pick_file()
            .map(|path| native_path(path).and_then(display_path)).transpose()
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn choose_media_files(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("添加媒体文件")
            .add_filter("媒体", &["mp4", "mov", "mkv", "webm", "avi", "mp3", "m4a", "wav", "flac", "ogg", "aac", "ts"])
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| native_path(path).and_then(display_path))
            .collect()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn choose_output_file(app: AppHandle, suggested_name: Option<String>, format: Option<String>) -> Result<Option<String>, String> {
    let format = format.filter(|value| ["mp4", "mkv", "mov", "webm", "mp3", "wav", "flac"].contains(&value.as_str())).unwrap_or_else(|| "mp4".to_owned());
    let filename = suggested_name.filter(|name| !name.is_empty() && !name.contains(['/', '\\', '\0'])).unwrap_or_else(|| format!("output.{format}"));
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("保存新文件的位置")
            .set_file_name(&filename)
            .add_filter("所选输出格式", &[format.as_str()])
            .blocking_save_file()
            .map(|path| native_path(path).and_then(display_path))
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_project_file(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app.dialog().file().set_title("打开工程").add_filter("FFmpeg 工程", &["json"]).blocking_pick_file() else {
            return Ok(None);
        };
        let path = native_path(path)?;
        let size = fs::metadata(&path).map_err(|error| error.to_string())?.len();
        if size > 8 * 1024 * 1024 {
            return Err("工程文件超过首版 8 MiB 限制。".to_owned());
        }
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str::<serde_json::Value>(&content).map_err(|error| format!("工程不是有效 JSON：{error}"))?;
        Ok(Some(content))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_project_file(app: AppHandle, content: String) -> Result<Option<String>, String> {
    if content.len() > 8 * 1024 * 1024 {
        return Err("工程文件超过首版 8 MiB 限制。".to_owned());
    }
    serde_json::from_str::<serde_json::Value>(&content).map_err(|error| format!("工程不是有效 JSON：{error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app.dialog().file().set_title("保存工程").set_file_name("workbench.ffgui.json").add_filter("FFmpeg 工程", &["json"]).blocking_save_file() else {
            return Ok(None);
        };
        let path = native_path(path)?;
        let parent = path.parent().ok_or("工程路径没有父目录。")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        staged.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
        staged.as_file().sync_all().map_err(|error| error.to_string())?;
        // The native save dialog authorizes replacing the selected project file.
        staged.persist(&path).map_err(|error| error.to_string())?;
        display_path(path).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(runner::RunnerState::default())
        .invoke_handler(tauri::generate_handler![
            engine::get_engine,
            engine::copy_engine_to_cache,
            engine::probe_media,
            choose_engine_file,
            choose_media_files,
            choose_output_file,
            read_project_file,
            save_project_file,
            runner::run_job,
            runner::cancel_job,
            results::prepare_media_preview,
            results::reveal_output_file,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<runner::RunnerState>();
                if state.cancel_for_exit() {
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动 FFmpeg Workbench");
}
