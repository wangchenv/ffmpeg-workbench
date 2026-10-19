import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export interface EngineInfo {
  path: string;
  version: string;
  available: boolean;
  error?: string;
  help?: string;
  encoders?: string[];
}
export interface JobEvent {
  jobId: string;
  kind: 'log' | 'progress' | 'state';
  message?: string;
  data?: Record<string, string>;
  state?: 'running' | 'succeeded' | 'failed' | 'canceled';
}
export interface MediaInfo {
  durationSeconds?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  probeSource: 'ffprobe' | 'ffmpeg';
  error?: string;
}
export async function probeMedia(executable: string, path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe_media', { executable, path });
}
export const enginePathDefault = (import.meta.env.DEV ? import.meta.env.VITE_FFMPEG_PATH : undefined) || 'ffmpeg';
export async function scanEngine(path: string): Promise<EngineInfo> {
  if (!native) return { path, version: '浏览器界面预览', available: false, error: '本机引擎扫描和执行请使用桌面版。' };
  return invoke<EngineInfo>('get_engine', { path });
}
export async function chooseInputs(): Promise<string[]> {
  return invoke<string[]>('choose_media_files');
}
export async function chooseEngine(): Promise<string | null> {
  return invoke<string | null>('choose_engine_file');
}
export async function copyEngineToCache(path: string): Promise<EngineInfo> {
  return invoke<EngineInfo>('copy_engine_to_cache', { path });
}
export async function chooseOutput(suggestedName?: string, format?: string): Promise<string | null> {
  return invoke<string | null>('choose_output_file', { suggestedName, format });
}
export async function saveProject(content: string): Promise<boolean> {
  if (native) { return (await invoke<string | null>('save_project_file', { content })) !== null; }
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'project.ffgui.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
export async function openProject(): Promise<string | null> {
  return invoke<string | null>('read_project_file');
}
export async function runJob(request: { id: string; executable: string; args: string[] }): Promise<void> {
  return invoke('run_job', { request });
}
export async function cancelJob(id: string): Promise<void> {
  return invoke('cancel_job', { id });
}
export async function prepareMediaPreview(jobId: string): Promise<{ url: string; sizeBytes: number }> {
  return invoke('prepare_media_preview', { jobId });
}
export async function revealOutputFile(jobId: string): Promise<void> {
  return invoke('reveal_output_file', { jobId });
}
export async function subscribeJobs(callback: (event: JobEvent) => void) {
  if (!native) return () => {};
  return listen<JobEvent>('job-event', event => callback(event.payload));
}
