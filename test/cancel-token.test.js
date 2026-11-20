// Cancel token (0.9.0 W3, plan ch. 3.7): run functions accept an
// optional AbortSignal-shaped token — the web layer's stop button.
// These tests pin the three guarantees the wave is gated on:
//   1. With no signal (every terminal caller) behavior is unchanged —
//      the full pre-existing suite is the proof; here the schedulers'
//      no-predicate path is re-asserted directly.
//   2. With a signal, work stops at batch/stage boundaries and the
//      run still lands gracefully: Hard keeps its checkpoint as
//      "paused" with stoppedReason "canceled" (exactly the terminal
//      Q/Ctrl+C outcome); runScan writes its report from the evidence
//      gathered and reports canceled in the Hard return vocabulary.
//   3. No fake evidence is ever fabricated: a canceled stage simply
//      contributes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInterleaved } from '../src/scheduler.js';
import {
  runEligibilityBatch,
  runAdaptiveEligibilityBatch,
} from '../src/hard-scheduler.js';
import { runScan } from '../src/scan.js';
import { runHardScan, hasHardScanState } from '../src/hard-scan.js';
import { createDefaultSettings } from '../src/config/settings.js';
import { paths } from '../src/platform/paths.js';
import { createVirtualCatalog } from './fixtures/virtual-catalog.js';

const VLESS_URI =
  'vless://11111111-2222-3333-4444-555555555555@edge.example.com:2052?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#Cancel';

function recordingLogger() {
  const events = [];
  return {
    events,
    info(event, details) { events.push({ level: 'info', event, details }); },
    debug() {},
    warn(event, details) { events.push({ level: 'warn', event, details }); },
    error() {},
    setLevel() {},
    setPhase() {},
    async close() {},
  };
}

function tempLayout(ranges) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-cancel-'));
  const layout = paths(root);
  for (const directory of [
    layout.data,
    layout.results,
    layout.logs,
    layout.hardScanDir,
    path.dirname(layout.rangesFile),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(layout.rangesFile, `${ranges.join('\n')}\n`);
  return layout;
}

test('runInterleaved: cancel predicate stops new work, keeps gathered results', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ ip: `10.0.0.${i + 1}` }));
  let calls = 0;
  const results = await runInterleaved({
    items,
    rounds: 1,
    concurrency: 2,
    seed: 7,
    task: async (item) => {
      calls += 1;
      return { ok: true, ip: item.ip };
    },
    isCanceled: () => calls >= 3,
  });
  assert.ok(calls >= 3, 'some work happened before the stop');
  assert.ok(calls < 10, `stop bounded the work (calls=${calls})`);
  assert.equal(results.length, calls, 'every completed task is in the results');
  // No predicate: the historical full sweep, unchanged.
  calls = 0;
  const full = await runInterleaved({
    items,
    rounds: 1,
    concurrency: 2,
    seed: 7,
    task: async (item) => {
      calls += 1;
      return { ok: true, ip: item.ip };
    },
  });
  assert.equal(calls, 10);
  assert.equal(full.length, 10);
});

test('batch runners: a cancel before the first pull starts nothing', async () => {
  let calls = 0;
  const task = async () => {
    calls += 1;
    return { ok: true, handshakeMs: 10, error: null };
  };
  const candidates = [{ ip: '10.0.0.1' }, { ip: '10.0.0.2' }];
  const eligibility = await runEligibilityBatch({
    candidates, rounds: 1, concurrency: 2, minimumSuccessRate: 0.6,
    task, isCanceled: () => true,
  });
  assert.deepEqual(eligibility, []);
  const adaptive = await runAdaptiveEligibilityBatch({
    candidates, concurrency: 2, task, isCanceled: () => true,
  });
  assert.deepEqual(adaptive, []);
  assert.equal(calls, 0);
});

test('runEligibilityBatch: mid-batch cancel returns finished candidates only, no holes', async () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({ ip: `10.0.0.${i + 1}` }));
  let done = 0;
  const results = await runEligibilityBatch({
    candidates,
    rounds: 1,
    concurrency: 2,
    minimumSuccessRate: 0.6,
    task: async () => {
      done += 1;
      return { ok: true, handshakeMs: 10, error: null };
    },
    isCanceled: () => done >= 2,
  });
  assert.ok(results.length >= 2 && results.length < 8, `partial results (${results.length})`);
  assert.ok(results.every((result) => result && result.candidate && Array.isArray(result.observations)));
});

