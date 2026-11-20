import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlockPlan } from '../src/candidate/blocks.js';
import { createDefaultSettings } from '../src/config/settings.js';
import { createReputationStore } from '../src/hard-reputation.js';
import { runBlockScreening } from '../src/hard-engine.js';
import { createVirtualCatalog, virtualRanges } from './fixtures/virtual-catalog.js';

function engineSettings(overrides = {}) {
  const settings = createDefaultSettings('linux');
  Object.assign(settings.hard, overrides);
  return settings;
}

function planFor(rangeCount) {
  const ranges = [];
  for (let index = 0; index < rangeCount; index += 1) {
    ranges.push(`192.${Math.floor(index / 256)}.${index % 256}.0/24`);
  }
  return buildBlockPlan(ranges);
}

function okTask(candidate) {
  return {
    ok: true, statusCode: 101, handshakeMs: 100, connectMs: 40,
    cfRay: null, colo: 'FRA', error: null,
  };
}

function failTask(error) {
  return () => ({
    ok: false, statusCode: null, handshakeMs: null, connectMs: null,
    cfRay: null, colo: null, error,
  });
}

// Wraps a task and records every probed candidate, in call order.
function recording(task) {
  const calls = [];
  const wrapped = async (candidate, round) => {
    calls.push(candidate);
    return task(candidate, round);
  };
  return { task: wrapped, calls };
}

test('primer visits every block exactly primerPerBlock times on a cold run', async () => {
  const plan = planFor(4);
  const { task, calls } = recording(okTask);
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 12 }),
    task,
    concurrency: 4,
  });
  assert.equal(calls.length, 12);
  const perBlock = new Map();
  for (const candidate of calls) {
    perBlock.set(candidate.block, (perBlock.get(candidate.block) ?? 0) + 1);
  }
  assert.equal(perBlock.size, 4);
  for (const count of perBlock.values()) assert.equal(count, 3);
  assert.equal(result.totals.primerProbes, 12);
  assert.equal(result.totals.expansionProbes, 0);
});

test('primer order is stratified: pass k primers the k-th block of every range', async () => {
  // Two ranges of two blocks each (a /23 is two /24 cells).
  const plan = buildBlockPlan(['192.0.2.0/23', '198.51.100.0/23']);
  const { task, calls } = recording(okTask);
  await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 12 }),
    task,
    concurrency: 4,
  });
  const firstOccurrence = [];
  for (const candidate of calls) {
    if (!firstOccurrence.includes(candidate.block)) {
      firstOccurrence.push(candidate.block);
    }
  }
  // Pass 0: first block of each range; pass 1: second block of each range.
  assert.deepEqual(firstOccurrence, [
    '192.0.2.0/24',
    '198.51.100.0/24',
    '192.0.3.0/24',
    '198.51.101.0/24',
  ]);
});

test('the expansion budget is respected exactly', async () => {
  const plan = planFor(10);
  const { task } = recording(okTask);
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 50 }),
    task,
    concurrency: 4,
  });
  assert.equal(result.totals.probesSpent, 50);
  assert.equal(result.totals.primerProbes, 30);
  assert.equal(result.totals.expansionProbes, 20);
  assert.equal(result.stoppedReason, 'budget');
  assert.equal(result.completed, true);
});

test('the governed depth cap reaches both the engine and the allocator', async () => {
  const plan = planFor(3);
  const { task, calls } = recording(okTask);
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 500, maxDepthPerBlock: 5 }),
    task,
    concurrency: 4,
  });
  const perBlock = new Map();
  for (const candidate of calls) {
    perBlock.set(candidate.block, (perBlock.get(candidate.block) ?? 0) + 1);
  }
  // With the settings-governed cap of 5 (not the modules' default 32),
  // every block stops at exactly 5 run probes and the run exhausts.
  for (const count of perBlock.values()) assert.equal(count, 5);
  assert.equal(result.stoppedReason, 'exhausted');
});

