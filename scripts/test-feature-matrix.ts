import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import assert from 'node:assert/strict';
import { advancedSettings, applyAdvancedSetting, applyFeatureConfig, readAdvancedSetting, readFeatureConfig, compileProject, serializeProject, deserializeProject } from '../src/core/index';
import type { CommandNode, FeatureConfig, ProjectDocument } from '../src/core/index';

const root = process.cwd();
const dir = resolve(root, 'artifacts/test-evidence');
const mediaDir = resolve(dir, 'media');
const logsDir = resolve(dir, 'logs');
mkdirSync(mediaDir, { recursive: true }); mkdirSync(logsDir, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH ?? resolve(root, '.tools/ffmpeg-node/node_modules/ffmpeg-static/ffmpeg');
const ffprobe = process.env.FFPROBE_PATH ?? resolve(root, '.tools/ffmpeg-node/node_modules/@ffprobe-installer/darwin-arm64/ffprobe');
type Row = { id: string; feature: string; config: unknown; status: 'pass'|'fail'|'blocked'; level: string; assertions: string[]; expected?: unknown; actual?: unknown; evidence: string[]; durationMs: number; error?: string };
type Probe = { streams: Array<Record<string, any>>; format: Record<string, any>; chapters?: Array<Record<string, any>> };
const rows: Row[] = [];
const selected = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const fixture = resolve(mediaDir, 'source.mp4');
const richFixture = resolve(mediaDir, 'source-rich.mkv');
const unevenFixture = resolve(mediaDir, 'source-uneven.mkv');
const variableFixture = resolve(mediaDir, 'source-vfr.mp4');
let serial = 0;
const node = (kind: CommandNode['kind'], tokens: string[], id?: string): CommandNode => ({ id: id ?? `n-${serial++}`, kind, tokens, enabled: true });
function command(exe: string, args: string[], binary = false) {
  const result = spawnSync(exe, args, { encoding: binary ? undefined : 'utf8', timeout: 90_000, maxBuffer: 48 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(exe)} exited ${result.status}: ${String(result.stderr).slice(-7000)}`);
  return result;
}
function probe(path: string): Probe { return JSON.parse(String(command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path]).stdout)); }
const video = (p: Probe) => p.streams.find((stream) => stream.codec_type === 'video');
const audio = (p: Probe) => p.streams.find((stream) => stream.codec_type === 'audio');
const seconds = (p: Probe) => Number(p.format.duration);
const fps = (s: Record<string, any> | undefined) => { const [a,b] = String(s?.avg_frame_rate ?? '0/1').split('/').map(Number); return a/b; };
const logParameter = (log: string, name: string, value: string | number) => new RegExp(`\\b${name}=${value}\\b`).test(log);
function base(id: string, format = 'mp4', input = fixture): ProjectDocument {
  return { id: `matrix-${id}`, schemaVersion: 1, name: `Matrix ${id}`, nodes: [node('input', ['-i', input]), node('option', ['-c:v', 'libx264']), node('option', ['-crf', '23']), node('option', ['-preset', 'fast']), node('option', ['-pix_fmt', 'yuv420p']), node('option', ['-c:a', 'aac']), node('option', ['-b:a', '192k']), node('output', [resolve(mediaDir, `${id}.${format}`)])] };
}
function row(id: string, feature: string, config: unknown, level: string, test: (r: Row) => void) {
  if (selected && !new RegExp(selected).test(id)) return;
  const r: Row = { id, feature, config, status: 'pass', level, assertions: [], expected: level==='validation-rejection'?{validation:'reject before command generation'}:{}, actual:{}, evidence: [], durationMs: 0 }; const start = performance.now();
  try { test(r); } catch (error) { r.status = 'fail'; r.error = String(error instanceof Error ? error.message : error); }
  if(level==='validation-rejection'&&r.status==='pass')r.actual={validation:'rejected before command generation'};
  r.durationMs = Math.round(performance.now() - start); rows.push(r);
  process.stdout.write(`${r.status.toUpperCase()} ${id}${r.error ? `: ${r.error.slice(0,250)}` : ''}\n`);
  save();
}
function save() {
  const counts = Object.fromEntries(['pass','fail','blocked'].map((status) => [status, rows.filter((r) => r.status === status).length]));
  writeFileSync(resolve(dir, selected ? 'feature-matrix-subset.json' : 'feature-matrix.json'), JSON.stringify({ generatedAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version, ffmpeg, ffprobe }, scope: 'Current six friendly functions and all 28 advanced controls; representative combinations, not every Cartesian product. Core command generation exercised; native runner tested separately.', counts, fixtures: [fixture, richFixture, unevenFixture, variableFixture], results: rows }, null, 2));
}
function check(r: Row, description: string, actual: unknown, expected: unknown) { r.expected={...(r.expected as object),[description]:expected??null};r.actual={...(r.actual as object),[description]:actual??null};assert.deepEqual(actual, expected, description); r.assertions.push(description); }
function near(r: Row, description: string, actual: number, expected: number, tolerance: number) { r.expected={...(r.expected as object),[description]:{value:expected,tolerance}};r.actual={...(r.actual as object),[description]:actual};assert.ok(Math.abs(actual-expected) <= tolerance, `${description}: ${actual} expected ${expected} ± ${tolerance}`); r.assertions.push(description); }
function execute(r: Row, project: ProjectDocument): { p: Probe; path: string; log: string; args: string[] } {
  const args = compileProject(project); const path = project.nodes.find((n) => n.enabled && n.kind === 'output')!.tokens[0];
  const result = command(ffmpeg, ['-hide_banner','-y', ...args]);
  const log = String(result.stderr); const logPath = resolve(logsDir, `${r.id}.log`); writeFileSync(logPath, log);
  const p = probe(path); const probePath = resolve(logsDir, `${r.id}.probe.json`); writeFileSync(probePath, JSON.stringify(p, null, 2));
  r.evidence.push(relative(root,path), relative(root,logPath), relative(root,probePath)); r.actual = { ...(r.actual as object), args, streams: p.streams.map(({codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels,profile,level,pix_fmt,color_range,color_space,color_transfer,color_primaries,bit_rate,has_b_frames,display_aspect_ratio,sample_fmt}) => ({codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels,profile,level,pix_fmt,color_range,color_space,color_transfer,color_primaries,bit_rate,has_b_frames,display_aspect_ratio,sample_fmt})), duration: p.format.duration, size: p.format.size, tags: p.format.tags, chapters: p.chapters };
  check(r, 'FFmpeg completed and output contains at least one stream', p.streams.length > 0, true);
  return { p, path, log, args };
}
function runFeature(id: string, patch: Partial<FeatureConfig>, verify: (r: Row, output: ReturnType<typeof execute>) => void) {
  row(id, 'friendly', patch, 'output-probed', (r) => { const project = applyFeatureConfig(base(id),patch); const restored = deserializeProject(serializeProject(project)); check(r,'JSON save/load preserves ordered argv',compileProject(restored),compileProject(project)); verify(r, execute(r,restored)); });
}
function rms(path: string): number {
  const data = command(ffmpeg,['-v','error','-i',path,'-vn','-t','0.8','-ar','44100','-ac','1','-f','s16le','pipe:1'],true).stdout as Buffer;
  let sum=0; for(let i=0;i<data.length;i+=2){const n=data.readInt16LE(i)/32768;sum+=n*n;} return Math.sqrt(sum/(data.length/2));
}
function frame(path: string, filter?: string): Buffer {
  return command(ffmpeg,['-v','error','-i',path,...(filter ? ['-vf',filter] : []),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],true).stdout as Buffer;
}
function visualCheck(r: Row, path: string, filter: string) {
  const actual = frame(path); const expected = frame(fixture,filter); check(r,'Transformed decoded frame has expected byte length',actual.length,expected.length);
  let delta=0; for(let i=0;i<actual.length;i++)delta+=Math.abs(actual[i]-expected[i]);
  const mae=delta/actual.length; assert.ok(mae<14,`Image transform mean absolute RGB error ${mae} must be <14`); r.assertions.push(`Decoded orientation matches reference transform (RGB mean absolute error ${mae.toFixed(3)} < 14)`);
}

console.log('Preparing synthetic audio/video, subtitle, metadata and chapter fixtures.');
command(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=1.2','-f','lavfi','-i','sine=frequency=1000:sample_rate=44100:duration=1.2','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',fixture]);
const srt = resolve(mediaDir,'source.srt'); const meta = resolve(mediaDir,'source.ffmeta');
writeFileSync(srt,'1\n00:00:00,000 --> 00:00:01,100\nSynthetic subtitle\n');
writeFileSync(meta,';FFMETADATA1\ntitle=Inherited Title\nartist=Inherited Artist\ncomment=Inherited Comment\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=600\ntitle=First chapter\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=600\nEND=1200\ntitle=Second chapter\n');
command(ffmpeg,['-v','error','-y','-i',fixture,'-i',srt,'-f','ffmetadata','-i',meta,'-map','0:v','-map','0:a','-map','1:s','-map_metadata','2','-map_chapters','2','-c','copy',richFixture]);
command(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=1.2','-f','lavfi','-i','sine=frequency=1000:sample_rate=44100:duration=1.8','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac',unevenFixture]);
command(ffmpeg,['-v','error','-y','-i',fixture,'-vf',"select='lt(n,12)+not(mod(n,2))'",'-fps_mode','vfr','-an','-c:v','libx264',variableFixture]);
const baselineRms = rms(fixture);

for (const purpose of ['compress','convert','trim','resize','audio','mute'] as const) {
  const patch: Partial<FeatureConfig> = { purpose, ...(purpose==='convert'?{format:'mkv'}:purpose==='trim'?{trimEnabled:true,trimStart:'0.2',trimDuration:'0.5'}:purpose==='resize'?{resize:'480'}:purpose==='compress'?{quality:'small'}:{}) };
  runFeature(`purpose-${purpose}`,patch,(r,{p})=>{ if(purpose==='audio'){check(r,'Extract audio removes video',Boolean(video(p)),false);check(r,'Extract audio produces MP3',audio(p)?.codec_name,'mp3');}else if(purpose==='mute')check(r,'Mute removes audio',Boolean(audio(p)),false);else if(purpose==='trim')near(r,'Trim output duration',seconds(p),0.5,0.07);else if(purpose==='resize')check(r,'Resize height',video(p)?.height,480);else check(r,'Video and audio retained',Boolean(video(p)&&audio(p)),true); });
}
const qualitySizes: Record<string,number> = {};
for (const quality of ['high','balanced','small'] as const) runFeature(`quality-${quality}`,{quality},(r,{p,args})=>{check(r,'Quality maps to expected CRF',args[args.indexOf('-crf')+1],String({high:18,balanced:23,small:28}[quality]));check(r,'H.264 output',video(p)?.codec_name,'h264');qualitySizes[quality]=Number(p.format.size);});
row('quality-relative-size','friendly',{qualities:['high','balanced','small']},'cross-output-comparison',(r)=>{if(Object.keys(qualitySizes).length!==3) {r.status='blocked';r.error='Quality executions omitted by filter';return;} check(r,'Higher quality synthetic output uses more bytes',qualitySizes.high>qualitySizes.balanced&&qualitySizes.balanced>qualitySizes.small,true);r.actual=qualitySizes;});
for (const [videoEncoding,codec] of Object.entries({compatible:'h264',efficient:'hevc',builtin:'mpeg4',web:'vp9'}) as Array<[FeatureConfig['videoEncoding'],string]>) runFeature(`encoding-${videoEncoding}`,{videoEncoding,...(videoEncoding==='web'?{format:'webm' as const}:{})},(r,{p})=>check(r,'Selected video codec',video(p)?.codec_name,codec));
for (const speed of ['fast','medium','slow'] as const) runFeature(`speed-${speed}`,{speed},(r,{p,args})=>{check(r,'Preset maps exactly',args[args.indexOf('-preset')+1],speed);check(r,'Preset produces H.264',video(p)?.codec_name,'h264');r.level='mapping-and-output-probed; timing not benchmarked';});
for (const format of ['mp4','mkv','mov','webm','mp3','wav','flac'] as const) runFeature(`format-${format}`,{format},(r,{p,path})=>{check(r,'Output extension follows selected format',path.endsWith(`.${format}`),true);if(['mp3','wav','flac'].includes(format)){check(r,'Audio formats omit video',Boolean(video(p)),false);check(r,'Audio codec matches format',audio(p)?.codec_name,format==='wav'?'pcm_s16le':format);}else{check(r,'Container has video and audio',Boolean(video(p)&&audio(p)),true);check(r,'Actual muxer matches selection',String(p.format.format_name).includes(format==='mkv'?'matroska':format==='webm'?'webm':format==='mov'?'mov':'mp4'),true);}});
for (const resize of ['original','1080','720','480','custom'] as const) runFeature(`resize-${resize}`,{resize,customHeight:240,...(resize==='1080'?{trimEnabled:true,trimStart:'0',trimDuration:'0.3'}:{})},(r,{p})=>{const height=resize==='original'?180:resize==='custom'?240:Number(resize);check(r,'Selected height',video(p)?.height,height);near(r,'Aspect ratio preserved by even-width scale',video(p)!.width/height,16/9,0.01);});
for(const customHeight of [2,242,8192]) row(`custom-height-${customHeight}`,'friendly',{customHeight},'mapping-boundary',(r)=>{const project=applyFeatureConfig(base(`custom-${customHeight}`),{resize:'custom',customHeight});check(r,'Valid even height maps to scale',compileProject(project).includes(`scale=-2:${customHeight}`),true);});
for (const rotation of ['none','clockwise','counterclockwise','half'] as const) runFeature(`rotation-${rotation}`,{rotation},(r,{p,path})=>{check(r,'Rotation dimensions', [video(p)?.width,video(p)?.height],['clockwise','counterclockwise'].includes(rotation)?[180,320]:[320,180]);visualCheck(r,path,{none:'null',clockwise:'transpose=1',counterclockwise:'transpose=2',half:'hflip,vflip'}[rotation]);});
for (const [flipHorizontal,flipVertical] of [[false,false],[true,false],[false,true],[true,true]]) runFeature(`flip-${Number(flipHorizontal)}${Number(flipVertical)}`,{flipHorizontal,flipVertical},(r,{path})=>visualCheck(r,path,[...(flipHorizontal?['hflip']:[]),...(flipVertical?['vflip']:[])].join(',')||'null'));
for (const rate of ['original','24','25','30','60'] as const) runFeature(`fps-${rate}`,{fps:rate},(r,{p})=>near(r,'Probed output frame rate',fps(video(p)),rate==='original'?30:Number(rate),0.001));
for (const [name,trimStart,trimDuration] of [['seconds','0.2','0.5'],['hhmmss','00:00:00.200','00:00:00.500'],['zero','0','0.1']]) runFeature(`trim-${name}`,{trimEnabled:true,trimStart,trimDuration},(r,{p})=>near(r,'Probed trimmed duration',seconds(p),name==='zero'?0.1:0.5,0.07));
runFeature('trim-disabled',{trimEnabled:false},(r,{p,args})=>{check(r,'Disabled trim has no ss or t',args.includes('-ss')||args.includes('-t'),false);near(r,'Full source duration retained',seconds(p),1.2,0.07);});
for (const format of ['mp3','wav','flac'] as const) runFeature(`audio-extract-${format}`,{purpose:'audio',format},(r,{p})=>{check(r,'No video on extracted audio',Boolean(video(p)),false);check(r,'Expected audio encoding',audio(p)?.codec_name,format==='wav'?'pcm_s16le':format);});
for (const audioBitrate of ['96','128','192','320'] as const) runFeature(`audio-bitrate-${audioBitrate}`,{purpose:'audio',format:'mp3',audioBitrate},(r,{p})=>near(r,'MP3 stream target bitrate',Number(audio(p)?.bit_rate),Number(audioBitrate)*1000,1000));
for (const audioSampleRate of ['original','44100','48000'] as const) runFeature(`sample-rate-${audioSampleRate}`,{purpose:'audio',format:'wav',audioSampleRate},(r,{p})=>check(r,'Audio sample rate',audio(p)?.sample_rate,audioSampleRate==='original'?'44100':audioSampleRate));
for (const volume of [0,0.5,1,2]) runFeature(`volume-${volume}`,{purpose:'audio',format:'wav',volume},(r,{path})=>{const ratio=rms(path)/baselineRms;near(r,'Decoded audio RMS multiplier',ratio,volume,0.025);r.actual={...(r.actual as object),rmsRatio:ratio};});

const settingValues: Record<string,string|boolean> = { 'video-bitrate':'1M','video-maxrate':'2M','video-buffer':'4M','keyframe-interval':'10','b-frames':'2','threads':'1','pixel-format':'yuv444p','h264-profile':'baseline','h264-level':'3.1','color-range':'pc','color-space':'bt709','color-primaries':'bt709','color-transfer':'smpte2084','display-aspect':'4:3','frame-timing':'cfr','audio-channels':'2','audio-sample-format':'s16','flac-compression':'8','shortest':true,'disable-subtitles':true,'disable-data':true,'faststart':true,'remove-metadata':true,'remove-chapters':true,'title':'矩阵标题 #1','artist':'测试作者','comment':'space "quote" = value','muxing-queue':'128' };
function applicable(id: string): ProjectDocument { let p=base(`advanced-${id}`, ['disable-subtitles','remove-metadata','remove-chapters','title','artist','comment'].includes(id)?'mkv':'mp4',['disable-subtitles','remove-metadata','remove-chapters','title','artist','comment'].includes(id)?richFixture:id==='shortest'?unevenFixture:fixture); if(id==='audio-sample-format')p=applyFeatureConfig(p,{purpose:'audio',format:'wav'});if(id==='flac-compression')p=applyFeatureConfig(p,{purpose:'audio',format:'flac'});return p; }
for (const definition of advancedSettings) {
  const id=definition.id; const setting=settingValues[id];
  row(`advanced-contract-${id}`,id,setting,'mapping-persistence-scope',(r)=>{
    const p=applicable(id); const outputIndex=p.nodes.findIndex((n)=>n.kind==='output');
    const originalInputOption=node('option',[definition.option, definition.metadataKey?`${definition.metadataKey}=input-value`:'input-value'],'scope-input-'+id); p.nodes.unshift(originalInputOption);
    const laterOption=node('option',[definition.option,definition.metadataKey?`${definition.metadataKey}=later-value`:'later-value'],'scope-later-'+id); const laterOutput=node('output',[resolve(mediaDir,`later-${id}.mkv`)],'scope-output-'+id); p.nodes.push(laterOption,laterOutput);
    const disabled=node('option',[definition.option,'disabled-value'],'scope-disabled-'+id);disabled.enabled=false;p.nodes.splice(outputIndex+1,0,disabled);
    const next=applyAdvancedSetting(p,id,setting);check(r,'Setting reads back selected value',readAdvancedSetting(next,id),setting);const restored=deserializeProject(serializeProject(next));check(r,'JSON save/load preserves selected setting',readAdvancedSetting(restored,id),setting);
    for(const protectedNode of [originalInputOption,laterOption,laterOutput,disabled])check(r,`Protected scope ${protectedNode.id} preserved`,restored.nodes.find(n=>n.id===protectedNode.id),protectedNode);
    const cleared=applyAdvancedSetting(restored,id,undefined);check(r,'Clearing restores absent/false state',readAdvancedSetting(cleared,id),definition.control==='toggle'?false:undefined);for(const protectedNode of [originalInputOption,laterOption,disabled])check(r,`Clear preserves ${protectedNode.id}`,cleared.nodes.find(n=>n.id===protectedNode.id),protectedNode);
    const args=compileProject(next);check(r,'Compiled argv contains exact mapped setting',definition.control==='toggle'?(args.includes(definition.option)&&(definition.trueValue?args.includes(definition.trueValue):true)):args.includes(definition.metadataKey?`${definition.metadataKey}=${setting}`:String(setting)),true);
  });
  row(`advanced-execute-${id}`,id,setting,'output-probed',(r)=>{
    let p=applicable(id);if(id==='video-maxrate')p=applyAdvancedSetting(p,'video-buffer','4M');if(id==='video-buffer')p=applyAdvancedSetting(p,'video-maxrate','2M');
    p=applyAdvancedSetting(p,id,setting);const {p:out,path,log,args}=execute(r,p);const v=video(out),a=audio(out);
    if(id==='video-bitrate'){check(r,'Bitrate control replaces constant quality',args.includes('-crf')||args.includes('-q:v'),false);check(r,'Encoder reports selected target bitrate',/bitrate=1000(?:\s|\b)/.test(log),true);check(r,'Video bitrate is measurable',Number(v?.bit_rate)>0,true);}
    else if(id==='video-maxrate'||id==='video-buffer'){check(r,'Encoder VBV maxrate applied',logParameter(log,'vbv_maxrate',2000),true);check(r,'Encoder VBV buffer applied',logParameter(log,'vbv_bufsize',4000),true);}
    else if(id==='keyframe-interval'){const frames=JSON.parse(String(command(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=key_frame,best_effort_timestamp_time','-of','json',path]).stdout)).frames;const keys=frames.flatMap((f:any,i:number)=>f.key_frame?[i]:[]);check(r,'Multiple keyframes exist',keys.length>=3,true);check(r,'Keyframe spacing within 10 frames',keys.slice(1).every((x:number,i:number)=>x-keys[i]<=10),true);r.actual={...(r.actual as object),keyframeIndices:keys};}
    else if(id==='b-frames')check(r,'B-frame capability enabled',v?.has_b_frames,2);
    else if(id==='threads'){check(r,'Encoder logs one processing thread',/\bthreads=1\b/.test(log),true);r.level='encoder-log-and-output-probed';}
    else if(id==='pixel-format')check(r,'Selected pixel format',v?.pix_fmt,'yuv444p');
    else if(id==='h264-profile')check(r,'H.264 Baseline profile',v?.profile,'Constrained Baseline');
    else if(id==='h264-level')check(r,'H.264 level 3.1',v?.level,31);
    else if(id==='color-range')check(r,'Color range tag',v?.color_range,'pc');
    else if(id==='color-space')check(r,'Color matrix tag',v?.color_space,'bt709');
    else if(id==='color-primaries')check(r,'Color primaries tag',v?.color_primaries,'bt709');
    else if(id==='color-transfer')check(r,'Color transfer tag',v?.color_transfer,'smpte2084');
    else if(id==='display-aspect')check(r,'Display aspect ratio tag',v?.display_aspect_ratio,'4:3');
    else if(id==='frame-timing'){near(r,'CFR output frame rate',fps(v),30,0.001);r.level='mapping-and-CFR-output-probed; VFR source not included';}
    else if(id==='audio-channels')check(r,'Audio channel count',a?.channels,2);
    else if(id==='audio-sample-format')check(r,'PCM sample format',a?.sample_fmt,'s16');
    else if(id==='flac-compression'){check(r,'Lossless FLAC codec',a?.codec_name,'flac');const hash=(f:string)=>command(ffmpeg,['-v','error','-i',f,'-vn','-c:a','pcm_s24le','-f','hash','-hash','sha256','pipe:1']).stdout;const outputHash=String(hash(path)),sourceHash=String(hash(fixture));check(r,'FLAC preserves exact decoded source audio at common PCM24 precision',outputHash,sourceHash);r.actual={...(r.actual as object),decodedAudioHash:{sampleCodec:'pcm_s24le',source:sourceHash.trim(),output:outputHash.trim()}};r.level='decoded-audio-hash-and-output-probed';}
    else if(id==='shortest'){near(r,'Output stops near shorter 1.2 second video',seconds(out),1.2,0.1);check(r,'Fixture audio duration exceeds resulting output',seconds(probe(unevenFixture))>seconds(out)+0.4,true);}
    else if(id==='disable-subtitles'){check(r,'Fixture has subtitle stream',probe(richFixture).streams.some(s=>s.codec_type==='subtitle'),true);check(r,'Output has no subtitle',out.streams.some(s=>s.codec_type==='subtitle'),false);}
    else if(id==='disable-data'){check(r,'Output has no data stream',out.streams.some(s=>s.codec_type==='data'),false);r.level='execution-only for removal effect; synthetic source has no data track';}
    else if(id==='faststart'){const data=readFileSync(path);const moov=data.indexOf(Buffer.from('moov')),mdat=data.indexOf(Buffer.from('mdat'));check(r,'MP4 has both moov and mdat boxes',moov>0&&mdat>0,true);check(r,'MP4 moov index precedes media data',moov<mdat,true);r.actual={...(r.actual as object),moovOffset:moov,mdatOffset:mdat};}
    else if(id==='remove-metadata'){check(r,'Source has inherited custom title',probe(richFixture).format.tags.title,'Inherited Title');check(r,'Inherited title removed',out.format.tags?.title,undefined);check(r,'Inherited artist removed',out.format.tags?.ARTIST??out.format.tags?.artist,undefined);}
    else if(id==='remove-chapters'){check(r,'Source contains chapters',probe(richFixture).chapters?.length,2);check(r,'Output chapters removed',out.chapters?.length??0,0);}
    else if(definition.metadataKey){const tags=out.format.tags??{};check(r,'Metadata written verbatim',tags[definition.metadataKey]??tags[definition.metadataKey.toUpperCase()],setting);}
    else if(id==='muxing-queue'){check(r,'Queue size is present in compiled argv',args[args.indexOf('-max_muxing_queue_size')+1],'128');r.level='execution-only for buffer-pressure effect; no exhaustion fixture';}
  });
  const invalid: unknown=definition.control==='toggle'?'true':definition.control==='select'?'not-a-choice':definition.control==='number'?String((definition.max??100)+1):'contains\0nul';
  row(`advanced-invalid-${id}`,id,invalid,'validation-rejection',(r)=>{assert.throws(()=>applyAdvancedSetting(applicable(id),id,invalid as string));r.assertions.push('Invalid control value rejected before command generation');});
}
for(const [name,patch] of Object.entries({ 'height-odd':{resize:'custom',customHeight:241},'height-zero':{customHeight:0},'height-too-high':{customHeight:8194},'volume-negative':{volume:-0.1},'volume-too-high':{volume:4.1},'trim-negative':{trimEnabled:true,trimStart:'-1'},'trim-zero-duration':{trimEnabled:true,trimDuration:'0'},'trim-bad-minute':{trimEnabled:true,trimStart:'00:60:00'},'trim-bad-second':{trimEnabled:true,trimStart:'00:00:60'},'trim-text':{trimEnabled:true,trimDuration:'abc'},'webm-h264':{format:'webm',videoEncoding:'compatible'},'mp4-vp9':{format:'mp4',videoEncoding:'web'} })) row(`invalid-${name}`,'friendly',patch,'validation-rejection',(r)=>{assert.throws(()=>applyFeatureConfig(base(name),patch as Partial<FeatureConfig>));r.assertions.push('Invalid configuration rejected before FFmpeg');});
for(const definition of advancedSettings.filter(d=>d.control==='select')) for(const choice of definition.choices!) {
  if(choice.value===settingValues[definition.id])continue;
  row(`advanced-choice-${definition.id}-${choice.value.replaceAll(':','-')}`,definition.id,choice.value,'output-probed',(r)=>{
    const id=definition.id;let p=base(r.id);if(id==='flac-compression'||(id==='audio-sample-format'&&choice.value==='s32'))p=applyFeatureConfig(p,{purpose:'audio',format:'flac'});else if(id==='audio-sample-format'&&choice.value==='s16')p=applyFeatureConfig(p,{purpose:'audio',format:'wav'});
    if(id==='video-maxrate')p=applyAdvancedSetting(p,'video-buffer','40M');if(id==='video-buffer')p=applyAdvancedSetting(p,'video-maxrate','2M');if(id==='color-range')p=applyAdvancedSetting(p,'color-space','bt709');
    p=applyAdvancedSetting(p,id,choice.value);const {p:out,log,args}=execute(r,p);const v=video(out),a=audio(out);
    if(id==='video-bitrate')check(r,'Encoder target bitrate',logParameter(log,'bitrate',Number(choice.value.slice(0,-1))*1000),true);
    else if(id==='video-maxrate')check(r,'Encoder maximum bitrate',logParameter(log,'vbv_maxrate',Number(choice.value.slice(0,-1))*1000),true);
    else if(id==='video-buffer')check(r,'Encoder buffer size',logParameter(log,'vbv_bufsize',Number(choice.value.slice(0,-1))*1000),true);
    else if(id==='b-frames')check(r,'Encoder B-frame limit',logParameter(log,'bframes',choice.value),true);
    else if(id==='pixel-format')check(r,'Pixel storage format',v?.pix_fmt,choice.value);
    else if(id==='h264-profile')check(r,'H.264 profile',v?.profile,{baseline:'Constrained Baseline',main:'Main',high:'High'}[choice.value as 'main']);
    else if(id==='h264-level')check(r,'H.264 level',v?.level,Number(choice.value)*10);
    else if(id==='color-range')check(r,'Color range',v?.color_range,choice.value);
    else if(id==='color-space')check(r,'Color matrix',v?.color_space,choice.value);
    else if(id==='color-primaries')check(r,'Color primaries',v?.color_primaries,choice.value);
    else if(id==='color-transfer')check(r,'Color transfer',v?.color_transfer,choice.value);
    else if(id==='display-aspect'){const[a,b]=choice.value.split(':').map(Number);const[c,d]=String(v?.display_aspect_ratio).split(':').map(Number);near(r,'Display aspect ratio',c/d,a/b,0.001);}
    else if(id==='frame-timing'){check(r,'Frame timing mode mapped',args[args.indexOf('-fps_mode')+1],choice.value);near(r,'Fixed-rate fixture timing retained',fps(v),30,0.001);r.level='mapping-and-output-probed; VFR source not included';}
    else if(id==='audio-channels')check(r,'Audio channels',a?.channels,Number(choice.value));
    else if(id==='audio-sample-format')check(r,'Audio sample precision',a?.sample_fmt,choice.value);
    else if(id==='flac-compression'){check(r,'FLAC codec',a?.codec_name,'flac');check(r,'Compression strength mapped',args[args.indexOf('-compression_level')+1],choice.value);r.level='mapping-and-output-probed; exact losslessness covered by strength 8 hash';}
  });
}
for(const mode of ['cfr','vfr','passthrough']) row(`variable-frame-timing-${mode}`,'frame-timing',{mode,source:'variable frame intervals'},'decoded-frame-timestamps',(r)=>{
  const p=applyAdvancedSetting(base(r.id,'mp4',variableFixture),'frame-timing',mode);const{path}=execute(r,p);
  const times=(input:string)=>JSON.parse(String(command(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',input]).stdout)).frames.map((f:any)=>Number(f.best_effort_timestamp_time)) as number[];
  const sourceTimes=times(variableFixture),outTimes=times(path);const intervals=outTimes.slice(1).map((time,i)=>Math.round((time-outTimes[i])*1000000));
  if(mode==='cfr'){check(r,'CFR makes all intervals uniform within two microseconds',Math.max(...intervals)-Math.min(...intervals)<=2,true);check(r,'CFR adds frames to variable-rate source',outTimes.length>sourceTimes.length,true);}else{check(r,'Variable mode preserves frame count',outTimes.length,sourceTimes.length);check(r,'Variable mode preserves frame timestamps',outTimes,sourceTimes);check(r,'Variable intervals remain nonuniform',Math.max(...intervals)-Math.min(...intervals)>30000,true);}
  r.actual={...(r.actual as object),sourceFrameTimestamps:sourceTimes,outputFrameTimestamps:outTimes};
});
runFeature('combination-video',{format:'mp4',videoEncoding:'compatible',quality:'high',speed:'slow',rotation:'clockwise',flipHorizontal:true,resize:'custom',customHeight:240,fps:'24',trimEnabled:true,trimStart:'0.2',trimDuration:'0.5',audioSampleRate:'48000',volume:0.5},(r,{p})=>{check(r,'Combined resize after portrait rotation',[video(p)?.width,video(p)?.height],[136,240]);near(r,'Combined FPS',fps(video(p)),24,0.001);near(r,'Combined trim duration',seconds(p),0.5,0.1);check(r,'Combined sample rate',audio(p)?.sample_rate,'48000');});
runFeature('combination-audio',{purpose:'audio',format:'flac',audioSampleRate:'48000',volume:2,trimEnabled:true,trimStart:'00:00:00.200',trimDuration:'00:00:00.500'},(r,{p})=>{check(r,'Combined lossless extraction',audio(p)?.codec_name,'flac');check(r,'Combined sample rate',audio(p)?.sample_rate,'48000');near(r,'Combined audio duration',seconds(p),0.5,0.03);check(r,'No video',Boolean(video(p)),false);});
save();
console.log(JSON.stringify({total:rows.length,passed:rows.filter(r=>r.status==='pass').length,failed:rows.filter(r=>r.status==='fail').length,blocked:rows.filter(r=>r.status==='blocked').length}));
process.exitCode=rows.some(r=>r.status==='fail')?1:0;
