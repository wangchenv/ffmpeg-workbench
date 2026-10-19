import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import JobCard from './JobCard';
import { version as appVersion } from '../package.json';
import ResultPreview from './ResultPreview';
import { parseProgress, formatMediaTime } from './core/progress';
import type { JobRecord, ProcessingPhase } from './core/progress';
import {
  Activity, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight,
  CircleHelp, Code2, Copy, Download, Film, FolderOpen, ListFilter,
  LoaderCircle, Maximize, Music2, PanelBottomClose, PanelBottomOpen, Play,
  Save, Scissors, Search, Settings2, ShieldCheck, Sparkles, Terminal,
  Video, Volume2, VolumeX, Wand2, X,
} from 'lucide-react';
import { compileProject, createDemoProject, deserializeProject, formatCommand, getOutputOption, parseHelp, replaceInputs, validateProject } from './core';
import { advancedSettings, applyAdvancedSetting, applyFeatureConfig, readAdvancedSetting, readFeatureConfig, getAdvancedChoiceIssue, getAudioBitrateIssue, getAudioSampleRateIssue } from './core/features';
import type { AdvancedSettingDefinition, FeatureConfig, FeaturePurpose } from './core/features';
import type { ProjectDocument } from './core/types';
import { native, enginePathDefault, scanEngine, copyEngineToCache, chooseInputs, chooseOutput, saveProject, openProject, runJob, cancelJob, subscribeJobs, probeMedia, chooseEngine, revealOutputFile } from './bridge';
import type { EngineInfo, JobEvent, MediaInfo } from './bridge';

type Job = JobRecord;
const uid = () => crypto.randomUUID();
const filename = (path: string) => path.split(/[\\/]/).pop() || path;
const tools: { id: FeaturePurpose; title: string; description: string; icon: typeof Video }[] = [
  { id: 'compress', title: '压缩视频', description: '文件更小，方便发送和保存', icon: Download },
  { id: 'convert', title: '转换格式', description: '让视频在需要的设备上播放', icon: Film },
  { id: 'trim', title: '截取片段', description: '留下需要的那一段', icon: Scissors },
  { id: 'resize', title: '调整画面', description: '修改尺寸、旋转或翻转', icon: Maximize },
  { id: 'audio', title: '提取音频', description: '把视频里的声音单独保存', icon: Music2 },
  { id: 'mute', title: '去除声音', description: '保留画面，生成静音视频', icon: VolumeX },
];
const qualityLabels = { high: '画质优先', balanced: '均衡', small: '体积优先' };
const displayTime = (value: string) => value.includes(':') ? value : value + ' 秒';
const resizeLabels = { original: '保持原尺寸', '1080': '1080p · 高清', '720': '720p · 日常分享', '480': '480p · 更小文件', custom: '自定义高度' };
const formatLabels: Record<FeatureConfig['format'], string> = { mp4: 'MP4 · 大多数设备都能播放', mkv: 'MKV · 适合保存多种媒体', mov: 'MOV · 常用于剪辑', webm: 'WebM · 适合网页', mp3: 'MP3 · 通用音频', wav: 'WAV · 无压缩音频', flac: 'FLAC · 无损音频' };

function makeInitial(): ProjectDocument {
  try {
    const raw = localStorage.getItem('ffwb.project.v1');
    if (raw) return deserializeProject(raw);
  } catch { /* Invalid saved data must not prevent startup. */ }
  const project = createDemoProject();
  project.name = '我的视频处理';
  const output = project.nodes.find(n => n.kind === 'output');
  if (output && import.meta.env.DEV && import.meta.env.VITE_SAMPLE_OUTPUT_PATH) output.tokens = [import.meta.env.VITE_SAMPLE_OUTPUT_PATH.replace(/\.mp4$/, '-' + Date.now().toString().slice(-6) + '.mp4')];
  return project;
}

