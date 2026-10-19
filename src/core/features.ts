import { assertProjectDocument } from './project';
import type { CommandNode, ProjectDocument } from './types';

export type FeaturePurpose = 'compress' | 'convert' | 'trim' | 'resize' | 'audio' | 'mute';
export type FeatureFormat = 'mp4' | 'mkv' | 'mov' | 'webm' | 'mp3' | 'wav' | 'flac';
export interface FeatureConfig {
  purpose: FeaturePurpose;
  format: FeatureFormat;
  videoEncoding: 'compatible' | 'efficient' | 'builtin' | 'web';
  quality: 'high' | 'balanced' | 'small';
  speed: 'fast' | 'medium' | 'slow';
  resize: 'original' | '1080' | '720' | '480' | 'custom';
  customHeight: number;
  rotation: 'none' | 'clockwise' | 'counterclockwise' | 'half';
  flipHorizontal: boolean;
  flipVertical: boolean;
  fps: 'original' | '24' | '25' | '30' | '60';
  trimEnabled: boolean;
  trimStart: string;
  trimDuration: string;
  audioMode: 'keep' | 'mute' | 'extract';
  audioBitrate: '96' | '128' | '192' | '320';
  audioSampleRate: 'original' | '44100' | '48000';
  /** Multiplier; 1 keeps the original loudness. */
  volume: number;
}
export interface FeatureWarning {
  code: 'unsupported' | 'pending' | 'multiple-outputs' | 'demo-duration';
  message: string;
  nodeId?: string;
}
export interface FeatureReadResult {
  config: FeatureConfig;
  warnings: FeatureWarning[];
  readonly: boolean;
}
export interface AdvancedSettingDefinition {
  id: string;
  label: string;
  category: '视频' | '音频' | '兼容性' | '文件组织';
  description: string;
  control: 'select' | 'number' | 'toggle' | 'text';
  choices?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
  defaultValue?: string | boolean;
  option: string;
  /** Whether the current prototype runner accepts this option, not a codec guarantee. */
  executable: boolean;
  compatibleFormats?: FeatureFormat[];
  compatibleCodecs?: string[];
  metadataKey?: string;
  trueValue?: string;
}