test('a block whose primers all fail non-retryably is hard-dead and gets no expansion', async () => {
  const plan = planFor(3);
  const deadBlock = plan.blocks[1].blockId;
  const { task, calls } = recording((candidate) => (candidate.block === deadBlock
    ? {
      ok: false, statusCode: 403, handshakeMs: null, connectMs: null,
      cfRay: null, colo: null, error: 'unexpected_status_403',
    }
    : okTask(candidate)));
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 60 }),
    task,
    concurrency: 4,
  });
  const deadCalls = calls.filter((candidate) => candidate.block === deadBlock);
  assert.equal(deadCalls.length, 3);
  assert.ok(result.totals.expansionProbes > 0);
});

test('the hard-error valve aborts a run whose first probes share one non-retryable error', async () => {
  const plan = planFor(100);
  const { task } = recording(failTask('unexpected_status_403'));
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 72000 }),
    task,
    concurrency: 12,
  });
  assert.equal(result.stoppedReason, 'hard-error');
  assert.equal(result.completed, false);
  // The full primer would be 300 probes; the valve fires once the first
  // 200 observations are in, inside the batch that crosses the window.
  assert.ok(result.totals.primerProbes >= 200);
  assert.ok(result.totals.primerProbes < 300);
  assert.equal(result.totals.expansionProbes, 0);
});

test('the dead-path valve aborts a primer with near-zero successes at scale', async () => {
  const plan = planFor(400);
  const { task } = recording(failTask('timeout'));
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 72000 }),
    task,
    concurrency: 12,
  });
  assert.equal(result.stoppedReason, 'dead-path');
  assert.equal(result.completed, false);
  assert.ok(result.totals.primerProbes >= 1000);
  assert.ok(result.totals.primerProbes < 1200);
  assert.equal(result.totals.expansionProbes, 0);
});

test('reputation tiers set primer depth: skip costs 0, confirm costs 1, failed confirm falls back to full', async () => {
  const plan = planFor(3);
  const [skipBlock, confirmBlock, failingConfirmBlock] = plan.blocks;
  const now = Date.parse('2026-11-20T00:00:00Z');
  const day = 24 * 3600 * 1000;
  const store = createReputationStore(null);
  const record = (attempts, successes, ageDays) => ({
    attempts,
    successes,
    lastSeenAt: new Date(now - ageDays * day).toISOString(),
    countsAsOf: new Date(now - ageDays * day).toISOString(),
    lastRunId: 'earlier',
    best: [],
    colo: null,
    parent: null,
    children: null,
  });
  store.blocks[skipBlock.blockId] = record(30, 29, 1);
  store.blocks[confirmBlock.blockId] = record(30, 29, 7);
  store.blocks[failingConfirmBlock.blockId] = record(30, 29, 7);
  const { task, calls } = recording((candidate) => (candidate.block === failingConfirmBlock.blockId
    ? {
      ok: false, statusCode: null, handshakeMs: null, connectMs: null,
      cfRay: null, colo: null, error: 'timeout',
    }
    : okTask(candidate)));
  await runBlockScreening({
    blocks: plan.blocks,
    // Budget exactly covers the primer so expansion cannot blur the counts.
    settings: engineSettings({ budgetProbes: 4 }),
    task,
    concurrency: 4,
    reputation: store,
    now,
  });
  const perBlock = new Map();
  for (const candidate of calls) {
    perBlock.set(candidate.block, (perBlock.get(candidate.block) ?? 0) + 1);
  }
  assert.equal(perBlock.get(skipBlock.blockId) ?? 0, 0);
  assert.equal(perBlock.get(confirmBlock.blockId) ?? 0, 1);
  assert.equal(perBlock.get(failingConfirmBlock.blockId) ?? 0, 3);
});