function DraftInput({ value, onCommit, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & { value: string | number; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input {...props} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => { if (draft !== String(value)) { onCommit(draft); setDraft(String(value)); } }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Switch({ label, hint, checked, onChange, disabled = false }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <div className="switch-row"><div className="switch-text"><strong>{label}</strong>{hint && <p>{hint}</p>}</div><button type="button" className={'toggle ' + (checked ? 'on' : '')} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span/></button></div>;
}
function Step({ number, title, description, action, children }: { number: string; title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return <section className="step-card"><div className="step-heading"><span className="step-number">{number}</span><div className="step-title"><h2>{title}</h2><p>{description}</p></div>{action && <div className="step-actions">{action}</div>}</div>{children}</section>;
}
function seconds(value: string): number {
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

export default function App() {
  const [project, setProject] = useState(makeInitial);
  const [page, setPage] = useState<'workspace' | 'settings' | 'queue'>('workspace');
  const [engine, setEngine] = useState<EngineInfo>({ path: enginePathDefault, version: native ? '正在连接' : '界面预览', available: false });
  const [enginePath, setEnginePath] = useState(() => localStorage.getItem('ffwb.engine') || enginePathDefault);
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState(0);
  const [engineModal, setEngineModal] = useState(false);
  const [helpModal, setHelpModal] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部设置');
  const [toast, setToast] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'command' | 'logs' | 'issues'>('command');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [eventsReady, setEventsReady] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [detailsJobId, setDetailsJobId] = useState<string>();
  const [previewJob, setPreviewJob] = useState<Job>();
  const [media, setMedia] = useState<{path: string; info?: MediaInfo; loading: boolean; error?: string}>({path: '', loading: false});
  const [sourceRevision, setSourceRevision] = useState(0);
  const cancelRequests = useRef(new Set<string>());
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<ProjectDocument[]>([]);
  const [extra, setExtra] = useState(false);
  const busy = useRef(false);
  const browserOpen = useRef<HTMLInputElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const pageScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { pageScroll.current?.scrollTo({top: 0}); }, [page]);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { try { localStorage.setItem('ffwb.project.v1', JSON.stringify(project)); } catch { /* A full storage quota does not block editing. */ } }, [project]);
  const edit = useCallback((change: (p: ProjectDocument) => ProjectDocument) => {
    try {
      const next = change(structuredClone(project));
      setHistory(h => [...h.slice(-29), project]);
      setProject(next);
      return true;
    } catch (error) { notify(String(error).replace(/^Error: /, '')); return false; }
  }, [project, notify]);
  const feature = useMemo(() => readFeatureConfig(project), [project]);
  const config = feature.config;
  const change = (patch: Partial<FeatureConfig>) => edit(p => {
    const next = applyFeatureConfig(p, patch);
    const restored = advancedSettings.filter(d => { const before = readAdvancedSetting(p, d.id); const after = readAdvancedSetting(next, d.id); return before !== undefined && before !== false && before !== '' && before !== '0' && (after === undefined || after === false || after === ''); });
    const before = readFeatureConfig(p).config;
    const after = readFeatureConfig(next).config;
    const adjustments: string[] = [];
    if (restored.length) adjustments.push('以下设置已恢复自动：' + restored.map(d => d.label).join('、'));
    if (patch.audioBitrate === undefined && before.audioBitrate !== after.audioBitrate) adjustments.push('声音清晰度已调整为 ' + after.audioBitrate + ' kbps');
    if (patch.audioSampleRate === undefined && before.audioSampleRate !== after.audioSampleRate) adjustments.push('声音采样率已调整为' + (after.audioSampleRate === 'original' ? '自动适配' : after.audioSampleRate + ' Hz'));
    if (adjustments.length) notify('为适配新的处理设置，' + adjustments.join('；'));
    return next;
  });
  const args = useMemo(() => compileProject(project), [project]);
  const command = useMemo(() => { try { return formatCommand(engine.path || 'ffmpeg', args); } catch (error) { return '请检查配置：' + String(error); } }, [engine.path, args]);
  const issues = useMemo(() => validateProject(project), [project]);
  const inputs = project.nodes.filter(n => n.kind === 'input' && n.enabled);
  const output = project.nodes.find(n => n.kind === 'output' && n.enabled);
  const outputPath = output?.tokens[0] || '';
  const sourcePath = inputs[0]?.tokens[1] || '';
  const demo = sourcePath.startsWith('testsrc2=');
  const activeJob = jobs.find(j => j.state === 'running' || j.state === 'starting');
  const selectedTool = tools.find(t => t.id === config.purpose) || tools[0];
  const audioOnly = config.audioMode === 'extract';
  const codec = getOutputOption(project, '-c:v')?.tokens[1] || '';
  const audioCodec = getOutputOption(project, '-c:a')?.tokens[1] || '';
  const targetBitrate = readAdvancedSetting(project, 'video-bitrate');
  const bitrateActive = typeof targetBitrate === 'string' && targetBitrate !== '0';
  const missingEncoders = engine.available && engine.encoders?.length ? [codec, audioCodec].filter(c => c && c !== 'copy' && !engine.encoders!.includes(c)) : [];
  const errors = issues.filter(i => i.severity === 'error');
  const advancedIssues = advancedSettings.flatMap(d => {
    const v = readAdvancedSetting(project, d.id);
    const reason = typeof v === 'string' ? getAdvancedChoiceIssue(project, d.id, v) : undefined;
    return reason ? [`${d.label}：${reason}`] : [];
  }).concat([getAudioBitrateIssue(project, config.audioBitrate), getAudioSampleRateIssue(project, config.audioSampleRate)].flatMap(reason => reason ? [reason] : []));
  const allSettings = advancedSettings.filter(d => (category === '全部设置' || category === d.category) && `${d.label}${d.description}${d.option}`.toLowerCase().includes(search.toLowerCase()));
  const configuredCount = advancedSettings.filter(d => { const v = readAdvancedSetting(project, d.id); return v !== undefined && v !== false && v !== '' && !(d.id === 'video-bitrate' && v === '0'); }).length;
  const canEdit = !feature.readonly;
  const sourceInfo = media.path === sourcePath ? media.info : undefined;
  const sourceLoading = media.path === sourcePath && media.loading;
  const sourceError = media.path === sourcePath ? media.error : undefined;
  const detailJob = jobs.find(j => j.id === detailsJobId);
  const displayedLogs = detailJob?.logs ?? logs;
  useEffect(() => {
    if (!activeJob) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [activeJob?.id]);
  useEffect(() => {
    let current = true;
    if (!native || !engine.available || !sourcePath || demo) { setMedia({path: sourcePath, loading: false}); return; }
    setMedia({path: sourcePath, loading: true});
    probeMedia(engine.path, sourcePath).then(info => { if (current) setMedia({path: sourcePath, info, loading: false}); }).catch(error => { if (current) setMedia({path: sourcePath, loading: false, error: String(error)}); });
    return () => { current = false; };
  }, [engine.path, engine.available, sourcePath, sourceRevision, demo]);

  const scan = useCallback(async (path: string) => {
    setScanning(true);
    setDiscovered(0);
    try {
      const result = await scanEngine(path);
      setEngine(result);
      if (result.available) {
        try { localStorage.setItem('ffwb.engine', result.path); } catch { /* Storage failure does not invalidate a connected engine. */ }
        setDiscovered(parseHelp(result.help || '').options.length);
      }
    } catch (error) { setEngine({ path, version: '', available: false, error: String(error) }); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void scan(enginePath); }, []);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let mounted = true;
    subscribeJobs((event: JobEvent) => {
      if (event.kind === 'log') {
        const line = event.message || '';
        setLogs(old => [...old.slice(-499), line]);
        setJobs(old => old.map(j => j.id === event.jobId ? { ...j, logs: [...j.logs.slice(-499), line] } : j));
      }
      if (event.kind === 'progress') {
        const data = event.data || {};
        const sampledSpeed = Number(data.speed?.replace(/x$/, ''));
        setJobs(old => old.map(j => j.id === event.jobId && !['succeeded', 'failed', 'canceled'].includes(j.state) ? { ...j, ...parseProgress(j, data), lastProgressAt: Date.now(), ...(Number.isFinite(sampledSpeed) && sampledSpeed > 0 ? {lastSpeedAt: Date.now()} : {}) } : j));
      }
      if (event.kind === 'state' && event.state) {
        const state = event.state;
        setJobs(old => old.map(j => {
          if (j.id !== event.jobId || ['succeeded', 'failed', 'canceled'].includes(j.state)) return j;
          const phase = event.data?.phase;
          const total = Number(event.data?.duration_seconds);
          const finalSize = Number(event.data?.final_size_bytes);
          const terminal = ['succeeded', 'failed', 'canceled'].includes(state);
          return { ...j, state,
            phase: ['preparing', 'processing', 'finalizing'].includes(phase || '') ? phase as ProcessingPhase : j.phase,
            ...(Number.isFinite(total) && total > 0 ? {duration: total} : {}),
            ...(event.data?.final_size_bytes && Number.isFinite(finalSize) && finalSize >= 0 ? {sizeBytes: finalSize} : {}),
            ...(terminal ? {finishedAt: Date.now(), cancelRequested: false} : {startedAt: j.startedAt ?? Date.now()}),
            ...(state === 'failed' ? {failureMessage: event.message} : {}),
            logs: event.message ? [...j.logs.slice(-499), event.message] : j.logs };
        }));
        if (['succeeded', 'failed', 'canceled'].includes(state)) {
          busy.current = false;
          cancelRequests.current.delete(event.jobId);
          if (event.message) setLogs(old => [...old.slice(-499), event.message!]);
          notify(state === 'succeeded' ? '处理完成，文件已保存到你选择的位置' : state === 'canceled' ? '任务已取消' : '处理未完成，请查看任务详情中的原因');
        }
      }
    }).then(fn => { if (mounted) { dispose = fn; setEventsReady(true); } else fn(); }).catch(error => { if (mounted) notify('任务进度连接失败，请重新打开应用后重试：' + String(error)); });
    return () => { mounted = false; dispose?.(); };
  }, [notify]);
  useEffect(() => {
    if (!native || !engine.available || !eventsReady || busy.current || jobs.some(j => ['running', 'starting'].includes(j.state))) return;
    const next = jobs.find(j => j.state === 'queued');
    if (!next) return;
    busy.current = true;
    setJobs(old => old.map(j => j.id === next.id ? { ...j, state: 'starting', startedAt: Date.now(), phase: 'preparing' } : j));
    const runtimeArgs = next.args.includes('-progress') ? next.args : ['-progress', 'pipe:1', ...next.args];
    runJob({ id: next.id, executable: next.executable, args: runtimeArgs.includes('-nostats') ? runtimeArgs : ['-nostats', ...runtimeArgs] }).then(() => { if (cancelRequests.current.has(next.id)) void cancelJob(next.id).catch(() => {}); }).catch(error => {
      busy.current = false;
      const message = String(error);
      setJobs(old => old.map(j => j.id === next.id ? { ...j, state: cancelRequests.current.has(next.id) ? 'canceled' : 'failed', finishedAt: Date.now(), cancelRequested: false, failureMessage: message, logs: [...j.logs, message] } : j));
      setLogs(old => [...old.slice(-499), message]); notify(message);
    });
  }, [jobs, engine, eventsReady, notify]);
  useEffect(() => { if (drawer && drawerTab === 'logs') logEnd.current?.scrollIntoView({ block: 'nearest' }); }, [displayedLogs, drawer, drawerTab]);

  function selectTool(purpose: FeaturePurpose) {
    change({ purpose, ...(purpose === 'audio' ? { audioMode: 'extract' as const, format: 'mp3' as const } : audioOnly ? { audioMode: 'keep' as const, format: 'mp4' as const } : config.purpose === 'mute' ? { audioMode: 'keep' as const } : {}), ...(purpose === 'mute' ? { audioMode: 'mute' as const } : {}), ...(purpose === 'trim' ? { trimEnabled: true } : {}) });
    setPage('workspace');
  }
  async function selectEngine() {
    if (!native) { notify('请在桌面版选择本机 FFmpeg 文件'); return; }
    try { const path = await chooseEngine(); if (path) { setEnginePath(path); await scan(path); } } catch (error) { notify(String(error)); }
  }
  async function connectEngineCopy() {
    setScanning(true);
    setDiscovered(0);
    try {
      const result = await copyEngineToCache(enginePath);
      setEngine(result);
      if (result.available) {
        setEnginePath(result.path);
        try { localStorage.setItem('ffwb.engine', result.path); } catch { /* Keep the verified connection even if storage is unavailable. */ }
        setDiscovered(parseHelp(result.help || '').options.length);
        notify('已使用本机缓存副本连接，原引擎文件保留');
      }
    } catch (error) {
      setEngine({path: enginePath, version: '', available: false, error: String(error)});
    } finally { setScanning(false); }
  }
  async function addInput() {
    if (!native) { notify('这是桌面界面的浏览器预览。请在桌面版选择本地素材，或使用内置示例体验配置。'); return; }
    if (!canEdit || inputs.length > 1) { notify('此工程包含多素材或复杂处理，已保留完整配置。请先载入新示例，再选择素材。'); return; }
    try {
      const paths = await chooseInputs();
      if (!paths.length) return;
      const changed = edit(p => {
        // The friendly workflow processes one source. Preserve unrelated nodes rather than silently merging files.
        const existing = p.nodes.filter(n => n.kind === 'input' && n.enabled).map(n => n.id);
        let next = p;
        if (demo) next = replaceInputs(p, [paths[0]]);
        else if (existing.length === 1) next.nodes.find(n => n.id === existing[0])!.tokens = ['-i', paths[0]];
        else next = replaceInputs(p, [paths[0]]);
        if (demo) next = applyFeatureConfig(next, { trimEnabled: false, audioMode: 'keep', purpose: 'compress', format: 'mp4', quality: 'balanced' });
        next.name = filename(paths[0]).replace(/\.[^.]+$/, '') + ' · 处理';
        const out = next.nodes.find(n => n.kind === 'output' && n.enabled);
        if (out) out.tokens = [paths[0].replace(/\.[^./\\]+$/, '') + '-处理-' + Date.now().toString().slice(-6) + '.' + readFeatureConfig(next).config.format];
        return next;
      });
      if (changed) {
        setSourceRevision(revision => revision + 1);
        notify(paths.length > 1 ? '已选择第一个素材；当前版本按单个文件处理' : '素材已准备好，可以选择想要的处理效果');
      }
    } catch (error) { notify(String(error)); }
  }
  async function selectOutput() {
    if (!native) { notify('桌面版可以选择保存位置；预览中可直接编辑下方路径。'); return; }
    try {
      const path = await chooseOutput(filename(outputPath), config.format);
      if (path && output) {
        const extension = path.split('.').at(-1)?.toLowerCase();
        if (extension !== config.format) { notify('请使用 .' + config.format + ' 扩展名，与选择的输出格式保持一致'); return; }
        edit(p => { p.nodes.find(n => n.id === output.id)!.tokens = [path]; return p; });
      }
    } catch (error) { notify(String(error)); }
  }
  async function save() {
    try { if (await saveProject(JSON.stringify(project, null, 2))) notify('配置已保存，下次可以继续使用'); } catch (error) { notify(String(error)); }
  }
  function loadProject(content: string) {
    try { const parsed = deserializeProject(content); edit(() => parsed); setPage('workspace'); notify('配置已载入'); } catch (error) { notify(String(error)); }
  }
  async function open() {
    if (!native) { browserOpen.current?.click(); return; }
    try { const content = await openProject(); if (content) loadProject(content); } catch (error) { notify(String(error)); }
  }
  function resetDemo() {
    const demoProject = createDemoProject();
    demoProject.name = '我的视频处理';
    const out = demoProject.nodes.find(n => n.kind === 'output');
    if (out && import.meta.env.DEV && import.meta.env.VITE_SAMPLE_OUTPUT_PATH) out.tokens = [import.meta.env.VITE_SAMPLE_OUTPUT_PATH.replace(/\.mp4$/, '-' + Date.now().toString().slice(-6) + '.mp4')];
    edit(() => applyFeatureConfig(demoProject, { purpose: 'compress' }));
    setPage('workspace'); setExtra(false); setHelpModal(false); notify('已载入 5 秒测试画面，可以直接试用');
  }
  function enqueue() {
    if (!native) { setHelpModal(true); return; }
    if (!engine.available) { setEngineModal(true); return; }
    if (!eventsReady) { notify('任务进度连接尚未准备好，请稍后再试；如持续出现，请重新打开应用'); return; }
    if (!canEdit) { notify('当前复杂配置尚未支持这版功能化处理，请先载入示例或普通素材'); return; }
    if (inputs.length !== 1 || project.nodes.filter(n => n.kind === 'output' && n.enabled).length !== 1) { notify('当前功能化流程支持一个素材、一个输出，请用普通素材开始新配置'); return; }
    if (!demo && sourceLoading) { notify('正在读取素材信息，请稍候再开始处理'); return; }
    if (!demo && sourceError) { notify('无法读取素材，请用“更换素材”重新选择文件'); return; }
    if (errors.length || missingEncoders.length || advancedIssues.length) { setDrawer(true); setDrawerTab('issues'); notify('有配置需要调整，请查看检查结果'); return; }
    if (demo && audioOnly) { notify('内置测试画面没有声音，请选择一个包含声音的本地视频'); return; }
    if (sourceInfo && audioOnly && !sourceInfo.hasAudio) { notify('这个素材没有声音轨道，请选择包含声音的视频或音频文件'); return; }
    if (sourceInfo && !audioOnly && !sourceInfo.hasVideo) { notify('这个素材只有声音，请选择“提取音频”功能处理'); return; }
    const start = config.trimEnabled ? seconds(config.trimStart) : 0;
    const available = sourceInfo?.durationSeconds === undefined ? undefined : Math.max(0, sourceInfo.durationSeconds - start);
    if (available !== undefined && available <= 0) { notify('片段开始位置已超出素材时长，请调整开始时间'); return; }
    const duration = config.trimEnabled ? Math.min(seconds(config.trimDuration), available ?? Infinity) : available;
    const job: Job = { id: uid(), name: selectedTool.title + ' · ' + (demo ? '测试画面' : filename(sourcePath)), executable: engine.path, duration, args: [...args], output: outputPath, source: sourcePath, format: config.format, video: !audioOnly, queuedAt: Date.now(), state: 'queued', phase: 'preparing', processedSeconds: 0, logs: [] };
    setJobs(old => [...old, job]);
    setDetailsJobId(job.id); setLogs([]); setPage('queue'); setDrawer(false); notify(activeJob ? '已加入队列，前面的任务结束后自动开始' : '已提交本机处理，正在准备素材');
  }
  function requestCancel(job: Job) {
    if (job.state === 'queued') { setJobs(old => old.map(j => j.id === job.id ? {...j, state: 'canceled', finishedAt: Date.now()} : j)); return; }
    cancelRequests.current.add(job.id);
    setJobs(old => old.map(j => j.id === job.id ? {...j, cancelRequested: true} : j));
    void cancelJob(job.id).catch(error => {
      if (job.state === 'starting') return; // Native preflight may not have registered the job yet; runJob.then sends this pending request.
      cancelRequests.current.delete(job.id);
      setJobs(old => old.map(j => j.id === job.id ? {...j, cancelRequested: false} : j));
      notify(String(error));
    });
  }
  async function revealResult(job: Job) {
    try { await revealOutputFile(job.id); } catch (error) { notify(String(error).replace(/^Error: /, '')); }
  }
  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { notify('复制失败，可手动选择命令文本'); }
  }
  function settingCard(definition: AdvancedSettingDefinition) {
    const rawValue = readAdvancedSetting(project, definition.id);
    const value = definition.id === 'video-bitrate' && rawValue === '0' ? undefined : rawValue;
    const importedChoice = definition.control === 'select' && typeof value === 'string' && !definition.choices?.some(c => c.value === value);
    const importedNumber = definition.control === 'number' && typeof value === 'string' && (!/^-?\d+$/.test(value) || Number(value) < (definition.min ?? -Infinity) || Number(value) > (definition.max ?? Infinity));
    const choiceIssue = typeof value === 'string' ? getAdvancedChoiceIssue(project, definition.id, value) : undefined;
    const formatMismatch = definition.compatibleFormats && !definition.compatibleFormats.includes(config.format);
    const codecMismatch = definition.compatibleCodecs && !definition.compatibleCodecs.some(c => c === codec || c === audioCodec);
    const videoSetting = definition.category === '视频' || /^-(?:pix_fmt|profile|level|color_|colorspace|color_primaries|color_trc|fps_mode)/.test(definition.option);
    const audioSetting = definition.category === '音频';
    const mediaMismatch = (audioOnly && videoSetting) || (config.audioMode === 'mute' && audioSetting);
    const disabled = !canEdit || !!formatMismatch || !!codecMismatch || !definition.executable || mediaMismatch;
    const set = (next: string | boolean | undefined) => edit(p => applyAdvancedSetting(p, definition.id, next));
    return <section className={'setting-card ' + (disabled ? 'unavailable' : '')} key={definition.id}>
      <div className="setting-header"><h3>{definition.label}</h3>{value !== undefined && value !== false && value !== '' && <span className="pill">已设置</span>}</div>
      <p className="setting-help">{definition.description}</p>
      <div className="setting-control">{definition.control === 'toggle' ? <Switch label={'启用' + definition.label} checked={value === true} disabled={disabled} onChange={set}/> : definition.control === 'select' ? <select aria-label={definition.label} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={e => set(e.target.value || undefined)}><option value="" disabled={!!getAdvancedChoiceIssue(project, definition.id, undefined)}>自动 / 保持默认</option>{importedChoice && <option value={String(value)}>导入原值：{String(value)}（候选列表外）</option>}{definition.choices?.map(c => <option key={c.value} value={c.value} disabled={!!getAdvancedChoiceIssue(project, definition.id, c.value)}>{c.label}{getAdvancedChoiceIssue(project, definition.id, c.value) ? ' · 当前组合不适用' : ''}</option>)}</select> : <DraftInput aria-label={definition.label} type={definition.control === 'number' ? 'number' : 'text'} min={definition.min} max={definition.max} value={typeof value === 'string' ? value : ''} placeholder={definition.control === 'number' ? '自动' : '留空保持默认'} disabled={disabled} onCommit={v => set(v || undefined)}/>}</div>
      {importedChoice && <p className="inline-note">已保留导入原值 {String(value)}，尚未改写。可以选择提供的值，或清空恢复自动。</p>}
      {importedNumber && <p className="inline-note">已保留导入原值 {String(value)}，尚未改写。此输入框支持 {definition.min} 到 {definition.max} 的整数；调整时请输入范围内值，或清空恢复自动。</p>}
      {choiceIssue && <p className="unavailable-tag">{choiceIssue}；请选择适用的值或恢复自动。</p>}
      {definition.control === 'select' && !choiceIssue && definition.choices?.some(c => getAdvancedChoiceIssue(project, definition.id, c.value)) && <p className="field-hint">部分选项与当前编码方式或兼容级别不匹配，已标为不可选；切换对应编码方式后可以使用。</p>}
      {disabled && <p className="unavailable-tag">{formatMismatch ? '适用于 ' + definition.compatibleFormats!.join(' / ').toUpperCase() + ' 格式' : codecMismatch ? '需要在声音或视频设置中选择对应编码方式' : mediaMismatch ? (audioOnly ? '仅适用于包含画面的输出' : '保留声音后可以设置') : '此工程暂不支持修改'}</p>}
      <details className="setting-code"><summary>技术详情 <ChevronDown size={12}/></summary><code>{definition.option}</code></details>
    </section>;
  }

  const formatField = <Field label="保存成什么格式" hint={audioOnly ? 'MP3 适合分享；WAV 和 FLAC 适合保留声音质量。' : '不确定时选 MP4，手机和电脑普遍支持。'}><select aria-label="输出格式" value={config.format} disabled={!canEdit} onChange={e => change({ format: e.target.value as FeatureConfig['format'] })}>{(audioOnly ? ['mp3', 'wav', 'flac'] : ['mp4', 'mkv', 'mov', 'webm']).map(f => <option key={f} value={f}>{formatLabels[f as FeatureConfig['format']]}</option>)}</select></Field>;
  const encodingField = <Field label="视频兼容方式" hint={config.videoEncoding === 'efficient' ? 'H.265 文件通常更小，但部分旧手机和播放器不支持。' : config.videoEncoding === 'web' ? 'WebM 使用 VP9，适合现代浏览器播放。' : config.videoEncoding === 'builtin' ? '示例默认使用内置编码；日常视频建议选择兼容优先。' : 'H.264 适合大多数手机、电脑和播放器。'}><select aria-label="视频兼容方式" value={config.videoEncoding} disabled={!canEdit || config.format === 'webm'} onChange={e => change({ videoEncoding: e.target.value as FeatureConfig['videoEncoding'] })}><option value="compatible">兼容优先 · H.264</option><option value="efficient">节省空间 · H.265（需设备支持）</option><option value="builtin">内置编码 · MPEG-4</option>{config.format === 'webm' && <option value="web">网页视频 · VP9</option>}</select></Field>;
  const qualityControl = <div className="feature-section"><h3>你更在意什么？</h3>{bitrateActive && <p className="inline-note">当前使用自定义目标码率 {String(targetBitrate)}。选择下方倾向后，会切回按画质压缩。</p>}<div className="choice-grid">{(['high', 'balanced', 'small'] as const).map(q => <button key={q} className={'choice-button ' + (!bitrateActive && config.quality === q ? 'active' : '')} aria-pressed={!bitrateActive && config.quality === q} disabled={!canEdit} onClick={() => change({ quality: q })}><span className="choice-label">{qualityLabels[q]}{!bitrateActive && config.quality === q && <Check size={14}/>}</span><span className="choice-hint">{q === 'high' ? '保留更多细节，文件较大' : q === 'balanced' ? '画质与体积都照顾到' : '方便分享，细节会减少'}</span></button>)}</div><p className="field-hint">实际文件大小取决于素材内容，不保证达到固定体积。</p></div>;
  const sizeField = <Field label="画面尺寸" hint="按高度等比例缩放；竖屏视频也会保持原比例。"><select aria-label="画面尺寸" value={config.resize} disabled={!canEdit} onChange={e => change({ resize: e.target.value as FeatureConfig['resize'] })}>{Object.entries(resizeLabels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>{config.resize === "custom" && <span className="custom-size"><span>高度（像素）</span><DraftInput aria-label="自定义画面高度" type="number" min={2} max={8192} step={2} value={config.customHeight} disabled={!canEdit} onCommit={v => change({ customHeight: Number(v) })}/></span>}</Field>;
  const trimControls = <div className="feature-section"><Switch label="只保留一段" hint="关闭后处理完整素材。开始时间和时长可以填写秒，或 00:01:30。" checked={config.trimEnabled} disabled={!canEdit || demo} onChange={v => change({ trimEnabled: v })}/>{demo && <p className="field-hint">测试画面为无限生成源，保留 5 秒时长限制；选择真实素材后可处理整段。</p>}{config.trimEnabled && <div className="field-grid"><Field label="从哪里开始" hint="例如 30 表示从第 30 秒开始。"><DraftInput aria-label="片段开始时间" value={config.trimStart} disabled={!canEdit} onCommit={v => change({ trimStart: v })}/></Field><Field label="保留多长时间" hint="例如 10 表示保留接下来的 10 秒。"><DraftInput aria-label="片段保留时长" value={config.trimDuration} disabled={!canEdit} onCommit={v => change({ trimDuration: v })}/></Field></div>}</div>;
  const pictureControls = <div className="feature-section"><div className="field-grid">{sizeField}<Field label="旋转画面" hint="拍摄方向不对时，在这里调整。"><select aria-label="旋转画面" value={config.rotation} disabled={!canEdit} onChange={e => change({ rotation: e.target.value as FeatureConfig['rotation'] })}><option value="none">不旋转</option><option value="clockwise">向右旋转 90°</option><option value="counterclockwise">向左旋转 90°</option><option value="half">旋转 180°</option></select></Field><Field label="画面流畅度" hint="一般保持原帧率即可，调高不会凭空增加画面细节。"><select aria-label="画面流畅度" value={config.fps} disabled={!canEdit} onChange={e => change({ fps: e.target.value as FeatureConfig['fps'] })}><option value="original">保持原帧率</option>{['24', '25', '30', '60'].map(v => <option key={v} value={v}>{v} 帧 / 秒</option>)}</select></Field></div><Switch label="左右镜像" hint="像照镜子一样水平翻转画面。" checked={config.flipHorizontal} disabled={!canEdit} onChange={v => change({ flipHorizontal: v })}/><Switch label="上下翻转" checked={config.flipVertical} disabled={!canEdit} onChange={v => change({ flipVertical: v })}/></div>;
  const audioControls = <div className="feature-section">{!audioOnly && <Switch label="保留声音" hint="关闭后，输出视频将没有声音。" checked={config.audioMode === 'keep'} disabled={!canEdit} onChange={v => change({ audioMode: v ? 'keep' : 'mute' })}/>}<div className="field-grid"><Field label="声音清晰度" hint={config.format === "webm" ? "WebM 通常选择 192 kbps；320 kbps 需在更多设置中先选择立体声或多声道。" : "语音通常 128 kbps 足够；音乐可以选择 192 或 320 kbps。"}><select aria-label="声音清晰度" value={config.audioBitrate} disabled={!canEdit || config.audioMode === 'mute' || ['wav','flac'].includes(config.format)} onChange={e => change({ audioBitrate: e.target.value as FeatureConfig['audioBitrate'] })}>{['96', '128', '192', '320'].map(v => <option key={v} value={v} disabled={!!getAudioBitrateIssue(project, v)}>{v} kbps{getAudioBitrateIssue(project, v) ? " · 当前组合不适用" : ""}{v === '128' ? ' · 语音常用' : v === '192' ? ' · 音乐常用' : ''}</option>)}</select></Field><Field label="声音采样率" hint={config.format === "webm" ? "网页音频使用 48 kHz；自动模式会按编码方式适配。" : "一般保持原采样率；视频制作常用 48 kHz。"}><select aria-label="声音采样率" value={config.audioSampleRate} disabled={!canEdit || config.audioMode === 'mute'} onChange={e => change({ audioSampleRate: e.target.value as FeatureConfig['audioSampleRate'] })}><option value="original">{config.format === "webm" ? "自动 · 适配网页音频" : "保持原采样率"}</option><option value="44100" disabled={!!getAudioSampleRateIssue(project, "44100")}>44.1 kHz · 音乐常用{getAudioSampleRateIssue(project, "44100") ? " · 当前格式不适用" : ""}</option><option value="48000">48 kHz · 视频常用</option></select></Field></div><Field label={'调整音量 · ' + Math.round(config.volume * 100) + '%'} hint="100% 保持原音量；超过 100% 可能失真。"><div className="range-field"><Volume2 size={17}/><input aria-label="调整音量" type="range" min="0" max="4" step="0.1" value={config.volume} disabled={!canEdit || config.audioMode === 'mute'} onChange={e => change({ volume: Number(e.target.value) })}/><span>{Math.round(config.volume * 100)}%</span></div></Field>{demo && <div className="inline-note"><CircleHelp size={15}/>测试画面没有声音；声音功能请使用包含音轨的本地素材。</div>}</div>;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">ff<span>›</span></span><div><strong>Workbench</strong><small>视频处理，简单一点</small></div></div><nav className="main-nav"><button className={page === 'workspace' ? 'active' : ''} aria-label="视频工具" onClick={() => setPage('workspace')}><Wand2 size={19}/><span>视频工具</span><ChevronRight size={14}/></button><button className={page === 'settings' ? 'active' : ''} aria-label="更多设置" onClick={() => setPage('settings')}><Settings2 size={19}/><span>更多设置</span>{configuredCount > 0 && <b className="nav-count">{configuredCount}</b>}</button><button className={page === 'queue' ? 'active' : ''} aria-label="处理任务" onClick={() => setPage('queue')}><ListFilter size={19}/><span>处理任务</span>{jobs.length > 0 && <b className="nav-count">{jobs.length}</b>}</button></nav><div className="sidebar-tip"><ShieldCheck size={19}/><p>素材留在你的电脑<br/>处理过程无需上传</p></div><div className="sidebar-bottom"><button className="sample-link" aria-label="用示例试试看" onClick={resetDemo}><Sparkles size={17}/><span>用示例试试看</span><ArrowRight size={14}/></button><button className="engine-card" aria-label="处理引擎设置" onClick={() => setEngineModal(true)}><span className={'status-dot ' + (engine.available ? 'ready' : '')}/><div><strong>{engine.available ? '本机引擎已连接' : native ? '设置处理引擎' : '界面预览模式'}</strong><small>{engine.available ? '准备好为你处理视频' : native ? '点击连接 FFmpeg' : '运行请打开桌面版'}</small></div><Settings2 size={15}/></button><div className="sidebar-footer"><span>v{appVersion} · Preview</span><button className="icon-button" aria-label="使用帮助" onClick={() => setHelpModal(true)}><CircleHelp size={17}/></button></div></div></aside>
    <main className="main-shell"><header className="topbar"><div className="breadcrumb"><span>我的工作空间</span><ChevronRight size={14}/><strong>{page === 'workspace' ? '视频工具' : page === 'settings' ? '更多设置' : '处理任务'}</strong></div><div className="top-actions"><span className="autosaved"><CheckCircle2 size={13}/>配置自动保存</span><button className="button subtle" aria-label="打开配置" onClick={open}><FolderOpen size={15}/><span>打开配置</span></button><button className="button subtle" aria-label="保存配置" onClick={save}><Save size={15}/><span>保存配置</span></button></div></header>
      <div className="page-scroll" ref={pageScroll}><div className="page-head"><div><div className="eyebrow">FFMPEG WORKBENCH</div><h1>{page === 'workspace' ? '今天，想怎么处理视频？' : page === 'settings' ? '按需要，把细节调好' : '看看处理到哪一步了'}</h1><p>{page === 'workspace' ? '选一个功能，调好效果，剩下的交给我们。' : page === 'settings' ? '每项设置都有用途说明。不确定时，保持默认就好。' : '所有任务都在本机运行，完成后保存到你选择的位置。'}</p></div><div className="head-actions">{page === 'workspace' ? <button className="button" disabled={!history.length} onClick={() => { const previous = history.at(-1); if (previous) { setProject(previous); setHistory(h => h.slice(0, -1)); } }}><ArrowLeft size={15}/>撤销修改</button> : <button className="button" onClick={() => setPage('workspace')}><ArrowLeft size={15}/>返回视频工具</button>}</div></div>
        {page === 'workspace' && <>
          <div className="tool-grid">{tools.map(t => <button key={t.id} className={'tool-card ' + (config.purpose === t.id ? 'active' : '')} aria-pressed={config.purpose === t.id} disabled={!canEdit} onClick={() => selectTool(t.id)}><span className="tool-icon"><t.icon size={22}/></span><span className="tool-copy"><strong>{t.title}</strong><span>{t.description}</span></span>{config.purpose === t.id && <CheckCircle2 className="tool-check" size={17}/>}</button>)}</div>
          {feature.warnings.length > 0 && <div className="notice warning"><CircleHelp size={18}/><div>{feature.warnings.map(w => <p key={w.code + (w.nodeId || '')}>{w.message}</p>)}</div></div>}
          <div className="friendly-layout"><div className="editor-column">
            <Step number="1" title="选择你的素材" description="支持本地视频和音频，原文件会保留。" action={<button className="button small" onClick={addInput}><FolderOpen size={15}/>{sourcePath ? '更换素材' : '选择文件'}</button>}><div className="source-box"><span className="source-icon"><Video size={29}/></span><div className="source-info"><strong>{demo ? '内置测试画面' : filename(sourcePath) || '还没有选择素材'}</strong><p>{demo ? '彩色测试画面，用来体验处理流程' : sourcePath || '点击“选择文件”开始'}</p><div className="source-tags"><span className="chip">{demo ? '示例素材' : '本地文件'}</span><span className="chip">{demo ? '1280 × 720' : '保留原文件'}</span>{demo && <span className="chip">无音轨</span>}{sourceInfo?.durationSeconds !== undefined && <span className="chip">{formatMediaTime(sourceInfo.durationSeconds)}</span>}{sourceInfo?.width && <span className="chip">{sourceInfo.width} × {sourceInfo.height}</span>}{sourceInfo && <span className="chip">{sourceInfo.hasAudio ? '包含声音' : '没有音轨'}</span>}{sourceLoading && <span className="chip">正在读取素材信息…</span>}</div></div><CheckCircle2 size={19}/></div>{!demo && sourceError && <div className="inline-note warning" role="alert"><CircleHelp size={15}/><div><strong>无法读取素材，请用“更换素材”重新选择文件。</strong><p style={{overflowWrap: 'anywhere'}}>{sourceError}</p></div></div>}</Step>
            <Step number="2" title={selectedTool.title + '，按你的需要来'} description={config.purpose === 'compress' ? '先选画质和尺寸，通常这两项就够了。' : config.purpose === 'trim' ? '指定开始位置和保留时长，不需要输入命令。' : config.purpose === 'resize' ? '所有画面调整都可以直接选择。' : audioOnly ? '选择声音格式，也可以调整音量和片段。' : '常用选项已整理好，直接选择需要的效果。'}>
              <fieldset className="feature-fieldset" disabled={!canEdit}>
                {config.purpose === 'compress' && <>{qualityControl}<div className="field-grid">{sizeField}{formatField}</div></>}
                {config.purpose === 'convert' && <><div className="field-grid">{formatField}{encodingField}</div>{qualityControl}</>}
                {config.purpose === 'trim' && <>{trimControls}<div className="field-grid">{formatField}{sizeField}</div><div className="inline-note"><Scissors size={15}/>重新编码后截取，优先保证起止位置准确。</div></>}
                {config.purpose === 'resize' && <>{pictureControls}<div className="field-grid">{formatField}</div></>}
                {audioOnly && <><div className="field-grid">{formatField}</div>{audioControls}{trimControls}</>}
                {config.purpose === 'mute' && <><div className="subtle-box"><VolumeX size={25}/><div><strong>只留下画面</strong><p>输出的视频将不包含声音，原素材不受影响。</p></div></div><div className="field-grid">{formatField}{sizeField}</div></>}
                <button className="advanced-toggle" onClick={() => setExtra(!extra)} aria-expanded={extra}><Settings2 size={16}/><span>{extra ? '收起其他调整' : '还想调整画面、声音或截取片段？'}</span><ChevronDown size={16} className={extra ? 'rotated' : ''}/></button>
                {extra && <div className="advanced-section">{!audioOnly && config.purpose !== 'resize' && <><h3>画面调整</h3>{pictureControls}</>}{!audioOnly && !['audio', 'mute'].includes(config.purpose) && <><h3>声音设置</h3>{audioControls}</>}{!['trim','audio'].includes(config.purpose) && <><h3>截取片段</h3>{trimControls}</>}{!audioOnly && config.purpose !== "convert" && encodingField}{!audioOnly && <Field label="处理速度" hint={!['compatible', 'efficient'].includes(config.videoEncoding) ? "选择兼容优先或节省空间后，可以调整处理速度。" : "较慢的处理可以提高压缩效率，电脑需要多花一点时间。"}><select aria-label="处理速度" disabled={!['compatible', 'efficient'].includes(config.videoEncoding)} value={config.speed} onChange={e => change({ speed: e.target.value as FeatureConfig['speed'] })}><option value="fast">更快完成</option><option value="medium">均衡 · 推荐</option><option value="slow">慢一些，压缩更充分</option></select></Field>}<button className="advanced-link" onClick={() => setPage('settings')}>兼容性、声音声道、文件信息等更多设置 <ArrowRight size={15}/></button></div>}
              </fieldset>
            </Step>
            <Step number="3" title="保存到哪里" description="会生成一个新文件，不覆盖已有文件。"><Field label="输出文件"><div className="output-location"><DraftInput aria-label="输出文件路径" value={outputPath} disabled={!canEdit} onCommit={path => output && edit(p => { if (!path.toLowerCase().endsWith("." + config.format)) throw new Error("请使用 ." + config.format + " 扩展名；转换格式请在上方选择。 "); p.nodes.find(n => n.id === output.id)!.tokens = [path]; return p; })}/><button className="button" disabled={!canEdit} onClick={selectOutput}><FolderOpen size={16}/><span>选择位置</span></button></div></Field></Step>
          </div><aside className="summary-column"><section className="summary-card"><div className="summary-heading"><span className="tool-icon"><selectedTool.icon size={20}/></span><div><h2>这次会得到</h2><p>{selectedTool.title}后的新文件</p></div></div><div className="summary-visual"><div className="summary-frame">{audioOnly ? <Music2 size={42}/> : <Play size={34} fill="currentColor"/>}<span>{config.format.toUpperCase()}</span></div><small>输出设置示意</small></div><div className="summary-list"><div className="summary-line"><span className="summary-label">格式</span><strong className="summary-value">{config.format.toUpperCase()}</strong></div>{!audioOnly && <><div className="summary-line"><span className="summary-label">画质倾向</span><strong className="summary-value">{bitrateActive ? String(targetBitrate) + " 目标码率" : qualityLabels[config.quality]}</strong></div><div className="summary-line"><span className="summary-label">画面尺寸</span><strong className="summary-value">{config.resize === 'custom' ? config.customHeight + ' 像素高' : resizeLabels[config.resize].split(' · ')[0]}</strong></div></>}<div className="summary-line"><span className="summary-label">保留范围</span><strong className="summary-value">{config.trimEnabled ? '从 ' + displayTime(config.trimStart) + ' 开始，保留 ' + displayTime(config.trimDuration) : '完整素材'}</strong></div><div className="summary-line"><span className="summary-label">声音</span><strong className="summary-value">{demo ? '示例没有音轨' : config.audioMode === 'mute' ? '移除声音' : audioOnly ? '单独保存' : '保留声音'}</strong></div>{configuredCount > 0 && <button className="text-button summary-extra" onClick={() => setPage('settings')}>{configuredCount} 项更多设置已配置 <ChevronRight size={13}/></button>}</div><div className="summary-footer"><button className="button primary wide" disabled={!canEdit} onClick={enqueue}>{activeJob ? <LoaderCircle size={17} className="spin"/> : <Play size={16} fill="currentColor"/>}{activeJob ? '加入处理队列' : '开始处理'}</button><p><ShieldCheck size={13}/>本地处理 · 保留原文件</p></div></section><div className="summary-help"><CircleHelp size={17}/><p>不确定怎么选？先用默认设置。所有修改都可以撤销。</p></div>{(errors.length > 0 || missingEncoders.length > 0 || advancedIssues.length > 0) && <button className="notice warning" onClick={() => { setDrawer(true); setDrawerTab('issues'); }}><CircleHelp size={17}/>有配置需要调整，查看原因 <ChevronRight size={14}/></button>}</aside></div>
        </>}
        {page === 'settings' && <><div className="catalog-intro"><Sparkles size={20}/><div><strong>不用认识参数，也能配置细节</strong><p>这些设置会直接应用到当前素材。常用的画质、尺寸、旋转和声音调整仍在视频工具里。</p></div><span className="pill">{advancedSettings.length} 项图形配置</span></div><div className="settings-layout"><nav className="settings-categories" aria-label="设置分类">{['全部设置', '视频', '音频', '兼容性', '文件组织'].map(c => <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c === '视频' ? '画面与压缩' : c === '音频' ? '声音细节' : c === '兼容性' ? '播放兼容性' : c === '文件组织' ? '文件信息与轨道' : c}<ChevronRight size={14}/></button>)}</nav><div><div className="search-field"><Search size={18}/><input aria-label="搜索设置用途" placeholder="按用途查找，例如：旧设备、声道、标题、网页播放" value={search} onChange={e => setSearch(e.target.value)}/>{search && <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={16}/></button>}</div><div className="settings-grid">{allSettings.map(settingCard)}</div>{!allSettings.length && <div className="empty-state"><Search size={30}/><h3>还没有对应的设置</h3><p>试试“颜色”“声音”或“标题”等用途。</p><button className="button" onClick={() => { setSearch(''); setCategory('全部设置'); }}>查看全部设置</button></div>}<p className="catalog-footnote">目前已完成 {advancedSettings.length} 项低频设置的中文说明与图形配置。本机发现的其他参数会逐步补充对应的功能界面。</p></div></div></>}
        {page === 'queue' && <section className="queue-panel"><div className="queue-overview"><div><ListFilter size={21}/><strong>{jobs.length}</strong><span>全部任务</span></div><div><Activity size={21}/><strong>{jobs.filter(j => ['running','starting'].includes(j.state)).length}</strong><span>正在处理</span></div><div><CheckCircle2 size={21}/><strong>{jobs.filter(j => j.state === 'succeeded').length}</strong><span>已经完成</span></div></div>{!jobs.length ? <div className="empty-state"><Film size={40}/><h3>选择一个功能，开始第一次处理</h3><p>处理进度和结果都会显示在这里。</p><button className="button primary" onClick={() => setPage('workspace')}>选择视频工具 <ArrowRight size={15}/></button></div> : <><p className="queue-explanation">显示实际处理数据。百分比和剩余时间按素材时长及当前速度估算，保存完成后显示 100%。</p><div className="job-list">{jobs.map((job, index) => <JobCard key={job.id} job={job} now={now} queuePosition={jobs.slice(0,index).filter(j => ['queued','starting','running'].includes(j.state)).length} onCancel={() => requestCancel(job)} onPreview={button => { previewTrigger.current = button; setPreviewJob(job); }} onReveal={() => void revealResult(job)} onDetails={() => { setDetailsJobId(job.id); setDrawer(true); setDrawerTab('logs'); }}/>)}</div></>}</section>}
      </div>
      <section className={'command-drawer ' + (!drawer ? 'collapsed' : '')}><div className="drawer-header"><div className="drawer-tabs"><button className={drawer && drawerTab === 'command' ? 'active' : ''} onClick={() => { setDrawer(drawerTab === 'command' ? !drawer : true); setDrawerTab('command'); }}><Terminal size={14}/>查看生成命令</button><button className={drawer && drawerTab === 'logs' ? 'active' : ''} onClick={() => { setDrawer(drawerTab === 'logs' ? !drawer : true); setDrawerTab('logs'); }}><Code2 size={14}/>处理详情</button><button className={drawer && drawerTab === 'issues' ? 'active' : ''} onClick={() => { setDrawer(drawerTab === 'issues' ? !drawer : true); setDrawerTab('issues'); }}><CheckCircle2 size={14}/>配置检查{errors.length > 0 && <span>{errors.length}</span>}</button></div><div className="drawer-tools">{drawer && drawerTab === 'command' && <button className="text-button" onClick={copyCommand}>{copied ? <Check size={14}/> : <Copy size={14}/>}<span>{copied ? '已复制' : '复制'}</span></button>}<button className="icon-button" aria-label={drawer ? '收起详情' : '展开详情'} onClick={() => setDrawer(!drawer)}>{drawer ? <PanelBottomClose size={17}/> : <PanelBottomOpen size={17}/>}</button></div></div>{drawer && <div className="drawer-body">{drawerTab === 'command' ? <div className="command-line"><code>{command}</code></div> : drawerTab === 'logs' ? <div className="log-lines">{detailJob && <p className="log-job-label">当前详情：{detailJob.name}</p>}{displayedLogs.length ? displayedLogs.map((line, i) => <div key={i}>{line}</div>) : <p>开始处理后，这里会显示实际处理信息。</p>}<div ref={logEnd}/></div> : <div className="issues-list">{missingEncoders.map(c => <p className="warning" key={c}>本机引擎未提供 {c} 编码方式，请更换输出格式或处理引擎。</p>)}{advancedIssues.map((message, i) => <p className="warning" key={'advanced-' + i}>{message}</p>)}{issues.length ? issues.map((issue, i) => <p className={issue.severity === 'error' ? 'warning' : ''} key={i}>{issue.message}</p>) : !advancedIssues.length && !missingEncoders.length ? <p><CheckCircle2 size={16}/>配置结构检查通过；实际素材兼容性将在处理时检查。</p> : null}</div>}</div>}</section><footer className="statusbar"><span><span className={'status-dot ' + (engine.available ? 'ready' : '')}/>{engine.available ? '已连接本机处理引擎' : native ? '正在等待引擎连接' : '浏览器界面预览 · 实际处理请使用桌面版'}</span><span>{activeJob ? '正在处理 · ' + formatMediaTime(activeJob.processedSeconds) : '配置已自动保存'}</span></footer>
    </main>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18}/><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={15}/></button></div>}
    {(engineModal || helpModal) && <div className="modal-backdrop" onClick={() => { setEngineModal(false); setHelpModal(false); }}><section className="modal" role="dialog" aria-modal="true" aria-label={engineModal ? '处理引擎设置' : '使用帮助'} onClick={e => e.stopPropagation()}><div className="modal-heading"><div><h2>{engineModal ? '连接本机处理引擎' : '三步，完成一次视频处理'}</h2><p>{engineModal ? '选择电脑上的 FFmpeg，文件处理留在本地完成。' : '选择素材 → 调整效果 → 选择位置并开始处理。'}</p></div><button className="icon-button" aria-label="关闭弹窗" onClick={() => { setEngineModal(false); setHelpModal(false); }}><X size={20}/></button></div>{engineModal ? <div className="settings-body"><Field label="FFmpeg 可执行文件位置"><input aria-label="FFmpeg 路径" value={enginePath} onChange={e => setEnginePath(e.target.value)}/></Field><div className="engine-actions"><button className="button" disabled={scanning} onClick={selectEngine}><FolderOpen size={16}/>选择 FFmpeg 文件</button><button className="button primary" disabled={scanning} onClick={() => void scan(enginePath)}>{scanning ? <LoaderCircle size={16} className="spin"/> : <Activity size={16}/>} {scanning ? '正在检测…' : '检测并连接'}</button><button className="button" disabled={scanning || !native} onClick={connectEngineCopy}>复制到应用缓存并连接</button></div><p className="field-help">遇到启动超时，可尝试复制到应用缓存并连接。副本只保存在本机，原文件保留；系统安全检查仍然有效。</p><div className={'engine-result ' + (engine.available ? 'success' : '')}><strong>{engine.available ? '已经连接' : '尚未连接'}</strong><p>{engine.available ? engine.version : engine.error}</p>{engine.available && engine.error && <p className="warning">检测提示：{engine.error}</p>}{discovered > 0 && <p>已发现 {discovered} 条引擎参数；已功能化的设置会显示在界面中。</p>}</div></div> : <div className="help-body"><div className="help-step"><span>1</span><div><h3>先选要做的事</h3><p>压缩、转换格式、截取片段、调整画面或处理声音，都有自己的选项。</p></div></div><div className="help-step"><span>2</span><div><h3>看效果说明，直接选择</h3><p>选项用中文解释。不确定时用默认值，较少使用的功能在“更多设置”中分类查找。</p></div></div><div className="help-step"><span>3</span><div><h3>在桌面版开始处理</h3><p>浏览器用于预览同一套桌面界面。选择本地文件和实际处理，请打开 FFmpeg Workbench 桌面应用。</p></div></div><button className="button primary wide" onClick={resetDemo}><Sparkles size={17}/>用 5 秒示例试试看</button></div>}</section></div>}
    {previewJob && <ResultPreview key={previewJob.id} job={previewJob} returnFocus={previewTrigger.current} onClose={() => setPreviewJob(undefined)} onReveal={() => revealOutputFile(previewJob.id)}/> }
    <input ref={browserOpen} className="hidden-input" type="file" accept=".json" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(loadProject); e.target.value = ''; }}/>
  </div>;
}
