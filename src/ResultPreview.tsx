import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, LoaderCircle, Music2, Pause, Play, Volume2, VolumeX, X } from 'lucide-react';
import { prepareMediaPreview } from './bridge';
import { formatBytes, formatMediaTime } from './core/progress';
import type { JobRecord } from './core/progress';

export default function ResultPreview({ job, onClose, onReveal, returnFocus }: { job: JobRecord; returnFocus: HTMLElement | null; onClose: () => void; onReveal: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const player = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [source, setSource] = useState<{ url: string; sizeBytes: number }>();
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [revealError, setRevealError] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [info, setInfo] = useState<{ duration?: number; width?: number; height?: number }>({});
  const title = job.video ? '预览视频' : '试听音频';
  const name = job.output.split(/[\\/]/).pop() || job.output;

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = returnFocus || document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    let current = true;
    prepareMediaPreview(job.id).then(value => { if (current) setSource(value); }).catch(reason => {
      if (current) setError(String(reason).replace(/^Error: /, ''));
    });
    return () => { current = false; };
  }, [job.id]);
  const bindPlayer = useCallback((element: HTMLVideoElement | HTMLAudioElement | null) => {
    if (!element) player.current?.pause();
    player.current = element;
  }, []);
  useEffect(() => {
    if (!source || loaded || error) return;
    const timeout = setTimeout(() => setError('读取预览时间较长。请关闭后重试，或打开所在文件夹，使用播放器查看。'), 20000);
    return () => clearTimeout(timeout);
  }, [source, loaded, error]);

  function metadata(element: HTMLMediaElement) {
    setInfo({ duration: Number.isFinite(element.duration) ? element.duration : undefined,
      ...(element instanceof HTMLVideoElement ? { width: element.videoWidth, height: element.videoHeight } : {}) });
  }
  const playbackError = () => setError('无法播放这个文件。文件可能已移动，或当前格式、编码暂不支持应用内预览。请打开所在文件夹，使用播放器查看。');
  function close() { player.current?.pause(); onClose(); }
  async function togglePlayback() {
    const element = player.current;
    if (!element) return;
    if (element.paused) {
      try { await element.play(); } catch (reason) {
        if (element !== player.current || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        playbackError();
      }
    } else element.pause();
  }
  function seek(value: number) {
    const element = player.current;
    if (!element || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.max(0, Math.min(value, element.duration));
    setPosition(element.currentTime);
  }
  async function reveal() {
    setRevealError('');
    setRevealing(true);
    try { await onReveal(); } catch (reason) { setRevealError(String(reason).replace(/^Error: /, '')); }
    finally { setRevealing(false); }
  }
  const mediaProps = { src: source?.url, autoPlay: true, preload: 'metadata',
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => metadata(event.currentTarget),
    onDurationChange: (event: React.SyntheticEvent<HTMLMediaElement>) => metadata(event.currentTarget),
    onLoadedData: () => setLoaded(true), onCanPlay: () => setLoaded(true), onError: playbackError,
    onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false),
    onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) => setPosition(event.currentTarget.currentTime) };

  return <dialog ref={dialog} className="result-preview" aria-labelledby="result-preview-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section>
      <header className="result-preview-heading"><div><h2 id="result-preview-title">{title}</h2><p title={job.output}>{name}</p></div><button className="icon-button" aria-label="关闭预览" onClick={close}><X size={21}/></button></header>
      <div className={'result-preview-stage ' + (job.video ? '' : 'audio-preview')}>
        {!error && (!source || !loaded) && <div className="result-preview-loading" role="status"><LoaderCircle className="spin" size={26}/><span>正在读取处理结果…</span></div>}
        {error ? <div className="result-preview-error" role="alert"><strong>暂时无法预览</strong><p>{error}</p></div> : source && (job.video
          ? <video {...mediaProps} ref={bindPlayer} aria-label="结果视频播放器" playsInline/>
          : <div className="result-preview-audio"><Music2 size={48}/><span>处理后的音频</span><audio {...mediaProps} ref={bindPlayer} aria-label="结果音频播放器"/></div>)}
      </div>
      {source && !error && <div className="result-preview-controls" aria-label="播放控制"><button className="button" onClick={() => void togglePlayback()}>{playing ? <Pause size={16}/> : <Play size={16}/>} {playing ? '暂停' : '播放'}</button><span className="preview-time">{formatMediaTime(position)}</span><input type="range" aria-label="播放进度" min="0" max={info.duration || 1} step="0.1" value={Math.min(position, info.duration || 1)} disabled={!loaded || !info.duration} onChange={event => seek(Number(event.target.value))}/><span className="preview-time">{formatMediaTime(info.duration)}</span><button className="icon-button" aria-label={muted ? '取消静音' : '静音'} disabled={!loaded} onClick={() => { if (player.current) { player.current.muted = !muted; setMuted(!muted); } }}>{muted ? <VolumeX size={18}/> : <Volume2 size={18}/>}</button><input className="preview-volume" type="range" aria-label="播放音量" min="0" max="1" step="0.05" value={muted ? 0 : volume} disabled={!loaded} onChange={event => { const value = Number(event.target.value); if (player.current) { player.current.volume = value; player.current.muted = false; setVolume(value); setMuted(false); } }}/></div>}
      <footer className="result-preview-footer"><div><p>{job.format.toUpperCase()}{source && ' · ' + formatBytes(source.sizeBytes)}{info.duration !== undefined && ' · ' + formatMediaTime(info.duration)}{info.width && info.height ? ` · ${info.width} × ${info.height}` : ''}</p><span>直接播放本机文件 · 拖动播放进度可查看不同位置</span></div><button className="button" disabled={revealing} onClick={() => void reveal()}><FolderOpen size={16}/>{revealing ? '正在打开…' : '打开所在文件夹'}</button>{revealError && <p className="result-preview-reveal-error" role="alert">{revealError}</p>}</footer>
    </section>
  </dialog>;
}
