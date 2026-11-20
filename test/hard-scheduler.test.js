import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRangePlan, nextRoundRobinCandidate } from '../src/candidate/hard-order.js';
import { collectCandidateBatch, probeCandidateRounds, runEligibilityBatch } from '../src/hard-scheduler.js';

test('hard batches keep range round-robin candidate order', () => {
  const plan = buildRangePlan(['192.0.2.0/30', '198.51.100.0/30', '203.0.113.0/30']);
  const first = collectCandidateBatch({
    plan,
    cursor: { rangeIndex: 0, passIndex: 0 },
    limit: 4,
    nextCandidate: nextRoundRobinCandidate,
  });
  assert.deepEqual(first.map((item) => item.ip), [
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.0.2.2',
  ]);
});

test('hard eligibility batch is concurrent and returns input order', async () => {
  const candidates = Array.from({ length: 8 }, (_value, index) => ({ ip: `ip-${index}` }));
  let active = 0;
  let peak = 0;
  const results = await runEligibilityBatch({
    candidates,
    rounds: 1,
    concurrency: 3,
    minimumSuccessRate: 0.6,
    task: async (candidate) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ip: candidate.ip, ok: true };
    },
  });
  assert.ok(peak > 1 && peak <= 3);
  assert.deepEqual(results.map((item) => item.candidate.ip), candidates.map((item) => item.ip));
});

