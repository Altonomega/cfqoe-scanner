import fs from "node:fs";
import path from "node:path";

// Cross-run block reputation for Hard Deep Scan (redesign spec §7): what the
// scanner has learned about each /24 block across runs, kept in a long-lived
// file next to the other data files. Unlike the run checkpoint — which a
// completed run deletes — this store is never deleted by a run; it only ever
// accumulates decayed evidence. This module is persistence only: it stores,
// decays, classifies freshness, and merges finished-run counters. It never
// probes and never interprets colo beyond storing it verbatim.

export const REPUTATION_VERSION = 1;
export const REPUTATION_HALF_LIFE_DAYS = 14;

// One run can add at most 32 probes to a block (the depth cap), so capping
// the stored prior at twice that keeps fresh evidence able to outvote stale
// history within a single run (spec §7.2).
const MAX_STORED_ATTEMPTS = 64;
const MAX_BEST_CANDIDATES = 4;

// Freshness tiers (spec §7.3): a recently seen block with enough evidence
// skips its primer entirely; a somewhat older block earns one confirmation
// probe; anything older — or decayed to nothing — pays the full primer.
const SKIP_PRIMER_MAX_AGE_DAYS = 3;
const CONFIRM_PRIMER_MAX_AGE_DAYS = 21;
const SKIP_PRIMER_MIN_ATTEMPTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// Each record carries two timestamps on purpose. `lastSeenAt` is when the
// block was last actually probed and drives freshness; `countsAsOf` is the
// instant the stored counts were last decayed to and drives decay. Keeping
// them separate makes load/save cycles idempotent (decay never compounds)
// without ever pretending a block was observed more recently than it was.
function toTimeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function toIsoString(timeMs) {
  return new Date(timeMs).toISOString();
}

function sanitizeCounts(attempts, successes) {
  const safeAttempts = Math.max(0, Math.floor(Number(attempts) || 0));
  const safeSuccesses = Math.min(
    safeAttempts,
    Math.max(0, Math.floor(Number(successes) || 0)),
  );
  return { attempts: safeAttempts, successes: safeSuccesses };
}

function sanitizeCandidate(candidate) {
  if (!candidate || typeof candidate.ip !== "string" || !candidate.ip) {
    return null;
  }
  const { attempts, successes } = sanitizeCounts(
    candidate.attempts,
    candidate.successes,
  );
  const median = Number(candidate.handshakeMedianMs);
  return {
    ip: candidate.ip,
    attempts,
    successes,
    handshakeMedianMs: Number.isFinite(median) ? median : null,
  };
}

function compareCandidates(left, right) {
  if (left.successes !== right.successes) {
    return right.successes - left.successes;
  }
  if (left.attempts !== right.attempts) return right.attempts - left.attempts;
  const leftMedian = left.handshakeMedianMs ?? Number.POSITIVE_INFINITY;
  const rightMedian = right.handshakeMedianMs ?? Number.POSITIVE_INFINITY;
  if (leftMedian !== rightMedian) return leftMedian - rightMedian;
  return left.ip.localeCompare(right.ip);
}

// Merge two observations of the same IP. Counts add up; the handshake median
// comes from whichever observation carries more attempts (ties keep the
// lower median), since a median of medians is not itself meaningful.
function combineCandidates(current, next) {
  if (!current) return { ...next, medianAttempts: next.attempts };
  let handshakeMedianMs = current.handshakeMedianMs;
  if (next.attempts > current.medianAttempts) {
    handshakeMedianMs = next.handshakeMedianMs;
  } else if (next.attempts === current.medianAttempts) {
    const medians = [current.handshakeMedianMs, next.handshakeMedianMs].filter(
      (value) => value !== null,
    );
    handshakeMedianMs = medians.length ? Math.min(...medians) : null;
  }
  return {
    ip: current.ip,
    attempts: current.attempts + next.attempts,
    successes: current.successes + next.successes,
    handshakeMedianMs,
    medianAttempts: Math.max(current.medianAttempts, next.attempts),
  };
}

