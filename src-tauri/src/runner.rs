use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::Duration,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tempfile::NamedTempFile;
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWriteExt}, sync::Notify};

use crate::engine;
use crate::results::{CompletedOutput, OutputRegistry};

use crate::engine::{local_path, SAFE_DEMUXERS};

#[derive(Default, Clone)]
pub struct RunnerState {
    active: Arc<Mutex<Option<ActiveJob>>>,
    exit_after_cancel: Arc<AtomicBool>,
    completed_outputs: Arc<Mutex<OutputRegistry>>,
    pub(crate) preview_service: Arc<tokio::sync::OnceCell<crate::preview::PreviewServer>>,
}

struct ActiveJob {
    id: String,
    canceled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl RunnerState {
    pub(crate) fn output_registry(&self) -> Arc<Mutex<OutputRegistry>> { self.completed_outputs.clone() }

    pub(crate) fn completed_output(&self, id: &str) -> Result<CompletedOutput, String> {
        self.completed_outputs.lock().map_err(|_| "结果记录不可用。")?.resolve(id)
    }

    pub fn cancel_for_exit(&self) -> bool {
        let Ok(active) = self.active.lock() else { return false; };
        if let Some(active) = active.as_ref() {
            self.exit_after_cancel.store(true, Ordering::SeqCst);
            active.canceled.store(true, Ordering::SeqCst);
            active.notify.notify_one();
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub id: String,
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    job_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<&'static str>,
}

fn emit(app: &AppHandle, id: &str, kind: &'static str, message: Option<String>, data: Option<Value>, state: Option<&'static str>) {
    let _ = app.emit("job-event", JobEvent { job_id: id.to_owned(), kind, message, data, state });
}

struct Plan {
    args: Vec<String>,
    source_args: Vec<String>,
    inputs: Vec<PathBuf>,
    output: PathBuf,
    staged: NamedTempFile,
}

fn base_option(value: &str) -> &str {
    value.split(':').next().unwrap_or(value)
}

fn safe_filter(value: &str) -> Result<(), String> {
    // These filters only transform supplied frames. Resource-reading filters,
    // graph sources/sinks and graph labels need a separate resource contract.
    const FILTERS: &[&str] = &[
        "scale", "crop", "fps", "eq", "hflip", "vflip", "format", "transpose",
        "setsar", "setdar", "pad", "trim", "setpts", "volume", "afade",
        "atempo", "aresample", "aformat", "atrim", "asetpts", "null", "anull",
    ];
    if value.contains([';', '[', ']']) || value.is_empty() {
        return Err("首版仅运行由安全滤镜组成的简单链；复杂图请先保存为工程。".to_owned());
    }
    for filter in value.split(',') {
        let name = filter.trim().split('=').next().unwrap_or_default();
        if !FILTERS.contains(&name) {
            return Err(format!("首版尚未验证滤镜 {name} 的资源访问范围，暂不执行。"));
        }
    }
    Ok(())
}

fn safe_lavfi(value: &str) -> bool {
    // A single bounded generator; commas, graph labels, file paths and other
    // generators are deliberately excluded from this first runnable slice.
    let Some(tail) = value.strip_prefix("testsrc2=") else { return false; };
    if tail.is_empty() { return false; }
    tail.split(':').all(|part| {
        let Some((name, raw)) = part.split_once('=') else { return false; };
        match name {
            "size" | "s" => raw.split_once('x').is_some_and(|(w, h)| {
                let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) else { return false; };
                (1..=8192).contains(&w) && (1..=8192).contains(&h)
            }),
            "rate" | "r" | "duration" | "d" => raw.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '/')) && !raw.is_empty(),
            "alpha" => raw.parse::<u16>().is_ok_and(|value| value <= 255),
            _ => false,
        }
    })
}

fn make_plan(request: &JobRequest) -> Result<Plan, String> {
    if request.id.is_empty() || request.id.len() > 128 {
        return Err("任务 ID 无效。".to_owned());
    }
    if request.args.is_empty() || request.args.len() > 2048 || request.args.iter().any(|value| value.len() > 16 * 1024 || value.contains('\0')) {
        return Err("参数为空、过多或包含无效内容。".to_owned());
    }
    let mut args = Vec::new();
    let mut inputs = Vec::new();
    let mut output_raw = None;
    let mut pending_format: Option<String> = None;
    let mut index = 0;
    let mut progress_seen = false;
    let mut input_count = 0;
    while index < request.args.len() {
        let token = &request.args[index];
        if token == "-i" {
            let raw = request.args.get(index + 1).ok_or("-i 缺少输入路径。")?;
            if pending_format.as_deref() == Some("lavfi") {
                if !safe_lavfi(raw) {
                    return Err("首版 lavfi 运行仅支持 testsrc2=size=宽x高:rate=帧率 测试源。".to_owned());
                }
                args.extend([token.clone(), raw.clone()]);
            } else {
                let path = local_path(raw)?.canonicalize().map_err(|error| format!("无法访问输入 {raw}：{error}"))?;
                if !path.is_file() { return Err("输入必须是普通本地媒体文件。".to_owned()); }
                // Restrict automatic demuxer detection so a selected playlist
                // cannot make FFmpeg resolve hidden network/local resources.
                args.extend(["-protocol_whitelist".to_owned(), "file".to_owned(), "-format_whitelist".to_owned(), SAFE_DEMUXERS.to_owned(), token.clone(), path.to_str().ok_or("首版不支持非 Unicode 路径。")?.to_owned()]);
                inputs.push(path);
            }
            pending_format = None;
            input_count += 1;
            index += 2;
            continue;
        }
        if !token.starts_with('-') || token == "-" {
            if index + 1 != request.args.len() || output_raw.is_some() {
                return Err("首版运行只支持最后一个参数指定的单个普通文件输出。".to_owned());
            }
            output_raw = Some(token.clone());
            index += 1;
            continue;
        }
        let base = base_option(token);
        if matches!(base, "-y" | "-n") || token == "-xerror" {
            // The runner owns overwrite and fail-on-error policy. Normalize
            // user duplicates, then add exactly one trusted global flag below.
            index += 1;
            continue;
        }
        if matches!(base, "-hide_banner" | "-nostats" | "-an" | "-vn" | "-sn" | "-dn" | "-shortest" | "-re" | "-copyts" | "-start_at_zero" | "-bitexact") {
            args.push(token.clone());
            index += 1;
            continue;
        }
        if !matches!(base,
            "-f" | "-c" | "-codec" | "-vcodec" | "-acodec" | "-crf" | "-preset" | "-tune" |
            "-q" | "-qscale" | "-b" | "-maxrate" | "-minrate" | "-bufsize" | "-r" | "-s" |
            "-pix_fmt" | "-profile" | "-level" | "-ar" | "-ac" | "-ss" | "-t" | "-to" |
            "-threads" | "-map" | "-map_metadata" | "-map_chapters" | "-metadata" | "-disposition" |
            "-vf" | "-af" | "-filter" | "-movflags" | "-loglevel" | "-v" | "-progress" |
            "-stats_period" | "-frames" | "-vsync" | "-fps_mode" | "-aspect" | "-tag" |
            "-color_range" | "-colorspace" | "-color_primaries" | "-color_trc" | "-sample_fmt" |
            "-compression_level" | "-g" | "-bf" | "-flags" | "-strict" | "-channel_layout" |
            "-ch_layout" | "-max_muxing_queue_size" | "-itsoffset" | "-itsscale" | "-stream_loop"
        ) {
            return Err(format!("参数 {token} 可保留和编辑，但首版尚未验证其执行范围，暂不运行。"));
        }
        let value = request.args.get(index + 1).ok_or_else(|| format!("{token} 缺少参数值。"))?;
        if base == "-f" {
            const FORMATS: &[&str] = &["lavfi", "mp4", "mov", "matroska", "webm", "avi", "wav", "flac", "mp3", "ogg", "opus", "adts", "mpegts", "aac"];
            if !FORMATS.contains(&value.as_str()) {
                return Err(format!("首版暂不运行 {value} 格式，尤其不支持清单、分片和多文件封装器。"));
            }
            pending_format = Some(value.clone());
        }
        if matches!(base, "-vf" | "-af" | "-filter") { safe_filter(value)?; }
        if base == "-progress" {
            if value != "pipe:1" || progress_seen { return Err("首版进度通道只支持单个 -progress pipe:1。".to_owned()); }
            progress_seen = true;
        }
        if matches!(base, "-c" | "-codec" | "-vcodec" | "-acodec") {
            // FFmpeg itself validates availability. Limit encoder spellings,
            // excluding plugin settings or ambiguous option-like values.
            // Names such as libvpx-vp9 legitimately contain a hyphen. A leading
            // hyphen is still excluded so an option cannot masquerade as a name.
            if value.is_empty() || value.starts_with('-') || !value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')) {
                return Err("编码器名称包含无效字符。".to_owned());
            }
        }
        args.extend([token.clone(), value.clone()]);
        index += 2;
    }
    if input_count == 0 { return Err("请先添加输入媒体或测试源。".to_owned()); }
    if pending_format.as_deref() == Some("lavfi") { return Err("lavfi 只能作为测试源输入格式。".to_owned()); }
    let output_raw = output_raw.ok_or("请指定普通本地输出文件。")?;
    let output = local_path(&output_raw)?;
    let filename = output.file_name().ok_or("输出没有文件名。")?;
    let parent = output.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let parent = parent.canonicalize().map_err(|error| format!("输出目录不存在或无法访问：{error}"))?;
    let output = parent.join(filename);
    if inputs.iter().any(|input| input == &output) { return Err("输出不能覆盖任何输入源文件。".to_owned()); }
    if fs::symlink_metadata(&output).is_ok() { return Err("输出已存在。首版不覆盖已有文件，请选择新文件名。".to_owned()); }
    let extension = output.extension().and_then(|value| value.to_str()).ok_or("输出需要明确扩展名。")?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp4" | "mkv" | "mov" | "webm" | "avi" | "wav" | "flac" | "mp3" | "m4a" | "ogg" | "opus" | "aac" | "ts") {
        return Err(format!("首版尚不支持 .{extension} 输出；请使用普通音视频文件扩展名。"));
    }
    let staged = tempfile::Builder::new().prefix(".ffgui-").suffix(&format!(".{extension}")).tempfile_in(&parent).map_err(|error| format!("无法在输出目录创建临时文件：{error}"))?;
    let temporary = staged.path().to_str().ok_or("首版不支持非 Unicode 输出路径。")?.to_owned();
    // FFmpeg 6 can log muxing errors, drop packets and still return exit 0.
    // -xerror makes those actual processing errors fail even with quiet logs,
    // so a partial result cannot be committed as a successful output.
    args.insert(0, "-xerror".to_owned());
    args.insert(0, "-y".to_owned());
    args.push(temporary);
    Ok(Plan { args, source_args: request.args.clone(), inputs, output, staged })
}

