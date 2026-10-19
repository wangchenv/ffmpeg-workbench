import assert from 'node:assert/strict';
import test from 'node:test';
import { jobProgress, parseProgress } from '../src/core/progress';
import type { ProgressJob } from '../src/core/progress';

const running = (): ProgressJob => ({ state: 'running', phase: 'processing', startedAt: 1000, duration: 20, processedSeconds: 5, speed: 2 });

test('progress timestamp precedence tolerates invalid primary values without mixing units', () => {
  const previous = { processedSeconds: 0 };
  assert.equal(parseProgress(previous, { out_time_us: '3000000', out_time_ms: '9000000', out_time: '00:00:15.000' }).processedSeconds, 3);
  assert.equal(parseProgress(previous, { out_time_us: 'N/A', out_time_ms: '4000000', out_time: '00:00:15.000' }).processedSeconds, 4);
  assert.equal(parseProgress(previous, { out_time_us: '-1', out_time_ms: 'Infinity', out_time: '01:02:03.250' }).processedSeconds, 3723.25);
  assert.equal(parseProgress(previous, { out_time_us: '0', out_time_ms: '9000000' }).processedSeconds, 0);
});

test('malformed telemetry cannot poison numeric metrics or regress written bytes and processed time', () => {
  const previous = { processedSeconds: 4, speed: 2, fps: 30, frame: 120, sizeBytes: 1024, bitrateKbps: 512 };
  const invalid = parseProgress(previous, { out_time_us: 'NaN', speed: 'Infinityx', fps: '-1', frame: '-1', total_size: 'NaN', bitrate: '-1kbits/s' });
  assert.deepEqual(invalid, previous);
  const delayed = parseProgress(previous, { out_time_us: '2000000', total_size: '64', frame: '121' });
  assert.equal(delayed.processedSeconds, 4);
  assert.equal(delayed.sizeBytes, 1024);
  assert.equal(delayed.frame, 121);
});

test('zero, negative and nonfinite duration never yields fabricated progress or ETA', () => {
  for (const duration of [undefined, 0, -1, NaN, Infinity]) {
    const view = jobProgress({ ...running(), duration }, 5000);
    assert.equal(view.knownDuration, false);
    assert.equal(view.percentage, undefined);
    assert.equal(view.remainingSeconds, undefined);
    assert.equal(jobProgress({ ...running(), duration, state: 'succeeded', finishedAt: 5000 }, 6000).percentage, 100);
  }
});

test('failed and canceled jobs freeze elapsed time and never retain a remaining-time estimate', () => {
  for (const state of ['failed', 'canceled'] as const) {
    const view = jobProgress({ ...running(), state, finishedAt: 6500 }, 999999);
    assert.equal(view.elapsedSeconds, 5.5);
    assert.equal(view.remainingSeconds, undefined);
    assert.equal(view.terminal, true);
    assert.notEqual(view.percentage, 100);
    assert.equal(view.phaseLabel, state === 'failed' ? '处理未完成' : '已取消处理');
  }
  assert.equal(jobProgress(running(), 500).elapsedSeconds, 0, 'Wall-clock rollback must not show negative elapsed time');
});

test('preparation and finalization do not claim an encoding ETA or completion before publication', () => {
  for (const phase of ['preparing', 'finalizing'] as const) {
    const view = jobProgress({ ...running(), phase, processedSeconds: 25 }, 9000);
    assert.equal(view.remainingSeconds, undefined);
    assert.equal(view.percentage, 99);
    assert.equal(view.phaseLabel, phase === 'preparing' ? '正在准备素材' : '正在保存文件');
  }
  assert.equal(jobProgress({ ...running(), processedSeconds: 25 }, 9000).remainingSeconds, 0);
});