function rankCandidates(candidates) {
  const byIp = new Map();
  for (const candidate of candidates) {
    const sanitized = sanitizeCandidate(candidate);
    if (sanitized) {
      byIp.set(sanitized.ip, combineCandidates(byIp.get(sanitized.ip), sanitized));
    }
  }
  return [...byIp.values()]
    .sort(compareCandidates)
    .slice(0, MAX_BEST_CANDIDATES)
    .map(({ medianAttempts, ...candidate }) => candidate);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const { attempts, successes } = sanitizeCounts(
    record.attempts,
    record.successes,
  );
  const lastSeenMs = toTimeMs(record.lastSeenAt);
  const countsAsOfMs = toTimeMs(record.countsAsOf);
  return {
    attempts,
    successes,
    lastSeenAt: Number.isFinite(lastSeenMs) ? toIsoString(lastSeenMs) : null,
    countsAsOf: Number.isFinite(countsAsOfMs)
      ? toIsoString(countsAsOfMs)
      : null,
    lastRunId: typeof record.lastRunId === "string" ? record.lastRunId : null,
    best: rankCandidates(Array.isArray(record.best) ? record.best : []),
    colo: typeof record.colo === "string" && record.colo ? record.colo : null,
    parent: record.parent ?? null,
    children: record.children ?? null,
  };
}

export function createReputationStore(catalogHash = null) {
  return {
    version: REPUTATION_VERSION,
    catalogHash: typeof catalogHash === "string" ? catalogHash : null,
    updatedAt: null,
    blocks: {},
  };
}

// The decayed view of a record's counts at `now` (spec §7.2): exponential
// decay with a 14-day half-life, measured from the instant the counts were
// last rebased. Pure — it never mutates the record.
export function decayedCounts(record, now = Date.now()) {
  if (!record) return { attempts: 0, successes: 0 };
  const counts = sanitizeCounts(record.attempts, record.successes);
  const asOfMs = toTimeMs(record.countsAsOf ?? record.lastSeenAt);
  const nowMs = toTimeMs(now);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(nowMs) || nowMs <= asOfMs) {
    return counts;
  }
  const ageDays = (nowMs - asOfMs) / DAY_MS;
  const weight = 2 ** (-ageDays / REPUTATION_HALF_LIFE_DAYS);
  const attempts = Math.round(counts.attempts * weight);
  const successes = Math.min(attempts, Math.round(counts.successes * weight));
  return { attempts, successes };
}

// Which primer a block needs at run start (spec §7.3): "skip" (seeded from
// reputation, 0 probes), "confirm" (1 probe), or "full" (the whole primer).
export function primerTierForRecord(record, now = Date.now()) {
  if (!record) return "full";
  const nowMs = toTimeMs(now);
  const lastSeenMs = toTimeMs(record.lastSeenAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastSeenMs)) return "full";
  const { attempts } = decayedCounts(record, nowMs);
  if (attempts < 1) return "full";
  const ageDays = Math.max(0, (nowMs - lastSeenMs) / DAY_MS);
  if (ageDays <= SKIP_PRIMER_MAX_AGE_DAYS && attempts >= SKIP_PRIMER_MIN_ATTEMPTS) {
    return "skip";
  }
  if (ageDays <= CONFIRM_PRIMER_MAX_AGE_DAYS) return "confirm";
  return "full";
}

export function isStale(record, now = Date.now(), staleDays = REPUTATION_HALF_LIFE_DAYS) {
  if (!record) return true;
  const nowMs = toTimeMs(now);
  const lastSeenMs = toTimeMs(record.lastSeenAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastSeenMs)) return true;
  return nowMs - lastSeenMs > staleDays * DAY_MS;
}

