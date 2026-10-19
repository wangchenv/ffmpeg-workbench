import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JobCard from '../src/JobCard';
import { parseProgress, jobProgress, formatBytes, formatElapsed, formatMediaTime } from '../src/core/progress';
import type { JobRecord } from '../src/core/progress';

test('native progress uses microseconds, retains monotonic time and ignores unavailable metrics', () => {
  const first = parseProgress({ processedSeconds: 0 }, { out_time_ms: '2500000', speed: '2.5x', fps: '30.0', frame: '75', total_size: '4096', bitrate: '102.4kbits/s' });
  assert.deepEqual(first, { processedSeconds: 2.5, speed: 2.5, fps: 30, frame: 75, sizeBytes: 4096, bitrateKbps: 102.4 });
  const later = parseProgress(first, { out_time_us: '-42', speed: 'N/A', fps: '0', total_size: 'N/A' });
  assert.deepEqual(later, first);
  assert.equal(parseProgress(first, { out_time: '00:01:02.500000' }).processedSeconds, 62.5);
  assert.equal(parseProgress(first, { out_time_us: '1000000' }).processedSeconds, 2.5);
});
test('percentage waits for publication and ETA uses measured speed with elapsed warmup', () => {
  const job = { state: 'running' as const, phase: 'processing' as const, duration: 10, startedAt: 1000, processedSeconds: 4, speed: 2 };
  const view = jobProgress(job, 3000);
  assert.equal(view.percentage, 40); assert.equal(view.remainingSeconds, 3); assert.equal(view.elapsedSeconds, 2);
  assert.equal(jobProgress(job, 1500).remainingSeconds, undefined);
  assert.equal(jobProgress({ ...job, processedSeconds: 11, phase: 'finalizing' }, 5000).percentage, 99);
  assert.equal(jobProgress({ ...job, state: 'succeeded', finishedAt: 4000 }, 100000).percentage, 100);
  assert.equal(jobProgress({ ...job, state: 'succeeded', finishedAt: 4000 }, 100000).elapsedSeconds, 3);
});
test('unknown duration never invents zero percent or a remaining time', () => {
  const view = jobProgress({ state: 'running', phase: 'processing', processedSeconds: 20, speed: 3, startedAt: 0 }, 10000);
  assert.equal(view.knownDuration, false); assert.equal(view.percentage, undefined); assert.equal(view.remainingSeconds, undefined);
  assert.equal(jobProgress({ state: 'canceled', phase: 'processing', processedSeconds: 1, duration: 10, startedAt: 1000, finishedAt: 2000, speed: 1 }, 9000).remainingSeconds, undefined);
});
test('human-readable telemetry handles hours, binary sizes and missing values', () => {
  assert.equal(formatBytes(undefined), '等待数据'); assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatElapsed(65), '1 分 5 秒'); assert.equal(formatElapsed(3660), '1 小时 1 分');
  assert.equal(formatMediaTime(3661), '01:01:01'); assert.equal(formatMediaTime(undefined), '时长未知');
});

test('positive subsecond telemetry keeps milliseconds while zero and whole seconds keep their usual display', () => {
  const cases = [
    [0, '00:00:00', '0 秒'],
    [0.1, '00:00:00.100', '0.1 秒'],
    [0.999, '00:00:00.999', '0.999 秒'],
    [1, '00:00:01', '1 秒'],
    [3661.75, '01:01:01', '1 小时 1 分'],
    [90061.75, '25:01:01', '25 小时 1 分'],
  ] as const;
  for (const [seconds, media, elapsed] of cases) {
    assert.equal(formatMediaTime(seconds), media);
    assert.equal(formatElapsed(seconds), elapsed);
  }
});

test('durations below displayed millisecond precision remain explicitly positive', () => {
  for (const seconds of [0.0001, Number.MIN_VALUE]) {
    assert.equal(formatMediaTime(seconds), '不足 0.001 秒');
    assert.equal(formatElapsed(seconds), '不足 0.001 秒');
  }
  assert.equal(formatMediaTime(0.999999), '00:00:00.999');
  assert.equal(formatMediaTime(1.999), '00:00:01', 'Ordinary second-level display remains unchanged');
});

test('completed short-clip cards retain fractional processed and total time without changing long-clip completion rounding', () => {
  const base: JobRecord = { id: 'short-clip', name: '截取片段', executable: 'ffmpeg', args: [], logs: [], output: '/output.mkv', source: '/source.mp4', format: 'mkv', video: true, queuedAt: 0, state: 'succeeded', phase: 'finalizing', startedAt: 1000, finishedAt: 1100, processedSeconds: 0.1, duration: 0.1, frame: 3 };
  for (const [seconds, expected] of [[0.1, '00:00:00.100'], [0.999, '00:00:00.999']] as const) {
    const html = renderToStaticMarkup(createElement(JobCard, { job: { ...base, processedSeconds: seconds, duration: seconds }, now: 2000, queuePosition: 0, onCancel: () => {}, onDetails: () => {} }));
    assert.ok(html.includes(expected + '<small> / ' + expected + '</small>'), html);
    assert.ok(html.includes('aria-valuenow="100"'));
    assert.ok(!html.includes('00:00:00<small> / 00:00:00</small>'));
  }
  const longClip = renderToStaticMarkup(createElement(JobCard, { job: { ...base, processedSeconds: 23.98, duration: 24 }, now: 2000, queuePosition: 0, onCancel: () => {}, onDetails: () => {} }));
  assert.ok(longClip.includes('00:00:24<small> / 00:00:24</small>'));
});
