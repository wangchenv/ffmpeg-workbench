import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancedSettings, applyAdvancedSetting, applyFeatureConfig, compileProject,
  createDemoProject, deserializeProject, getOutputOption, readAdvancedSetting,
  readFeatureConfig, replaceInputs, serializeProject, validateProject,
} from '../src/core/index';
import type { FeatureConfig, FeatureFormat, FeaturePurpose } from '../src/core/features';
import type { CommandNode, ProjectDocument } from '../src/core/types';

const node = (id: string, kind: CommandNode['kind'], tokens: string[], enabled = true): CommandNode => ({ id, kind, tokens, enabled });
const real = (): ProjectDocument => ({ schemaVersion: 1, id: 'regression', name: '全量回归', nodes: [node('source', 'input', ['-i', '输入 素材.mp4']), node('destination', 'output', ['输出 文件.mp4'])] });
const withOption = (name: string, value?: string): ProjectDocument => {
  const project = real();
  project.nodes.splice(1, 0, node('imported-option', 'option', value === undefined ? [name] : [name, value]));
  return project;
};

// The product contract uses six user intents; assertions concern the resulting
// command and persisted meaning, rather than internal helper implementation.
const intents: Record<FeaturePurpose, Partial<FeatureConfig>> = {
  compress: { purpose: 'compress', quality: 'small' },
  convert: { purpose: 'convert', format: 'mkv' },
  trim: { purpose: 'trim', trimEnabled: true, trimStart: '1', trimDuration: '2' },
  resize: { purpose: 'resize', resize: '480' },
  audio: { purpose: 'audio', format: 'mp3' },
  mute: { purpose: 'mute' },
};
for (const purpose of Object.keys(intents) as FeaturePurpose[]) {
  test(`feature intent ${purpose} persists and produces semantically valid settings`, () => {
    const original = real();
    const snapshot = structuredClone(original);
    const changed = applyFeatureConfig(original, intents[purpose]);
    const restored = deserializeProject(serializeProject(changed));
    assert.deepEqual(original, snapshot);
    assert.equal(readFeatureConfig(restored).config.purpose, purpose);
    assert.equal(readFeatureConfig(restored).readonly, false);
    assert.equal(validateProject(restored).filter((issue) => issue.severity === 'error').length, 0);
    assert.ok(!compileProject(restored).includes('undefined'));
    if (purpose === 'audio') assert.deepEqual(getOutputOption(restored, '-vn')?.tokens, ['-vn']);
    if (purpose === 'mute') assert.deepEqual(getOutputOption(restored, '-an')?.tokens, ['-an']);
    if (purpose === 'trim') assert.equal(getOutputOption(restored, '-t')?.tokens[1], '2');
    if (purpose === 'resize') assert.equal(getOutputOption(restored, '-vf')?.tokens[1], 'scale=-2:480');
  });
}

for (const format of ['mp4', 'mkv', 'mov', 'webm', 'mp3', 'wav', 'flac'] as FeatureFormat[]) {
  test(`format ${format} maps container and audio/video presence consistently`, () => {
    const changed = applyFeatureConfig(real(), { format, audioMode: 'keep' });
    const audioOnly = ['mp3', 'wav', 'flac'].includes(format);
    assert.equal(readFeatureConfig(changed).config.format, format);
    assert.equal(readFeatureConfig(changed).config.audioMode, audioOnly ? 'extract' : 'keep');
    assert.equal(compileProject(changed).at(-1), `输出 文件.${format}`);
    assert.equal(getOutputOption(changed, '-f')?.tokens[1], format === 'mkv' ? 'matroska' : format);
    assert.equal(Boolean(getOutputOption(changed, '-vn')), audioOnly);
    assert.equal(Boolean(getOutputOption(changed, '-c:v')), !audioOnly);
    if (format === 'wav' || format === 'flac') assert.equal(getOutputOption(changed, '-b:a'), undefined);
  });
}

