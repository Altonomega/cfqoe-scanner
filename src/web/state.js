// Web run-state store: the one place the live scanner is translated
// into the CONTRACT's snapshot/event language (plan ch. 3.2–3.3,
// design §5). The server (transport + auth) and the run manager
// (scanner lifecycle) both talk to this store; neither formats an
// event itself.
//
// Three kinds of truth meet here, kept separate on purpose:
//   - the genome tracker derives per-block vectors from the run's
//     summary stream (the engine emits no per-block transitions) and
//     reconciles them with the Hard checkpoint, which is the exact
//     record for splits/exhaustion and the run's own totals;
//   - the run view mirrors the active run's phase/counters exactly
//     as the run functions report them (the same onProgress payload
//     the terminal recorder consumes — one pipeline, two surfaces);
//   - snapshots are assembled per request from current facts, never
//     cached into staleness: status facts come from the caller's
//     fresh reads, `latest` from the results directory.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildBlockPlan } from "../candidate/blocks.js";
import { ipToInt, parseRangeList } from "../candidate/ipv4.js";
import { loadReputation, decayedCounts, primerTierForRecord } from "../hard-reputation.js";
import { compareEligibilitySummaries } from "../hard-engine.js";
import { fisherExactTwoSided } from "../measurement/bandit.js";
import { wilsonInterval } from "../measurement/confidence.js";
import { VERSION } from "../version.js";

// CONTRACT §5 batching: block deltas at most every 250 ms, counters
// at 1 Hz (piggybacked on block frames), log tail flushed at 500 ms
// with a bounded per-client queue.
const BLOCK_FLUSH_MS = 250;
const COUNTER_FLUSH_MS = 1000;
const LOG_FLUSH_MS = 500;
const TRACE_FLUSH_MS = 250;
const TRACE_BUFFER_LIMIT = 1000;
const LOG_QUEUE_LIMIT = 200;
const LOG_REPLAY_LIMIT = 200;
const TICKER_LIMIT = 40;
const TOP_LIMIT = 30;

// One chromatogram point for one real probe observation, in the
// client's [outcome, ms] shape: a success plots its measured
// handshake (bar height grows as the handshake shrinks — the canvas's
// "height = speed"); a failure is a timeout or an error stub and
// carries no figure, because none was measured. A success without a
// measured handshake plots nothing rather than an invented height.
function tracePointFor(observation) {
  if (!observation) return null;
  if (observation.ok) {
    return Number.isFinite(observation.handshakeMs)
      ? ["ok", Math.round(observation.handshakeMs)]
      : null;
  }
  return [/timeout/i.test(String(observation.error ?? "")) ? "timeout" : "error", 0];
}

function encodeBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function encodeBase64U32(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) view.setUint32(index * 4, values[index], true);
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// Genome tracker
// ---------------------------------------------------------------------------

