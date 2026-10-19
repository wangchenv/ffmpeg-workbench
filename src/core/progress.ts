export type ProcessingPhase = 'preparing' | 'processing' | 'finalizing';
export interface JobMetrics {
  processedSeconds: number;
  speed?: number;
  fps?: number;
  frame?: number;
  sizeBytes?: number;
  bitrateKbps?: number;
}
export interface ProgressJob extends JobMetrics {
  state: 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'canceled';
  phase: ProcessingPhase;
  duration?: number;
  startedAt?: number;
  finishedAt?: number;
}
export interface JobRecord extends ProgressJob {
  id: string;
  name: string;
  executable: string;
  args: string[];
  logs: string[];
  output: string;
  source: string;
  format: string;
  video: boolean;
  queuedAt: number;
  lastProgressAt?: number;
  lastSpeedAt?: number;
  cancelRequested?: boolean;
  failureMessage?: string;
}

const nonnegative = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !value.trim() || value.trim() === 'N/A') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

/** FFmpeg's out_time_ms is historically microseconds, just like out_time_us. */
export function parseProgress(previous: JobMetrics, data: Record<string, string>): JobMetrics {
  const microseconds = nonnegative(data.out_time_us) ?? nonnegative(data.out_time_ms);
  let processedSeconds = microseconds === undefined ? undefined : microseconds / 1e6;
  if (processedSeconds === undefined && /^\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(data.out_time || '')) {
    processedSeconds = data.out_time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }
  const speed = nonnegative(data.speed?.replace(/x$/, ''));
  const fps = nonnegative(data.fps);
  const frame = nonnegative(data.frame);
  const sizeBytes = nonnegative(data.total_size);
  const bitrateKbps = nonnegative(data.bitrate?.replace(/kbits\/s$/, '').trim());
  return {
    ...previous,
    processedSeconds: Math.max(previous.processedSeconds, processedSeconds ?? 0),
    ...(speed !== undefined && speed > 0 ? { speed } : {}),
    ...(fps !== undefined && fps > 0 ? { fps } : {}),
    ...(frame !== undefined ? { frame } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes: Math.max(previous.sizeBytes ?? 0, sizeBytes) } : {}),
    ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
  };
}

export function jobProgress(job: ProgressJob, now: number) {
  const knownDuration = job.duration !== undefined && Number.isFinite(job.duration) && job.duration > 0;
  const terminal = ['succeeded', 'failed', 'canceled'].includes(job.state);
  const elapsedSeconds = job.startedAt === undefined ? 0 : Math.max(0, ((job.finishedAt ?? now) - job.startedAt) / 1000);
  const percentage = job.state === 'succeeded' ? 100 : knownDuration ? Math.min(99, Math.max(0, job.processedSeconds / job.duration! * 100)) : undefined;
  const remainingSeconds = !terminal && job.state === 'running' && job.phase === 'processing' && knownDuration && job.speed && elapsedSeconds >= 1
    ? Math.max(0, (job.duration! - job.processedSeconds) / job.speed) : undefined;
  const phaseLabel = job.state === 'queued' ? '等待前面的任务' : job.state === 'starting' || (job.state === 'running' && job.phase === 'preparing') ? '正在准备素材'
    : job.state === 'succeeded' ? '文件已保存' : job.state === 'failed' ? '处理未完成' : job.state === 'canceled' ? '已取消处理' : job.phase === 'finalizing' ? '正在保存文件' : '正在处理音视频';
  return { knownDuration, terminal, elapsedSeconds, percentage, remainingSeconds, phaseLabel };
}

export function formatElapsed(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '等待估算';
  if (seconds > 0 && seconds < 1) {
    if (seconds < 0.001) return '不足 0.001 秒';
    return Math.floor(seconds * 1000) / 1000 + ' 秒';
  }
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return whole + ' 秒';
  if (whole < 3600) return Math.floor(whole / 60) + ' 分 ' + whole % 60 + ' 秒';
  return Math.floor(whole / 3600) + ' 小时 ' + Math.floor(whole % 3600 / 60) + ' 分';
}
export function formatMediaTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '时长未知';
  if (seconds > 0 && seconds < 1) {
    if (seconds < 0.001) return '不足 0.001 秒';
    return '00:00:00.' + String(Math.floor(seconds * 1000)).padStart(3, '0');
  }
  const whole = Math.max(0, Math.floor(seconds));
  return [Math.floor(whole / 3600), Math.floor(whole % 3600 / 60), whole % 60].map(v => String(v).padStart(2, '0')).join(':');
}
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '等待数据';
  if (bytes < 1024) return Math.round(bytes) + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}