for (const definition of advancedSettings) {
  test(`advanced ${definition.id}: set, persist, clear and isolate output groups`, () => {
    const original = definition.id === 'flac-compression'
      ? applyFeatureConfig(real(), { format: 'flac' })
      : applyFeatureConfig(real(), { videoEncoding: 'compatible', format: 'mp4', audioMode: 'keep' });
    original.nodes.unshift(node('input-setting', 'option', [definition.option, 'input-value']));
    original.nodes.push(node('later-setting', 'option', [definition.option, 'later-value']), node('later-output', 'output', ['后来文件.mp4']));
    const snapshot = structuredClone(original);
    const selected = definition.control === 'toggle' ? true : definition.control === 'select' ? definition.choices!.at(-1)!.value : definition.control === 'number' ? String(definition.max) : '文字 $HOME; 保留\n换行=值';
    const changed = applyAdvancedSetting(original, definition.id, selected);
    const restored = deserializeProject(serializeProject(changed));
    assert.deepEqual(original, snapshot);
    assert.equal(readAdvancedSetting(restored, definition.id), selected);
    assert.deepEqual(restored.nodes.find((entry) => entry.id === 'input-setting'), snapshot.nodes.find((entry) => entry.id === 'input-setting'));
    assert.deepEqual(restored.nodes.find((entry) => entry.id === 'later-setting'), snapshot.nodes.find((entry) => entry.id === 'later-setting'));
    const cleared = applyAdvancedSetting(restored, definition.id, undefined);
    assert.equal(readAdvancedSetting(cleared, definition.id), definition.control === 'toggle' ? false : undefined);
  });
}

test('audio extraction and restoration never retain contradictory media suppression switches', () => {
  const muted = applyFeatureConfig(real(), { purpose: 'mute' });
  const audio = applyFeatureConfig(muted, { purpose: 'audio', format: 'mp3' });
  assert.equal(getOutputOption(audio, '-an'), undefined);
  assert.ok(getOutputOption(audio, '-vn'));
  const video = applyFeatureConfig(audio, { purpose: 'compress', audioMode: 'keep', format: 'mp4' });
  assert.equal(getOutputOption(video, '-vn'), undefined);
  assert.equal(getOutputOption(video, '-an'), undefined);
  assert.equal(getOutputOption(video, '-c:v')?.tokens[1], 'libx264');
  assert.equal(getOutputOption(video, '-c:a')?.tokens[1], 'aac');
});

test('format switching clears incompatible container, H264 and FLAC specific settings', () => {
  let h264 = applyFeatureConfig(real(), { format: 'mp4', videoEncoding: 'compatible' });
  h264 = applyAdvancedSetting(h264, 'h264-profile', 'high');
  h264 = applyAdvancedSetting(h264, 'h264-level', '4.1');
  h264 = applyAdvancedSetting(h264, 'faststart', true);
  const web = applyFeatureConfig(h264, { format: 'webm' });
  for (const flag of ['-profile:v', '-level:v', '-movflags']) assert.equal(getOutputOption(web, flag), undefined);
  const flac = applyAdvancedSetting(applyFeatureConfig(real(), { format: 'flac' }), 'flac-compression', '8');
  const mp3 = applyFeatureConfig(flac, { format: 'mp3' });
  assert.equal(getOutputOption(mp3, '-compression_level'), undefined, 'FLAC-specific compression must not leak into MP3');
});

test('audio encoder switches reset sampling negotiation while keeping disabled and unknown options', () => {
  let wav = applyFeatureConfig(real(), { format: 'wav' });
  wav = applyAdvancedSetting(wav, 'audio-sample-format', 's16');
  wav.nodes.splice(1, 0, node('disabled-sampling', 'option', ['-sample_fmt', 's32'], false), node('unknown-audio', 'option', ['-future_audio_control', 'retain']));
  const mp3 = applyFeatureConfig(wav, { format: 'mp3' });
  assert.equal(getOutputOption(mp3, '-sample_fmt'), undefined);
  assert.deepEqual(mp3.nodes.find((entry) => entry.id === 'disabled-sampling'), wav.nodes.find((entry) => entry.id === 'disabled-sampling'));
  assert.deepEqual(mp3.nodes.find((entry) => entry.id === 'unknown-audio'), wav.nodes.find((entry) => entry.id === 'unknown-audio'));
  const configured = applyAdvancedSetting(mp3, 'audio-sample-format', 'fltp');
  const louder = applyFeatureConfig(configured, { volume: 0.5 });
  assert.equal(getOutputOption(louder, '-sample_fmt')?.tokens[1], 'fltp', 'Unchanged encoder keeps explicit sampling precision');
});

test('all declared format and codec restrictions reject incompatible advanced edits', () => {
  assert.throws(() => applyAdvancedSetting(applyFeatureConfig(real(), { format: 'webm' }), 'faststart', true), /格式/);
  assert.throws(() => applyAdvancedSetting(applyFeatureConfig(real(), { videoEncoding: 'builtin' }), 'h264-profile', 'high'), /编码器/);
  assert.throws(() => applyAdvancedSetting(applyFeatureConfig(real(), { videoEncoding: 'efficient' }), 'h264-level', '4.1'), /编码器/);
  assert.throws(() => applyAdvancedSetting(real(), 'flac-compression', '8'), /格式/);
});