test('delayed retries are queued from screening results and suppressed when disabled', async () => {
  const plan = planFor(3);
  const flakyBlock = plan.blocks[0].blockId;
  let seen = 0;
  const task = (candidate) => {
    if (candidate.block !== flakyBlock) return okTask(candidate);
    seen += 1;
    // First probe succeeds (so the block stays expandable); the rest fail
    // with a retryable error, in primer and expansion alike.
    return seen === 1
      ? okTask(candidate)
      : {
        ok: false, statusCode: null, handshakeMs: null, connectMs: null,
        cfRay: null, colo: null, error: 'timeout',
      };
  };
  const withRetries = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 40 }),
    task,
    concurrency: 4,
  });
  assert.ok(withRetries.retryQueue.length > 0);
  assert.ok(withRetries.retryQueue.every((entry) => entry.block === flakyBlock));
  assert.equal(withRetries.totals.retryQueued, withRetries.retryQueue.length);

  seen = 0;
  const withoutRetries = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 40, delayedRetry: false }),
    task,
    concurrency: 4,
  });
  assert.equal(withoutRetries.retryQueue.length, 0);
});

test('a heterogeneous block splits and its hot half keeps contributing candidates', async () => {
  const plan = planFor(1);
  const block = plan.blocks[0];
  const task = (candidate) => (candidate.hostOffset < block.size / 2
    ? okTask(candidate)
    : {
      ok: false, statusCode: null, handshakeMs: null, connectMs: null,
      cfRay: null, colo: null, error: 'timeout',
    });
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 32 }),
    task,
    concurrency: 4,
  });
  assert.equal(result.splits.length, 1);
  assert.equal(result.splits[0].parent, block.blockId);
  assert.equal(result.totals.blocksSplit, 1);
  const children = result.blockState.blocks.filter(
    (entry) => entry.parentBlockId === block.blockId,
  );
  assert.equal(children.length, 2);
  assert.ok(result.pool.length > 0);
  assert.ok(result.pool.every(
    (summary) => summary.block === block.blockId
      || children.some((child) => child.blockId === summary.block),
  ));
});

test('split-coverage pass: step E promotes a starved 0-success block and stage 1 splits it', async () => {
  const plan = planFor(1);
  const block = plan.blocks[0];
  // Seed 6 places all three primer draws in the upper half (offsets
  // 152/246/202), so with the upper half cold the primer is a 0/3
  // shutout — the class UCB expansion starves by construction.
  const settings = engineSettings({ budgetProbes: 20 });
  settings.scan.seed = 6;
  const task = (candidate) => (candidate.hostOffset < block.size / 2
    ? okTask(candidate)
    : {
      ok: false, statusCode: null, handshakeMs: null, connectMs: null,
      cfRay: null, colo: null, error: 'timeout',
    });
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings,
    task,
    concurrency: 4,
  });
  assert.equal(result.totals.blocksExtended, 1);
  assert.equal(result.totals.blocksPromoted, 1);
  assert.equal(result.totals.suspectsServed, 1);
  assert.ok(result.totals.reserveProbes > 0);
  assert.ok(
    result.totals.reserveProbes <= Math.floor(0.85 * (20 - 3)),
    `reserve ${result.totals.reserveProbes} exceeded its slice`,
  );
  assert.equal(result.splits.length, 1);
  assert.equal(result.splits[0].parent, block.blockId);
  assert.equal(result.splits[0].halves.upperSuccesses, 0);
  assert.ok(result.splits[0].halves.lowerSuccesses >= 4);
});

test('split-coverage pass: a zero reserve fraction disables the pass entirely', async () => {
  const plan = planFor(1);
  const block = plan.blocks[0];
  const settings = engineSettings({ budgetProbes: 20, splitReserveFraction: 0 });
  settings.scan.seed = 6;
  const task = (candidate) => (candidate.hostOffset < block.size / 2
    ? okTask(candidate)
    : {
      ok: false, statusCode: null, handshakeMs: null, connectMs: null,
      cfRay: null, colo: null, error: 'timeout',
    });
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings,
    task,
    concurrency: 4,
  });
  assert.equal(result.totals.reserveProbes, 0);
  assert.equal(result.totals.blocksExtended, 0);
  assert.equal(result.totals.blocksPromoted, 0);
  assert.equal(result.totals.suspectsServed, 0);
});

