import { classifyProbeError } from './probe/errors.js';
import { createSprtConfig, runSprt } from './measurement/sprt.js';
import { wilsonInterval } from './measurement/confidence.js';

function positiveInteger(value, fallback = 1) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function collectCandidateBatch({ plan, cursor, limit, nextCandidate }) {
  const candidates = [];
  let nextCursor = cursor;
  while (candidates.length < positiveInteger(limit)) {
    const candidate = nextCandidate(plan, nextCursor);
    if (!candidate) break;
    candidates.push(candidate);
    nextCursor = candidate.nextCursor;
  }
  return candidates;
}

export async function probeCandidateRounds({ candidate, rounds, minimumSuccessRate, task }) {
  const totalRounds = positiveInteger(rounds);
  const threshold = Math.max(0, Math.min(1, Number(minimumSuccessRate) || 0));
  const requiredSuccesses = Math.ceil((totalRounds * threshold) - Number.EPSILON);
  const observations = [];
  let successes = 0;
  for (let round = 1; round <= totalRounds; round += 1) {
    const observation = await task(candidate, round);
    observations.push(observation);
    if (observation.ok) successes += 1;
    if (successes + (totalRounds - round) < requiredSuccesses) break;
  }
  return observations;
}

async function runWorkers({ candidates, concurrency, worker }) {
  const results = new Array(candidates.length);
  const workerCount = Math.min(positiveInteger(concurrency), candidates.length);
  let cursor = 0;
  let finished = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      results[index] = await worker(candidates[index], index);
      finished += 1;
      results[index].finished = finished;
    }
  }));
  return results;
}

export async function runEligibilityBatch({ candidates, rounds, concurrency, minimumSuccessRate, task, onCandidateDone = null }) {
  if (candidates.length === 0) return [];
  const results = await runWorkers({
    candidates, concurrency,
    worker: async (candidate) => ({ candidate, observations: await probeCandidateRounds({ candidate, rounds, minimumSuccessRate, task }) }),
  });
  for (const result of results) onCandidateDone?.({ ...result, total: candidates.length });
  return results.map(({ finished, ...result }) => result);
}

export async function runAdaptiveEligibilityBatch({ candidates, concurrency, task, sprt = {}, onCandidateDone = null }) {
  if (candidates.length === 0) return [];
  const config = createSprtConfig(sprt);
  const results = await runWorkers({
    candidates, concurrency,
    worker: async (candidate) => {
      const evaluated = await runSprt({ task: (round) => task(candidate, round), config });
      return { candidate, ...evaluated };
    },
  });
  for (const result of results) onCandidateDone?.({ ...result, total: candidates.length });
  return results.map(({ finished, ...result }) => result);
}

// Delayed-retry selection. A retry exists to rescue candidates a fresh
// probe can still save — never to re-probe one that already stands at or
// above the eligibility rate. That exclusion is load-bearing in runScan,
// where the retry observation is appended to the record the eligibility
// gate reads: re-probing a passing 2/3 candidate and drawing one
// transient failure drops it to 2/4 = 0.5 and strips eligibility it had
// already earned. Selection therefore requires a retryable failure and a
// below-threshold record; survivors are ordered by Wilson upper bound,
// most recoverable first, so a capped batch spends itself where recovery
// is likeliest (equal bounds keep the caller's order — the sort is
// stable). With `singleProbe` (runScan's one appended observation) a
// candidate must also be one success from the threshold, or already hold
// a success the extra probe can build on. The Hard engines pass no
// singleProbe: their retry is a fresh multi-round batch whose summary
// replaces the screening one, and a zero-success candidate is exactly
// what that batch exists to rescue.
export function selectDelayedRetries(results, { maxRetries = Infinity, minimumSuccessRate = null, singleProbe = false } = {}) {
  const threshold = null == minimumSuccessRate ? NaN : Number(minimumSuccessRate),
    targeted = Number.isFinite(threshold),
    selected = [];
  for (const { candidate, observations } of results) {
    if (!observations?.some((item) => !item.ok && classifyProbeError(item.error).retryable)) continue;
    if (!targeted) {
      selected.push({ candidate, upper: 0 });
      continue;
    }
    const successes = observations.filter((item) => item.ok).length,
      rate = observations.length ? successes / observations.length : 0;
    if (rate >= threshold) continue;
    if (singleProbe) {
      const oneSuccessRescues = (successes + 1) / (observations.length + 1) >= threshold;
      if (!oneSuccessRescues && 0 === successes) continue;
    }
    selected.push({
      candidate,
      upper: wilsonInterval(successes, observations.length).upper,
    });
  }
  if (targeted) selected.sort((left, right) => right.upper - left.upper);
  return selected.slice(0, maxRetries).map(({ candidate }) => candidate);
}

// Tunnel slots are the scarcest resource in a run, so they are dealt in
// post-verification order, not the pre-verification screening order the
// eligible list arrives in: an SPRT-accepted finalist outranks an
// inconclusive one, which outranks a candidate that was never verified —
// regardless of how the screening tie-break (raw rate, then handshake
// speed) happened to line them up. Eligibility itself is untouched; only
// the slot order changes. Within a decision class the fresher evidence
// leads (verification success rate), then the caller's screening order.
export function orderForTunnelSelection(entries, { decisionByIp = new Map(), verificationRateByIp = new Map() } = {}) {
  const groupOf = (ip) => {
    const decision = decisionByIp.get(ip);
    return 'accept' === decision ? 0 : decision ? 1 : 2;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) =>
      groupOf(left.entry.candidate.ip) - groupOf(right.entry.candidate.ip) ||
      (verificationRateByIp.get(right.entry.candidate.ip) ?? -1) -
        (verificationRateByIp.get(left.entry.candidate.ip) ?? -1) ||
      left.index - right.index)
    .map(({ entry }) => entry);
}

// Verify-stage selection for Hard finalize: the top `limit` finalists in
// the caller's order, with at most `perBlock` finalists from any one
// catalog block — the diversity cap hard.recheckPerBlock documents.
// Without it one hot /24 could fill the entire recheck budget and the
// rest of the catalog's finalists would go unverified; finalists past a
// capped block are reached by walking deeper into the list. Entries that
// carry no block (legacy sweep summaries) are grouped by their /24 — the
// block the catalog geometry would have given them.
export function selectRecheckFinalists(candidates, { limit, perBlock } = {}) {
  const total = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0,
    cap = Number.isFinite(perBlock) && perBlock > 0 ? Math.floor(perBlock) : Infinity,
    perBlockCounts = new Map(),
    selected = [];
  for (const entry of candidates) {
    if (selected.length >= total) break;
    const key = blockKeyOf(entry),
      count = perBlockCounts.get(key) || 0;
    if (count >= cap) continue;
    perBlockCounts.set(key, count + 1);
    selected.push(entry);
  }
  return selected;
}
function blockKeyOf(entry) {
  if (entry.block) return entry.block;
  const parts = String(entry.ip || '').split('.');
  return 4 === parts.length ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : String(entry.ip);
}