// Tolerant by design: reputation is an optimization, never a dependency, so
// a missing, corrupt, or foreign-version file loads as an empty store and
// never throws. When the caller supplies the catalog hash and its block
// list, records for blocks the catalog no longer contains are dropped
// (spec §7.4); without the block list a hash mismatch is left visible in
// the returned store rather than silently adopting foreign records.
export function loadReputation(file, options = {}) {
  const nowMs = toTimeMs(options.now ?? Date.now());
  const fallback = createReputationStore(options.catalogHash ?? null);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    parsed.version !== REPUTATION_VERSION ||
    typeof parsed.blocks !== "object" ||
    parsed.blocks === null
  ) {
    return fallback;
  }
  const store = createReputationStore(
    typeof parsed.catalogHash === "string" ? parsed.catalogHash : null,
  );
  store.updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
  for (const [block, record] of Object.entries(parsed.blocks)) {
    const normalized = normalizeRecord(record);
    if (normalized) store.blocks[block] = normalized;
  }
  if (options.catalogHash != null && store.catalogHash !== options.catalogHash) {
    if (options.knownBlocks != null) {
      const known =
        options.knownBlocks instanceof Set
          ? options.knownBlocks
          : new Set(options.knownBlocks);
      for (const block of Object.keys(store.blocks)) {
        if (!known.has(block)) delete store.blocks[block];
      }
      store.catalogHash = options.catalogHash;
    }
  } else if (options.catalogHash != null) {
    store.catalogHash = options.catalogHash;
  }
  // Decay on load (spec §7.2): counts are rebased to `now`, so saving the
  // loaded store and loading it again never decays the same evidence twice.
  if (Number.isFinite(nowMs)) {
    for (const record of Object.values(store.blocks)) {
      const decayed = decayedCounts(record, nowMs);
      record.attempts = decayed.attempts;
      record.successes = decayed.successes;
      record.countsAsOf = toIsoString(nowMs);
    }
  }
  return store;
}

// Atomic publish: the store is long-lived and irreplaceable, so a crash
// mid-write must never leave a torn file behind. Write a sibling temp file
// and rename it over the target — rename is atomic on the same filesystem.
export function saveReputation(file, store, options = {}) {
  const nowMs = toTimeMs(options.now ?? Date.now());
  const snapshot = {
    version: REPUTATION_VERSION,
    catalogHash: store?.catalogHash ?? null,
    updatedAt: Number.isFinite(nowMs)
      ? toIsoString(nowMs)
      : (store?.updatedAt ?? null),
    blocks: store?.blocks ?? {},
  };
  if (store && typeof store === "object") store.updatedAt = snapshot.updatedAt;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tempFile, file);
  return file;
}

// Fold one finished run's per-block results into the store. Each result is
// `{ block, attempts, successes, best | candidates, colo, runId, parent,
// children }`; results with no probes and no candidates carry no evidence
// and are skipped. Stored counts are the decayed prior plus the run's fresh
// counts, capped so history can never outweigh a single run (spec §7.2).
export function mergeRunIntoReputation(store, blockResults, now = Date.now()) {
  if (!store || typeof store !== "object") return store;
  if (!store.blocks || typeof store.blocks !== "object") store.blocks = {};
  if (!Array.isArray(blockResults)) return store;
  const nowMs = toTimeMs(now);
  const nowIso = toIsoString(Number.isFinite(nowMs) ? nowMs : Date.now());
  let mergedAny = false;
  for (const result of blockResults) {
    if (!result || typeof result.block !== "string" || !result.block) continue;
    const run = sanitizeCounts(result.attempts, result.successes);
    const incoming = rankCandidates(
      Array.isArray(result.best)
        ? result.best
        : Array.isArray(result.candidates)
          ? result.candidates
          : [],
    );
    if (run.attempts === 0 && incoming.length === 0) continue;
    const existing = store.blocks[result.block] ?? null;
    const prior = existing
      ? decayedCounts(existing, nowMs)
      : { attempts: 0, successes: 0 };
    let attempts = prior.attempts + run.attempts;
    let successes = prior.successes + run.successes;
    if (attempts > MAX_STORED_ATTEMPTS) {
      successes = Math.round((successes * MAX_STORED_ATTEMPTS) / attempts);
      attempts = MAX_STORED_ATTEMPTS;
    }
    successes = Math.min(successes, attempts);
    store.blocks[result.block] = {
      attempts,
      successes,
      lastSeenAt: nowIso,
      countsAsOf: nowIso,
      lastRunId:
        typeof result.runId === "string"
          ? result.runId
          : typeof result.lastRunId === "string"
            ? result.lastRunId
            : (existing?.lastRunId ?? null),
      best: rankCandidates([...(existing?.best ?? []), ...incoming]),
      colo:
        typeof result.colo === "string" && result.colo
          ? result.colo
          : (existing?.colo ?? null),
      parent: result.parent !== undefined ? result.parent : (existing?.parent ?? null),
      children:
        result.children !== undefined
          ? result.children
          : (existing?.children ?? null),
    };
    mergedAny = true;
  }
  if (mergedAny) store.updatedAt = nowIso;
  return store;
}