const choices = (...values: string[]): { value: string; label: string }[] => values.map((value) => ({ value, label: value }));
export const advancedSettings: AdvancedSettingDefinition[] = [
  { id: 'video-bitrate', label: '视频目标码率', category: '视频', description: '每秒分配给画面的数据量。增大会改善画质，也会增大文件；选择后改用目标码率控制。', control: 'select', choices: ['1M', '2M', '4M', '8M', '12M', '20M'].map((value) => ({ value, label: `${value.replace('M', '')} Mbps` })), option: '-b:v', executable: true },
  { id: 'video-maxrate', label: '视频码率上限', category: '视频', description: '限制高运动画面的最高码率。通常需要同时设置“码率缓冲区”。', control: 'select', choices: choices('2M', '4M', '8M', '12M', '20M'), option: '-maxrate', executable: true },
  { id: 'video-buffer', label: '码率缓冲区', category: '视频', description: '平滑码率波动。通常可设为码率上限的两倍，例如上限 4M 配合缓冲区 8M。', control: 'select', choices: choices('4M', '8M', '16M', '24M', '40M'), option: '-bufsize', executable: true },
  { id: 'keyframe-interval', label: '关键帧间隔', category: '视频', description: '每隔多少帧插入一个完整画面。较短间隔方便拖动和剪辑，文件可能更大。', control: 'number', min: 1, max: 1000, unit: '帧', option: '-g', executable: true },
  { id: 'b-frames', label: '双向预测帧数量', category: '视频', description: '在完整画面之间加入预测帧以减小文件。0 表示关闭；可用范围由编码器决定。', control: 'select', choices: choices('0', '1', '2', '3'), option: '-bf', executable: true },
  { id: 'threads', label: '处理线程数', category: '视频', description: '0 让编码器自动选择。较少线程便于同时使用电脑，但不保证所有编码器都遵守。', control: 'number', min: 0, max: 64, defaultValue: '0', option: '-threads', executable: true },
  { id: 'pixel-format', label: '画面颜色存储方式', category: '兼容性', description: '普通设备建议 yuv420p。10 位格式需要编码器和播放器同时支持。', control: 'select', choices: [{ value: 'yuv420p', label: '标准 8 位 · 兼容性优先' }, { value: 'yuv420p10le', label: '10 位 · 需设备支持' }, { value: 'yuv444p', label: '4:4:4 · 需设备支持' }], option: '-pix_fmt', executable: true },
  { id: 'h264-profile', label: 'H.264 播放兼容级别', category: '兼容性', description: 'Baseline 面向较旧设备，High 通常有更高压缩效率。仅适用于 H.264 编码器。', control: 'select', choices: [{ value: 'baseline', label: 'Baseline · 旧设备' }, { value: 'main', label: 'Main · 通用' }, { value: 'high', label: 'High · 高压缩效率' }], option: '-profile:v', executable: true, compatibleCodecs: ['libx264'] },
  { id: 'h264-level', label: 'H.264 设备解码等级', category: '兼容性', description: '约束分辨率、帧率和码率的组合。只有目标设备明确要求时才设置。', control: 'select', choices: choices('3.1', '4.0', '4.1', '4.2', '5.1'), option: '-level:v', executable: true, compatibleCodecs: ['libx264'] },
  { id: 'color-range', label: '颜色数值范围标记', category: '兼容性', description: '告诉播放器视频使用电视范围还是全范围；此项只改变标记，不转换实际颜色。', control: 'select', choices: [{ value: 'tv', label: '电视范围' }, { value: 'pc', label: '全范围' }], option: '-color_range', executable: true },
  { id: 'color-space', label: '色彩矩阵标记', category: '兼容性', description: '标记颜色的转换矩阵。高清 SDR 常用 BT.709；此项不自动完成颜色转换。', control: 'select', choices: choices('bt709', 'bt470bg', 'smpte170m', 'bt2020nc'), option: '-colorspace', executable: true },
  { id: 'color-primaries', label: '色域标记', category: '兼容性', description: '标记视频的原色坐标。与素材不一致的标记会导致显示颜色异常。', control: 'select', choices: choices('bt709', 'bt470bg', 'bt2020'), option: '-color_primaries', executable: true },
  { id: 'color-transfer', label: '亮度曲线标记', category: '兼容性', description: '标记 SDR 或 HDR 亮度曲线。选择 HDR 标记不会把普通视频转换成 HDR。', control: 'select', choices: [{ value: 'bt709', label: 'BT.709 · 常用 SDR' }, { value: 'smpte2084', label: 'PQ · HDR' }, { value: 'arib-std-b67', label: 'HLG · HDR' }], option: '-color_trc', executable: true },
  { id: 'display-aspect', label: '播放显示比例', category: '视频', description: '设置播放器的显示比例，例如 16:9。只改变显示比例标记，不裁剪画面。', control: 'select', choices: choices('16:9', '4:3', '1:1', '9:16', '21:9'), option: '-aspect', executable: true },
  { id: 'frame-timing', label: '帧率时间处理', category: '兼容性', description: '固定帧率便于部分剪辑软件读取；保留时间戳适合可变帧率素材。', control: 'select', choices: [{ value: 'cfr', label: '固定帧率' }, { value: 'vfr', label: '可变帧率' }, { value: 'passthrough', label: '保留帧时间戳' }], option: '-fps_mode', executable: true },
  { id: 'audio-channels', label: '声音声道', category: '音频', description: '单声道适合语音；立体声适合普通音乐和视频。多声道混音方式由 FFmpeg 默认规则决定。', control: 'select', choices: [{ value: '1', label: '单声道' }, { value: '2', label: '立体声' }, { value: '6', label: '5.1 声道 · 需编码器支持' }], option: '-ac', executable: true },
  { id: 'audio-sample-format', label: '声音采样精度', category: '音频', description: '控制编码前的声音数据格式，须由声音编码器支持。一般保留自动选择即可。', control: 'select', choices: [{ value: 's16', label: '16 位整数' }, { value: 's32', label: '32 位整数' }, { value: 'fltp', label: '浮点 · 平面存储' }], option: '-sample_fmt', executable: true },
  { id: 'flac-compression', label: 'FLAC 无损压缩强度', category: '音频', description: '0 最快，8 压缩更紧密。只影响处理时间和文件大小，不降低声音质量。', control: 'select', choices: choices('0', '2', '5', '8'), option: '-compression_level', executable: true, compatibleFormats: ['flac'], compatibleCodecs: ['flac'] },
  { id: 'shortest', label: '声音或画面先结束时停止', category: '文件组织', description: '当最短的流结束时结束输出，适合声音和视频时长不一致的素材。', control: 'toggle', defaultValue: false, option: '-shortest', executable: true },
  { id: 'disable-subtitles', label: '移除字幕轨道', category: '文件组织', description: '不把字幕流写入文件。已经烧录进画面的字幕无法用此项移除。', control: 'toggle', defaultValue: false, option: '-sn', executable: true },
  { id: 'disable-data', label: '移除附加数据轨道', category: '文件组织', description: '移除普通播放不需要的数据流，例如部分设备附加数据。', control: 'toggle', defaultValue: false, option: '-dn', executable: true },
  { id: 'faststart', label: '优化网页起播速度', category: '兼容性', description: '把 MP4/MOV 的索引放到文件前部，使在线播放更早开始；不改变画质。', control: 'toggle', defaultValue: false, option: '-movflags', trueValue: '+faststart', executable: true, compatibleFormats: ['mp4', 'mov'] },
  { id: 'remove-metadata', label: '移除继承的文件信息', category: '文件组织', description: '不自动复制标题、作者等元数据。手动填写的文件信息仍会写入。', control: 'toggle', defaultValue: false, option: '-map_metadata', trueValue: '-1', executable: true },
  { id: 'remove-chapters', label: '移除章节', category: '文件组织', description: '不把原文件的章节目录复制到输出。', control: 'toggle', defaultValue: false, option: '-map_chapters', trueValue: '-1', executable: true },
  { id: 'title', label: '文件标题', category: '文件组织', description: '填写播放器显示的标题。可留空以恢复自动继承；容器支持情况不同。', control: 'text', option: '-metadata', metadataKey: 'title', executable: true },
  { id: 'artist', label: '作者或演出者', category: '文件组织', description: '填写文件的作者或演出者信息；容器支持情况不同。', control: 'text', option: '-metadata', metadataKey: 'artist', executable: true },
  { id: 'comment', label: '备注', category: '文件组织', description: '在文件中保存简短备注；不改变输出文件名。', control: 'text', option: '-metadata', metadataKey: 'comment', executable: true },
  { id: 'muxing-queue', label: '封装等待队列大小', category: '兼容性', description: '只在出现“Too many packets buffered”错误时尝试增大，数值越大可能占用更多内存。', control: 'number', min: 1, max: 65536, unit: '包', option: '-max_muxing_queue_size', executable: true },
];