#[derive(Debug)]
struct DurationEstimate {
    seconds: f64,
    source: &'static str,
}

// This is an estimate of the output timeline, not an assurance that an entire
// file will decode. Complicated time transforms deliberately remain unknown.
fn estimate_duration(args: &[String], media: Option<&engine::MediaInfo>) -> Option<DurationEstimate> {
    let mut input = None;
    let mut input_count = 0;
    let mut format = None;
    let mut input_is_lavfi = false;
    let mut input_start = 0.0;
    let mut output_start = 0.0;
    let mut input_limit: Option<f64> = None;
    let mut input_end: Option<f64> = None;
    let mut limit: Option<f64> = None;
    let mut end: Option<f64> = None;
    let mut loops = 0_i64;
    let mut complicated = false;
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        let base = base_option(token);
        if token == "-i" {
            input = args.get(index + 1);
            input_is_lavfi = format.as_deref() == Some("lavfi");
            input_count += 1;
            format = None;
            index += 2;
            continue;
        }
        if let Some(value) = args.get(index + 1) {
            match base {
                "-f" => format = Some(value.clone()),
                "-ss" => {
                    let seconds = if value == "0" { 0.0 } else { engine::parse_seconds(value)? };
                    if input_count > 0 { output_start = seconds; } else { input_start = seconds; }
                }
                "-t" => {
                    let seconds = engine::parse_seconds(value)?;
                    if input_count > 0 { limit = Some(seconds); } else { input_limit = Some(seconds); }
                }
                "-to" => { if input_count > 0 { end = engine::parse_seconds(value); } else { input_end = engine::parse_seconds(value); } }
                "-stream_loop" => loops = value.parse().ok()?,
                "-vf" | "-af" | "-filter" => {
                    if value.split(',').any(|filter| matches!(filter.trim().split('=').next().unwrap_or_default(), "trim" | "atrim" | "setpts" | "asetpts" | "atempo")) { complicated = true; }
                }
                "-itsoffset" | "-itsscale" | "-frames" | "-copyts" | "-start_at_zero" => complicated = true,
                _ => {}
            }
        }
        // Only consume values for known value-taking options. Boolean options
        // such as -an and -re are retained as individual tokens.
        index += if token.starts_with('-') && !matches!(base, "-y" | "-n" | "-xerror" | "-hide_banner" | "-nostats" | "-an" | "-vn" | "-sn" | "-dn" | "-shortest" | "-re" | "-copyts" | "-start_at_zero" | "-bitexact") { 2 } else { 1 };
    }
    if let Some(end) = end.filter(|_| limit.is_none()) {
        let seconds = end - output_start;
        if seconds <= 0.0 { return None; }
        limit = Some(limit.map_or(seconds, |old| old.min(seconds)));
    }
    if let Some(end) = input_end.filter(|_| input_limit.is_none()) {
        let seconds = end - input_start;
        if seconds <= 0.0 { return None; }
        input_limit = Some(input_limit.map_or(seconds, |old| old.min(seconds)));
    }
    if complicated { return None; }
    let source = if input_count == 1 {
        let input = input?;
        if input_is_lavfi {
            input.strip_prefix("testsrc2=").unwrap_or(input).split(':').find_map(|part| part.strip_prefix("duration=").or_else(|| part.strip_prefix("d=")).and_then(engine::parse_seconds))
        } else {
            media.and_then(|info| info.duration_seconds)
        }
    } else { None };
    let source_known = source.is_some();
    let source = source.and_then(|seconds| {
        if loops < 0 { None } else { Some((seconds * (loops as f64 + 1.0) - input_start).max(0.0)) }
    });
    let source = match (source, input_limit) {
        (Some(source), Some(limit)) => Some(source.min(limit)),
        (None, Some(limit)) if input_count == 1 => Some(limit),
        (source, _) => source,
    }.map(|seconds| (seconds - output_start).max(0.0));
    let seconds = match (source, limit) {
        (Some(source), Some(limit)) => source.min(limit),
        (Some(source), None) => source,
        (None, Some(limit)) => limit,
        (None, None) => return None,
    };
    (seconds.is_finite() && seconds > 0.0).then_some(DurationEstimate { seconds, source: if source_known { "media" } else { "limit" } })
}

