import assert from 'node:assert/strict';
import test from 'node:test';
import { advancedSettings, applyAdvancedSetting, applyFeatureConfig, compileProject, createDemoProject, deserializeProject, readAdvancedSetting, readFeatureConfig, replaceInputs, serializeProject } from '../src/core/index';
import type { CommandNode, ProjectDocument } from '../src/core/types';

const node = (id: string, kind: CommandNode['kind'], tokens: string[], enabled = true): CommandNode => ({ id, kind, tokens, enabled });
const document = (nodes: CommandNode[]): ProjectDocument => ({ id: 'features-test', name: '功能测试', nodes });
const realProject = () => document([node('input', 'input', ['-i', 'input.mp4']), node('output', 'output', ['output.mp4'])]);

test('demo friendly controls remain runnable and quality uses native mpeg4 scale', () => {
  const original = createDemoProject();
  const read = readFeatureConfig(original);
  assert.equal(read.readonly, false);
  assert.equal(read.config.trimEnabled, true);
  assert.equal(read.config.trimDuration, '5');
  assert.equal(read.config.audioMode, 'mute');
  assert.equal(read.config.quality, 'balanced');
  const changed = applyFeatureConfig(original, { quality: 'high' });
  assert.ok(compileProject(changed).join(' ').includes('-c:v mpeg4 -q:v 2'));
  assert.equal(readFeatureConfig(changed).config.quality, 'high');
  assert.deepEqual(compileProject(original), compileProject(createDemoProject()));
  assert.throws(() => applyFeatureConfig(original, { trimEnabled: false }), /测试画面/);
});

test('real source replacement removes the demo five second limit and uses H264', () => {
  const replaced = replaceInputs(createDemoProject(), ['real.mov']);
  assert.equal(readFeatureConfig(replaced).config.trimEnabled, false);
  const changed = applyFeatureConfig(replaced, { purpose: 'compress', format: 'mp4', quality: 'balanced', audioMode: 'keep' });
  const args = compileProject(changed);
  assert.ok(!args.includes('-t'));
  assert.ok(!args.includes('-an'));
  assert.ok(args.join(' ').includes('-c:v libx264 -crf 23 -preset medium'));
  assert.ok(args.join(' ').includes('-c:a aac'));
});

test('feature writes affect only the first output and never input options', () => {
  const original = document([
    node('input-seek', 'option', ['-ss', '8']), node('input-rate', 'option', ['-r', '12']),
    node('input', 'input', ['-i', 'input.mov']), node('first-duration', 'option', ['-t', '2']), node('first-output', 'output', ['first.mp4']),
    node('later-codec', 'option', ['-c:v', 'copy']), node('later-duration', 'option', ['-t', '20']), node('later-output', 'output', ['second.mkv']),
  ]);
  const changed = applyFeatureConfig(original, { trimEnabled: true, trimStart: '1', trimDuration: '6', fps: '30', quality: 'small' });
  assert.deepEqual(changed.nodes.slice(0, 3), original.nodes.slice(0, 3));
  const secondIndex = changed.nodes.findIndex((entry) => entry.id === 'later-codec');
  assert.deepEqual(changed.nodes.slice(secondIndex), original.nodes.slice(5));
  const args = compileProject(changed);
  assert.ok(args.join(' ').includes('-ss 1 -t 6'));
  assert.ok(args.join(' ').includes('-crf 28'));
  assert.equal(readFeatureConfig(changed).warnings[0].code, 'multiple-outputs');
});

test('combined resize, turn, flip and frame rate map to an ordered simple filter chain', () => {
  const changed = applyFeatureConfig(realProject(), { resize: '720', rotation: 'clockwise', flipHorizontal: true, fps: '30' });
  assert.ok(compileProject(changed).includes('transpose=1,hflip,scale=-2:720,fps=30'));
  const read = readFeatureConfig(changed);
  assert.equal(read.readonly, false);
  assert.equal(read.config.resize, '720');
  assert.equal(read.config.rotation, 'clockwise');
  assert.equal(read.config.flipHorizontal, true);
  assert.equal(read.config.fps, '30');
  assert.ok(!compileProject(applyFeatureConfig(changed, { resize: 'original', rotation: 'none', flipHorizontal: false, fps: 'original' })).includes('-vf'));
});