const formats: FeatureFormat[] = ['mp4', 'mkv', 'mov', 'webm', 'mp3', 'wav', 'flac'];
const audioFormats = new Set<FeatureFormat>(['mp3', 'wav', 'flac']);
const videoCodecs = new Set(['mpeg4', 'libx264', 'libx265', 'libvpx-vp9']);
const codecOptions = ['-c:v', '-crf', '-q:v', '-preset'];
const videoOnlyOptions = new Set([...codecOptions, '-b:v', '-maxrate', '-minrate', '-bufsize', '-r', '-s', '-vf', '-pix_fmt', '-profile:v', '-level:v', '-g', '-bf', '-aspect', '-fps_mode', '-color_range', '-colorspace', '-color_primaries', '-color_trc', '-tag:v']);
const featureOptions = new Set(['-f', ...videoOnlyOptions, '-an', '-vn', '-c:a', '-b:a', '-ar', '-af', '-ss', '-t', '-to']);
const advancedOptions = new Set(advancedSettings.map((item) => item.option));
// Intersection of the current UI's s16/s32/fltp candidates with each supported
// encoder's advertised formats. This is intentionally not a full FFmpeg
// capability catalogue: MP3 also accepts planar integer formats and Opus flt,
// neither of which is offered by this version's controls.
const audioSampleChoices: Readonly<Record<string, readonly string[]>> = {
  aac: ['fltp'], pcm_s16le: ['s16'], flac: ['s16', 's32'], libmp3lame: ['fltp'], libopus: ['s16'],
};
const audioCodecLabels: Readonly<Record<string, string>> = { aac: 'AAC', pcm_s16le: 'WAV 16 位 PCM', flac: 'FLAC', libmp3lame: 'MP3', libopus: 'Opus' };
const limitedH264Profiles = new Set(['baseline', 'main', 'high']);
const nonstandardH264PixelChoices = new Set(['yuv420p10le', 'yuv444p']);
const audioCodecForFormat = (format: FeatureFormat): string => format === 'mp3' ? 'libmp3lame' : format === 'wav' ? 'pcm_s16le' : format === 'flac' ? 'flac' : format === 'webm' ? 'libopus' : 'aac';

function opusBitrateIssue(project: ProjectDocument, format: FeatureFormat, bitrate: string): string | undefined {
  if (format !== 'webm' || bitrate !== '320') return undefined;
  const channels = Number(value(project, '-ac'));
  if (!Number.isInteger(channels) || channels < 2) return 'WebM 的 Opus 声音使用 320 kbps 时，请先在“声音声道”选择立体声或多声道；单声道或自动声道请使用 192 kbps 及以下。';
  return undefined;
}

function opusSampleRateIssue(format: FeatureFormat, sampleRate: string): string | undefined {
  return format === 'webm' && sampleRate === '44100' ? 'WebM 的 Opus 声音不支持 44.1 kHz；请选择 48 kHz 或自动适配。' : undefined;
}

/** Friendly WebM/Opus constraints, not a bitrate/rate catalogue for every build. */
export function getAudioBitrateIssue(project: ProjectDocument, bitrate: string): string | undefined {
  const { config } = readFeatureConfig(project);
  return config.audioMode === 'mute' ? undefined : opusBitrateIssue(project, config.format, bitrate);
}

export function getAudioSampleRateIssue(project: ProjectDocument, sampleRate: string): string | undefined {
  const { config } = readFeatureConfig(project);
  return config.audioMode === 'mute' ? undefined : opusSampleRateIssue(config.format, sampleRate);
}

function rangeOf(project: ProjectDocument): { start: number; end: number } | undefined {
  let start = 0;
  for (let index = 0; index < project.nodes.length; index++) {
    const node = project.nodes[index];
    if (!node.enabled) continue;
    if (node.kind === 'output') return { start, end: index };
    if (node.kind === 'input') start = index + 1;
  }
  return undefined;
}

function group(project: ProjectDocument): CommandNode[] {
  const range = rangeOf(project);
  return range ? project.nodes.slice(range.start, range.end).filter((node) => node.enabled) : [];
}

function option(project: ProjectDocument, name: string): CommandNode | undefined {
  return group(project).reverse().find((node) => node.kind === 'option' && node.tokens[0] === name);
}

function value(project: ProjectDocument, name: string): string | undefined {
  return option(project, name)?.tokens[1];
}

function isDemo(project: ProjectDocument): boolean {
  return project.nodes.some((node) => node.enabled && node.kind === 'input' && /^testsrc2(?:=|$)/.test(node.tokens[1] ?? ''));
}

function detectedFormat(project: ProjectDocument): FeatureFormat | undefined {
  const range = rangeOf(project);
  if (!range) return undefined;
  const forced = value(project, '-f');
  const muxer = forced === 'matroska' ? 'mkv' : forced;
  if (muxer && formats.includes(muxer as FeatureFormat)) return muxer as FeatureFormat;
  const suffix = project.nodes[range.end].tokens[0]?.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase();
  return formats.includes(suffix as FeatureFormat) ? suffix as FeatureFormat : undefined;
}

const has = (patch: Partial<FeatureConfig>, name: keyof FeatureConfig): boolean => Object.prototype.hasOwnProperty.call(patch, name);
const oneOf = <T extends string>(candidate: string | undefined, allowed: readonly T[], fallback: T): T => allowed.includes(candidate as T) ? candidate as T : fallback;