test('runScan: a pre-aborted token skips every stage and still writes a canceled report', async () => {
  const layout = tempLayout(['104.16.0.0/24', '104.17.0.0/24']);
  const settings = createDefaultSettings('linux');
  const logger = recordingLogger();
  const controller = new AbortController();
  controller.abort();
  const result = await runScan({
    vlessUri: VLESS_URI,
    settings,
    layout,
    logger,
    runId: 'cancel-scan-preaborted',
    signal: controller.signal,
  });
  assert.equal(result.canceled, true);
  assert.equal(result.stoppedReason, 'canceled');
  assert.equal(result.eligibleCount, 0);
  assert.ok(fs.existsSync(result.jsonPath), 'report written from the (empty) evidence');
  assert.equal(result.report.totals.unmeasured, result.report.totals.candidates);
  // No calibration verdict was measured, so none may be logged.
  assert.ok(!logger.events.some((entry) => entry.event === 'scan.calibration'));
  const complete = logger.events.find((entry) => entry.event === 'scan.complete');
  assert.equal(complete?.details.canceled, true);
});

test('runHardScan: aborting the token mid-screening pauses exactly like Q/Ctrl+C', { timeout: 60000 }, async () => {
  const ranges = ['10.0.0.0/22'];
  const settings = createDefaultSettings('linux');
  settings.calibration.enabled = false;
  settings.tunnel.enabled = false;
  Object.assign(settings.hard, { concurrency: 4, engine: 'blocks', budgetProbes: 400 });

  // Control run (no token): the full probe count the abort must beat.
  const controlLayout = tempLayout(ranges);
  const controlCatalog = createVirtualCatalog({ ranges, map: 'clustered', seed: 7 });
  const control = await runHardScan({
    vlessUri: VLESS_URI,
    settings,
    layout: controlLayout,
    logger: recordingLogger(),
    runId: 'cancel-hard-control',
    task: controlCatalog.task,
  });
  assert.equal(control.canceled, false);

  const layout = tempLayout(ranges);
  const catalog = createVirtualCatalog({ ranges, map: 'clustered', seed: 7 });
  const controller = new AbortController();
  let calls = 0;
  const countingTask = async (candidate, round) => {
    calls += 1;
    if (calls === 25) controller.abort();
    return catalog.task(candidate, round);
  };
  const result = await runHardScan({
    vlessUri: VLESS_URI,
    settings,
    layout,
    logger: recordingLogger(),
    runId: 'cancel-hard-abort',
    task: countingTask,
    signal: controller.signal,
  });
  assert.equal(result.canceled, true);
  assert.equal(result.stoppedReason, 'canceled');
  assert.ok(
    result.report.totals.probesSpent < control.report.totals.probesSpent,
    `aborted run spent ${result.report.totals.probesSpent} of the control's ${control.report.totals.probesSpent}`,
  );
  // The terminal stop contract: checkpoint kept, status paused, resumable.
  assert.equal(hasHardScanState(layout), true);
  const checkpoint = JSON.parse(fs.readFileSync(layout.hardStateFile, 'utf8'));
  assert.equal(checkpoint.status, 'paused');
});

test('runHardScan: a pre-aborted token spends zero probes and pauses', { timeout: 60000 }, async () => {
  const ranges = ['10.0.0.0/22'];
  const settings = createDefaultSettings('linux');
  settings.calibration.enabled = false;
  settings.tunnel.enabled = false;
  Object.assign(settings.hard, { concurrency: 4, engine: 'blocks', budgetProbes: 400 });
  const layout = tempLayout(ranges);
  const catalog = createVirtualCatalog({ ranges, map: 'clustered', seed: 7 });
  const controller = new AbortController();
  controller.abort();
  const result = await runHardScan({
    vlessUri: VLESS_URI,
    settings,
    layout,
    logger: recordingLogger(),
    runId: 'cancel-hard-preaborted',
    task: catalog.task,
    signal: controller.signal,
  });
  assert.equal(result.canceled, true);
  assert.equal(result.stoppedReason, 'canceled');
  assert.equal(result.report.totals.probesSpent, 0);
  assert.equal(hasHardScanState(layout), true);
});