test('half turn combined with flips preserves the selected controls through project roundtrip', () => {
  for (const flipHorizontal of [false, true]) {
    for (const flipVertical of [false, true]) {
      const changed = applyFeatureConfig(realProject(), { rotation: 'half', flipHorizontal, flipVertical });
      const read = readFeatureConfig(changed);
      assert.equal(read.readonly, false);
      assert.equal(read.config.rotation, 'half');
      assert.equal(read.config.flipHorizontal, flipHorizontal);
      assert.equal(read.config.flipVertical, flipVertical);
    }
  }
});

test('custom resize remains custom at a standard height through saved project roundtrips', () => {
  const selected = applyFeatureConfig(realProject(), { resize: 'custom' });
  assert.ok(compileProject(selected).includes('scale=-2:720'));
  const restored = deserializeProject(serializeProject(selected));
  assert.equal(readFeatureConfig(restored).config.resize, 'custom');
  assert.equal(readFeatureConfig(restored).config.customHeight, 720);
  const resized = applyFeatureConfig(restored, { customHeight: 1080 });
  assert.equal(readFeatureConfig(resized).config.resize, 'custom');
  assert.equal(readFeatureConfig(resized).config.customHeight, 1080);
  assert.equal(readFeatureConfig(resized).readonly, false);
  const preset = applyFeatureConfig(resized, { resize: '720' });
  assert.equal(readFeatureConfig(deserializeProject(serializeProject(preset))).config.resize, '720');
  assert.equal(readFeatureConfig(applyFeatureConfig(preset, { resize: 'original' })).config.resize, 'original');
});