/** Read only verified simple controls; warning messages disclose values that cannot be represented. */
export function readFeatureConfig(project: ProjectDocument): FeatureReadResult {
  assertProjectDocument(project);
  const warnings: FeatureWarning[] = [];
  let readonly = false;
  const unsupported = (message: string, nodeId?: string) => { warnings.push({ code: 'unsupported', message, nodeId }); readonly = true; };
  const range = rangeOf(project);
  if (!range) unsupported('工程没有可配置的输出文件。请先添加输出文件。');
  const outputCount = project.nodes.filter((node) => node.enabled && node.kind === 'output').length;
  if (outputCount > 1) warnings.push({ code: 'multiple-outputs', message: '当前配置只作用于第一个输出文件；其他输出保持原样。' });
  for (const node of project.nodes) {
    if (!node.enabled) continue;
    if (node.kind === 'opaque') unsupported('工程含有未经解释的命令片段。为保留原工程，本页只读。', node.id);
    if (node.kind === 'option' && ['-filter_complex', '-filter_complex_script', '-lavfi'].includes(node.tokens[0])) unsupported('工程使用复杂滤镜图，功能面板无法完整表达其连接关系。本页只读。', node.id);
  }
  for (const node of group(project)) {
    if (node.kind !== 'option') continue;
    const name = node.tokens[0];
    if (['-c', '-codec', '-vcodec', '-acodec', '-filter:v', '-filter:a', '-filter_script', '-map'].includes(name) || /^-(?:c|codec|vf|af|b|r|s|ss|t):[va]:/.test(name)) {
      unsupported(`工程使用 ${name} 的流选择或别名配置。为避免更改错误的流，本页只读。`, node.id);
    } else if (!featureOptions.has(name) && !advancedOptions.has(name) && !['-hide_banner', '-loglevel', '-nostats', '-progress', '-y', '-n', '-sn', '-dn'].includes(name)) {
      warnings.push({ code: 'pending', message: `已保留 ${name} 的原始配置，此设置尚未映射为功能。`, nodeId: node.id });
    }
    if ((featureOptions.has(name) || advancedOptions.has(name)) && node.tokens.length > 2) unsupported(`${name} 包含多个原始值，不能用单值控件安全修改。`, node.id);
  }
  const format = detectedFormat(project);
  if (!format && range) unsupported('当前输出格式尚未映射到这些功能。原文件和参数已保留。', project.nodes[range.end].id);
  const codec = value(project, '-c:v');
  if (codec && !videoCodecs.has(codec) && !audioFormats.has(format ?? 'mp4')) unsupported(`当前视频编码器 ${codec} 的设置尚未映射，本页只读。`, option(project, '-c:v')?.id);
  const trimDuration = value(project, '-t') ?? '5';
  const staleDemoDuration = !isDemo(project) && project.id === 'demo-project' && option(project, '-t')?.id === 'duration' && value(project, '-t') === '5';
  if (staleDemoDuration) warnings.push({ code: 'demo-duration', message: '已识别测试画面遗留的 5 秒限制。下一次应用功能设置时会移除，真实素材默认输出完整时长。' });
  const qualityNumber = Number(codec === 'mpeg4' ? value(project, '-q:v') : value(project, '-crf'));
  const quality: FeatureConfig['quality'] = codec === 'mpeg4'
    ? qualityNumber === 2 ? 'high' : qualityNumber === 8 ? 'small' : 'balanced'
    : qualityNumber === 18 || (codec === 'libvpx-vp9' && qualityNumber === 28) ? 'high' : qualityNumber === 28 || (codec === 'libvpx-vp9' && qualityNumber === 40) ? 'small' : 'balanced';
  const audioMode: FeatureConfig['audioMode'] = option(project, '-vn') || audioFormats.has(format ?? 'mp4') ? 'extract' : option(project, '-an') ? 'mute' : 'keep';
  const config: FeatureConfig = {
    purpose: oneOf(typeof project.friendlyPurpose === 'string' ? project.friendlyPurpose : undefined, ['compress', 'convert', 'trim', 'resize', 'audio', 'mute'], audioMode === 'extract' ? 'audio' : audioMode === 'mute' && !isDemo(project) ? 'mute' : 'compress'),
    format: format ?? 'mp4', quality,
    videoEncoding: codec === 'libx265' ? 'efficient' : codec === 'mpeg4' ? 'builtin' : codec === 'libvpx-vp9' || (!codec && format === 'webm') ? 'web' : codec === 'libx264' ? 'compatible' : isDemo(project) ? 'builtin' : 'compatible',
    speed: oneOf(value(project, '-preset'), ['fast', 'medium', 'slow'], 'medium'),
    resize: 'original', customHeight: 720, rotation: 'none', flipHorizontal: false, flipVertical: false,
    fps: oneOf(value(project, '-r'), ['24', '25', '30', '60'], 'original'),
    trimEnabled: !staleDemoDuration && Boolean(option(project, '-ss') || option(project, '-t') || option(project, '-to')),
    trimStart: value(project, '-ss') ?? '0', trimDuration,
    audioMode,
    audioBitrate: oneOf(value(project, '-b:a')?.replace(/k$/i, ''), ['96', '128', '192', '320'], '192'),
    audioSampleRate: oneOf(value(project, '-ar'), ['44100', '48000'], 'original'),
    volume: 1,
  };
  const videoFilterNodes = group(project).filter((node) => node.kind === 'option' && node.tokens[0] === '-vf');
  const audioFilterNodes = group(project).filter((node) => node.kind === 'option' && node.tokens[0] === '-af');
  if (videoFilterNodes.length > 1 || audioFilterNodes.length > 1) unsupported('工程包含重复滤镜链。功能面板不能无损合并，本页只读。');
  const filters = (value(project, '-vf') ?? '').split(',').filter(Boolean);
  let scales = 0; let rotations = 0; let horizontalFlips = 0; let verticalFlips = 0; let frameRates = 0;
  for (const filter of filters) {
    const scale = filter.match(/^scale=-2:(\d+)$/);
    const fps = filter.match(/^fps=(24|25|30|60)$/);
    if (scale) {
      scales++;
      config.customHeight = Number(scale[1]);
      config.resize = project.friendlyResize === 'custom' ? 'custom' : oneOf(scale[1], ['1080', '720', '480'], 'custom');
    } else if (filter === 'transpose=1') { config.rotation = 'clockwise'; rotations++; }
    else if (filter === 'transpose=2') { config.rotation = 'counterclockwise'; rotations++; }
    else if (filter === 'hflip') { config.flipHorizontal = true; horizontalFlips++; }
    else if (filter === 'vflip') { config.flipVertical = true; verticalFlips++; }
    else if (fps) { config.fps = fps[1] as FeatureConfig['fps']; frameRates++; }
    else unsupported(`滤镜“${filter}”尚未映射为可视化功能。原始滤镜已保留，本页只读。`, option(project, '-vf')?.id);
  }
  // Our half turn is represented by two flips. Preserve the distinction through project metadata.
  if (project.friendlyRotation === 'half') {
    config.rotation = 'half'; config.flipHorizontal = !config.flipHorizontal; config.flipVertical = !config.flipVertical;
  }
  if ([scales, rotations, horizontalFlips, verticalFlips, frameRates].some((count) => count > 1) || (scales > 0 && filters.findIndex((filter) => filter.startsWith('scale=')) < filters.findIndex((filter) => filter.startsWith('transpose=')))) unsupported('滤镜的重复项或执行顺序无法由当前功能面板无损表示，本页只读。');
  const audioFilter = value(project, '-af');
  if (audioFilter) {
    const volume = audioFilter.match(/^volume=(\d+(?:\.\d+)?)$/);
    if (volume && Number(volume[1]) <= 4) config.volume = Number(volume[1]);
    else unsupported('声音滤镜包含音量调整以外的处理。原始声音处理已保留，本页只读。', option(project, '-af')?.id);
  }
  if (option(project, '-s')) unsupported('工程用固定宽高设置输出尺寸，而当前功能使用保持比例的高度。原始尺寸已保留，本页只读。', option(project, '-s')?.id);
  if (option(project, '-r') && filters.some((filter) => filter.startsWith('fps='))) unsupported('工程同时设置输出帧率与帧率滤镜，当前功能不能无损合并。本页只读。');
  if (filters.length && !readonly) {
    const canonical: string[] = [];
    if (config.rotation === 'clockwise') canonical.push('transpose=1');
    if (config.rotation === 'counterclockwise') canonical.push('transpose=2');
    if ((config.rotation === 'half') !== config.flipHorizontal) canonical.push('hflip');
    if ((config.rotation === 'half') !== config.flipVertical) canonical.push('vflip');
    if (config.resize !== 'original') canonical.push(`scale=-2:${config.resize === 'custom' ? config.customHeight : config.resize}`);
    if (config.fps !== 'original' && !option(project, '-r')) canonical.push(`fps=${config.fps}`);
    if (canonical.join(',') !== filters.join(',')) unsupported('滤镜的执行顺序不能由当前功能面板无损表示。原始顺序已保留，本页只读。');
  }
  if (value(project, '-to')) unsupported('工程使用结束时间裁剪，当前功能面板使用持续时长。原始裁剪已保留，本页只读。', option(project, '-to')?.id);
  return { config, warnings, readonly };
}