test('split-coverage pass: reserve spend is capped at the slice of post-primer headroom', async () => {
  const plan = planFor(8);
  const { task } = recording(failTask('timeout'));
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 30 }),
    task,
    concurrency: 4,
  });
  // Primer spends 24 of 30; the slice is floor(0.85 × 6) = 5, checked
  // before each block's stage, so spend lands in [5, 5 + one stage].
  assert.equal(result.totals.primerProbes, 24);
  assert.ok(result.totals.reserveProbes >= 5, `reserve ${result.totals.reserveProbes} < slice 5`);
  assert.ok(result.totals.reserveProbes <= 7, `reserve ${result.totals.reserveProbes} overshot the slice by more than one stage`);
  assert.ok(result.totals.blocksExtended >= 3);
  assert.equal(result.totals.blocksPromoted, 0);
  assert.ok(result.totals.probesSpent <= 30);
});

test('summaries stream through onSummary with block provenance, one per tested candidate', async () => {
  const plan = planFor(3);
  const summaries = [];
  const result = await runBlockScreening({
    blocks: plan.blocks,
    settings: engineSettings({ budgetProbes: 30 }),
    task: okTask,
    concurrency: 4,
    onSummary: (summary, candidate) => {
      assert.equal(summary.block, candidate.block);
      summaries.push(summary);
    },
  });
  assert.equal(summaries.length, result.totals.tested);
  assert.ok(summaries.every((summary) => typeof summary.block === 'string'));
});

test('crash/resume: a wave-aligned checkpoint resumes into the identical probe sequence', async () => {
  const ranges = virtualRanges(8);
  const makeRun = () => {
    const catalog = createVirtualCatalog({ ranges, map: 'clustered', seed: 4242 });
    const settings = createDefaultSettings('linux');
    settings.hard.budgetProbes = 2400;
    settings.hard.finalTop = 53;
    settings.hard.concurrency = 12;
    return { catalog, settings };
  };

  const full = makeRun();
  const fullResult = await runBlockScreening({
    blocks: full.catalog.blocks,
    settings: full.settings,
    task: full.catalog.task,
    concurrency: 12,
  });

  // Interrupt after the first expansion wave: onProgress fires at wave
  // boundaries, so the persisted state is wave-aligned and the allocator
  // (a pure function of the counters) replays exactly.
  const part = makeRun();
  let cancelArmed = false;
  const partResult = await runBlockScreening({
    blocks: part.catalog.blocks,
    settings: part.settings,
    task: part.catalog.task,
    concurrency: 12,
    isCanceled: () => cancelArmed,
    onProgress: ({ phase }) => {
      if (phase === 'hard-expansion') cancelArmed = true;
    },
  });
  assert.equal(partResult.completed, false);
  assert.equal(partResult.stoppedReason, 'canceled');
  assert.ok(part.catalog.probeLog.length < full.catalog.probeLog.length);

  const resumed = makeRun();
  const resumedResult = await runBlockScreening({
    blocks: resumed.catalog.blocks,
    settings: resumed.settings,
    task: resumed.catalog.task,
    concurrency: 12,
    initialBlockState: partResult.blockState,
  });
  assert.equal(resumedResult.completed, true);
  const combined = [...part.catalog.probeLog, ...resumed.catalog.probeLog]
    .map((entry) => entry.ip);
  assert.deepEqual(combined, full.catalog.probeLog.map((entry) => entry.ip));
  // The split-coverage pass settled inside part 1 (it spent reserve
  // probes there); the resumed run restores the pass counters and
  // spends no reserve probes of its own — the identical combined
  // probe sequence above is the sharp form of the same fact.
  assert.ok(partResult.totals.reserveProbes > 0);
  assert.equal(
    resumedResult.totals.reserveProbes,
    partResult.totals.reserveProbes,
  );
  // Part 1 expanded blocks before the interruption, and the resumed
  // run rebuilds blocksExpanded from the per-block expansionProbes
  // counters — so those counters must ride the checkpoint, or blocks
  // expanded only before the crash silently drop out of the count.
  assert.ok(partResult.totals.blocksExpanded > 0);
  assert.equal(
    resumedResult.totals.blocksExpanded,
    fullResult.totals.blocksExpanded,
  );
  assert.deepEqual(
    resumedResult.pool.map((summary) => summary.ip).sort(),
    fullResult.pool.map((summary) => summary.ip).sort(),
  );
});
