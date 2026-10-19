import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAdvancedSetting, applyFeatureConfig, getAdvancedChoiceIssue, getAudioBitrateIssue, getAudioSampleRateIssue, getOutputOption, readFeatureConfig } from '../src/core';
import type { ProjectDocument } from '../src/core';

const project = (): ProjectDocument => ({ schemaVersion: 1, id: 'opus-choice', name: 'Opus 界面候选兼容', nodes: [
  { id: 'source', kind: 'input', enabled: true, tokens: ['-i', 'mono-source.mp4'] },
  { id: 'video', kind: 'option', enabled: true, tokens: ['-c:v', 'libx264'] },
  { id: 'audio', kind: 'option', enabled: true, tokens: ['-c:a', 'aac'] },
  { id: 'output', kind: 'output', enabled: true, tokens: ['output.mp4'] },
] });
const webm = () => applyFeatureConfig(project(), { format: 'webm' });

for (const bitrate of ['96', '128', '192', '320'] as const) {
  test(`WebM bitrate ${bitrate} with automatic/mono channels is checked before command generation`, () => {
    for (const p of [webm(), applyAdvancedSetting(webm(), 'audio-channels', '1')]) {
      const snapshot = structuredClone(p);
      if (bitrate === '320') {
        assert.match(getAudioBitrateIssue(p, bitrate)!, /立体声|多声道/);
        assert.throws(() => applyFeatureConfig(p, { audioBitrate: bitrate }), /立体声|多声道/);
      } else {
        assert.equal(getAudioBitrateIssue(p, bitrate), undefined);
        assert.equal(getOutputOption(applyFeatureConfig(p, { audioBitrate: bitrate }), '-b:a')?.tokens[1], `${bitrate}k`);
      }
      assert.deepEqual(p, snapshot);
    }
  });
}

for (const channels of ['2', '6']) {
  test(`explicit Opus channels ${channels} allow 320 kbps without losing the explicit channel setting`, () => {
    const p = applyAdvancedSetting(webm(), 'audio-channels', channels);
    assert.equal(getAudioBitrateIssue(p, '320'), undefined);
    const selected = applyFeatureConfig(p, { audioBitrate: '320' });
    assert.equal(getOutputOption(selected, '-b:a')?.tokens[1], '320k');
    assert.equal(getOutputOption(selected, '-ac')?.tokens[1], channels);
  });
}

for (const rate of ['original', '44100', '48000'] as const) {
  test(`WebM sampling rate ${rate} follows Opus support rather than allowing an encoder failure`, () => {
    const p = webm();
    if (rate === '44100') {
      assert.match(getAudioSampleRateIssue(p, rate)!, /44.1/);
      assert.throws(() => applyFeatureConfig(p, { audioSampleRate: rate }), /44.1/);
    } else {
      assert.equal(getAudioSampleRateIssue(p, rate), undefined);
      const selected = applyFeatureConfig(p, { audioSampleRate: rate });
      assert.equal(getOutputOption(selected, '-ar')?.tokens[1], rate === 'original' ? undefined : rate);
    }
  });
}

test('switching to WebM normalizes incompatible inherited audio controls in argv and their readback', () => {
  const existing = applyFeatureConfig(project(), { audioBitrate: '320', audioSampleRate: '44100' });
  existing.nodes.splice(1, 0, { id: 'disabled-rate', kind: 'option', enabled: false, tokens: ['-ar', '44100'] }, { id: 'unknown', kind: 'option', enabled: true, tokens: ['-future_option', 'keep'] });
  const changed = applyFeatureConfig(existing, { format: 'webm' });
  assert.equal(readFeatureConfig(existing).config.audioBitrate, '320');
  assert.equal(readFeatureConfig(changed).config.audioBitrate, '192');
  assert.equal(getOutputOption(changed, '-b:a')?.tokens[1], '192k');
  assert.equal(readFeatureConfig(changed).config.audioSampleRate, 'original');
  assert.equal(getOutputOption(changed, '-ar'), undefined);
  for (const id of ['disabled-rate', 'unknown']) assert.deepEqual(changed.nodes.find(n => n.id === id), existing.nodes.find(n => n.id === id));
  assert.throws(() => applyFeatureConfig(existing, { format: 'webm', audioBitrate: '320' }));
  assert.throws(() => applyFeatureConfig(existing, { format: 'webm', audioSampleRate: '44100' }));
});

test('switching a compatible stereo configuration to WebM preserves its chosen 320 kbps', () => {
  const existing = applyAdvancedSetting(applyFeatureConfig(project(), { audioBitrate: '320', audioSampleRate: '48000' }), 'audio-channels', '2');
  const changed = applyFeatureConfig(existing, { format: 'webm' });
  assert.equal(readFeatureConfig(changed).config.audioBitrate, '320');
  assert.equal(getOutputOption(changed, '-b:a')?.tokens[1], '320k');
  assert.equal(getOutputOption(changed, '-ar')?.tokens[1], '48000');
});

test('Opus bitrate and channel choices are guarded in both directions, including resetting channels to automatic', () => {
  const stereo = applyAdvancedSetting(webm(), 'audio-channels', '2');
  const high = applyFeatureConfig(stereo, { audioBitrate: '320' });
  for (const value of ['1', '', undefined]) {
    assert.match(getAdvancedChoiceIssue(high, 'audio-channels', value)!, /192/);
    assert.throws(() => applyAdvancedSetting(high, 'audio-channels', value), /192/);
  }
  assert.equal(getAdvancedChoiceIssue(high, 'audio-channels', '2'), undefined);
  assert.equal(getAdvancedChoiceIssue(high, 'audio-channels', '6'), undefined);
  const lowered = applyFeatureConfig(high, { audioBitrate: '192' });
  for (const value of ['1', '', undefined]) assert.equal(getAdvancedChoiceIssue(lowered, 'audio-channels', value), undefined);
  assert.equal(getOutputOption(applyAdvancedSetting(lowered, 'audio-channels', undefined), '-ac'), undefined);
});

test('MP3 and AAC retain valid 320 kbps and 44.1 kHz choices', () => {
  for (const format of ['mp3', 'mp4'] as const) {
    const p = applyFeatureConfig(project(), { format });
    assert.equal(getAudioBitrateIssue(p, '320'), undefined);
    assert.equal(getAudioSampleRateIssue(p, '44100'), undefined);
    const selected = applyFeatureConfig(p, { audioBitrate: '320', audioSampleRate: '44100' });
    assert.equal(getOutputOption(selected, '-b:a')?.tokens[1], '320k');
    assert.equal(getOutputOption(selected, '-ar')?.tokens[1], '44100');
  }
});

test('unmuting a legacy WebM configuration also resolves its inherited invalid audio controls', () => {
  const muted = applyFeatureConfig(project(), { audioBitrate: '320', audioSampleRate: '44100', purpose: 'mute' });
  const legacy = applyFeatureConfig(muted, { format: 'webm' });
  assert.equal(getAudioBitrateIssue(legacy, '320'), undefined);
  assert.equal(getAudioSampleRateIssue(legacy, '44100'), undefined);
  assert.equal(getAdvancedChoiceIssue(legacy, 'audio-channels', '1'), undefined);
  const enabled = applyFeatureConfig(legacy, { audioMode: 'keep' });
  assert.equal(getOutputOption(enabled, '-b:a')?.tokens[1], '192k');
  assert.equal(getOutputOption(enabled, '-ar'), undefined);
  assert.equal(getOutputOption(enabled, '-an'), undefined);
});