function removeOptions(project: ProjectDocument, names: Set<string>): void {
  const range = rangeOf(project);
  if (!range) return;
  // Disabled nodes are kept for a future advanced editor; only active command instances are replaced.
  project.nodes = project.nodes.filter((node, index) => !(index >= range.start && index < range.end && node.enabled && node.kind === 'option' && names.has(node.tokens[0])));
}

function putOption(project: ProjectDocument, name: string, argument?: string): void {
  removeOptions(project, new Set([name]));
  const range = rangeOf(project);
  if (!range) throw new Error('找不到输出文件。');
  project.nodes.splice(range.end, 0, { id: crypto.randomUUID(), kind: 'option', enabled: true, tokens: argument === undefined ? [name] : [name, argument], scope: 'output-1' });
}

function validateConfig(config: FeatureConfig): void {
  const enumerations: Partial<Record<keyof FeatureConfig, readonly string[]>> = {
    purpose: ['compress', 'convert', 'trim', 'resize', 'audio', 'mute'],
    format: formats,
    videoEncoding: ['compatible', 'efficient', 'builtin', 'web'],
    quality: ['high', 'balanced', 'small'], speed: ['fast', 'medium', 'slow'],
    resize: ['original', '1080', '720', '480', 'custom'],
    rotation: ['none', 'clockwise', 'counterclockwise', 'half'],
    fps: ['original', '24', '25', '30', '60'],
    audioMode: ['keep', 'mute', 'extract'], audioBitrate: ['96', '128', '192', '320'],
    audioSampleRate: ['original', '44100', '48000'],
  };
  for (const [key, allowed] of Object.entries(enumerations)) {
    const selected = config[key as keyof FeatureConfig];
    if (typeof selected !== 'string' || !allowed!.includes(selected)) throw new Error(`配置 ${key} 的值无效，请使用提供的选项。`);
  }
  for (const key of ['flipHorizontal', 'flipVertical', 'trimEnabled'] as const) {
    if (typeof config[key] !== 'boolean') throw new Error(`配置 ${key} 需要开关值。`);
  }
  if (typeof config.trimStart !== 'string' || typeof config.trimDuration !== 'string') throw new Error('裁剪时间需要文本值。');
  if (!Number.isInteger(config.customHeight) || config.customHeight < 2 || config.customHeight > 8192 || config.customHeight % 2 !== 0) throw new Error('自定义高度应为 2 到 8192 之间的偶数。');
  if (!Number.isFinite(config.volume) || config.volume < 0 || config.volume > 4) throw new Error('音量倍率须介于 0 和 4 之间。');
  if (config.trimEnabled) {
    const seconds = (time: string): number => {
      if (!/^\d+(?:\.\d+)?$|^\d+:\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(time)) return NaN;
      const parts = time.split(':').map(Number);
      if (parts.length === 3 && (parts[1] >= 60 || parts[2] >= 60)) return NaN;
      return parts.reduce((sum, part) => sum * 60 + part, 0);
    };
    if (!Number.isFinite(seconds(config.trimStart)) || !Number.isFinite(seconds(config.trimDuration)) || seconds(config.trimDuration) <= 0) throw new Error('裁剪开始时间应大于等于 0，持续时长应大于 0；支持秒数或 HH:MM:SS。');
  }
  const strings = Object.values(config).filter((entry): entry is string => typeof entry === 'string');
  if (strings.some((entry) => entry.includes('\0'))) throw new Error('配置内容不能包含 NUL 字符。');
}