// Per-block live state for the plate. Summary stream first (it is
// ahead of the checkpoint between phase transitions), checkpoint as
// the reconciling overlay (max-merged counts, authoritative splits
// and exhaustion), reputation as the at-rest `known` layer.
function createGenomeTracker(layout) {
  let plan = null;
  let known = new Uint8Array(0);
  let reputationStore = null;
  let state = new Uint8Array(0);
  let heat = new Uint8Array(0);
  let quads = new Uint32Array(0);
  let quadHeat = new Uint32Array(0);
  let runAttempts = new Uint32Array(0);
  let runSuccesses = new Uint32Array(0);
  let halfLowerAttempts = new Uint32Array(0);
  let halfLowerSuccesses = new Uint32Array(0);
  let halfUpperAttempts = new Uint32Array(0);
  let halfUpperSuccesses = new Uint32Array(0);
  let expanded = new Uint8Array(0);
  let bestByBlock = new Map();
  let primerTargets = null;
  let checkpointCache = { key: null, value: null };
  const dirty = new Set();

  function ensurePlan() {
    if (plan) return plan;
    const rangesText = fs.readFileSync(layout.rangesFile, "utf8");
    const ranges = parseRangeList(rangesText);
    const built = buildBlockPlan(ranges);
    const blocksById = new Map(built.blocks.map((block) => [block.blockId, block.index]));
    // The catalog hash is the engine's own definition (sha256 of the
    // ranges file text) so reputation records line up exactly.
    plan = {
      ranges,
      blocks: built.blocks,
      blocksById,
      catalogHash: createHash("sha256").update(rangesText).digest("hex"),
      totalAddresses: built.totalAddresses,
    };
    const size = built.blocks.length;
    known = new Uint8Array(size);
    state = new Uint8Array(size);
    heat = new Uint8Array(size);
    quads = new Uint32Array(size);
    quadHeat = new Uint32Array(size);
    runAttempts = new Uint32Array(size);
    runSuccesses = new Uint32Array(size);
    halfLowerAttempts = new Uint32Array(size);
    halfLowerSuccesses = new Uint32Array(size);
    halfUpperAttempts = new Uint32Array(size);
    halfUpperSuccesses = new Uint32Array(size);
    expanded = new Uint8Array(size);
    refreshKnown();
    resetRunArrays();
    return plan;
  }

  function refreshKnown() {
    if (!plan) return;
    reputationStore = loadReputation(layout.reputationFile, {
      catalogHash: plan.catalogHash,
      knownBlocks: plan.blocks.map((block) => block.blockId),
    });
    for (const block of plan.blocks) {
      const record = reputationStore.blocks[block.blockId];
      const decayed = decayedCounts(record);
      known[block.index] =
        decayed.attempts > 0 ? Math.round((255 * decayed.successes) / decayed.attempts) : 0;
    }
  }

  // The plate at rest: reputation ghosts only. Run arrays zeroed.
  function resetRunArrays() {
    if (!plan) return;
    runAttempts.fill(0);
    runSuccesses.fill(0);
    halfLowerAttempts.fill(0);
    halfLowerSuccesses.fill(0);
    halfUpperAttempts.fill(0);
    halfUpperSuccesses.fill(0);
    expanded.fill(0);
    quads.fill(0);
    quadHeat.fill(0);
    bestByBlock = new Map();
    primerTargets = null;
    dirty.clear();
    for (const block of plan.blocks) paintCell(block.index);
  }

  // One cell's state/heat from the tracker's current counts. Split
  // and exhausted cells are painted by the checkpoint overlay, which
  // runs after this and wins.
  function paintCell(index) {
    const attempts = runAttempts[index];
    if (attempts <= 0) {
      state[index] = known[index] > 0 ? 1 : 0;
      heat[index] = known[index];
      return;
    }
    const successes = runSuccesses[index];
    state[index] = successes > 0 ? (expanded[index] ? 5 : 3) : 4;
    heat[index] = Math.round((255 * successes) / attempts);
  }

  // The checkpoint file, parsed at most once per on-disk change
  // (mtime+size key). Tolerant: a half-written or absent checkpoint
  // reads as null, never as an error.
  function checkpoint() {
    let stat = null;
    try {
      stat = fs.statSync(layout.hardStateFile);
    } catch {
      checkpointCache = { key: null, value: null };
      return null;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (checkpointCache.key === key) return checkpointCache.value;
    let value = null;
    try {
      value = JSON.parse(fs.readFileSync(layout.hardStateFile, "utf8"));
    } catch {
      value = null;
    }
    checkpointCache = { key, value };
    return value;
  }

  // Reconcile with the checkpoint: counts max-merge (the summary
  // stream is ahead between saves, the checkpoint ahead after a
  // restart), split parents get state 7 with their children's cells
  // packed into quads/quadHeat in address order, hard-dead and
  // address-exhausted blocks get state 8.
  function applyCheckpointOverlay() {
    const saved = checkpoint();
    const entries = saved?.blockState?.blocks;
    if (!saved || !Array.isArray(entries) || !plan) return null;
    const childrenOf = new Map();
    for (const entry of entries) {
      if (entry.parentBlockId) {
        if (!childrenOf.has(entry.parentBlockId)) childrenOf.set(entry.parentBlockId, []);
        childrenOf.get(entry.parentBlockId).push(entry);
      }
    }
    const childCell = (entry) => {
      const attempts = entry.runAttempts ?? 0;
      if (attempts <= 0) return { state: 0, heat: 0 };
      const successes = entry.runSuccesses ?? 0;
      return { state: successes > 0 ? 3 : 4, heat: Math.round((255 * successes) / attempts) };
    };
    for (const entry of entries) {
      const index = plan.blocksById.get(entry.blockId);
      if (index === undefined) continue;
      if ((entry.runAttempts ?? 0) > runAttempts[index]) {
        runAttempts[index] = entry.runAttempts;
        runSuccesses[index] = entry.runSuccesses ?? 0;
        paintCell(index);
      }
      const children = childrenOf.get(entry.blockId);
      if (entry.splitDepth === 0 && children && children.length > 0) {
        const ordered = [...children].sort(
          (a, b) => ipToInt(a.blockId.split("/")[0]) - ipToInt(b.blockId.split("/")[0]),
        );
        let packedState = 0;
        let packedHeat = 0;
        if (ordered.length === 2) {
          // Depth-1 split: lower half -> q0,q1; upper half -> q2,q3
          // (CONTRACT §1 quadrant packing).
          const lower = childCell(ordered[0]);
          const upper = childCell(ordered[1]);
          packedState = lower.state | (lower.state << 8) | (upper.state << 16) | (upper.state << 24);
          packedHeat = lower.heat | (lower.heat << 8) | (upper.heat << 16) | (upper.heat << 24);
        } else {
          ordered.slice(0, 4).forEach((child, slot) => {
            const cell = childCell(child);
            packedState |= cell.state << (slot * 8);
            packedHeat |= cell.heat << (slot * 8);
          });
        }
        state[index] = 7;
        quads[index] = packedState >>> 0;
        quadHeat[index] = packedHeat >>> 0;
        dirty.add(index);
      } else if (entry.hardDead || entry.addressesExhausted) {
        state[index] = 8;
        dirty.add(index);
      }
    }
    return saved;
  }

  return {
    ensurePlan,
    refreshKnown,
    resetRunArrays,
    checkpoint,
    catalog() {
      ensurePlan();
      const grouped = [];
      for (const block of plan.blocks) {
        const current = grouped[grouped.length - 1];
        if (current && current.rangeIndex === block.rangeIndex) {
          current.blocks += 1;
        } else {
          grouped.push({
            cidr: block.range,
            rangeIndex: block.rangeIndex,
            firstBlock: block.index,
            blocks: 1,
          });
        }
      }
      return {
        ranges: grouped.map(({ cidr, firstBlock, blocks }) => ({ cidr, firstBlock, blocks })),
        blocksTotal: plan.blocks.length,
        rangesTotal: plan.ranges.length,
        addressesTotal: plan.totalAddresses,
      };
    },
    // Prepare for a blocks-engine run: per-block primer targets from
    // the same reputation tiers the engine will compute, so
    // blocksPrimed is derivable live.
    beginRun({ settings }) {
      ensurePlan();
      refreshKnown();
      resetRunArrays();
      const hard = settings?.hard ?? {};
      const perBlock = Math.max(1, Math.floor(hard.primerPerBlock ?? 3));
      primerTargets = new Uint16Array(plan.blocks.length);
      for (const block of plan.blocks) {
        const tier = primerTierForRecord(reputationStore.blocks[block.blockId], Date.now(), hard.reputation ?? {});
        primerTargets[block.index] = tier === "skip" ? 0 : tier === "confirm" ? 1 : perBlock;
      }
    },
    noteSummary(summary, phase) {
      if (!plan || !summary || typeof summary.block !== "string") return;
      const index = plan.blocksById.get(summary.block);
      if (index === undefined) return;
      const attempts = summary.eligibility?.attempts ?? 0;
      const successes = summary.eligibility?.successes ?? 0;
      if (attempts <= 0) return;
      runAttempts[index] += attempts;
      runSuccesses[index] += successes;
      const block = plan.blocks[index];
      try {
        const offset = ipToInt(summary.ip) - block.base;
        if (offset < block.size / 2) {
          halfLowerAttempts[index] += attempts;
          halfLowerSuccesses[index] += successes;
        } else {
          halfUpperAttempts[index] += attempts;
          halfUpperSuccesses[index] += successes;
        }
      } catch {
        // An unparseable address still counted toward the block.
      }
      if (phase === "hard-expansion") expanded[index] = 1;
      const previous = bestByBlock.get(index);
      if (!previous || compareEligibilitySummaries(summary, previous) < 0) bestByBlock.set(index, summary);
      paintCell(index);
      dirty.add(index);
    },
    // Winner/finalist paint at run end, from the finished report's
    // own rows (design §3.3: 9 = finalist pool, 10 = top ranks).
    markFinalists(rows) {
      if (!plan || !Array.isArray(rows)) return;
      rows.forEach((row, rank) => {
        if (!row || typeof row.block !== "string") return;
        const index = plan.blocksById.get(row.block);
        if (index === undefined || state[index] === 7 || state[index] === 8) return;
        state[index] = rank < 5 ? 10 : 9;
        dirty.add(index);
      });
    },
    drainDirty() {
      const deltas = [];
      for (const index of dirty) {
        if (state[index] === 7) {
          deltas.push([index, 7, heat[index], quads[index] >>> 0, quadHeat[index] >>> 0]);
        } else {
          deltas.push([index, state[index], heat[index]]);
        }
      }
      dirty.clear();
      return deltas;
    },
    vectors() {
      ensurePlan();
      applyCheckpointOverlay();
      return {
        blocksTotal: plan.blocks.length,
        state: encodeBase64(state),
        heat: encodeBase64(heat),
        quads: encodeBase64U32(quads),
        quadHeat: encodeBase64U32(quadHeat),
        known: encodeBase64(known),
      };
    },
    counters() {
      const saved = checkpoint();
      const counts = saved?.counts ?? {};
      // The engine's own totals ride inside the serialized block
      // state; the checkpoint's counts object is the run-level view.
      // Either may be ahead of the other between saves — max-merge.
      const totals = saved?.blockState?.totals ?? {};
      let probesSpent = 0;
      let blocksPrimed = 0;
      for (let index = 0; index < runAttempts.length; index += 1) {
        probesSpent += runAttempts[index];
        if (primerTargets && runAttempts[index] >= primerTargets[index]) blocksPrimed += 1;
      }
      let blocksExpanded = 0;
      for (let index = 0; index < expanded.length; index += 1) blocksExpanded += expanded[index];
      let blocksSplit = 0;
      const entries = saved?.blockState?.blocks;
      if (Array.isArray(entries)) {
        const parents = new Set();
        for (const entry of entries) if (entry.parentBlockId) parents.add(entry.parentBlockId);
        blocksSplit = parents.size;
      }
      return {
        probesSpent: Math.max(
          probesSpent,
          totals.probesSpent ?? (counts.primerProbes ?? 0) + (counts.expansionProbes ?? 0),
        ),
        primerProbes: totals.primerProbes ?? counts.primerProbes ?? 0,
        expansionProbes: totals.expansionProbes ?? counts.expansionProbes ?? 0,
        blocksPrimed: Math.max(blocksPrimed, counts.blocksPrimed ?? 0),
        blocksExpanded: Math.max(blocksExpanded, counts.blocksExpanded ?? 0),
        blocksSplit,
      };
    },
    topList() {
      const rows = [...bestByBlock.values()].sort(compareEligibilitySummaries);
      return rows.slice(0, TOP_LIMIT);
    },
    blockDetail(index) {
      ensurePlan();
      const block = plan.blocks[index];
      if (!block) return null;
      applyCheckpointOverlay();
      const saved = checkpoint();
      const savedBlocks = saved?.blockState?.blocks;
      const savedEntry = Array.isArray(savedBlocks)
        ? savedBlocks.find((entry) => entry.blockId === block.blockId)
        : null;
      const record = reputationStore?.blocks?.[block.blockId] ?? null;
      const decayed = decayedCounts(record);
      const attempts = runAttempts[index];
      const successes = runSuccesses[index];
      const lower = { attempts: halfLowerAttempts[index], successes: halfLowerSuccesses[index] };
      const upper = { attempts: halfUpperAttempts[index], successes: halfUpperSuccesses[index] };
      const splitP = fisherExactTwoSided({
        lowerSuccesses: lower.successes,
        lowerAttempts: lower.attempts,
        upperSuccesses: upper.successes,
        upperAttempts: upper.attempts,
      });
      const best = bestByBlock.get(index);
      return {
        index,
        cidr: block.blockId,
        range: block.range ?? null,
        lane: block.rangeIndex + 1,
        run:
          attempts > 0
            ? {
                attempts,
                successes,
                rate: Number((successes / attempts).toFixed(3)),
                lower: Number(wilsonInterval(successes, attempts).lower.toFixed(3)),
              }
            : null,
        primer: savedEntry
          ? { attempts: savedEntry.primerDone ?? 0, tier: savedEntry.tier ?? null }
          : { attempts: 0, tier: primerTierForRecord(record, Date.now(), {}) },
        halves: {
          lower: { s: lower.successes, n: lower.attempts },
          upper: { s: upper.successes, n: upper.attempts },
          splitP: Number(splitP.toFixed(4)),
          split: Boolean(
            savedEntry &&
              savedEntry.splitDepth === 0 &&
              Array.isArray(savedBlocks) &&
              savedBlocks.some((entry) => entry.parentBlockId === block.blockId),
          ),
        },
        reputation: record
          ? {
              attempts: decayed.attempts,
              runs: record.runs ?? 0,
              rate: decayed.attempts > 0 ? Number((decayed.successes / decayed.attempts).toFixed(3)) : 0,
              lastSeen: record.lastSeenAt ?? null,
              best: record.bestOverall ?? null,
              colo: record.dominantColo ?? null,
            }
          : null,
        candidates: best ? [best] : [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Event store + snapshot assembly
// ---------------------------------------------------------------------------

export function createWebState({ layout, startedAt = new Date().toISOString() }) {
  const tracker = createGenomeTracker(layout);
  let seq = 0;
  const clients = new Set();
  let run = null; // { mode, runId, status, phase, startedAt, counters }
  // The most recent finished run's terminal view. Without it the
  // at-rest snapshot had nothing truthful to say about a scan-mode
  // run that just ended (run = null read as "idle"), so the event
  // stream and the snapshot disagreed about the same run — the
  // banner-resurrection defect. Event, snapshot and API now all
  // serve this same terminal status until a new run begins.
  let lastRun = null; // { mode, runId, status, phase, startedAt, counters, error? }
  let phaseStartedAt = null;
  let tickerLines = [];
  let tickerWindow = [];
  let attachedLogger = null;
  let unsubscribeLogger = null;
  let latestCache = { key: null, value: null };
  let blockTimer = null;
  let counterTimer = null;
  let logTimer = null;
  let countersDirty = false;
  // Chromatogram points awaiting their flush, built only from real
  // probe observations handed up with eligibility summaries.
  let tracePoints = [];
  let traceTimer = null;

  function nextSeq() {
    seq += 1;
    return seq;
  }

  // Direct sends to one client (connect greeting, log replay, drop
  // markers) carry the current seq WITHOUT consuming the next one:
  // the sequence numbers the broadcast stream, and a private frame
  // must never look like a gap in everyone else's stream. The log
  // tail is loss-tolerant by design (drop markers, §3.3), so its
  // frames stay out of the gap-checked sequence entirely.
  function peekSeq() {
    return seq;
  }

  // One fan-out point for every event type: the seq is assigned here
  // and only here, so a gap on the client always means a lost frame
  // (its resync signal), never a numbering bug.
  function emit(type, payload, { tailOnly = false } = {}) {
    const eventSeq = nextSeq();
    for (const client of clients) {
      if (tailOnly && !client.wantsTail) continue;
      try {
        client.send(type, payload, eventSeq);
      } catch {
        clients.delete(client);
      }
    }
    return eventSeq;
  }

  function flushBlocks() {
    blockTimer = null;
    const deltas = tracker.drainDirty();
    if (deltas.length > 0) emit("blocks", { deltas });
    if (countersDirty) flushCounters();
  }

  function scheduleBlocks() {
    if (blockTimer) return;
    blockTimer = setTimeout(flushBlocks, BLOCK_FLUSH_MS);
    if (typeof blockTimer.unref === "function") blockTimer.unref();
  }

  function flushCounters() {
    counterTimer = null;
    countersDirty = false;
    if (!run) return;
    emit("counters", { ...run.counters });
  }

  function scheduleCounters() {
    countersDirty = true;
    if (counterTimer) return;
    counterTimer = setTimeout(flushCounters, COUNTER_FLUSH_MS);
    if (typeof counterTimer.unref === "function") counterTimer.unref();
  }

  function flushTrace() {
    traceTimer = null;
    if (tracePoints.length === 0) return;
    const points = tracePoints;
    tracePoints = [];
    emit("trace", { points });
  }

  function scheduleTrace() {
    if (traceTimer) return;
    traceTimer = setTimeout(flushTrace, TRACE_FLUSH_MS);
    if (typeof traceTimer.unref === "function") traceTimer.unref();
  }

  function resetTrace() {
    tracePoints = [];
    if (traceTimer) {
      clearTimeout(traceTimer);
      traceTimer = null;
    }
  }

  function pushTicker(text) {
    if (!text) return;
    const now = Date.now();
    tickerWindow = tickerWindow.filter((at) => now - at < 1000);
    if (tickerWindow.length >= 5) return; // §5.2 cap: 5 lines/second
    tickerWindow.push(now);
    tickerLines.push(text);
    if (tickerLines.length > TICKER_LIMIT) tickerLines = tickerLines.slice(-TICKER_LIMIT);
    emit("ticker", { text });
  }

  function logPayload(record) {
    return {
      time: record.time,
      level: record.level,
      event: record.event,
      msg: record.message ?? record.note ?? "",
      // The one datum the narration needs from a log record: the
      // concurrency a calibration verdict left the run at.
      n: record.requestedConcurrency ?? record.selectedConcurrency ?? null,
    };
  }

  function queueLog(record) {
    const payload = logPayload(record);
    for (const client of clients) {
      if (!client.wantsTail) continue;
      client.logQueue.push(payload);
      if (client.logQueue.length > LOG_QUEUE_LIMIT) {
        const dropped = client.logQueue.length - LOG_QUEUE_LIMIT;
        client.logQueue.splice(0, dropped);
        client.droppedLogs += dropped;
      }
    }
    if (!logTimer) {
      logTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
      if (typeof logTimer.unref === "function") logTimer.unref();
    }
  }

  function flushLogs() {
    logTimer = null;
    for (const client of clients) {
      if (!client.wantsTail) continue;
      if (client.droppedLogs > 0) {
        try {
          client.send(
            "log",
            {
              time: new Date().toISOString(),
              level: "warn",
              event: "log.dropped",
              msg: `${client.droppedLogs} log records dropped (slow reader)`,
              count: client.droppedLogs,
            },
            peekSeq(),
          );
        } catch {
          clients.delete(client);
          continue;
        }
        client.droppedLogs = 0;
      }
      const queued = client.logQueue;
      client.logQueue = [];
      for (const payload of queued) {
        try {
          client.send("log", payload, peekSeq());
        } catch {
          clients.delete(client);
          break;
        }
      }
    }
  }

  function readLatest() {
    const file = `${layout.results}/latest.json`;
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      latestCache = { key: null, value: null };
      return null;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (latestCache.key === key) return latestCache.value;
    let value = null;
    try {
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      value = {
        runId: report.runId,
        finishedAt: report.finishedAt ?? null,
        best: Array.isArray(report.results) ? report.results.slice(0, 5) : [],
      };
    } catch {
      value = null;
    }
    latestCache = { key, value };
    return value;
  }

  // The at-rest run view: a paused Hard checkpoint is presented as a
  // finished-but-resumable run (CONTRACT §1); otherwise the last
  // finished run's terminal view, so a stopped or failed scan run
  // keeps its real status at rest instead of decaying to idle.
  function restRunView() {
    const paused = pausedRunView();
    if (paused) return paused;
    return lastRun;
  }

  function pausedRunView() {
    const saved = tracker.checkpoint();
    if (!saved || saved.status !== "paused") return null;
    return {
      mode: "hard",
      runId: saved.runId,
      status: "paused-done",
      phase: saved.phase ?? null,
      startedAt: saved.createdAt ?? null,
      counters: { ...tracker.counters(), stoppedReason: saved.stoppedReason ?? null },
    };
  }

  return {
    tracker,
    get seq() {
      return seq;
    },
    // SSE client registration. `send(type, payload, seq)` is the
    // transport's writer; the store owns sequencing and batching.
    addClient(client) {
      client.logQueue = [];
      client.droppedLogs = 0;
      clients.add(client);
      // A fresh subscriber first hears where the run stands right
      // now; its /api/state fetch fills in everything else.
      const view = run ?? restRunView();
      try {
        client.send(
          "run-state",
          { status: view ? view.status : "idle", mode: view?.mode ?? null, runId: view?.runId ?? null },
          peekSeq(),
        );
        if (client.wantsTail && attachedLogger) {
          for (const record of attachedLogger.recent(LOG_REPLAY_LIMIT)) {
            client.send("log", logPayload(record), peekSeq());
          }
        }
      } catch {
        clients.delete(client);
      }
      return () => clients.delete(client);
    },
    clientCount() {
      return clients.size;
    },
    // The run logger is the tail's source while a run lives (and
    // briefly after, for the final records). One subscription per
    // run; replay for late joiners comes from the logger's ring.
    attachLogger(logger) {
      if (unsubscribeLogger) unsubscribeLogger();
      attachedLogger = logger;
      unsubscribeLogger = logger.subscribe((record) => queueLog(record), { minLevel: "debug" });
    },
    detachLogger() {
      if (unsubscribeLogger) unsubscribeLogger();
      unsubscribeLogger = null;
      attachedLogger = null;
    },
    beginRun({ mode, runId, settings }) {
      lastRun = null;
      resetTrace();
      run = {
        mode,
        runId,
        status: "running",
        phase: null,
        startedAt: new Date().toISOString(),
        counters: {},
      };
      phaseStartedAt = null;
      if (mode === "hard" && settings?.hard?.engine !== "round-robin") tracker.beginRun({ settings });
      else if (mode === "hard") tracker.resetRunArrays();
      emit("run-state", { status: "running", mode, runId });
    },
    // The run manager's onProgress: the identical payload shape the
    // terminal surfaces consume. Phase changes are immediate; notes
    // feed the ticker; counters batch at 1 Hz.
    onProgress(progress) {
      if (!run || !progress) return;
      const phase = progress.phase ?? run.phase;
      if (phase !== run.phase) {
        run.phase = phase;
        phaseStartedAt = new Date().toISOString();
        emit("phase", { phase, startedAt: phaseStartedAt });
      }
      run.counters = {
        ...run.counters,
        completed: progress.completed ?? run.counters.completed ?? 0,
        total: progress.total ?? run.counters.total ?? 0,
        eligible: progress.eligible ?? run.counters.eligible ?? 0,
        failed: progress.failed ?? run.counters.failed ?? 0,
        elapsedMs: progress.elapsedMs ?? run.counters.elapsedMs ?? 0,
        // Narration fields: which screening round is in flight and
        // which candidate the newest progress event belongs to, so
        // the console can say what is happening right now instead of
        // only how much is done. Absent outside the phases that know.
        round: progress.round ?? run.counters.round ?? null,
        currentIp: progress.ip ?? progress.item?.ip ?? run.counters.currentIp ?? null,
        ...(run.mode === "hard" ? tracker.counters() : {}),
      };
      if (progress.note) pushTicker(progress.note);
      scheduleCounters();
    },
    onSummary(summary, observations) {
      tracker.noteSummary(summary, run?.phase ?? null);
      if (run?.mode === "hard") {
        run.counters = { ...run.counters, ...tracker.counters() };
        scheduleCounters();
      }
      scheduleBlocks();
      // The chromatogram feed: every observation behind this summary
      // becomes one point, in probe order. Summaries that arrive
      // without their observations (any caller that does not hand
      // them up) feed nothing — the trace never plots an aggregate
      // as if it were a probe.
      if (run && Array.isArray(observations)) {
        for (const observation of observations) {
          const point = tracePointFor(observation);
          if (point) tracePoints.push(point);
        }
        if (tracePoints.length > TRACE_BUFFER_LIMIT) {
          tracePoints.splice(0, tracePoints.length - TRACE_BUFFER_LIMIT);
        }
        if (tracePoints.length > 0) scheduleTrace();
      }
    },
    emitCandidate(row, lane) {
      emit("candidate", lane ? { row, lane } : { row });
    },
    ticker(text) {
      pushTicker(text);
    },
    finishRun({ status, mode, runId, report, error }) {
      if (report && mode === "hard") tracker.markFinalists(report.results);
      lastRun = {
        mode,
        runId,
        status,
        phase: run?.phase ?? null,
        startedAt: run?.startedAt ?? null,
        counters: run?.counters ?? {},
        ...(error ? { error } : {}),
      };
      if (report) {
        latestCache = { key: null, value: null };
        readLatest();
      }
      run = null;
      phaseStartedAt = null;
      // The last probes of the run reach the chromatogram before the
      // terminal run-state, like the final plate state below.
      if (traceTimer) {
        clearTimeout(traceTimer);
        traceTimer = null;
      }
      flushTrace();
      // Final plate state (splits, finalists) goes out before the
      // terminal run-state, so the client's completion resync starts
      // from an already-correct genome.
      const deltas = tracker.drainDirty();
      if (deltas.length > 0) emit("blocks", { deltas });
      emit("run-state", { status, mode, runId, ...(error ? { error } : {}) });
    },
    currentRunState() {
      const view = run ?? restRunView();
      return view
        ? { status: view.status, mode: view.mode, runId: view.runId }
        : { status: "idle", mode: null, runId: null };
    },
    buildSnapshot(statusFacts) {
      const genome = tracker.vectors();
      const view = run ?? restRunView();
      return {
        server: {
          version: VERSION,
          platform: `${process.platform}-${process.arch}`,
          startedAt,
        },
        status: statusFacts,
        genome,
        run: view
          ? {
              mode: view.mode,
              runId: view.runId,
              status: view.status,
              phase: view.phase,
              startedAt: view.startedAt,
              counters: view.mode === "hard" ? { ...view.counters, ...tracker.counters() } : view.counters,
              ...(view.error ? { error: view.error } : {}),
              ...(view.mode === "hard" ? { genome, top: tracker.topList() } : {}),
            }
          : null,
        latest: readLatest(),
      };
    },
  };
}