test('advanced controls reject out of range, fractional, nonnumeric and wrong control types', () => {
  for (const definition of advancedSettings) {
    const original = definition.id === 'flac-compression' ? applyFeatureConfig(real(), { format: 'flac' }) : applyFeatureConfig(real(), { videoEncoding: 'compatible' });
    if (definition.control === 'number') {
      for (const invalid of [String(definition.min! - 1), String(definition.max! + 1), '1.5', 'NaN', 'Infinity', 'abc', ' ', ' 1', '1e1']) assert.throws(() => applyAdvancedSetting(original, definition.id, invalid), `${definition.id}: ${invalid}`);
    }
    if (definition.control === 'select') assert.throws(() => applyAdvancedSetting(original, definition.id, '__invalid_choice__'));
    if (definition.control === 'toggle') assert.throws(() => applyAdvancedSetting(original, definition.id, 'true'));
    else assert.throws(() => applyAdvancedSetting(original, definition.id, true));
    assert.throws(() => applyAdvancedSetting(original, definition.id, 'a\0b'));
  }
});

test('valid size, volume and trim boundaries remain usable while invalid boundaries are rejected', () => {
  for (const customHeight of [2, 8192]) assert.equal(readFeatureConfig(applyFeatureConfig(real(), { resize: 'custom', customHeight })).config.customHeight, customHeight);
  for (const volume of [0, 4]) assert.equal(readFeatureConfig(applyFeatureConfig(real(), { volume })).config.volume, volume);
  for (const trimStart of ['0', '00:00:00', '24:59:59.999']) assert.equal(readFeatureConfig(applyFeatureConfig(real(), { trimEnabled: true, trimStart, trimDuration: '0.001' })).config.trimStart, trimStart);
  for (const customHeight of [0, 1, 8193, 8194, NaN, Infinity, 720.5]) assert.throws(() => applyFeatureConfig(real(), { resize: 'custom', customHeight }));
  for (const volume of [-0.01, 4.01, NaN, Infinity]) assert.throws(() => applyFeatureConfig(real(), { volume }));
  for (const trimStart of ['-1', '', ' 1', '1 ', '1e3', '01:60:00', '01:00:60', '1:2', 'NaN']) assert.throws(() => applyFeatureConfig(real(), { trimEnabled: true, trimStart, trimDuration: '1' }));
  for (const trimDuration of ['0', '-1', '', 'Infinity']) assert.throws(() => applyFeatureConfig(real(), { trimEnabled: true, trimStart: '0', trimDuration }));
});

test('invalid enum values cannot silently become literal undefined command values', () => {
  for (const key of ['purpose', 'format', 'videoEncoding', 'quality', 'speed', 'resize', 'rotation', 'fps', 'audioMode', 'audioBitrate', 'audioSampleRate'] as const) {
    assert.throws(() => applyFeatureConfig(real(), { [key]: '__invalid__' } as Partial<FeatureConfig>), key);
    assert.throws(() => applyFeatureConfig(real(), { [key]: undefined } as Partial<FeatureConfig>), key);
  }
  for (const key of ['flipHorizontal', 'flipVertical', 'trimEnabled'] as const) assert.throws(() => applyFeatureConfig(real(), { [key]: 'true' } as unknown as Partial<FeatureConfig>), key);
});

test('replacement ignores disabled format overrides and replaces the enabled demo source', () => {
  const original = createDemoProject();
  original.nodes.splice(1, 0, node('disabled-format', 'option', ['-f', 'mp4'], false));
  const changed = replaceInputs(original, ['新视频.mp4']);
  assert.equal(changed.nodes.filter((entry) => entry.enabled && entry.kind === 'input').length, 1);
  assert.ok(!compileProject(changed).some((token) => token.startsWith('testsrc2=')));
  assert.ok(changed.nodes.some((entry) => entry.id === 'disabled-format'));
});

test('replacement preserves disabled demo nodes and disabled boundaries losslessly', () => {
  const original = real();
  original.nodes.unshift(node('disabled-format', 'option', ['-f', 'lavfi'], false), node('disabled-demo', 'input', ['-i', 'testsrc2=size=1280x720'], false));
  const changed = replaceInputs(original, ['第二视频.mp4']);
  assert.deepEqual(changed.nodes.find((entry) => entry.id === 'disabled-format'), original.nodes[0]);
  assert.deepEqual(changed.nodes.find((entry) => entry.id === 'disabled-demo'), original.nodes[1]);
  assert.equal(changed.nodes.filter((entry) => entry.enabled && entry.kind === 'input').length, 2);
});