/** Apply only the controls explicitly changed, within the first output's actual argv group. */
export function applyFeatureConfig(project: ProjectDocument, patch: Partial<FeatureConfig>): ProjectDocument {
  const read = readFeatureConfig(project);
  if (read.readonly) throw new Error(read.warnings.find((warning) => warning.code === 'unsupported')?.message ?? '当前工程只读。');
  const config = { ...read.config, ...patch };
  // Validate untrusted patches before they can influence codec lookup or be
  // normalized by a related control. Controls normally supply these enums, but
  // imported or future API callers must never generate an "undefined" argv.
  validateConfig(config);
  if (patch.purpose === 'audio' && !has(patch, 'audioMode')) config.audioMode = 'extract';
  if (patch.purpose === 'mute' && !has(patch, 'audioMode')) config.audioMode = 'mute';
  if (patch.purpose === 'audio' && !has(patch, 'format') && !audioFormats.has(config.format)) config.format = 'mp3';
  if (has(patch, 'format') && audioFormats.has(config.format)) config.audioMode = 'extract';
  if (has(patch, 'audioMode') && config.audioMode === 'extract' && !has(patch, 'format') && !audioFormats.has(config.format)) config.format = 'mp3';
  if (has(patch, 'audioMode') && config.audioMode !== 'extract' && audioFormats.has(config.format) && !has(patch, 'format')) config.format = 'mp4';
  const formatChanged = has(patch, 'format') || config.format !== read.config.format;
  const audioChange = ['audioMode', 'audioBitrate', 'audioSampleRate', 'volume'].some((key) => has(patch, key as keyof FeatureConfig)) || formatChanged || (has(patch, 'purpose') && ['audio', 'mute'].includes(config.purpose));
  let bitrateReset = false;
  let sampleRateReset = false;
  if (config.audioMode !== 'mute' && audioChange) {
    const bitrateIssue = opusBitrateIssue(project, config.format, config.audioBitrate);
    const sampleRateIssue = opusSampleRateIssue(config.format, config.audioSampleRate);
    if (has(patch, 'audioBitrate') && bitrateIssue) throw new Error(bitrateIssue);
    if (has(patch, 'audioSampleRate') && sampleRateIssue) throw new Error(sampleRateIssue);
    // Adapting an existing configuration to a new output format restores safe
    // values in argv itself, so both the controls and the parent's change toast
    // can explain the actual adjustment. Explicit conflicting choices reject.
    if (bitrateIssue) { config.audioBitrate = '192'; bitrateReset = true; }
    if (sampleRateIssue) { config.audioSampleRate = 'original'; sampleRateReset = true; }
  }
  if (formatChanged && !has(patch, 'videoEncoding')) config.videoEncoding = config.format === 'webm' ? 'web' : isDemo(project) ? 'builtin' : 'compatible';
  if (config.audioMode !== 'extract' && ((config.videoEncoding === 'web') !== (config.format === 'webm'))) throw new Error('WebM 格式请使用“网页视频”编码；其他视频格式请选择兼容、节省空间或内置编码。');
  if (isDemo(project) && !config.trimEnabled) throw new Error('测试画面会持续生成，需要保留输出时长。导入真实视频后可以输出完整视频。');
  validateConfig(config);
  const next = structuredClone(project);
  next.friendlyPurpose = config.purpose;
  if (read.warnings.some((warning) => warning.code === 'demo-duration')) removeOptions(next, new Set(['-t']));
  const extractionChanged = has(patch, 'audioMode') || has(patch, 'purpose') || formatChanged;
  if (formatChanged) {
    const range = rangeOf(next)!;
    const output = next.nodes[range.end];
    const path = output.tokens[0];
    output.tokens = [/\.[^./\\]+$/.test(path) ? path.replace(/\.[^./\\]+$/, `.${config.format}`) : `${path}.${config.format}`];
    putOption(next, '-f', config.format === 'mkv' ? 'matroska' : config.format);
    if (!['mp4', 'mov'].includes(config.format)) removeOptions(next, new Set(['-movflags']));
  }
  if (extractionChanged) {
    removeOptions(next, new Set(['-an', '-vn']));
    if (config.audioMode === 'extract') {
      removeOptions(next, videoOnlyOptions);
      // Presentation metadata must not describe filters removed from argv.
      next.friendlyRotation = 'none';
      next.friendlyResize = 'original';
      putOption(next, '-vn');
    } else if (config.audioMode === 'mute') putOption(next, '-an');
  }
  const videoChange = ['videoEncoding', 'quality', 'speed', 'resize', 'customHeight', 'rotation', 'flipHorizontal', 'flipVertical', 'fps'].some((key) => has(patch, key as keyof FeatureConfig));
  if (config.audioMode !== 'extract' && (videoChange || formatChanged || (extractionChanged && read.config.audioMode === 'extract'))) {
    const existingCodec = value(next, '-c:v');
    const codec = { compatible: 'libx264', efficient: 'libx265', builtin: 'mpeg4', web: 'libvpx-vp9' }[config.videoEncoding];
    if (existingCodec !== codec && codec !== 'libx264') removeOptions(next, new Set(['-profile:v', '-level:v']));
    if (existingCodec !== codec && codec === 'mpeg4' && value(next, '-pix_fmt') && value(next, '-pix_fmt') !== 'yuv420p') removeOptions(next, new Set(['-pix_fmt']));
    putOption(next, '-c:v', codec);
    if (has(patch, 'quality') || has(patch, 'videoEncoding') || formatChanged || existingCodec !== codec) {
      removeOptions(next, new Set(['-crf', '-q:v', '-b:v', '-minrate', '-maxrate', '-bufsize']));
      if (codec === 'mpeg4') putOption(next, '-q:v', String({ high: 2, balanced: 4, small: 8 }[config.quality]));
      else if (codec === 'libvpx-vp9') { putOption(next, '-crf', String({ high: 28, balanced: 32, small: 40 }[config.quality])); putOption(next, '-b:v', '0'); }
      else putOption(next, '-crf', String({ high: 18, balanced: 23, small: 28 }[config.quality]));
    }
    if (codec === 'libx264' || codec === 'libx265') putOption(next, '-preset', config.speed);
    else removeOptions(next, new Set(['-preset']));
  }
  if (config.audioMode !== 'extract' && ['resize', 'customHeight', 'rotation', 'flipHorizontal', 'flipVertical', 'fps'].some((key) => has(patch, key as keyof FeatureConfig))) {
    const filters: string[] = [];
    if (config.rotation === 'clockwise') filters.push('transpose=1');
    if (config.rotation === 'counterclockwise') filters.push('transpose=2');
    if ((config.rotation === 'half') !== config.flipHorizontal) filters.push('hflip');
    if ((config.rotation === 'half') !== config.flipVertical) filters.push('vflip');
    if (config.resize !== 'original') filters.push(`scale=-2:${config.resize === 'custom' ? config.customHeight : config.resize}`);
    if (config.fps !== 'original') filters.push(`fps=${config.fps}`);
    removeOptions(next, new Set(['-vf', '-r', '-s']));
    if (filters.length) putOption(next, '-vf', filters.join(','));
    next.friendlyRotation = config.rotation;
    next.friendlyResize = config.resize;
  }
  if (['trimEnabled', 'trimStart', 'trimDuration'].some((key) => has(patch, key as keyof FeatureConfig))) {
    removeOptions(next, new Set(['-ss', '-t', '-to']));
    if (config.trimEnabled) { if (Number(config.trimStart) !== 0) putOption(next, '-ss', config.trimStart); putOption(next, '-t', config.trimDuration); }
  }
  if (config.audioMode !== 'mute' && audioChange) {
    const codec = audioCodecForFormat(config.format);
    const oldCodec = value(next, '-c:a');
    const sampling = value(next, '-sample_fmt');
    if (oldCodec !== codec && sampling && audioSampleChoices[codec] && !audioSampleChoices[codec].includes(sampling)) {
      // Sampling formats are encoder specific. Restore automatic negotiation
      // when changing encoder; disabled nodes and unknown options remain saved.
      removeOptions(next, new Set(['-sample_fmt']));
    }
    if (formatChanged && read.config.format === 'flac' && config.format !== 'flac') removeOptions(next, new Set(['-compression_level']));
    putOption(next, '-c:a', codec);
    if (has(patch, 'audioBitrate') || formatChanged || extractionChanged || bitrateReset) {
      removeOptions(next, new Set(['-b:a']));
      if (!['wav', 'flac'].includes(config.format)) putOption(next, '-b:a', `${config.audioBitrate}k`);
    }
    if (has(patch, 'audioSampleRate') || sampleRateReset) { removeOptions(next, new Set(['-ar'])); if (config.audioSampleRate !== 'original') putOption(next, '-ar', config.audioSampleRate); }
    if (has(patch, 'volume')) { removeOptions(next, new Set(['-af'])); if (config.volume !== 1) putOption(next, '-af', `volume=${config.volume}`); }
  }
  return next;
}

