import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAdvancedSetting, applyFeatureConfig, getAdvancedChoiceIssue, getOutputOption, readFeatureConfig, serializeProject, deserializeProject } from '../src/core';
import type { FeatureFormat, ProjectDocument } from '../src/core';

function project(): ProjectDocument {
  return { id: 'choice-compatibility', schemaVersion: 1, name: '兼容候选回归', nodes: [
    { id: 'input', kind: 'input', enabled: true, tokens: ['-i', 'input.mp4'] },
    { id: 'video', kind: 'option', enabled: true, tokens: ['-c:v', 'libx264'] },
    { id: 'audio', kind: 'option', enabled: true, tokens: ['-c:a', 'aac'] },
    { id: 'output', kind: 'output', enabled: true, tokens: ['output.mp4'] },
  ] };
}

for (const [format, allowed] of [
  ['mp4', ['fltp']], ['wav', ['s16']], ['flac', ['s16', 's32']], ['mp3', ['fltp']], ['webm', ['s16']],
] as const) {
  for (const choice of ['s16', 's32', 'fltp']) {
    test(`sample precision ${format}/${choice} follows the actual encoder's current UI candidates`, () => {
      const p = applyFeatureConfig(project(), { format: format as FeatureFormat });
      const snapshot = structuredClone(p);
      if ((allowed as readonly string[]).includes(choice)) {
        assert.equal(getAdvancedChoiceIssue(p, 'audio-sample-format', choice), undefined);
        assert.equal(getOutputOption(applyAdvancedSetting(p, 'audio-sample-format', choice), '-sample_fmt')?.tokens[1], choice);
      } else {
        assert.ok(getAdvancedChoiceIssue(p, 'audio-sample-format', choice)?.includes('不支持'));
        assert.throws(() => applyAdvancedSetting(p, 'audio-sample-format', choice), /不支持/);
      }
      assert.deepEqual(p, snapshot);
    });
  }
}

for (const choice of ['yuv420p', 'yuv420p10le', 'yuv444p']) {
  test(`MPEG4 pixel choice ${choice} cannot silently fall back to a different format`, () => {
    const p = applyFeatureConfig(project(), { videoEncoding: 'builtin' });
    if (choice === 'yuv420p') {
      assert.equal(getAdvancedChoiceIssue(p, 'pixel-format', choice), undefined);
      assert.equal(getOutputOption(applyAdvancedSetting(p, 'pixel-format', choice), '-pix_fmt')?.tokens[1], choice);
    } else {
      assert.match(getAdvancedChoiceIssue(p, 'pixel-format', choice)!, /MPEG-4/);
      assert.throws(() => applyAdvancedSetting(p, 'pixel-format', choice), /MPEG-4/);
    }
  });
}

for (const profile of ['baseline', 'main', 'high']) {
  for (const pixel of ['yuv420p', 'yuv420p10le', 'yuv444p']) {
    test(`H264 ${profile} with ${pixel} has the same compatibility in both edit orders`, () => {
      const withProfile = applyAdvancedSetting(project(), 'h264-profile', profile);
      const withPixel = applyAdvancedSetting(project(), 'pixel-format', pixel);
      if (pixel === 'yuv420p') {
        assert.equal(getAdvancedChoiceIssue(withProfile, 'pixel-format', pixel), undefined);
        assert.equal(getAdvancedChoiceIssue(withPixel, 'h264-profile', profile), undefined);
        assert.equal(getOutputOption(applyAdvancedSetting(withProfile, 'pixel-format', pixel), '-pix_fmt')?.tokens[1], pixel);
        assert.equal(getOutputOption(applyAdvancedSetting(withPixel, 'h264-profile', profile), '-profile:v')?.tokens[1], profile);
      } else {
        assert.match(getAdvancedChoiceIssue(withProfile, 'pixel-format', pixel)!, /10 位|4:4:4/);
        assert.match(getAdvancedChoiceIssue(withPixel, 'h264-profile', profile)!, /10 位|4:4:4/);
        assert.throws(() => applyAdvancedSetting(withProfile, 'pixel-format', pixel));
        assert.throws(() => applyAdvancedSetting(withPixel, 'h264-profile', profile));
      }
    });
  }
}

test('automatic H264 profile permits 10 bit and 444, with an explicit reset path from a limited profile', () => {
  for (const pixel of ['yuv420p10le', 'yuv444p']) {
    const limited = applyAdvancedSetting(project(), 'h264-profile', 'high');
    const automatic = applyAdvancedSetting(limited, 'h264-profile', undefined);
    assert.equal(getAdvancedChoiceIssue(automatic, 'pixel-format', pixel), undefined);
    assert.equal(getOutputOption(applyAdvancedSetting(automatic, 'pixel-format', pixel), '-pix_fmt')?.tokens[1], pixel);
  }
});