async fn prepare_command(executable: &Path, plan: &Plan, canceled: &AtomicBool, notify: &Notify) -> Result<(tokio::process::Command, Option<DurationEstimate>), String> {
    if canceled.load(Ordering::SeqCst) { return Err("准备阶段已取消。".to_owned()); }
    let metadata = tokio::select! {
        biased;
        _ = notify.notified() => return Err("准备阶段已取消。".to_owned()),
        result = async {
            let mut metadata = BTreeMap::new();
            for input in &plan.inputs {
                if metadata.contains_key(input) { continue; }
                let info = engine::probe_media_path(executable, input.to_str().ok_or("首版不支持非 Unicode 路径。")?).await.map_err(|error| {
                    format!("无法读取输入素材 {}，尚未开始处理，也未保存输出。请通过“更换素材”重新选择文件后重试；若仍失败，请检查文件是否可读取和有效。\n{error}", input.display())
                })?;
                metadata.insert(input.clone(), info);
            }
            Ok::<_, String>(metadata)
        } => result?,
    };
    if canceled.load(Ordering::SeqCst) { return Err("准备阶段已取消。".to_owned()); }
    // Validate every real file first, even when timeline transforms make its
    // duration unknowable. Reuse that probe instead of silently treating an
    // unreadable file as a valid source with unknown duration.
    let duration = estimate_duration(&plan.source_args, plan.inputs.first().and_then(|input| metadata.get(input)));
    let mut command = engine::command(executable);
    command.args(&plan.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    Ok((command, duration))
}

#[tauri::command]
pub async fn run_job(app: AppHandle, state: State<'_, RunnerState>, request: JobRequest) -> Result<(), String> {
    let executable = engine::resolve_executable(Some(&request.executable))?;
    engine::verify(&executable).await?;
    let plan = make_plan(&request)?;
    let canceled = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());
    let runner = state.inner().clone();
    {
        let mut active = runner.active.lock().map_err(|_| "任务状态锁不可用。")?;
        if active.is_some() { return Err("已有一个任务正在运行，请等待完成或取消。".to_owned()); }
        if runner.completed_outputs.lock().map_err(|_| "结果记录不可用。")?.contains(&request.id) {
            return Err("该任务 ID 已完成，请创建新任务。".to_owned());
        }
        *active = Some(ActiveJob { id: request.id.clone(), canceled: canceled.clone(), notify: notify.clone() });
    }
    // Completion is delivered only through job-event; invoke returns promptly.
    tauri::async_runtime::spawn(async move {
        execute(app, runner, request.id, executable, plan, canceled, notify).await;
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_job(state: State<'_, RunnerState>, id: String) -> Result<(), String> {
    let active = state.active.lock().map_err(|_| "任务状态锁不可用。")?;
    let job = active.as_ref().filter(|job| job.id == id).ok_or("该任务已结束或不在运行。")?;
    job.canceled.store(true, Ordering::SeqCst);
    job.notify.notify_one();
    Ok(())
}

async fn drain_stream<R: AsyncRead + Unpin>(app: AppHandle, id: String, mut reader: R, progress: bool) {
    let mut chunk = [0_u8; 4096];
    let mut line = Vec::new();
    let mut emitted = 0_usize;
    let mut limited = false;
    let mut fields = BTreeMap::<String, String>::new();
    loop {
        let count = match reader.read(&mut chunk).await { Ok(0) | Err(_) => break, Ok(count) => count };
        for byte in &chunk[..count] {
            if *byte != b'\n' && line.len() < 16 * 1024 { line.push(*byte); continue; }
            let text = String::from_utf8_lossy(&line).trim_end_matches('\r').to_owned();
            line.clear();
            if progress {
                if let Some((key, value)) = text.split_once('=') {
                    if fields.len() < 128 { fields.insert(key.to_owned(), value.to_owned()); }
                    if key == "progress" {
                        emit(&app, &id, "progress", None, Some(json!(fields)), None);
                        fields.clear();
                    }
                }
            } else if emitted < 2 * 1024 * 1024 {
                emitted += text.len();
                emit(&app, &id, "log", Some(text), None, None);
            } else if !limited {
                emit(&app, &id, "log", Some("日志显示达到 2 MiB 上限，后续输出继续读取但不展示。".to_owned()), None, None);
                limited = true;
            }
        }
    }
    if !line.is_empty() && !progress && !limited {
        emit(&app, &id, "log", Some(String::from_utf8_lossy(&line).into_owned()), None, None);
    }
}

async fn execute(app: AppHandle, runner: RunnerState, id: String, executable: PathBuf, plan: Plan, canceled: Arc<AtomicBool>, notify: Arc<Notify>) {
    emit(&app, &id, "state", Some("正在读取素材信息并准备处理。".to_owned()), Some(json!({ "phase": "preparing", "output": plan.output })), Some("running"));
    let (mut command, duration) = match prepare_command(&executable, &plan, &canceled, &notify).await {
        Ok(prepared) => prepared,
        Err(error) => {
            let (state, message) = finalize_job(&runner, plan, &canceled, Err(error));
            emit(&app, &id, "state", message, None, Some(state));
            if runner.exit_after_cancel.load(Ordering::SeqCst) { app.exit(0); }
            return;
        }
    };
    let outcome = match command.spawn() {
        Err(error) => Err(format!("无法启动任务：{error}")),
        Ok(mut child) => {
            let pid = child.id();
#[cfg(windows)]
            let process_tree = match pid.and_then(|pid| ProcessTree::attach(pid).ok()) {
                Some(tree) => Some(tree),
                None => {
                    let _ = child.kill().await;
                    finish(&app, &runner, &id, if canceled.load(Ordering::SeqCst) { "canceled" } else { "failed" }, Some("无法创建 Windows 进程树管理对象，任务已停止。".to_owned()));
                    return;
                }
            };
            let mut stdin = child.stdin.take();
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let mut data = json!({ "phase": "processing", "executable": executable, "args": plan.args, "output": plan.output });
            if let Some(duration) = &duration {
                data["duration_seconds"] = json!(duration.seconds.to_string());
                data["duration_source"] = json!(duration.source);
            }
            emit(&app, &id, "state", Some("正在处理音视频，写入同目录临时文件。".to_owned()), Some(data), Some("running"));
            let out_task = stdout.map(|out| tauri::async_runtime::spawn(drain_stream(app.clone(), id.clone(), out, true)));
            let err_task = stderr.map(|err| tauri::async_runtime::spawn(drain_stream(app.clone(), id.clone(), err, false)));
            let status = if canceled.load(Ordering::SeqCst) {
                cancel_process(&app, &id, &mut child, &mut stdin, pid).await
            } else {
                tokio::select! {
                    status = child.wait() => status,
                    _ = notify.notified() => cancel_process(&app, &id, &mut child, &mut stdin, pid).await,
                }
            };
            drop(stdin);
            #[cfg(windows)]
            drop(process_tree);
            if let Some(mut task) = out_task {
                if tokio::time::timeout(Duration::from_secs(2), &mut task).await.is_err() { task.abort(); }
            }
            if let Some(mut task) = err_task {
                if tokio::time::timeout(Duration::from_secs(2), &mut task).await.is_err() { task.abort(); }
            }
            status.map_err(|error| format!("无法取得进程退出状态：{error}"))
        }
    };
    if !canceled.load(Ordering::SeqCst) && outcome.as_ref().is_ok_and(|status| status.success()) {
        emit(&app, &id, "state", Some("编码已结束，正在同步并保存结果文件。".to_owned()), Some(json!({ "phase": "finalizing", "output": plan.output })), Some("running"));
    }
    let mut result_data = json!({ "output": plan.output });
    if let Some(duration) = &duration { result_data["duration_seconds"] = json!(duration.seconds.to_string()); }
    let final_size = plan.staged.as_file().metadata().ok().map(|metadata| metadata.len());
    // Cancellation and commit share the active-job mutex. A cancel accepted
    // before this point always wins even if FFmpeg handled q with exit code 0.
    let (state, message) = finalize_job(&runner, plan, &canceled, outcome);
    if state == "succeeded" {
        if let Some(size) = final_size { result_data["final_size_bytes"] = json!(size.to_string()); }
    }
    emit(&app, &id, "state", message, Some(result_data), Some(state));
    if runner.exit_after_cancel.load(Ordering::SeqCst) { app.exit(0); }
}

fn finalize_job(runner: &RunnerState, plan: Plan, canceled: &AtomicBool, outcome: Result<std::process::ExitStatus, String>) -> (&'static str, Option<String>) {
    let mut active = match runner.active.lock() {
        Ok(active) => active,
        Err(_) => return ("failed", Some("任务状态锁不可用，临时产物未提交。".to_owned())),
    };
    let mut completed = match runner.completed_outputs.lock() {
        Ok(completed) => completed,
        Err(_) => {
            *active = None;
            return ("failed", Some("结果记录不可用，临时产物未提交。".to_owned()));
        }
    };
    // Capture the identity of the staged file, before its atomic publication.
    // A later path replacement must never become an authorized preview.
    let output = plan.staged.as_file().metadata().ok().map(|metadata| CompletedOutput::new(plan.output.clone(), &metadata));
    let result = finalize_output(plan, canceled.load(Ordering::SeqCst), outcome);
    if result.0 == "succeeded" {
        if let (Some(job), Some(output)) = (active.as_ref(), output) {
            completed.insert(job.id.clone(), output);
        }
    }
    *active = None;
    result
}

fn finalize_output(plan: Plan, canceled: bool, outcome: Result<std::process::ExitStatus, String>) -> (&'static str, Option<String>) {
    if canceled {
        return ("canceled", Some("任务已取消，部分产物未提交。".to_owned()));
    }
    match outcome {
        Err(error) => ("failed", Some(error)),
        Ok(status) if !status.success() => ("failed", Some(format!("FFmpeg 异常退出（{status}），请查看日志。"))),
        Ok(_) => match commit_output(plan) {
            Ok(path) => ("succeeded", Some(format!("已保存：{}", path.display()))),
            Err(error) => ("failed", Some(error)),
        },
    }
}

fn commit_output(plan: Plan) -> Result<PathBuf, String> {
    let metadata = plan.staged.as_file().metadata().map_err(|error| format!("无法验证临时产物：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 { return Err("FFmpeg 返回成功，但没有生成有效的非空普通文件。".to_owned()); }
    plan.staged.as_file().sync_all().map_err(|error| format!("无法同步临时产物：{error}"))?;
    // Atomic no-clobber publication: unlike a check-then-rename, this cannot
    // replace a file created by another process after preflight.
    plan.staged.persist_noclobber(&plan.output).map_err(|error| format!("输出提交失败（不会覆盖已有文件）：{error}"))?;
    Ok(plan.output)
}

#[cfg(windows)]
fn finish(app: &AppHandle, runner: &RunnerState, id: &str, state: &'static str, message: Option<String>) {
    if let Ok(mut active) = runner.active.lock() { *active = None; }
    emit(app, id, "state", message, None, Some(state));
    if runner.exit_after_cancel.load(Ordering::SeqCst) { app.exit(0); }
}

async fn cancel_process(app: &AppHandle, id: &str, child: &mut tokio::process::Child, stdin: &mut Option<tokio::process::ChildStdin>, pid: Option<u32>) -> std::io::Result<std::process::ExitStatus> {
    emit(app, id, "log", Some("正在发送 q 请求正常退出；3 秒后仍未结束将强制停止。".to_owned()), None, None);
    graceful_stop(child, stdin, pid).await
}

async fn graceful_stop(child: &mut tokio::process::Child, stdin: &mut Option<tokio::process::ChildStdin>, pid: Option<u32>) -> std::io::Result<std::process::ExitStatus> {
    if let Some(input) = stdin.as_mut() { let _ = input.write_all(b"q\n").await; let _ = input.flush().await; }
    match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
        Ok(result) => result,
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = pid {
                // Child was started in its own process group; the PID belongs
                // to this live Child, never to a persisted/reused job record.
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            }
            #[cfg(not(unix))]
            let _ = pid;
            let _ = child.start_kill();
            child.wait().await
        }
    }
}

#[cfg(windows)]
struct ProcessTree(usize);

#[cfg(windows)]
impl ProcessTree {
    fn attach(pid: u32) -> std::io::Result<Self> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::{JobObjects::*, Threading::*}};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return Err(std::io::Error::last_os_error()); }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) == 0 {
                let error = std::io::Error::last_os_error(); CloseHandle(job); return Err(error);
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() { let error = std::io::Error::last_os_error(); CloseHandle(job); return Err(error); }
            let assigned = AssignProcessToJobObject(job, process);
            let error = std::io::Error::last_os_error();
            CloseHandle(process);
            if assigned == 0 { CloseHandle(job); return Err(error); }
            Ok(Self(job as usize))
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(output: &Path) -> JobRequest {
        JobRequest { id: "test".to_owned(), executable: "ffmpeg".to_owned(), args: vec!["-f".into(), "lavfi".into(), "-i".into(), "testsrc2=size=128x72:rate=5".into(), "-t".into(), "1".into(), "-c:v".into(), "mpeg4".into(), "-an".into(), output.to_str().unwrap().into()] }
    }

    #[test]
    fn retains_order_and_stages_same_extension() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("含 空格.mp4");
        let plan = make_plan(&sample(&output)).unwrap();
        assert_eq!(&plan.args[..2], &["-y", "-xerror"]);
        assert_eq!(&plan.args[2..12], &["-f", "lavfi", "-i", "testsrc2=size=128x72:rate=5", "-t", "1", "-c:v", "mpeg4", "-an", plan.args.last().unwrap()]);
        assert_eq!(plan.staged.path().extension().unwrap(), "mp4");
        assert_eq!(plan.staged.path().parent().unwrap(), output.parent().unwrap().canonicalize().unwrap());
        assert!(!output.exists());
    }

    #[test]
    fn fail_on_error_is_an_unambiguous_runner_policy() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("output.mp4");
        let mut request = sample(&output);
        request.args.splice(0..0, ["-xerror", "-n", "-xerror", "-y"].map(String::from));
        let plan = make_plan(&request).unwrap();
        assert_eq!(plan.args.iter().filter(|token| token.as_str() == "-xerror").count(), 1);
        assert_eq!(&plan.args[..2], &["-y", "-xerror"]);
        for extra in [["-xerror", "0"], ["-xerror:v", "0"], ["-no_xerror", "0"]] {
            let mut invalid = sample(&output);
            invalid.args.splice(0..0, extra.map(String::from));
            assert!(make_plan(&invalid).is_err());
        }
    }

    #[test]
    fn rejects_existing_outputs_and_unsafe_io() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("output.mp4");
        fs::write(&output, "original").unwrap();
        assert!(make_plan(&sample(&output)).unwrap_err_text().contains("已存在"));
        fs::remove_file(&output).unwrap();
        for target in ["https://example.com/output.mp4", "pipe:1", "frame-%03d.mp4"] {
            let mut request = sample(&output);
            *request.args.last_mut().unwrap() = target.into();
            assert!(make_plan(&request).is_err());
        }
        for extra in [vec!["-report"], vec!["-f", "hls"], vec!["-vf", "movie=/private/secret.mp4"], vec!["-filter_complex", "null"]] {
            let mut request = sample(&output);
            let position = request.args.len() - 1;
            request.args.splice(position..position, extra.into_iter().map(String::from));
            assert!(make_plan(&request).is_err());
        }
    }

    #[test]
    fn publication_never_clobbers_concurrent_file() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("output.mp4");
        let mut plan = make_plan(&sample(&output)).unwrap();
        plan.staged.write_all(b"encoded data").unwrap();
        fs::write(&output, b"concurrent original").unwrap();
        assert!(commit_output(plan).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"concurrent original");
    }

    #[test]
    fn only_successful_atomic_publication_registers_a_viewable_result() {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let directory = tempfile::tempdir().unwrap();
        for (id, canceled, successful) in [("success", false, true), ("failed", false, false), ("canceled", true, true)] {
            let output = directory.path().join(format!("{id}.mp4"));
            let mut plan = make_plan(&sample(&output)).unwrap();
            plan.staged.write_all(b"processed output").unwrap();
            let (runner, cancel_flag, _) = registered_test_job(id);
            cancel_flag.store(canceled, Ordering::SeqCst);
            let status = std::process::ExitStatus::from_raw(if successful { 0 } else { 1 });
            let result = finalize_job(&runner, plan, &cancel_flag, Ok(status));
            if id == "success" {
                assert_eq!(result.0, "succeeded");
                assert!(runner.completed_output(id).is_ok());
                assert!(output.is_file());
            } else {
                assert_eq!(result.0, if canceled { "canceled" } else { "failed" });
                assert!(runner.completed_output(id).is_err());
                assert!(!output.exists());
            }
        }
    }

    #[test]
    fn safe_filters_and_generators_are_explicit() {
        assert!(safe_filter("scale=640:-2,fps=24,hflip").is_ok());
        assert!(safe_filter("scale=-2:720,transpose=1,vflip,crop=640:360:0:0").is_ok());
        assert!(safe_filter("volume=0.5").is_ok());
        assert!(safe_filter("drawtext=textfile=/private/secret").is_err());
        assert!(safe_lavfi("testsrc2=size=1280x720:rate=30"));
        assert!(!safe_lavfi("testsrc2=size=1280x720,movie=/secret"));
        assert!(!safe_lavfi("testsrc2=size=100000x720"));
    }

    #[tokio::test]
    async fn closing_an_active_window_requests_cancel_before_exit() {
        let runner = RunnerState::default();
        assert!(!runner.cancel_for_exit());
        let canceled = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        *runner.active.lock().unwrap() = Some(ActiveJob { id: "close-test".into(), canceled: canceled.clone(), notify: notify.clone() });
        assert!(runner.cancel_for_exit());
        assert!(canceled.load(Ordering::SeqCst));
        assert!(runner.exit_after_cancel.load(Ordering::SeqCst));
        tokio::time::timeout(Duration::from_millis(100), notify.notified()).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unresponsive_child_is_force_stopped_after_grace_period() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let mut command = engine::command(Path::new("/bin/sh"));
        // Built-ins deliberately keep reading and ignore q, without creating
        // descendants or depending on any external program or network.
        command.args(["-c", "while IFS= read -r line; do :; done"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        let mut stdin = child.stdin.take();
        let started = std::time::Instant::now();
        let status = graceful_stop(&mut child, &mut stdin, pid).await.unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert!(started.elapsed() >= Duration::from_secs(3));
        assert!(started.elapsed() < Duration::from_secs(8));
        assert_eq!(child.try_wait().unwrap(), Some(status));
    }

    #[test]
    fn named_codecs_and_single_file_opus_are_supported() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("vp9.webm");
        let mut request = sample(&output);
        request.args[7] = "libvpx-vp9".into();
        assert!(make_plan(&request).is_ok());
        request.args[7] = "-report".into();
        assert!(make_plan(&request).is_err());
        request.args[7] = "encoder:options".into();
        assert!(make_plan(&request).is_err());

        let output = directory.path().join("audio.opus");
        let mut request = sample(&output);
        request.args.splice(6..9, ["-vn", "-c:a", "libopus", "-f", "opus"].map(String::from));
        assert!(make_plan(&request).is_ok());
    }

    async fn probe_json(executable: &Path, output: &Path) -> Value {
        let result = engine::command(executable).args(["-v", "error", "-show_streams", "-show_format", "-of", "json"]).arg(output).output().await.unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        serde_json::from_slice(&result.stdout).unwrap()
    }

    async fn encode_and_publish(executable: &Path, id: &str, args: Vec<String>) {
        let request = JobRequest { id: id.into(), executable: executable.to_string_lossy().into_owned(), args };
        let plan = make_plan(&request).unwrap();
        let result = engine::command(executable).args(&plan.args).output().await.unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        assert_eq!(finalize_output(plan, false, Ok(result.status)).0, "succeeded");
    }

    async fn create_av_fixture(executable: &Path, output: &Path) {
        // The fixture is generated directly in the test. It deliberately does
        // not widen the application's permitted synthetic input generators.
        let result = engine::command(executable).args([
            "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
        ]).arg(output).output().await.unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn muxing_errors_fail_without_publishing_even_when_logs_are_quiet() {
        fn report_child_timeout(stage: &str) {
            match stage {
                "reproduce FFmpeg 6 exit-zero muxing error" => eprintln!("::error::Media regression historical baseline child remained running beyond 30 seconds."),
                "reject muxing error with production fail-on-error policy" => eprintln!("::error::Media regression production failure child remained running beyond 30 seconds."),
                "reject muxing error with quiet logs" => eprintln!("::error::Media regression quiet failure child remained running beyond 30 seconds."),
                "recover with a sufficient muxing queue" => eprintln!("::error::Media regression recovery child remained running beyond 30 seconds."),
                _ => eprintln!("::error::Media regression child remained running beyond 30 seconds."),
            }
        }

        fn report_pipe_timeout(stage: &str) {
            match stage {
                "reproduce FFmpeg 6 exit-zero muxing error" => eprintln!("::error::Media regression historical baseline child exited but output pipes did not close within 2 seconds."),
                "reject muxing error with production fail-on-error policy" => eprintln!("::error::Media regression production failure child exited but output pipes did not close within 2 seconds."),
                "reject muxing error with quiet logs" => eprintln!("::error::Media regression quiet failure child exited but output pipes did not close within 2 seconds."),
                "recover with a sufficient muxing queue" => eprintln!("::error::Media regression recovery child exited but output pipes did not close within 2 seconds."),
                _ => eprintln!("::error::Media regression child exited but output pipes did not close within 2 seconds."),
            }
        }

        async fn collect_stage_output(stage: &str, command: &mut tokio::process::Command) -> std::process::Output {
            // Distinguish a live encoder hang from inherited pipe handles. An
            // output() timeout cannot tell which of those is still pending.
            // Both remain test failures; killing a child never counts as a
            // successful reproduction of the encoder's own failure status.
            let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let mut stdout_task = tokio::spawn(async move {
                let mut bytes = Vec::new();
                stdout.read_to_end(&mut bytes).await.map(|_| bytes)
            });
            let mut stderr_task = tokio::spawn(async move {
                let mut bytes = Vec::new();
                stderr.read_to_end(&mut bytes).await.map(|_| bytes)
            });
            let status = match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
                Ok(result) => result.unwrap(),
                Err(_) => match child.try_wait().unwrap() {
                    // Resolve the narrow race where the child exited exactly
                    // as the deadline expired before diagnosing its pipes.
                    Some(status) => status,
                    None => {
                        report_child_timeout(stage);
                        let _ = child.start_kill();
                        if !matches!(tokio::time::timeout(Duration::from_secs(5), child.wait()).await, Ok(Ok(_))) {
                            eprintln!("::error::Media regression timed-out test child could not be reaped within 5 seconds.");
                        }
                        stdout_task.abort();
                        stderr_task.abort();
                        panic!("muxing-error regression stage '{stage}' child remained alive beyond its deadline");
                    }
                },
            };
            let (stdout, stderr) = match tokio::time::timeout(Duration::from_secs(2), async {
                tokio::join!(&mut stdout_task, &mut stderr_task)
            }).await {
                Ok((stdout, stderr)) => (stdout.unwrap().unwrap(), stderr.unwrap().unwrap()),
                Err(_) => {
                    report_pipe_timeout(stage);
                    stdout_task.abort();
                    stderr_task.abort();
                    panic!("muxing-error regression stage '{stage}' exited but its output pipes remained open");
                }
            };
            std::process::Output { status, stdout, stderr }
        }

        async fn finish_stage<T>(stage: &str, operation: impl std::future::Future<Output = T>) -> T {
            match tokio::time::timeout(Duration::from_secs(30), operation).await {
                Ok(result) => result,
                Err(_) => {
                    // Emit only fixed check categories to CI annotations.
                    // Raw child output, paths and environment stay out of them.
                    match stage {
                        "generate audio/video fixture" => eprintln!("::error::Media regression timed out during fixture generation."),
                        "delay fixture audio" => eprintln!("::error::Media regression timed out during fixture audio delay."),
                        "read engine version" => eprintln!("::error::Media regression timed out during engine version detection."),
                        "reproduce FFmpeg 6 exit-zero muxing error" => eprintln!("::error::Media regression timed out during historical baseline reproduction."),
                        "reject muxing error with production fail-on-error policy" => eprintln!("::error::Media regression timed out during production failure handling."),
                        "reject muxing error with quiet logs" => eprintln!("::error::Media regression timed out during quiet failure handling."),
                        "recover with a sufficient muxing queue" => eprintln!("::error::Media regression timed out during muxing queue recovery."),
                        "probe recovered output" => eprintln!("::error::Media regression timed out during recovered output inspection."),
                        _ => eprintln!("::error::Media regression timed out during an unclassified test stage."),
                    }
                    panic!("muxing-error regression stage '{stage}' exceeded 30 seconds")
                }
            }
        }

        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.mp4");
        let input = directory.path().join("delayed-audio.mkv");
        let generated = finish_stage("generate audio/video fixture", engine::command(&executable).args([
            "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1.2",
            "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac",
        ]).arg(&source).output()).await.unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let delayed = finish_stage("delay fixture audio", engine::command(&executable).args(["-v", "error", "-i"]).arg(&source)
            .args(["-itsoffset", "1", "-i"]).arg(&source)
            .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy"]).arg(&input).output()).await.unwrap();
        assert!(delayed.status.success(), "{}", String::from_utf8_lossy(&delayed.stderr));
        fs::remove_file(&source).unwrap();

        let request = |name: &str, queue: &str, quiet: bool| {
            let mut args = vec!["-i".into(), input.to_string_lossy().into_owned()];
            args.extend(["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-c:a", "aac", "-max_muxing_queue_size", queue].map(String::from));
            if quiet { args.extend(["-loglevel", "quiet"].map(String::from)); }
            args.push(directory.path().join(name).to_string_lossy().into_owned());
            JobRequest { id: name.into(), executable: executable.to_string_lossy().into_owned(), args }
        };
        let inject_test_threshold = |plan: &mut Plan| {
            // Force the same queue overflow with a tiny disposable fixture.
            // This test-only option remains outside the production whitelist;
            // the GUI regression uses a larger source and the default threshold.
            let output_index = plan.args.len() - 1;
            plan.args.splice(output_index..output_index, ["-muxing_queue_data_threshold", "0"].map(String::from));
        };
        let failing_request = request("failed.mp4", "1", false);
        let mut plan = make_plan(&failing_request).unwrap();
        inject_test_threshold(&mut plan);
        // FFmpeg 6 is the affected development engine; newer builds may already
        // return a failure or stall in this unprotected historical reproduction.
        // Every version must still pass the production -xerror checks below.
        let version = finish_stage("read engine version", engine::verify(&executable)).await.unwrap();
        if version.starts_with("ffmpeg version 6.") {
            let baseline_args = plan.args.iter().filter(|token| token.as_str() != "-xerror").collect::<Vec<_>>();
            let baseline = collect_stage_output("reproduce FFmpeg 6 exit-zero muxing error", engine::command(&executable).args(baseline_args)).await;
            assert!(String::from_utf8_lossy(&baseline.stderr).contains("Too many packets buffered"), "{}", String::from_utf8_lossy(&baseline.stderr));
            assert!(baseline.status.success(), "FFmpeg 6 should reproduce its exit-0 muxing-error behavior");
        }
        let result = collect_stage_output("reject muxing error with production fail-on-error policy", engine::command(&executable).args(&plan.args)).await;
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("Too many packets buffered"));
        assert_eq!(finalize_output(plan, false, Ok(result.status)).0, "failed");
        assert!(!directory.path().join("failed.mp4").exists());

        let mut quiet_plan = make_plan(&request("quiet-failed.mp4", "1", true)).unwrap();
        inject_test_threshold(&mut quiet_plan);
        let result = collect_stage_output("reject muxing error with quiet logs", engine::command(&executable).args(&quiet_plan.args)).await;
        assert!(!result.status.success());
        assert!(result.stderr.is_empty(), "quiet logs should not be needed to detect a failure");
        assert_eq!(finalize_output(quiet_plan, false, Ok(result.status)).0, "failed");
        assert!(!directory.path().join("quiet-failed.mp4").exists());

        let mut recovered = make_plan(&request("recovered.mp4", "1024", false)).unwrap();
        inject_test_threshold(&mut recovered);
        let result = collect_stage_output("recover with a sufficient muxing queue", engine::command(&executable).args(&recovered.args)).await;
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        assert_eq!(finalize_output(recovered, false, Ok(result.status)).0, "succeeded");
        let metadata = finish_stage("probe recovered output", probe_json(&probe, &directory.path().join("recovered.mp4"))).await;
        assert_eq!(metadata["streams"][0]["nb_frames"], "36");
        assert_eq!(metadata["streams"][1]["codec_type"], "audio");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2, "temporary or failed outputs must be cleaned up");
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn real_media_metadata_and_untrimmed_duration_are_discovered_safely() {
        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("含 空格 素材.mp4");
        create_av_fixture(&executable, &input).await;
        let metadata = engine::probe_media_path(&executable, input.to_str().unwrap()).await.unwrap();
        // Installed engines may ship a sibling ffprobe; otherwise the
        // supported FFmpeg header fallback provides the same business data.
        assert!(matches!(metadata.probe_source, "ffmpeg" | "ffprobe"), "unexpected metadata provider: {}", metadata.probe_source);
        assert!(metadata.has_video && metadata.has_audio);
        assert_eq!((metadata.width, metadata.height), (Some(160), Some(90)));
        assert_eq!(metadata.frame_rate, Some(12.0));
        assert!((metadata.duration_seconds.unwrap() - 3.0).abs() < 0.05);
        let args = ["-i".into(), input.to_string_lossy().into_owned(), "output.mp4".into()].to_vec();
        let estimate = estimate_duration(&args, Some(&metadata)).unwrap();
        assert!((estimate.seconds - 3.0).abs() < 0.05);
        assert_eq!(estimate.source, "media");
        let mut trimmed = args.clone();
        trimmed.splice(2..2, ["-ss", "0.5", "-t", "10"].map(String::from));
        assert!((estimate_duration(&trimmed, Some(&metadata)).unwrap().seconds - 2.5).abs() < 0.05);
        let mut shorter = args.clone();
        shorter.splice(2..2, ["-ss", "0.5", "-t", "1"].map(String::from));
        assert_eq!(estimate_duration(&shorter, Some(&metadata)).unwrap().seconds, 1.0);
        let mut input_trim = args.clone();
        input_trim.splice(0..0, ["-ss", "0.5", "-t", "1.5"].map(String::from));
        input_trim.splice(6..6, ["-ss", "0.5"].map(String::from));
        assert!((estimate_duration(&input_trim, Some(&metadata)).unwrap().seconds - 1.0).abs() < 0.05);
        let mut time_filter = args;
        time_filter.splice(2..2, ["-af", "atempo=2"].map(String::from));
        assert!(estimate_duration(&time_filter, Some(&metadata)).is_none());

        #[cfg(unix)]
        {
            let linked_engine = directory.path().join("ffmpeg");
            std::os::unix::fs::symlink(&executable, &linked_engine).unwrap();
            std::os::unix::fs::symlink(&probe, directory.path().join("ffprobe")).unwrap();
            let metadata = engine::probe_media_path(&linked_engine, input.to_str().unwrap()).await.unwrap();
            assert_eq!(metadata.probe_source, "ffprobe");
            assert!(metadata.has_video && metadata.has_audio);
            assert_eq!((metadata.width, metadata.height), (Some(160), Some(90)));
        }
        let playlist = directory.path().join("hidden-network.m3u8");
        fs::write(&playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nhttps://example.invalid/private.ts\n#EXT-X-ENDLIST\n").unwrap();
        let error = engine::probe_media_path(&executable, playlist.to_str().unwrap()).await.unwrap_err();
        assert!(error.contains("whitelist"), "{error}");
        let invalid = directory.path().join("corrupt.mp4");
        fs::write(&invalid, "not media data").unwrap();
        assert!(engine::probe_media_path(&executable, invalid.to_str().unwrap()).await.is_err());
    }

    #[tokio::test]
    async fn bounded_generator_duration_and_unknown_timelines_are_distinguished() {
        let directory = tempfile::tempdir().unwrap();
        let request = sample(&directory.path().join("output.mp4"));
        assert_eq!(estimate_duration(&request.args, None).unwrap().seconds, 1.0);
        let mut bounded = request.args.clone();
        bounded[3] = "testsrc2=duration=3:size=128x72:rate=5".into();
        bounded.drain(4..6);
        assert_eq!(estimate_duration(&bounded, None).unwrap().seconds, 3.0);
        bounded[3] = "testsrc2=size=128x72:rate=5".into();
        assert!(estimate_duration(&bounded, None).is_none());
    }

    fn registered_test_job(id: &str) -> (RunnerState, Arc<AtomicBool>, Arc<Notify>) {
        let runner = RunnerState::default();
        let canceled = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        *runner.active.lock().unwrap() = Some(ActiveJob { id: id.to_owned(), canceled: canceled.clone(), notify: notify.clone() });
        (runner, canceled, notify)
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH pointing to an installed engine"]
    async fn unreadable_inputs_fail_preparing_before_encoder_even_with_limits_or_time_filters() {
        use std::os::unix::fs::PermissionsExt;
        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let trace = directory.path().join("commands.log");
        let wrapper = directory.path().join("ffmpeg");
        let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
        // This wrapper records which real FFmpeg operation was requested; it
        // does not invent media metadata or encoding results.
        fs::write(&wrapper, format!("#!/bin/sh\nif [ \"$1\" = '-y' ]; then printf 'encoder\\n'; else printf 'probe\\n'; fi >> {}\nexec {} \"$@\"\n", quote(&trace), quote(&executable))).unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        let corrupt = directory.path().join("corrupt.mp4");
        let missing = directory.path().join("removed-before-preparing.mp4");
        let valid = directory.path().join("valid.mp4");
        fs::write(&corrupt, b"not a media file").unwrap();
        fs::write(&missing, b"was present when the plan was accepted").unwrap();
        create_av_fixture(&executable, &valid).await;
        for (index, source, extra) in [
            (0, &corrupt, vec!["-t", "0.1"]),
            (1, &corrupt, vec!["-vf", "setpts=PTS/2"]),
            (2, &missing, vec!["-t", "0.1"]),
            (3, &valid, vec!["-i", corrupt.to_str().unwrap(), "-t", "0.1"]),
        ] {
            let output = directory.path().join(format!("failed-{index}.mp4"));
            let mut args = vec!["-i".to_owned(), source.to_str().unwrap().to_owned()];
            args.extend(extra.into_iter().map(String::from));
            args.extend(["-c:v".into(), "mpeg4".into(), "-an".into(), output.to_str().unwrap().into()]);
            let plan = make_plan(&JobRequest { id: format!("failed-{index}"), executable: wrapper.to_str().unwrap().into(), args }).unwrap();
            let staged = plan.staged.path().to_owned();
            if index == 2 { fs::remove_file(&missing).unwrap(); }
            let (runner, canceled, notify) = registered_test_job("failed");
            let error = match prepare_command(&wrapper, &plan, &canceled, &notify).await {
                Err(error) => error,
                Ok((mut command, _)) => { let _ = command.output().await; panic!("unreadable source reached encoder"); }
            };
            assert!(error.contains("无法读取输入素材") && error.contains("更换素材"), "{error}");
            if index != 2 { assert!(error.contains("无法读取素材信息"), "original probe error was lost: {error}"); }
            let (state, message) = finalize_job(&runner, plan, &canceled, Err(error.clone()));
            assert_eq!(state, "failed");
            assert_eq!(message.as_deref(), Some(error.as_str()));
            assert!(runner.active.lock().unwrap().is_none());
            assert!(!output.exists() && !staged.exists());
        }
        let operations = fs::read_to_string(&trace).unwrap();
        assert_eq!(operations.lines().count(), 4); // corrupt x2, valid + corrupt; removed file never spawns a probe.
        assert!(operations.lines().all(|line| line == "probe"), "{operations}");
        assert_eq!(fs::read(&corrupt).unwrap(), b"not a media file");
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn raw_video_with_unknown_duration_passes_preparing_and_really_encodes() {
        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("unknown-duration.h264");
        let generated = engine::command(&executable).args(["-hide_banner", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=12", "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast", "-an", "-f", "h264", input.to_str().unwrap()]).output().await.unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let source_bytes = fs::read(&input).unwrap();
        let output = directory.path().join("encoded.mp4");
        let request = JobRequest { id: "unknown-duration".into(), executable: executable.to_str().unwrap().into(), args: ["-i", input.to_str().unwrap(), "-c:v", "mpeg4", "-an", "-progress", "pipe:1", output.to_str().unwrap()].map(String::from).to_vec() };
        let plan = make_plan(&request).unwrap();
        let (runner, canceled, notify) = registered_test_job(&request.id);
        let (mut command, duration) = prepare_command(&executable, &plan, &canceled, &notify).await.unwrap();
        assert!(duration.is_none());
        let encoded = command.output().await.unwrap();
        assert!(encoded.status.success(), "{}", String::from_utf8_lossy(&encoded.stderr));
        assert!(String::from_utf8_lossy(&encoded.stdout).contains("progress=end"));
        assert_eq!(finalize_job(&runner, plan, &canceled, Ok(encoded.status)).0, "succeeded");
        assert!(runner.active.lock().unwrap().is_none());
        let metadata = probe_json(&probe, &output).await;
        assert_eq!(metadata["streams"][0]["codec_name"], "mpeg4");
        assert_eq!(metadata["streams"][0]["nb_frames"], "6");
        assert_eq!(fs::read(&input).unwrap(), source_bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn canceling_a_pending_probe_reaps_child_clears_active_and_removes_staged_output() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input.mp4");
        let output = directory.path().join("never-encoded.mp4");
        let pid_file = directory.path().join("probe.pid");
        let unexpected_encoder = directory.path().join("unexpected-encoder");
        let wrapper = directory.path().join("ffmpeg");
        fs::write(&input, b"placeholder: the real test process blocks before reading").unwrap();
        // exec replaces the test shell, so the PID represents the sole pending
        // probe process and no untracked shell/sleep descendants are created.
        fs::write(&wrapper, format!("#!/bin/sh\nif [ \"$1\" = '-y' ]; then touch '{}'; exit 1; fi\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 30\n", unexpected_encoder.display(), pid_file.display())).unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        let request = JobRequest { id: "pending-probe".into(), executable: wrapper.to_str().unwrap().into(), args: ["-i", input.to_str().unwrap(), "-t", "1", output.to_str().unwrap()].map(String::from).to_vec() };
        let plan = make_plan(&request).unwrap();
        let staged = plan.staged.path().to_owned();
        let (runner, canceled, notify) = registered_test_job(&request.id);
        let cancel_flag = canceled.clone();
        let cancel_notify = notify.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(text) = fs::read_to_string(&pid_file) {
                        if let Ok(pid) = text.parse::<i32>() {
                            cancel_flag.store(true, Ordering::SeqCst);
                            cancel_notify.notify_one();
                            return pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.unwrap()
        });
        let prepared = tokio::time::timeout(Duration::from_secs(3), prepare_command(&wrapper, &plan, &canceled, &notify)).await.unwrap();
        let error = match prepared { Err(error) => error, Ok(_) => panic!("canceled preparation reached encoder") };
        assert_eq!(finalize_job(&runner, plan, &canceled, Err(error)).0, "canceled");
        assert!(runner.active.lock().unwrap().is_none());
        assert!(!output.exists() && !staged.exists() && !unexpected_encoder.exists());
        let pid = cancel_task.await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("canceled probe process was left alive");
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn friendly_video_actions_produce_trimmed_resized_rotated_and_encoded_media() {
        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.mp4");
        create_av_fixture(&executable, &input).await;
        let output = directory.path().join("压缩 裁剪 旋转.mp4");
        let mut args = ["-i".into(), input.to_string_lossy().into_owned()].to_vec();
        args.extend(["-ss", "0.5", "-t", "1", "-c:v", "libx264", "-crf", "26", "-preset", "ultrafast", "-vf", "scale=-2:36,transpose=1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"].map(String::from));
        args.push(output.to_string_lossy().into_owned());
        encode_and_publish(&executable, "friendly-compress-trim-rotate", args).await;
        let metadata = probe_json(&probe, &output).await;
        assert_eq!(metadata["streams"][0]["codec_name"], "h264");
        assert_eq!(metadata["streams"][0]["width"], 36);
        assert_eq!(metadata["streams"][0]["height"], 64);
        assert_eq!(metadata["streams"][1]["codec_name"], "aac");
        let duration = metadata["format"]["duration"].as_str().unwrap().parse::<f64>().unwrap();
        assert!((duration - 1.0).abs() < 0.06, "duration={duration}");

        // VP9's encoder has a hyphen; verify the actual engine accepts the
        // corrected name, while crop/flip/frame-rate controls change the media.
        let output = directory.path().join("cropped.webm");
        let mut args = ["-i".into(), input.to_string_lossy().into_owned()].to_vec();
        args.extend(["-t", "0.5", "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-vf", "crop=128:72:0:0,hflip,vflip,fps=6", "-an"].map(String::from));
        args.push(output.to_string_lossy().into_owned());
        encode_and_publish(&executable, "friendly-crop-vp9", args).await;
        let metadata = probe_json(&probe, &output).await;
        assert_eq!(metadata["streams"].as_array().unwrap().len(), 1);
        assert_eq!(metadata["streams"][0]["codec_name"], "vp9");
        assert_eq!(metadata["streams"][0]["width"], 128);
        assert_eq!(metadata["streams"][0]["height"], 72);
        assert_eq!(metadata["streams"][0]["avg_frame_rate"], "6/1");

        let output = directory.path().join("hevc.mp4");
        let mut args = ["-i".into(), input.to_string_lossy().into_owned()].to_vec();
        args.extend(["-t", "0.25", "-c:v", "libx265", "-crf", "28", "-preset", "ultrafast", "-threads", "1", "-an"].map(String::from));
        args.push(output.to_string_lossy().into_owned());
        encode_and_publish(&executable, "friendly-hevc", args).await;
        let metadata = probe_json(&probe, &output).await;
        assert_eq!(metadata["streams"][0]["codec_name"], "hevc");
    }

    async fn audio_rms(executable: &Path, input: &Path) -> f64 {
        let result = engine::command(executable).args(["-v", "error", "-i"]).arg(input).args(["-t", "1", "-vn", "-ac", "1", "-ar", "24000", "-f", "f32le", "pipe:1"]).output().await.unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let samples = result.stdout.chunks_exact(4).map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()) as f64).collect::<Vec<_>>();
        assert!(!samples.is_empty());
        (samples.iter().map(|sample| sample * sample).sum::<f64>() / samples.len() as f64).sqrt()
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn friendly_audio_extraction_supports_formats_and_changes_loudness() {
        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("source.mp4");
        create_av_fixture(&executable, &input).await;
        for (extension, encoder, codec) in [("mp3", "libmp3lame", "mp3"), ("wav", "pcm_s16le", "pcm_s16le"), ("flac", "flac", "flac"), ("m4a", "aac", "aac"), ("opus", "libopus", "opus")] {
            let output = directory.path().join(format!("extracted.{extension}"));
            let mut args = ["-i".into(), input.to_string_lossy().into_owned()].to_vec();
            args.extend(["-vn", "-t", "1", "-c:a", encoder, "-ac", "1", "-ar", "24000", "-af", "volume=0.5"].map(String::from));
            if !matches!(extension, "wav" | "flac") { args.extend(["-b:a", "96k"].map(String::from)); }
            args.push(output.to_string_lossy().into_owned());
            encode_and_publish(&executable, &format!("friendly-extract-{extension}"), args).await;
            let metadata = probe_json(&probe, &output).await;
            assert_eq!(metadata["streams"].as_array().unwrap().len(), 1);
            assert_eq!(metadata["streams"][0]["codec_type"], "audio");
            assert_eq!(metadata["streams"][0]["codec_name"], codec);
            assert_eq!(metadata["streams"][0]["channels"], 1);
            // Opus decoders report 48 kHz even when the encoder accepts a
            // 24 kHz source, as specified by the Opus container granule clock.
            let expected_rate = if extension == "opus" { "48000" } else { "24000" };
            assert_eq!(metadata["streams"][0]["sample_rate"], expected_rate);
        }
        let original_rms = audio_rms(&executable, &input).await;
        let adjusted_rms = audio_rms(&executable, &directory.path().join("extracted.wav")).await;
        let ratio = adjusted_rms / original_rms;
        assert!((0.48..0.52).contains(&ratio), "volume ratio={ratio}");
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn real_ffmpeg_output_is_probed_and_canceled_output_is_not_published() {
        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        assert!(engine::verify(&executable).await.unwrap().starts_with("ffmpeg version "));
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("含 空格.mp4");
        let mut request = sample(&output);
        request.args.splice(0..0, ["-progress".into(), "pipe:1".into(), "-nostats".into()]);
        let plan = make_plan(&request).unwrap();
        let result = engine::command(&executable).args(&plan.args).output().await.unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let telemetry = String::from_utf8_lossy(&result.stdout);
        assert!(telemetry.contains("progress=end"));
        for field in ["frame", "fps", "bitrate", "total_size", "out_time_us", "out_time", "dup_frames", "drop_frames", "speed"] {
            assert!(telemetry.lines().any(|line| line.starts_with(&format!("{field}="))), "missing {field}: {telemetry}");
        }
        assert_eq!(finalize_output(plan, false, Ok(result.status)).0, "succeeded");
        let result = engine::command(&probe).args(["-v", "error", "-show_streams", "-of", "json"]).arg(&output).output().await.unwrap();
        assert!(result.status.success());
        let metadata: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(metadata["streams"][0]["width"], 128);
        assert_eq!(metadata["streams"][0]["height"], 72);
        assert_eq!(metadata["streams"][0]["codec_name"], "mpeg4");
        assert_eq!(metadata["streams"].as_array().unwrap().len(), 1);

        let reencoded = directory.path().join("scaled.mp4");
        let file_request = JobRequest { id: "file-transcode".into(), executable: executable.to_string_lossy().into_owned(), args: vec!["-i".into(), output.to_string_lossy().into_owned(), "-c:v".into(), "mpeg4".into(), "-vf".into(), "scale=64:36".into(), "-an".into(), reencoded.to_string_lossy().into_owned()] };
        let plan = make_plan(&file_request).unwrap();
        assert!(plan.args.iter().any(|value| value == "-format_whitelist"));
        let result = engine::command(&executable).args(&plan.args).output().await.unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        assert_eq!(finalize_output(plan, false, Ok(result.status)).0, "succeeded");
        let result = engine::command(&probe).args(["-v", "error", "-show_streams", "-of", "json"]).arg(&reencoded).output().await.unwrap();
        let metadata: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(metadata["streams"][0]["width"], 64);
        assert_eq!(metadata["streams"][0]["height"], 36);
        let mut same_source = file_request;
        *same_source.args.last_mut().unwrap() = output.to_string_lossy().into_owned();
        assert!(make_plan(&same_source).unwrap_err_text().contains("输入源文件"));

        let output = directory.path().join("canceled.mp4");
        let mut request = sample(&output);
        request.args.splice(0..0, ["-re".into()]);
        request.args[6] = "30".into(); // -re shifts the -t argument by one.
        let plan = make_plan(&request).unwrap();
        let mut child = engine::command(&executable).args(&plan.args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take();
        let pid = child.id();
        tokio::time::sleep(Duration::from_millis(250)).await;
        let status = graceful_stop(&mut child, &mut stdin, pid).await.unwrap();
        // q normally returns exit code 0: cancellation must still take priority.
        assert!(status.success());
        assert_eq!(finalize_output(plan, true, Ok(status)).0, "canceled");
        assert!(!output.exists());
    }

    #[tokio::test]
    #[ignore = "requires FFMPEG_PATH and FFPROBE_PATH pointing to installed engines"]
    async fn corrupted_media_fails_with_quiet_logs_and_recovers_safely() {
        async fn finish_stage<T>(stage: &str, operation: impl std::future::Future<Output = T>) -> T {
            match tokio::time::timeout(Duration::from_secs(30), operation).await {
                Ok(result) => result,
                Err(_) => {
                    match stage {
                        "generate fixture" => eprintln!("::error::Corrupted-media regression timed out during fixture generation."),
                        "locate video packet" => eprintln!("::error::Corrupted-media regression timed out during packet inspection."),
                        "inspect damaged metadata" => eprintln!("::error::Corrupted-media regression timed out during damaged metadata inspection."),
                        "prepare damaged input" => eprintln!("::error::Corrupted-media regression timed out during damaged input preparation."),
                        "encode damaged input" => eprintln!("::error::Corrupted-media regression timed out during normal failure handling."),
                        "encode damaged input quietly" => eprintln!("::error::Corrupted-media regression timed out during quiet failure handling."),
                        "prepare recovery" => eprintln!("::error::Corrupted-media regression timed out during recovery preparation."),
                        "encode recovery" => eprintln!("::error::Corrupted-media regression timed out during recovery encoding."),
                        "inspect recovery" => eprintln!("::error::Corrupted-media regression timed out during recovered output inspection."),
                        _ => eprintln!("::error::Corrupted-media regression timed out during an unclassified test stage."),
                    }
                    panic!("corrupted-media regression stage '{stage}' exceeded 30 seconds");
                }
            }
        }

        let executable = PathBuf::from(std::env::var("FFMPEG_PATH").expect("set FFMPEG_PATH"));
        let probe = PathBuf::from(std::env::var("FFPROBE_PATH").expect("set FFPROBE_PATH"));
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("original-faststart.mp4");
        let damaged = directory.path().join("damaged-faststart.mp4");
        let generated = finish_stage("generate fixture", engine::command(&executable).args([
            "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12", "-t", "3",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
        ]).arg(&source).output()).await.unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let original_bytes = fs::read(&source).unwrap();
        let packets = finish_stage("locate video packet", engine::command(&probe).args([
            "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pos,size", "-of", "json",
        ]).arg(&source).output()).await.unwrap();
        assert!(packets.status.success(), "{}", String::from_utf8_lossy(&packets.stderr));
        let packets: Value = serde_json::from_slice(&packets.stdout).unwrap();
        let packets = packets["packets"].as_array().unwrap();
        assert_eq!(packets.len(), 36);
        let packet = &packets[packets.len() / 2];
        let position = packet["pos"].as_str().unwrap().parse::<usize>().unwrap();
        let size = packet["size"].as_str().unwrap().parse::<usize>().unwrap();
        assert!(size > 4 && position > 0 && position.checked_add(size).is_some_and(|end| end <= original_bytes.len()));
        let mut damaged_bytes = original_bytes.clone();
        // MP4 stores the NAL length before the packet payload. Invalidating a
        // later real packet preserves moov and earlier decodable video, unlike
        // a missing header rejected before the production encoder ever starts.
        damaged_bytes[position..position + size].fill(0xff);
        fs::write(&damaged, &damaged_bytes).unwrap();
        assert_eq!(damaged_bytes.len(), original_bytes.len());
        let metadata = finish_stage("inspect damaged metadata", engine::probe_media_path(&executable, damaged.to_str().unwrap())).await.unwrap();
        assert!(metadata.has_video && !metadata.has_audio);
        assert_eq!((metadata.width, metadata.height), (Some(160), Some(90)));
        assert_eq!(metadata.frame_rate, Some(12.0));
        assert!((metadata.duration_seconds.unwrap() - 3.0).abs() < 0.05);

        let request = |input: &Path, id: &str, quiet: bool| {
            let output = directory.path().join(format!("{id}.mp4"));
            let mut args = vec!["-i".into(), input.to_str().unwrap().into(), "-c:v".into(), "mpeg4".into(), "-an".into()];
            if quiet { args.extend(["-loglevel", "quiet"].map(String::from)); }
            args.push(output.to_str().unwrap().into());
            JobRequest { id: id.into(), executable: executable.to_str().unwrap().into(), args }
        };
        for (id, quiet) in [("normal-failure", false), ("quiet-failure", true)] {
            let output = directory.path().join(format!("{id}.mp4"));
            let plan = make_plan(&request(&damaged, id, quiet)).unwrap();
            assert_eq!(plan.args.iter().filter(|token| token.as_str() == "-xerror").count(), 1);
            let staged = plan.staged.path().to_owned();
            let canceled = AtomicBool::new(false);
            let notify = Notify::new();
            let (mut command, duration) = finish_stage("prepare damaged input", prepare_command(&executable, &plan, &canceled, &notify)).await.unwrap();
            assert!((duration.unwrap().seconds - 3.0).abs() < 0.05);
            let phase = if quiet { "encode damaged input quietly" } else { "encode damaged input" };
            let encoded = finish_stage(phase, command.output()).await.unwrap();
            let partial_bytes = fs::metadata(&staged).map(|metadata| metadata.len()).unwrap_or(0);
            // Observation only: encoders may buffer differently across builds.
            // A forced timeout is never considered the expected media failure.
            println!("corrupted-media {id}: staged partial bytes={partial_bytes}");
            assert!(!encoded.status.success(), "damaged media unexpectedly encoded successfully");
            if quiet { assert!(encoded.stderr.is_empty(), "quiet failure must not depend on stderr logs"); }
            assert_eq!(finalize_output(plan, false, Ok(encoded.status)).0, "failed");
            assert!(!output.exists(), "damaged media was published");
            assert!(!staged.exists(), "failed staged output was not removed");
        }

        // Keep the same encoder and quiet log setting; replacing only the
        // damaged input with its original must produce a complete real result.
        let output = directory.path().join("recovered.mp4");
        let plan = make_plan(&request(&source, "recovered", true)).unwrap();
        assert_eq!(plan.args.iter().filter(|token| token.as_str() == "-xerror").count(), 1);
        let staged = plan.staged.path().to_owned();
        let canceled = AtomicBool::new(false);
        let notify = Notify::new();
        let (mut command, duration) = finish_stage("prepare recovery", prepare_command(&executable, &plan, &canceled, &notify)).await.unwrap();
        assert!((duration.unwrap().seconds - 3.0).abs() < 0.05);
        let encoded = finish_stage("encode recovery", command.output()).await.unwrap();
        assert!(encoded.status.success(), "valid source failed with the same production configuration");
        assert!(encoded.stderr.is_empty());
        assert_eq!(finalize_output(plan, false, Ok(encoded.status)).0, "succeeded");
        assert!(!staged.exists());
        let metadata = finish_stage("inspect recovery", probe_json(&probe, &output)).await;
        assert_eq!(metadata["streams"].as_array().unwrap().len(), 1);
        assert_eq!(metadata["streams"][0]["codec_name"], "mpeg4");
        assert_eq!(metadata["streams"][0]["width"], 160);
        assert_eq!(metadata["streams"][0]["height"], 90);
        assert_eq!(metadata["streams"][0]["nb_frames"], "36");
        assert!((metadata["format"]["duration"].as_str().unwrap().parse::<f64>().unwrap() - 3.0).abs() < 0.05);
        assert_eq!(fs::read(&source).unwrap(), original_bytes);
        assert_eq!(fs::read(&damaged).unwrap(), damaged_bytes);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 3, "unexpected failed or staged outputs remain");
    }

    trait ErrorText { fn unwrap_err_text(self) -> String; }
    impl ErrorText for Result<Plan, String> {
        fn unwrap_err_text(self) -> String { match self { Err(error) => error, Ok(_) => panic!("expected error") } }
    }
}