function advancedDefinition(id: string): AdvancedSettingDefinition {
  const definition = advancedSettings.find((item) => item.id === id);
  if (!definition) throw new Error('找不到此配置项。');
  return definition;
}

/** Explain a known incompatible choice before it can be selected or executed.
 * Rules cover the current controls and supported encoders; unknown imported
 * encoders/values remain subject to actual engine validation. Clearing normally
 * remains available to repair imports; Opus 320 kbps is the exception because
 * removing its explicit multi-channel setting would create a known conflict.
 */
export function getAdvancedChoiceIssue(project: ProjectDocument, id: string, setting: string | boolean | undefined): string | undefined {
  const read = readFeatureConfig(project);
  const definition = advancedDefinition(id);
  const videoSetting = definition.category === '视频' || /^-(?:pix_fmt|profile|level|color_|colorspace|color_primaries|color_trc|fps_mode)/.test(definition.option);
  // The UI separately disables controls for absent media. Compatibility
  // preflight must not block a job because of parameters its -an/-vn ignores.
  if ((read.config.audioMode === 'extract' && videoSetting) || (read.config.audioMode === 'mute' && definition.category === '音频')) return undefined;
  if (id === 'audio-channels' && read.config.audioMode !== 'mute' && read.config.format === 'webm' && read.config.audioBitrate === '320' && (setting === undefined || setting === '' || setting === '1')) return '当前声音清晰度为 320 kbps，Opus 需要明确的立体声或多声道；请先把声音清晰度降至 192 kbps 及以下，再改单声道或自动。';
  if (setting === undefined || setting === '' || setting === false) return undefined;
  if (read.readonly) return read.warnings.find((warning) => warning.code === 'unsupported')?.message ?? '当前工程只读。';
  if (definition.compatibleFormats && !definition.compatibleFormats.includes(read.config.format)) return `“${definition.label}”不适用于当前输出格式。`;
  const codec = value(project, '-c:v') ?? (read.config.format === 'webm' ? 'libvpx-vp9' : 'libx264');
  const audioCodec = value(project, '-c:a') ?? audioCodecForFormat(read.config.format);
  if (definition.compatibleCodecs && !definition.compatibleCodecs.includes(codec) && !definition.compatibleCodecs.includes(audioCodec)) return `“${definition.label}”不适用于当前编码器。`;
  if (id === 'audio-sample-format' && typeof setting === 'string') {
    const supported = audioSampleChoices[audioCodec];
    const isCurrentCandidate = definition.choices?.some((choice) => choice.value === setting);
    if (supported && isCurrentCandidate && !supported.includes(setting)) {
      const labels = definition.choices?.filter((choice) => supported.includes(choice.value)).map((choice) => choice.label).join(' / ');
      return `当前 ${audioCodecLabels[audioCodec] ?? audioCodec} 声音编码不支持此采样精度；请选择“${labels}”或保持自动。`;
    }
  }
  if (id === 'pixel-format' && typeof setting === 'string') {
    if (codec === 'mpeg4' && setting !== 'yuv420p') return '内置 MPEG-4 编码仅支持标准 8 位 yuv420p；请更换视频兼容方式或保持自动。';
    const profile = value(project, '-profile:v');
    if (codec === 'libx264' && limitedH264Profiles.has(profile ?? '') && nonstandardH264PixelChoices.has(setting)) return `H.264 ${profile} 不支持 10 位或 4:4:4；请先把播放兼容级别恢复自动，或选择标准 8 位。`;
  }
  if (id === 'h264-profile' && typeof setting === 'string' && codec === 'libx264' && limitedH264Profiles.has(setting) && nonstandardH264PixelChoices.has(value(project, '-pix_fmt') ?? '')) return '当前画面采用 10 位或 4:4:4，不能使用此 H.264 兼容级别；请保持自动，或先恢复标准 8 位画面。';
  return undefined;
}