test('codec switches clear known incompatible precision and pixel settings but preserve compatible settings and disabled tokens', () => {
  const p = applyAdvancedSetting(applyFeatureConfig(project(), { format: 'flac' }), 'audio-sample-format', 's32');
  p.nodes.splice(1, 0, { id: 'disabled-sample', kind: 'option', enabled: false, tokens: ['-sample_fmt', 's16'] }, { id: 'unknown-preserved', kind: 'option', enabled: true, tokens: ['-future_flag', 'keep'] });
  const aac = applyFeatureConfig(p, { audioMode: 'keep', format: 'mp4' });
  assert.equal(getOutputOption(aac, '-sample_fmt'), undefined);
  assert.deepEqual(aac.nodes.find(n => n.id === 'disabled-sample'), p.nodes.find(n => n.id === 'disabled-sample'));
  assert.deepEqual(aac.nodes.find(n => n.id === 'unknown-preserved'), p.nodes.find(n => n.id === 'unknown-preserved'));
  const wav = applyAdvancedSetting(applyFeatureConfig(project(), { format: 'wav' }), 'audio-sample-format', 's16');
  const flac = applyFeatureConfig(wav, { format: 'flac' });
  assert.equal(getOutputOption(flac, '-sample_fmt')?.tokens[1], 's16');
  const h264 = applyAdvancedSetting(project(), 'pixel-format', 'yuv420p10le');
  const mpeg4 = applyFeatureConfig(h264, { videoEncoding: 'builtin' });
  assert.equal(getOutputOption(mpeg4, '-pix_fmt'), undefined);
  const standard = applyAdvancedSetting(project(), 'pixel-format', 'yuv420p');
  assert.equal(getOutputOption(applyFeatureConfig(standard, { videoEncoding: 'builtin' }), '-pix_fmt')?.tokens[1], 'yuv420p');
});

test('conflicting imported settings can be cleared without asserting they are valid selectable candidates', () => {
  const badSample = project();
  badSample.nodes.splice(3, 0, { id: 'bad-sampling', kind: 'option', enabled: true, tokens: ['-sample_fmt', 's16'] });
  assert.ok(getAdvancedChoiceIssue(badSample, 'audio-sample-format', 's16'));
  assert.equal(getAdvancedChoiceIssue(badSample, 'audio-sample-format', undefined), undefined);
  assert.equal(getOutputOption(applyAdvancedSetting(badSample, 'audio-sample-format', undefined), '-sample_fmt'), undefined);
  const wrongFormat = project();
  wrongFormat.nodes.splice(3, 0, { id: 'flac-only', kind: 'option', enabled: true, tokens: ['-compression_level', '8'] });
  assert.equal(getOutputOption(applyAdvancedSetting(wrongFormat, 'flac-compression', undefined), '-compression_level'), undefined);
});

test('limited UI candidate rules do not falsely reject valid imported formats omitted from the dropdown', () => {
  const mp3 = applyFeatureConfig(project(), { format: 'mp3' });
  mp3.nodes.splice(1, 0, { id: 'imported-planar-integer', kind: 'option', enabled: true, tokens: ['-sample_fmt', 's32p'] });
  assert.equal(getAdvancedChoiceIssue(mp3, 'audio-sample-format', 's32p'), undefined);
  const louder = applyFeatureConfig(mp3, { volume: 0.5 });
  assert.equal(getOutputOption(louder, '-sample_fmt')?.tokens[1], 's32p');
  assert.throws(() => applyAdvancedSetting(mp3, 'audio-sample-format', 's32p'), /提供的配置值/, 'Omitted values can be retained from imports, not newly selected by this editor');
});

test('media suppression prevents ignored legacy options from falsely blocking the executed media', () => {
  const audio = applyFeatureConfig(project(), { format: 'flac' });
  assert.equal(getAdvancedChoiceIssue(audio, 'pixel-format', 'yuv420p10le'), undefined);
  assert.equal(getAdvancedChoiceIssue(audio, 'h264-profile', 'baseline'), undefined);
  const muted = applyFeatureConfig(project(), { purpose: 'mute' });
  assert.equal(getAdvancedChoiceIssue(muted, 'audio-sample-format', 's16'), undefined);
  assert.equal(getAdvancedChoiceIssue(muted, 'audio-channels', '1'), undefined);
});

test('audio extraction clears video filter presentation metadata before returning to a video function', () => {
  const transformed = applyFeatureConfig(project(), { purpose: 'resize', rotation: 'half', resize: 'custom', customHeight: 720 });
  const audio = applyFeatureConfig(transformed, { purpose: 'audio', format: 'mp3' });
  const restored = deserializeProject(serializeProject(audio));
  assert.equal(getOutputOption(restored, '-vf'), undefined);
  for (const p of [restored, applyFeatureConfig(restored, { purpose: 'compress', audioMode: 'keep', format: 'mp4' })]) {
    const read = readFeatureConfig(p);
    assert.equal(read.config.rotation, 'none');
    assert.equal(read.config.flipHorizontal, false);
    assert.equal(read.config.flipVertical, false);
    assert.equal(read.config.resize, 'original');
    assert.equal(read.readonly, false);
  }
});
