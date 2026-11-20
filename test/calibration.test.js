import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateConcurrency } from '../src/measurement/calibration.js';

test('calibration selects the highest concurrency that does not distort latency', async () => {
  const result = await calibrateConcurrency({
    levels: [1, 2, 4, 8],
    latencyInflationLimit: 0.1,
    failureRateIncreaseLimit: 0.02,
    eventLoopLagLimitMs: 10000,
    controlTask: async ({ level }) => ({ ok: true, latencyMs: level <= 4 ? 100 : 130 }),
  });
  assert.equal(result.selectedConcurrency, 4);
  assert.equal(result.levels.at(-1).level, 8);
  assert.equal(result.levels.at(-1).accepted, false);
});

test('calibration backs off when failures rise with load', async () => {
  const result = await calibrateConcurrency({
    levels: [1, 2, 4],
    eventLoopLagLimitMs: 10000,
    controlTask: async ({ level, index }) => ({ ok: level < 4 || index === 0, latencyMs: 100 }),
  });
  assert.equal(result.selectedConcurrency, 2);
});

test('calibration requires a control task and at least one level', async () => {
  await assert.rejects(() => calibrateConcurrency({ levels: [1] }), /controlTask/);
  await assert.rejects(
    () => calibrateConcurrency({ levels: [], controlTask: async () => ({ ok: true, latencyMs: 1 }) }),
    /concurrency level/,
  );
});

test('calibration reports each measured level, in order, with the ladder size', async () => {
  const events = [];
  const result = await calibrateConcurrency({
    levels: [1, 2, 4],
    eventLoopLagLimitMs: 10000,
    controlTask: async () => ({ ok: true, latencyMs: 100 }),
    onProgress: (event) => events.push(event),
  });
  assert.equal(result.selectedConcurrency, 4);
  assert.deepEqual(
    events.map(({ completed, total, level }) => [completed, total, level]),
    [
      [1, 3, 1],
      [2, 3, 2],
      [3, 3, 4],
    ],
  );
});

test('an abort mid-level rejects with AbortError instead of waiting out the level', async () => {
  const controller = new AbortController();
  const slowProbe = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true, latencyMs: 100 }), 3000);
      timer.unref?.();
    });
  const startedAt = Date.now();
  const pending = calibrateConcurrency({
    levels: [1, 2, 4],
    eventLoopLagLimitMs: 10000,
    controlTask: slowProbe,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `abort landed in ${elapsed}ms, not after the 3000ms probe`);
});