test('dead candidate stops when remaining rounds cannot reach threshold', async () => {
  let attempts = 0;
  const observations = await probeCandidateRounds({
    candidate: { ip: '192.0.2.1' },
    rounds: 3,
    minimumSuccessRate: 0.6,
    task: async () => {
      attempts += 1;
      return { ok: false };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(observations.length, 2);
});

import { selectDelayedRetries, orderForTunnelSelection, selectRecheckFinalists } from '../src/hard-scheduler.js';

const ok = { ok: true };
const retryable = { ok: false, error: 'timeout' };
const hardFailure = { ok: false, error: 'unexpected_status_403' };
const batch = (ip, observations) => ({ candidate: { ip }, observations });

test('delayed retries: untargeted selection keeps the legacy any-retryable-failure rule', () => {
  const results = [batch('a', [ok, ok, retryable]), batch('b', [hardFailure]), batch('c', [retryable])];
  assert.deepEqual(selectDelayedRetries(results).map((c) => c.ip), ['a', 'c']);
  assert.deepEqual(selectDelayedRetries(results, { maxRetries: 1 }).map((c) => c.ip), ['a']);
});

test('delayed retries: a passing candidate is never re-probed (the sink-the-winner guard)', () => {
  const results = [batch('winner', [ok, ok, retryable]), batch('perfect', [ok, ok, ok])];
  const picked = selectDelayedRetries(results, { minimumSuccessRate: 0.6, singleProbe: true });
  assert.deepEqual(picked, []);
});

test('delayed retries: single-probe selection takes only candidates one probe can still save', () => {
  const results = [
    batch('one-of-three', [ok, retryable, retryable]),
    batch('zero-of-three', [retryable, retryable, retryable]),
    batch('one-of-two', [ok, retryable]),
    batch('hard-only', [ok, hardFailure, hardFailure]),
  ];
  const picked = selectDelayedRetries(results, { minimumSuccessRate: 0.6, singleProbe: true }).map((c) => c.ip);
  assert.deepEqual(picked.sort(), ['one-of-three', 'one-of-two']);
});

test('delayed retries: queue selection (no single-probe window) still rescues zero-success candidates', () => {
  const results = [batch('zero', [retryable, retryable, retryable]), batch('passing', [ok, ok, retryable])];
  const picked = selectDelayedRetries(results, { minimumSuccessRate: 0.6 }).map((c) => c.ip);
  assert.deepEqual(picked, ['zero']);
});

test('delayed retries: targeted selection orders by Wilson upper bound and caps after ordering', () => {
  const results = [
    batch('thin', [ok, ok, ok, retryable, retryable, retryable, retryable, retryable, retryable, retryable]),
    batch('coin-flip', [ok, retryable]),
    batch('blank', [retryable, retryable]),
  ];
  const picked = selectDelayedRetries(results, { minimumSuccessRate: 0.6 }).map((c) => c.ip);
  assert.deepEqual(picked, ['coin-flip', 'blank', 'thin']);
  assert.deepEqual(selectDelayedRetries(results, { minimumSuccessRate: 0.6, maxRetries: 2 }).map((c) => c.ip), ['coin-flip', 'blank']);
});

test('tunnel selection: post-verification order beats the screening order', () => {
  const entries = [
    { candidate: { ip: 'unverified' }, observations: [] },
    { candidate: { ip: 'inconclusive' }, observations: [] },
    { candidate: { ip: 'accepted' }, observations: [] },
  ];
  const decisionByIp = new Map([['inconclusive', 'inconclusive'], ['accepted', 'accept']]);
  const verificationRateByIp = new Map([['inconclusive', 0.7], ['accepted', 0.8]]);
  const ordered = orderForTunnelSelection(entries, { decisionByIp, verificationRateByIp });
  assert.deepEqual(ordered.map((e) => e.candidate.ip), ['accepted', 'inconclusive', 'unverified']);
});

test('tunnel selection: fresher verification evidence leads within a decision class', () => {
  const entries = [
    { candidate: { ip: 'accepted-low' }, observations: [] },
    { candidate: { ip: 'accepted-high' }, observations: [] },
    { candidate: { ip: 'plain-a' }, observations: [] },
    { candidate: { ip: 'plain-b' }, observations: [] },
  ];
  const decisionByIp = new Map([['accepted-low', 'accept'], ['accepted-high', 'accept']]);
  const verificationRateByIp = new Map([['accepted-low', 0.75], ['accepted-high', 1]]);
  const ordered = orderForTunnelSelection(entries, { decisionByIp, verificationRateByIp });
  assert.deepEqual(ordered.map((e) => e.candidate.ip), ['accepted-high', 'accepted-low', 'plain-a', 'plain-b']);
});

test('recheck selection: the per-block cap walks deeper into the finalist list', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_v, i) => ({ ip: `10.0.0.${i + 1}`, block: '10.0.0.0/24' })),
    ...Array.from({ length: 6 }, (_v, i) => ({ ip: `10.0.1.${i + 1}`, block: '10.0.1.0/24' })),
  ];
  const picked = selectRecheckFinalists(entries, { limit: 5, perBlock: 4 });
  assert.deepEqual(picked.map((e) => e.ip), ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.1.1']);
});

test('recheck selection: a cap above the block size is the plain top slice', () => {
  const entries = Array.from({ length: 6 }, (_v, i) => ({ ip: `10.0.0.${i + 1}`, block: '10.0.0.0/24' }));
  assert.deepEqual(selectRecheckFinalists(entries, { limit: 3, perBlock: 8 }).map((e) => e.ip), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

test('recheck selection: legacy entries without a block group by their /24; split blocks count apart', () => {
  const legacy = [{ ip: '10.0.0.5' }, { ip: '10.0.0.9' }, { ip: '10.0.1.5' }];
  assert.deepEqual(selectRecheckFinalists(legacy, { limit: 3, perBlock: 1 }).map((e) => e.ip), ['10.0.0.5', '10.0.1.5']);
  const splits = [
    { ip: '10.0.0.1', block: '10.0.0.0/25' },
    { ip: '10.0.0.2', block: '10.0.0.0/25' },
    { ip: '10.0.0.129', block: '10.0.0.128/25' },
  ];
  assert.deepEqual(selectRecheckFinalists(splits, { limit: 3, perBlock: 1 }).map((e) => e.ip), ['10.0.0.1', '10.0.0.129']);
});