test('replacement without outputs or with disabled outputs preserves existing argv order', () => {
  const noOutput: ProjectDocument = { id: 'no-output', name: '无输出', nodes: [node('source', 'input', ['-i', 'existing.mp4']), node('trailing', 'opaque', ['-future', 'same tokens'])] };
  assert.deepEqual(compileProject(replaceInputs(noOutput, ['追加.wav'])), ['-i', 'existing.mp4', '-i', '追加.wav', '-future', 'same tokens']);
  const disabled = real();
  disabled.nodes.splice(1, 0, node('disabled-output', 'output', ['忽略.mp4'], false), node('filter', 'option', ['-vf', 'scale=-2:480']));
  const changed = replaceInputs(disabled, ['追加.wav']);
  assert.deepEqual(compileProject(changed), ['-i', '输入 素材.mp4', '-i', '追加.wav', '-vf', 'scale=-2:480', '输出 文件.mp4']);
  assert.throws(() => replaceInputs(real(), ['bad\0path']));
});

test('strict JSON import rejects coercible kind values and every malformed structural field', () => {
  const malformed: unknown[] = [null, [], '', 1, { ...real(), nodes: null }, { ...real(), id: '' }, { ...real(), name: 12 }, { ...real(), schemaVersion: '1' }];
  for (const patch of [{ kind: ['option'] }, { kind: ['opaque'] }, { enabled: 'true' }, { tokens: [null] }, { tokens: 'not-array' }, { scope: {} }, { id: '' }]) malformed.push({ ...real(), nodes: [{ ...node('bad', 'option', ['-an']), ...patch }] });
  for (const document of malformed) assert.throws(() => deserializeProject(JSON.stringify(document)), JSON.stringify(document));
});

test('JSON roundtrip preserves arbitrary extension keys, disabled raw tokens and literal paths', () => {
  const original = real();
  original.vendor = { nested: ['中文', { unrecognized: null, value: true }] };
  original.nodes.unshift({ ...node('disabled-raw', 'opaque', ['', '$HOME', 'x\ny', '\\server\\视频'], false), future: { v: 2 } });
  original.nodes.splice(2, 0, node('unknown-option', 'option', ['-future', 'one two']));
  const snapshot = structuredClone(original);
  const changed = applyFeatureConfig(original, { quality: 'high' });
  const restored = deserializeProject(serializeProject(changed));
  assert.deepEqual(original, snapshot);
  assert.deepEqual(restored.vendor, snapshot.vendor);
  assert.deepEqual(restored.nodes.find((entry) => entry.id === 'disabled-raw'), snapshot.nodes[0]);
  assert.deepEqual(restored.nodes.find((entry) => entry.id === 'unknown-option'), snapshot.nodes.find((entry) => entry.id === 'unknown-option'));
  assert.equal(readFeatureConfig(restored).readonly, false);
  assert.ok(readFeatureConfig(restored).warnings.some((warning) => warning.code === 'pending'));
});

for (const [name, value] of [
  ['-vf', 'hflip,hflip'], ['-vf', 'scale=-2:480,transpose=1'],
  ['-vf', 'crop=100:100'], ['-af', 'volume=2,volume=2'],
  ['-af', 'volume=5'], ['-filter:v', 'hflip'], ['-c:v:0', 'libx264'],
  ['-to', '10'], ['-s', '640x360'], ['-c:v', 'copy'],
]) {
  test(`unsupported imported ${name}=${value} remains readonly with exact tokens`, () => {
    const original = withOption(name, value);
    const snapshot = structuredClone(original);
    assert.equal(readFeatureConfig(original).readonly, true);
    assert.throws(() => applyFeatureConfig(original, { quality: 'high' }));
    assert.throws(() => applyAdvancedSetting(original, 'title', 'changed'));
    assert.deepEqual(deserializeProject(serializeProject(original)), snapshot);
  });
}

test('semantic validation catches malformed nodes, duplicate paths and overwrite switch contradictions', () => {
  const invalid = real();
  invalid.nodes.splice(1, 0, node('empty', 'option', []), node('bad-input', 'input', ['wrong', '']), node('bad-option', 'option', ['not-an-option']), node('y', 'option', ['-y']), node('n', 'option', ['-n']));
  invalid.nodes.push(node('duplicate', 'output', ['输出 文件.mp4']), node('source-overwrite', 'output', ['输入 素材.mp4']));
  const errors = validateProject(invalid).filter((issue) => issue.severity === 'error');
  for (const id of ['empty', 'bad-input', 'bad-option', 'duplicate', 'source-overwrite']) assert.ok(errors.some((issue) => issue.nodeId === id), id);
  assert.ok(errors.some((issue) => issue.message.includes('-y')));
});