test('audio extraction strips known first-output video settings and picks codec per format', () => {
  const original = document([
    node('input', 'input', ['-i', 'input.mp4']), node('codec', 'option', ['-c:v', 'libx264']), node('quality', 'option', ['-crf', '23']),
    node('filter', 'option', ['-vf', 'scale=-2:720']), node('profile', 'option', ['-profile:v', 'high']),
    node('metadata', 'option', ['-metadata', 'title=保留']), node('unknown', 'option', ['-future_option', 'future']), node('output', 'output', ['output.mp4']),
  ]);
  const mapping = { mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac' } as const;
  for (const [format, codec] of Object.entries(mapping)) {
    const changed = applyFeatureConfig(original, { purpose: 'audio', format: format as 'mp3' | 'wav' | 'flac' });
    const args = compileProject(changed);
    assert.ok(args.includes('-vn'));
    for (const flag of ['-c:v', '-crf', '-vf', '-profile:v']) assert.ok(!args.includes(flag));
    assert.ok(args.includes(codec));
    assert.ok(args.includes('title=保留'));
    assert.ok(args.includes('future'));
    assert.equal(args.at(-1), `output.${format}`);
    assert.equal(readFeatureConfig(changed).config.audioMode, 'extract');
  }
});

test('volume, sound bitrate and sample rate are configurable without shell parsing', () => {
  const changed = applyFeatureConfig(realProject(), { audioBitrate: '128', audioSampleRate: '44100', volume: 0.5 });
  const args = compileProject(changed);
  assert.ok(args.join(' ').includes('-b:a 128k -ar 44100 -af volume=0.5'));
  assert.equal(readFeatureConfig(changed).config.volume, 0.5);
  const reset = applyFeatureConfig(changed, { audioSampleRate: 'original', volume: 1 });
  assert.ok(!compileProject(reset).includes('-ar'));
  assert.ok(!compileProject(reset).includes('-af'));
});

test('mute is a function and returning to keep sound removes only its audio switch', () => {
  const muted = applyFeatureConfig(realProject(), { purpose: 'mute' });
  assert.ok(compileProject(muted).includes('-an'));
  assert.equal(readFeatureConfig(muted).config.purpose, 'mute');
  assert.ok(!compileProject(applyFeatureConfig(muted, { audioMode: 'keep' })).includes('-an'));
});

test('WebM chooses VP9 and Opus with a quality mode valid for VP9', () => {
  const changed = applyFeatureConfig(realProject(), { format: 'webm', quality: 'high', audioMode: 'keep' });
  const args = compileProject(changed);
  assert.ok(args.join(' ').includes('-c:v libvpx-vp9 -crf 28 -b:v 0'));
  assert.ok(args.includes('libopus'));
  assert.equal(readFeatureConfig(changed).config.quality, 'high');
  const h264 = applyAdvancedSetting(applyFeatureConfig(realProject(), { quality: 'balanced' }), 'h264-profile', 'high');
  assert.ok(!compileProject(applyFeatureConfig(h264, { format: 'webm' })).includes('-profile:v'));
});

test('video encoding selection maps codec, quality and speed while other changes preserve it', () => {
  const efficient = applyFeatureConfig(realProject(), { videoEncoding: 'efficient', quality: 'high', speed: 'slow' });
  assert.ok(compileProject(efficient).join(' ').includes('-c:v libx265 -crf 18 -preset slow'));
  assert.equal(readFeatureConfig(efficient).config.videoEncoding, 'efficient');
  const resized = applyFeatureConfig(efficient, { resize: '720', speed: 'fast' });
  assert.ok(compileProject(resized).includes('libx265'));
  assert.ok(compileProject(resized).join(' ').includes('-preset fast'));
  const builtin = applyFeatureConfig(resized, { videoEncoding: 'builtin' });
  assert.ok(compileProject(builtin).join(' ').includes('-c:v mpeg4 -q:v 2'));
  assert.ok(!compileProject(builtin).includes('-preset'));
  assert.equal(readFeatureConfig(builtin).config.videoEncoding, 'builtin');
  const compatible = applyFeatureConfig(builtin, { videoEncoding: 'compatible' });
  assert.ok(compileProject(compatible).includes('libx264'));
  const web = applyFeatureConfig(compatible, { format: 'webm' });
  assert.equal(readFeatureConfig(web).config.videoEncoding, 'web');
  assert.ok(compileProject(web).includes('libvpx-vp9'));
  assert.throws(() => applyFeatureConfig(web, { videoEncoding: 'compatible' }), /WebM/);
  assert.throws(() => applyFeatureConfig(compatible, { videoEncoding: 'web' }), /WebM/);
  assert.equal(readFeatureConfig(applyFeatureConfig(web, { format: 'mp4' })).config.videoEncoding, 'compatible');
});

test('unknown options and disabled fragments survive changes, complex enabled content is read only', () => {
  const original = realProject();
  original.nodes.splice(1, 0, node('unknown', 'option', ['-future_flag', 'two words']), node('disabled', 'opaque', ['arbitrary', 'tokens'], false));
  const changed = applyFeatureConfig(original, { quality: 'small' });
  assert.deepEqual(changed.nodes.find((entry) => entry.id === 'unknown'), original.nodes.find((entry) => entry.id === 'unknown'));
  assert.deepEqual(changed.nodes.find((entry) => entry.id === 'disabled'), original.nodes.find((entry) => entry.id === 'disabled'));
  assert.ok(readFeatureConfig(changed).warnings.some((warning) => warning.code === 'pending'));
  for (const complex of [node('complex', 'option', ['-filter_complex', '[0:v]scale=100:100[out]']), node('raw', 'opaque', ['-future', 'raw']), node('mapped', 'option', ['-map', '0:v:0']), node('unsupported-filter', 'option', ['-vf', 'crop=100:100'])]) {
    const unsafe = realProject(); unsafe.nodes.splice(1, 0, complex);
    assert.equal(readFeatureConfig(unsafe).readonly, true);
    assert.throws(() => applyFeatureConfig(unsafe, { quality: 'high' }));
    assert.throws(() => applyAdvancedSetting(unsafe, 'title', 'new title'));
  }
});

test('input-filter scope and subsequent outputs never become friendly first output controls', () => {
  const original = document([
    node('input-volume', 'option', ['-af', 'unknown=keep']), node('input', 'input', ['-i', 'input.mp4']), node('first', 'output', ['first.mp4']),
    node('later-filter', 'option', ['-vf', 'crop=12:12']), node('later', 'output', ['later.mp4']),
  ]);
  assert.equal(readFeatureConfig(original).readonly, false);
  const changed = applyFeatureConfig(original, { volume: 2 });
  assert.deepEqual(changed.nodes.find((entry) => entry.id === 'input-volume'), original.nodes[0]);
  assert.deepEqual(changed.nodes.find((entry) => entry.id === 'later-filter'), original.nodes[3]);
});

test('advanced catalog is contextual and metadata edits preserve repeated unrelated keys', () => {
  assert.ok(advancedSettings.length >= 20);
  assert.equal(new Set(advancedSettings.map((entry) => entry.id)).size, advancedSettings.length);
  assert.ok(advancedSettings.every((entry) => entry.label && entry.description && typeof entry.executable === 'boolean'));
  const original = realProject();
  original.nodes.splice(1, 0, node('title', 'option', ['-metadata', 'title=old']), node('author', 'option', ['-metadata', 'artist=keep']), node('later-title', 'option', ['-metadata', 'title=last']));
  assert.equal(readAdvancedSetting(original, 'title'), 'last');
  const changed = applyAdvancedSetting(original, 'title', '新标题 $HOME; 保留字面值');
  assert.equal(readAdvancedSetting(changed, 'title'), '新标题 $HOME; 保留字面值');
  assert.equal(readAdvancedSetting(changed, 'artist'), 'keep');
  assert.equal(compileProject(changed).filter((entry) => entry.startsWith('title=')).length, 1);
  assert.equal(readAdvancedSetting(applyAdvancedSetting(changed, 'title', ''), 'title'), undefined);
});

test('advanced settings validate numeric choices and retain other MOV flags', () => {
  const original = realProject();
  original.nodes.splice(1, 0, node('movflags', 'option', ['-movflags', '+frag_keyframe']));
  const started = applyAdvancedSetting(original, 'faststart', true);
  assert.equal(readAdvancedSetting(started, 'faststart'), true);
  assert.ok(compileProject(started).includes('+frag_keyframe+faststart'));
  assert.ok(compileProject(applyAdvancedSetting(started, 'faststart', false)).includes('+frag_keyframe'));
  assert.throws(() => applyAdvancedSetting(original, 'threads', '10000'));
  assert.throws(() => applyAdvancedSetting(original, 'threads', '1.5'));
  assert.throws(() => applyAdvancedSetting(original, 'audio-channels', '12'));
  assert.throws(() => applyAdvancedSetting(original, 'flac-compression', '5'));
  assert.throws(() => applyAdvancedSetting(original, 'title', 'bad\0title'));
});

test('target bitrate clears constant quality rather than leaving conflicting controls', () => {
  const original = applyFeatureConfig(realProject(), { quality: 'high' });
  const bitrate = applyAdvancedSetting(original, 'video-bitrate', '4M');
  assert.ok(compileProject(bitrate).join(' ').includes('-b:v 4M'));
  assert.ok(!compileProject(bitrate).includes('-crf'));
  const quality = applyFeatureConfig(bitrate, { quality: 'balanced' });
  assert.ok(!compileProject(quality).includes('-b:v'));
  assert.ok(compileProject(quality).join(' ').includes('-crf 23'));
});

test('bad trim, resize and volume values cannot produce argv', () => {
  for (const patch of [{ trimEnabled: true, trimStart: '-1' }, { trimEnabled: true, trimDuration: '0' }, { trimEnabled: true, trimStart: '00:99:00' }, { resize: 'custom' as const, customHeight: 719 }, { volume: 4.1 }]) assert.throws(() => applyFeatureConfig(realProject(), patch));
  const timed = applyFeatureConfig(realProject(), { trimEnabled: true, trimStart: '00:01:03.5', trimDuration: '10' });
  assert.ok(compileProject(timed).join(' ').includes('-ss 00:01:03.5 -t 10'));
});