export function readAdvancedSetting(project: ProjectDocument, id: string): string | boolean | undefined {
  assertProjectDocument(project);
  const definition = advancedDefinition(id);
  const nodes = group(project).filter((node) => node.kind === 'option' && node.tokens[0] === definition.option && (!definition.metadataKey || node.tokens[1]?.startsWith(`${definition.metadataKey}=`)));
  const node = nodes.at(-1);
  if (definition.control === 'toggle') return definition.trueValue === '+faststart' ? /(?:^|[+-])faststart(?:$|[+-])/.test(node?.tokens[1] ?? '') && !(node?.tokens[1] ?? '').includes('-faststart') : definition.trueValue ? node?.tokens[1] === definition.trueValue : Boolean(node);
  if (definition.metadataKey) return node?.tokens[1]?.slice(definition.metadataKey.length + 1);
  return node?.tokens[1];
}

/** Empty strings clear one setting; unknown nodes and metadata keys are never rewritten. */
export function applyAdvancedSetting(project: ProjectDocument, id: string, setting: string | boolean | undefined): ProjectDocument {
  const read = readFeatureConfig(project);
  if (read.readonly) throw new Error(read.warnings.find((warning) => warning.code === 'unsupported')?.message ?? '当前工程只读。');
  const definition = advancedDefinition(id);
  if (typeof setting === 'string' && setting.includes('\0')) throw new Error('配置内容不能包含 NUL 字符。');
  if (setting !== undefined && setting !== '') {
    if (definition.control === 'toggle' && typeof setting !== 'boolean') throw new Error('此配置项需要开关值。');
    if (definition.control !== 'toggle' && typeof setting !== 'string') throw new Error('此配置项需要文本值。');
    if (definition.control === 'select' && !definition.choices?.some((choice) => choice.value === setting)) throw new Error('请选择提供的配置值。');
    if (definition.control === 'number' && (!/^-?\d+$/.test(setting as string) || !Number.isInteger(Number(setting)) || Number(setting) < (definition.min ?? -Infinity) || Number(setting) > (definition.max ?? Infinity))) throw new Error(`请输入 ${definition.min ?? '不限'} 到 ${definition.max ?? '不限'} 之间的整数。`);
  }
  const choiceIssue = getAdvancedChoiceIssue(project, id, setting);
  if (choiceIssue) throw new Error(choiceIssue);
  const next = structuredClone(project);
  const range = rangeOf(next)!;
  if (definition.metadataKey) {
    next.nodes = next.nodes.filter((node, index) => !(index >= range.start && index < range.end && node.enabled && node.kind === 'option' && node.tokens[0] === '-metadata' && node.tokens[1]?.startsWith(`${definition.metadataKey}=`)));
    if (typeof setting === 'string' && setting !== '') {
      const nextRange = rangeOf(next)!;
      next.nodes.splice(nextRange.end, 0, { id: crypto.randomUUID(), kind: 'option', enabled: true, tokens: ['-metadata', `${definition.metadataKey}=${setting}`], scope: 'output-1' });
    }
  } else if (definition.id === 'faststart') {
    const original = value(next, '-movflags') ?? '';
    const remainder = original.replace(/[+-]?faststart/g, '');
    removeOptions(next, new Set(['-movflags']));
    const flags = `${remainder}${setting === true ? '+faststart' : ''}`;
    if (flags) putOption(next, '-movflags', flags);
  } else {
    removeOptions(next, new Set([definition.option]));
    if (definition.control === 'toggle' ? setting === true : typeof setting === 'string' && setting !== '') putOption(next, definition.option, definition.control === 'toggle' ? definition.trueValue : setting as string);
    if (definition.id === 'video-bitrate' && setting) removeOptions(next, new Set(['-crf', '-q:v']));
  }
  return next;
}
