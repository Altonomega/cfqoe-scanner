import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import {
  parseVlessUri,
  describeVless,
  assertWebsocketCapable,
} from "./config/vless.js";
import { parseRangeList, sampleCandidates } from "./candidate/ipv4.js";
import {
  buildRangePlan,
  nextRoundRobinCandidate,
  nextLegacyCandidate,
} from "./candidate/hard-order.js";
import {
  collectCandidateBatch,
  runEligibilityBatch,
  runAdaptiveEligibilityBatch,
  selectDelayedRetries,
  selectRecheckFinalists,
  tunnelAttemptBudget,
  shouldAttemptTunnelCandidate,
} from "./hard-scheduler.js";
import { probeWebsocket } from "./probe/websocket.js";
import { startXray } from "./xray/manager.js";
import { locateXray } from "./platform/xray.js";
import { loadCatalog, resolveWorkloads } from "./config/settings.js";
import { probeBrowsing } from "./browsing/probe.js";
import { probeStreaming } from "./streaming/probe.js";
import {
  applyTunnelResults,
  buildEligibilitySummary,
  hasScoredTunnelStage,
  rankCandidates,
  renderTopList,
  REPORT_SCHEMA,
  GENERATOR_VERSION,
} from "./report.js";
import { runLoadProbe } from "./probe/load.js";
import { createProgressRecorder } from "./logging/logger.js";
import { calibrateWebsocketConcurrency } from "./measurement/scan-calibration.js";
import {
  compareEligibilitySummaries,
  runBlockScreening,
} from "./hard-engine.js";
import { buildBlockPlan } from "./candidate/blocks.js";
import { loadReputation, saveReputation } from "./hard-reputation.js";
// The newest checkpoint format, written by the block-adaptive engine.
// The legacy engine keeps writing its v3 format (see the state creator
// in runHardScan): a checkpoint always belongs to the engine that
// created it, so both versions stay readable forever.
export const HARD_STATE_VERSION = 4;
function clampInt(value, fallback = 1, max = 64) {
  const parsed = Math.floor(Number(value));
  return !Number.isFinite(parsed) || parsed <= 0
    ? fallback
    : Math.min(parsed, max);
}
function successRate(observations) {
  return 0 === observations.length
    ? 0
    : observations.filter((observation) => observation.ok).length /
        observations.length;
}
// The finalize ordering has exactly one definition — the engine's
// compareEligibilitySummaries (Wilson lower bound, success rate,
// handshake median, connect median, IP) — shared by the live top list,
// the finalist merge, and verification, for both engines.
function insertTop(list, entry, limit) {
  const next = list.filter((item) => item.ip !== entry.ip);
  return (
    next.push(entry),
    next.sort(compareEligibilitySummaries),
    next.slice(0, limit)
  );
}
function writeJsonFile(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 384 });
}
function appendJsonLine(file, data) {
  fs.appendFileSync(file, `${JSON.stringify(data)}\n`, { mode: 384 });
}
function stateExists(layout) {
  return fs.existsSync(layout.hardStateFile);
}
function persistState(layout, state) {
  (writeJsonFile(layout.hardStateFile, state),
    writeJsonFile(state.files.archiveStateFile, state));
}
function removeStateFile(layout) {
  try {
    fs.rmSync(layout.hardStateFile, { force: !0 });
  } catch {}
}
function isLegacyState(state) {
  return state.version < 3 || Number.isInteger(state.cursor?.hostIndex);
}
function isBlocksState(state) {
  return "blocks" === state.engine;
}
function traversalForState(state) {
  return isBlocksState(state)
    ? "block-adaptive"
    : isLegacyState(state)
      ? "legacy-range-sequential"
      : "range-round-robin";
}
function catalogHashOf(rangesText) {
  return createHash("sha256").update(rangesText).digest("hex");
}
function writeSnapshot(state) {
  const legacy = isLegacyState(state),
    blocks = isBlocksState(state),
    snapshot = {
      runId: state.runId,
      status: state.status,
      scope: "run-relative",
      traversal: traversalForState(state),
      execution: "parallel-batched",
      startedAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      progress: {
        tested: state.counts.tested,
        eligible: state.counts.eligible,
        failed: state.counts.failed,
        retryQueued: state.counts.retryQueued,
        retryRecovered: state.counts.retryRecovered,
        total: state.total,
        rangeIndex: blocks ? null : state.cursor.rangeIndex,
        passIndex: blocks || legacy ? null : state.cursor.passIndex,
        hostIndex: legacy ? state.cursor.hostIndex : null,
        ...(blocks
          ? {
              phase: state.phase,
              blocksPrimed: state.counts.blocksPrimed,
              blocksTotal: state.blocksTotal,
            }
          : {}),
      },
      files: state.files,
      topEligibility: state.topEligibility,
    };
  (writeJsonFile(state.files.snapshotJson, snapshot),
    fs.writeFileSync(
      state.files.snapshotTxt,
      `${(function (entries, limit = 30) {
        return [
          [
            "IP",
            "Success",
            "Lower95",
            "Confidence",
            "HandshakeP50",
            "POP",
            "Range",
          ].join("\t"),
          ...entries
            .slice(0, limit)
            .map((entry) =>
              [
                entry.ip,
                `${Math.round(100 * (entry.eligibility.successRate || 0))}%`,
                `${Math.round(100 * (entry.eligibility.confidence95?.lower || 0))}%`,
                entry.eligibility.confidence,
                entry.eligibility.handshakeMedianMs ?? "-",
                entry.eligibility.pops?.dominant || "-",
                entry.range,
              ].join("\t"),
            ),
        ].join("\n");
      })(state.topEligibility, state.settings.hard.liveTop)}\n`,
      { mode: 384 },
    ));
}
// Checkpoint v4 for the block-adaptive engine. Same file layout and
// finalize inputs as v3; what changes is the screening record: no
// traversal cursor (the engine's serialized per-block state replaces
// it), a phase marker, and the catalog hash the block state is only
// meaningful against. `total` is the planned probe total — the run's
// probe budget, a denominator the run can actually reach — not the
// catalog size the legacy sweep walks.
function createBlocksState({
  layout,
  runId,
  settings,
  target,
  rangesCount,
  blocksTotal,
  catalogHash,
}) {
  const basePath = path.join(layout.hardScanDir, `run-${runId}`);
  return {
    version: HARD_STATE_VERSION,
    runId,
    mode: "hard",
    engine: "blocks",
    traversal: "block-adaptive",
    execution: "parallel-batched",
    status: "in_progress",
    startedAt: new Date().toISOString(),
    target,
    settings,
    total: settings.hard.budgetProbes,
    rangesCount,
    blocksTotal,
    catalogHash,
    cursor: null,
    phase: "primer",
    blockState: null,
    counts: {
      tested: 0,
      eligible: 0,
      failed: 0,
      retryQueued: 0,
      retryRecovered: 0,
      primerProbes: 0,
      expansionProbes: 0,
      blocksPrimed: 0,
      blocksExpanded: 0,
    },
    files: {
      eligibilityFile: `${basePath}.eligibility.ndjson`,
      retryFile: `${basePath}.retry.ndjson`,
      snapshotJson: `${basePath}.partial.json`,
      snapshotTxt: `${basePath}.partial.txt`,
      archiveStateFile: `${basePath}.state.json`,
    },
    topEligibility: [],
  };
}
async function runDelayedRetries({
  state,
  settings,
  logger,
  onProgress,
  task,
}) {
  if (!settings.hard.delayedRetry) return [];
  const retryCandidates = await (async function (file, limit) {
    const entries = [];
    if (!file || !fs.existsSync(file)) return entries;
    const seen = new Set(),
      lines = readline.createInterface({
        input: fs.createReadStream(file, "utf8"),
        crlfDelay: 1 / 0,
      });
    for await (const line of lines) {
      const text = line.trim();
      if (text)
        try {
          const entry = JSON.parse(text);
          if (!entry.ip || seen.has(entry.ip)) continue;
          if (
            (seen.add(entry.ip),
            entries.push({
              ip: entry.ip,
              range: entry.range,
              block: entry.block,
            }),
            entries.length >= limit)
          )
            break;
        } catch {}
    }
    return entries;
  })(state.files.retryFile, clampInt(settings.hard.retryLimit, 1e3, 1e5));
  if (0 === retryCandidates.length) return [];
  const concurrency = clampInt(
    settings.hard.concurrency,
    settings.scan.concurrency,
  );
  logger.info("hard.retry.start", {
    candidates: retryCandidates.length,
    concurrency,
  });
  let recovered = 0;
  const results = await runEligibilityBatch({
    candidates: retryCandidates,
    // Cross-section read, deliberately: Hard has no retry-rounds key of
    // its own — the delayed-retry batch reuses scan.rounds (clamped to
    // 2..16), the screening depth the shared pipeline runs at.
    rounds: clampInt(settings.scan.rounds, 2, 16),
    concurrency,
    minimumSuccessRate: settings.scan.minimumSuccessRate,
    task,
    onCandidateDone: ({ candidate, observations, finished, total }) => {
      (successRate(observations) >= settings.scan.minimumSuccessRate &&
        (recovered += 1),
        onProgress({
          phase: "hard-retry",
          completed: finished,
          total,
          eligible: recovered,
          failed: finished - recovered,
          currentRange: candidate.range,
          note: "delayed retry of transient failures",
        }));
    },
  });
  return (
    (state.counts.retryRecovered = recovered),
    logger.info("hard.retry.complete", {
      candidates: results.length,
      recovered,
    }),
    results
      .filter(({ observations }) =>
        observations.some((observation) => observation.ok),
      )
      .map(({ candidate, observations }) =>
        buildEligibilitySummary({
          ip: candidate.ip,
          range: candidate.range,
          eligibility: observations,
          temporalBlocks: 2,
          block: candidate.block,
        }),
      )
  );
}
export function hasHardScanState(layout) {
  return stateExists(layout);
}
export async function runHardScan({
  vlessUri,
  settings,
  layout,
  logger,
  onProgress = () => {},
  // Called once, after the plan exists and before the first probe:
  // the run-defining facts (engine, catalog size, probe budget) are
  // known only here, and the caller deserves them on screen before
  // the first progress line overwrites the banner.
  onStart = () => {},
  runId,
  resume = !1,
  // Optional external cancel token (AbortSignal-shaped): the web
  // layer's stop button. Its abort feeds the same `canceled` flag the
  // terminal watcher (Q / Ctrl+C) sets below, so a programmatic stop
  // is indistinguishable from a terminal one downstream — same
  // checkpoint, same paused state, same stoppedReason. Absent (every
  // terminal caller), nothing about the run changes.
  signal = null,
  // Optional observer for eligibility summaries as they are recorded
  // (the web layer's genome tracker). Observer-only: it runs after
  // the run's own bookkeeping and its return value is ignored.
  onSummary = null,
  // Test seam with the scheduler/engine task shape: when null (every
  // production caller) probing binds to the real websocket probe below.
  task = null,
  // Test seam mirroring startXray's own: an interpreter prefix for the
  // located Xray path, forwarded to the finalize stage's startXray
  // calls. Empty for every production caller (a real xray binary is
  // spawned directly, exactly as before); the wiring tests use it to
  // drive the fake-xray fixture through node itself, because a script
  // file cannot be spawned directly on Windows.
  xrayArgs = [],
}) {
  const vless = parseVlessUri(vlessUri);
  assertWebsocketCapable(vless);
  // Progress events from THIS module's own stages (calibrating, the
  // legacy traversal, finalize) are mirrored into the log as
  // hard.progress records (debug per event, info throttled). UI events
  // keep their raw phase strings; the caller names the checkpoint's
  // phase vocabulary for the record, so log, checkpoint and UI agree
  // about where the run is. The block engine's progress is NOT
  // mirrored here: the engine already writes the canonical
  // hard.engine.progress record itself, and a second mirror made
  // every engine event land in the log twice (W1 gate C3, removed in
  // W5) — one event, one record.
  const recordProgress = createProgressRecorder(logger, {
      event: "hard.progress",
    }),
    emitProgress = (event, logPhase = event.phase) => {
      onProgress(event);
      recordProgress({ ...event, phase: logPhase });
    };
  const target = describeVless(vless),
    rangesText = fs.readFileSync(layout.rangesFile, "utf8"),
    ranges = parseRangeList(rangesText),
    plan = buildRangePlan(ranges);
  let state,
    blockPlan = null,
    catalogHash = null;
  // The block plan and catalog hash exist only for blocks-engine runs;
  // building them is skipped entirely on the legacy path so it cannot
  // gain a new failure mode.
  const prepareBlocks = () => {
    if (!blockPlan)
      ((blockPlan = buildBlockPlan(ranges)),
        (catalogHash = catalogHashOf(rangesText)));
  };
  if (resume && stateExists(layout))
    ((state = (function (loaded) {
      return (
        loaded.files.retryFile ||
          (loaded.files.retryFile = loaded.files.eligibilityFile.replace(
            /\.eligibility\.ndjson$/,
            ".retry.ndjson",
          )),
        loaded.counts.retryQueued || (loaded.counts.retryQueued = 0),
        loaded.counts.retryRecovered || (loaded.counts.retryRecovered = 0),
        loaded
      );
    })(JSON.parse(fs.readFileSync(layout.hardStateFile, "utf8")))),
      (state.settings = settings),
      (state.status = "in_progress"),
      (state.execution = "parallel-batched"),
      (state.traversal = traversalForState(state)),
      // A resumed v4 checkpoint keeps its engine whatever the current
      // settings say (the engine setting affects new runs only); patch
      // in any v4 field an early build may not have written.
      isBlocksState(state) &&
        ((state.blockState ??= null),
        (state.phase ??= "primer"),
        (state.counts.primerProbes ??= 0),
        (state.counts.expansionProbes ??= 0),
        (state.counts.blocksPrimed ??= 0),
        (state.counts.blocksExpanded ??= 0)));
  else {
    "blocks" === settings.hard.engine && prepareBlocks();
    ((state =
      "blocks" === settings.hard.engine
        ? createBlocksState({
            layout,
            runId,
            settings,
            target,
            rangesCount: ranges.length,
            blocksTotal: blockPlan.totalBlocks,
            catalogHash,
          })
        : (function ({
      layout,
      runId,
      settings,
      target,
      total,
      rangesCount,
    }) {
      const basePath = path.join(layout.hardScanDir, `run-${runId}`);
      return {
        version: 3,
        runId,
        mode: "hard",
        traversal: "range-round-robin",
        execution: "parallel-batched",
        status: "in_progress",
        startedAt: new Date().toISOString(),
        target,
        settings,
        total,
        rangesCount,
        cursor: { rangeIndex: 0, passIndex: 0 },
        counts: {
          tested: 0,
          eligible: 0,
          failed: 0,
          retryQueued: 0,
          retryRecovered: 0,
        },
        files: {
          eligibilityFile: `${basePath}.eligibility.ndjson`,
          retryFile: `${basePath}.retry.ndjson`,
          snapshotJson: `${basePath}.partial.json`,
          snapshotTxt: `${basePath}.partial.txt`,
          archiveStateFile: `${basePath}.state.json`,
        },
        topEligibility: [],
      };
    })({
      layout,
      runId,
      settings,
      target,
      total: plan.total,
      rangesCount: ranges.length,
    })),
      removeStateFile(layout));
    for (const file of Object.values(state.files))
      try {
        fs.rmSync(file, { force: !0 });
      } catch {}
  }
  // Calibration probes the path before the sweep starts (it runs inside
  // the declaration chain below); announce it, or the run opens with a
  // silent minute — the same fix as the Full path.
  emitProgress({ phase: "calibrating", completed: 0, total: 1 }, "calibrating");
  // The probe binding for every stage below: the injected task when a
  // test supplies one, otherwise the real websocket probe. It reads
  // `settings` lazily because calibration replaces the settings object
  // further down.
  const probeTask =
      task ??
      (async (candidate) =>
        probeWebsocket({
          ip: candidate.ip,
          vless,
          timeoutMs: settings.scan.timeoutMs,
        })),
    requestedConcurrency = clampInt(
      settings.hard.concurrency,
      settings.scan.concurrency,
    ),
    calibrationCandidates = sampleCandidates({
      ranges,
      perRange: 1,
      // The control hunt probes up to 32 candidates (scan-calibration);
      // the pool must be at least that deep or the cap is fiction here.
      max: Math.max(32, requestedConcurrency),
      seed: 404,
    }),
    calibration = await calibrateWebsocketConcurrency({
      candidates: calibrationCandidates,
      vless,
      calibration: settings.calibration,
      requestedConcurrency,
      timeoutMs: settings.scan.timeoutMs,
      ...(task
        ? {
            probeTask: ({ ip }) =>
              task(
                calibrationCandidates.find(
                  (candidate) => candidate.ip === ip,
                ) ?? { ip, range: null },
                1,
              ),
          }
        : {}),
    });
  ((settings = {
    ...settings,
    hard: { ...settings.hard, concurrency: calibration.selectedConcurrency },
    calibration: { ...settings.calibration, result: calibration },
  }),
    (state.settings = settings));
  emitProgress(
    {
      phase: "calibrating",
      completed: 1,
      total: 1,
      note: `concurrency ${calibration.selectedConcurrency} selected`,
    },
    "calibrating",
  );
  // Same calibration verdict as the Full path records (scan.calibration):
  // the selected concurrency and why, with per-level results.
  logger.info("hard.calibration", {
    requestedConcurrency: calibration.requestedConcurrency,
    selectedConcurrency: calibration.selectedConcurrency,
    reason: calibration.reason,
    controlIp: calibration.controlIp ?? null,
    levels: calibration.levels,
  });
  // Same no-control warning as the Full path: calibration no-ops and the
  // sweep runs at the requested concurrency unmeasured.
  if ("no_working_control" === calibration.reason)
    logger.warn("hard.calibration.no_control", {
      requestedConcurrency: calibration.requestedConcurrency,
      controlProbes: calibration.controlProbes ?? null,
    });
  const concurrency = calibration.selectedConcurrency,
    screeningRounds = clampInt(settings.hard.screeningRounds, 1, 5),
    blocksEngine = isBlocksState(state);
  let reputationStore = null,
    initialBlockState = null;
  if (blocksEngine) {
    prepareBlocks();
    state.blocksTotal = blockPlan.totalBlocks;
    if (resume) {
      // The persisted block arrays are only meaningful for the exact
      // catalog they were built from: on a hash mismatch the block
      // state is discarded, but the eligibility NDJSON, counts, and
      // top list are kept — earned results are never thrown away; the
      // primer simply restarts over the new block space.
      if (state.catalogHash === catalogHash)
        initialBlockState = state.blockState ?? null;
      else
        logger.warn("hard.blocks.catalog-changed", {
          runId: state.runId,
          savedHash: state.catalogHash ?? null,
          currentHash: catalogHash,
        });
      state.catalogHash = catalogHash;
    }
    reputationStore = loadReputation(layout.reputationFile, {
      catalogHash,
      knownBlocks: blockPlan.blocks.map((block) => block.blockId),
      halfLifeDays: settings.hard.reputationHalfLifeDays,
      skipAgeDays: settings.hard.reputationSkipAgeDays,
      confirmAgeDays: settings.hard.reputationConfirmAgeDays,
      maxStoredAttempts: settings.hard.reputationMaxStoredAttempts,
    });
    // The load outcome steers the next primer (tiers are applied inside
    // the engine and ride its start record); until now it was invisible.
    logger.info("hard.reputation.loaded", {
      records: Object.keys(reputationStore.blocks).length,
    });
  }
  let canceled = Boolean(signal && signal.aborted);
  const removeCancelWatcher = (function (onCancel) {
      const onSignal = () => onCancel("signal");
      process.on("SIGINT", onSignal);
      let rawEnabled = !1,
        previousRaw = !1,
        onData = null;
      if (
        process.stdin.isTTY &&
        "function" == typeof process.stdin.setRawMode
      ) {
        previousRaw = Boolean(process.stdin.isRaw);
        try {
          (process.stdin.setRawMode(!0),
            (rawEnabled = !0),
            process.stdin.resume(),
            (onData = (chunk) => {
              ("q" ===
                String(chunk || "")
                  .trim()
                  .toLowerCase() ||
                (chunk && 3 === chunk[0])) &&
                onCancel("keyboard");
            }),
            process.stdin.on("data", onData));
        } catch {
          rawEnabled = !1;
        }
      }
      return () => {
        if (
          (process.off("SIGINT", onSignal),
          onData && process.stdin.off("data", onData),
          rawEnabled)
        )
          try {
            process.stdin.setRawMode(previousRaw);
          } catch {}
      };
    })(() => {
      canceled = !0;
    }),
    legacy = isLegacyState(state),
    nextCandidate = legacy ? nextLegacyCandidate : nextRoundRobinCandidate;
  // The external token's listener lives for the whole run — unlike the
  // terminal watcher above, which is removed after screening — because
  // the finalize stage's own `canceled` checks (retry, verify, tunnel)
  // keep honoring the flag, and a web stop pressed during finalize
  // deserves the same graceful pause as one pressed during screening.
  // Removed just before the return below; a signal whose run already
  // ended is the caller's to discard with its controller.
  const onExternalAbort = () => {
    canceled = !0;
  };
  if (signal && "function" == typeof signal.addEventListener && !signal.aborted)
    signal.addEventListener("abort", onExternalAbort, { once: !0 });
  onStart({
    engine: blocksEngine ? "blocks" : "legacy",
    blocks: blocksEngine ? blockPlan.totalBlocks : null,
    totalCandidates: plan.total,
    ranges: ranges.length,
    budgetProbes: blocksEngine ? settings.hard.budgetProbes : null,
  });
  logger.info("hard.start", {
    runId: state.runId,
    target,
    totalCandidates: plan.total,
    ranges: ranges.length,
    traversal: traversalForState(state),
    ...(blocksEngine ? { blocks: blockPlan.totalBlocks } : {}),
    execution: "parallel-batched",
    concurrency,
    screeningRounds,
    delayedRetry: Boolean(settings.hard.delayedRetry),
    resume,
  });
  let sinceSave = 0,
    engineOutcome = null;
  try {
    if (blocksEngine) {
      engineOutcome = await runBlockScreening({
        blocks: blockPlan.blocks,
        settings,
        task: probeTask,
        concurrency,
        reputation: reputationStore,
        initialBlockState,
        onSummary: (summary) => {
          (appendJsonLine(state.files.eligibilityFile, summary),
            onSummary?.(summary),
            (state.counts.tested += 1),
            summary.eligibility.successRate >= settings.scan.minimumSuccessRate
              ? (state.counts.eligible += 1)
              : (state.counts.failed += 1),
            (state.topEligibility = insertTop(
              state.topEligibility,
              summary,
              settings.hard.liveTop,
            )),
            logger.debug("hard.eligibility", {
              ip: summary.ip,
              range: summary.range,
              eligibility: summary.eligibility,
            }),
            (sinceSave += 1),
            // Snapshot only, never the checkpoint: the checkpoint's
            // counts and block state must move together, and the block
            // state exists only when the engine returns (below). A
            // crash therefore resumes from the last returned engine
            // state and re-probes the difference — the NDJSON dedup
            // and the checkpoint counts stay consistent, the same
            // contract the legacy in-flight batch already has.
            sinceSave >= settings.hard.saveEvery &&
              (writeSnapshot(state), (sinceSave = 0)));
        },
        onProgress: (event) => {
          // The checkpoint phase tracks the engine's screening stage;
          // the split-coverage pass surfaces to callers under its own
          // progress label (hard-coverage) between primer and
          // expansion. No recordProgress here: the engine logs its own
          // hard.engine.progress records (see the note at the top of
          // this function) — this callback only keeps the checkpoint
          // phase and forwards the UI event.
          ("hard-primer" === event.phase
            ? (state.phase = "primer")
            : "hard-split-coverage" === event.phase
              ? (state.phase = "coverage")
              : "hard-expansion" === event.phase &&
                (state.phase = "expansion"),
            onProgress({
              ...event,
              phase:
                "hard-split-coverage" === event.phase
                  ? "hard-coverage"
                  : event.phase,
            }));
        },
        logger,
        isCanceled: () => canceled,
        runId: state.runId,
      });
      // The engine has returned — on completion or on cancel — so the
      // serialized block state and the counters derived from it move
      // into the checkpoint together, and the retries it queued join
      // the shared retry file the finalize stage reads.
      ((state.blockState = engineOutcome.blockState),
        (state.counts.primerProbes = engineOutcome.totals.primerProbes),
        (state.counts.expansionProbes =
          engineOutcome.totals.expansionProbes),
        (state.counts.blocksPrimed = engineOutcome.totals.blocksPrimed),
        (state.counts.blocksExpanded = engineOutcome.totals.blocksExpanded),
        (state.counts.retryQueued += engineOutcome.totals.retryQueued));
      for (const retry of engineOutcome.retryQueue)
        appendJsonLine(state.files.retryFile, retry);
      // Reputation is saved only on the engine's natural completion:
      // the engine merges results into the store only then, and saving
      // an unmerged store would still persist the load-time decay
      // rebasing — a canceled or valve-aborted run leaves the file
      // exactly as it found it.
      if (engineOutcome.completed)
        (saveReputation(layout.reputationFile, reputationStore),
          logger.info("hard.reputation.saved", {
            blocks: Object.keys(reputationStore.blocks).length,
          }));
      if (!canceled) state.phase = "finalize";
    }
    for (; !blocksEngine && !canceled;) {
      const batch = collectCandidateBatch({
        plan,
        cursor: state.cursor,
        limit: concurrency,
        nextCandidate,
      });
      if (0 === batch.length) break;
      let batchEligible = 0,
        batchFailed = 0;
      const results = await runEligibilityBatch({
        candidates: batch,
        rounds: screeningRounds,
        concurrency,
        minimumSuccessRate: settings.scan.minimumSuccessRate,
        task: probeTask,
        onCandidateDone: ({ candidate, observations, finished }) => {
          (successRate(observations) >= settings.scan.minimumSuccessRate
            ? (batchEligible += 1)
            : (batchFailed += 1),
            emitProgress(
              {
                phase: "hard-scan",
                completed: state.counts.tested + finished,
                total: state.total,
                eligible: state.counts.eligible + batchEligible,
                failed: state.counts.failed + batchFailed,
                currentRange: candidate.range,
                note: legacy
                  ? `legacy parallel resume x${concurrency}; Q or Ctrl+C to stop safely`
                  : `parallel x${concurrency}; range pass ${candidate.hostIndex + 1}; Q or Ctrl+C to stop safely`,
              },
              "screening",
            ));
        },
      });
      if (settings.hard.delayedRetry)
        for (const retry of selectDelayedRetries(results, {
          maxRetries: concurrency,
          minimumSuccessRate: settings.scan.minimumSuccessRate,
        }))
          (appendJsonLine(state.files.retryFile, {
            ip: retry.ip,
            range: retry.range,
          }),
            (state.counts.retryQueued += 1));
      for (const { candidate, observations } of results) {
        const summary = buildEligibilitySummary({
          ip: candidate.ip,
          range: candidate.range,
          eligibility: observations,
        });
        (appendJsonLine(state.files.eligibilityFile, summary),
          (state.cursor = candidate.nextCursor),
          (state.counts.tested += 1),
          summary.eligibility.successRate >= settings.scan.minimumSuccessRate
            ? (state.counts.eligible += 1)
            : (state.counts.failed += 1),
          (state.topEligibility = insertTop(
            state.topEligibility,
            summary,
            settings.hard.liveTop,
          )),
          logger.debug("hard.eligibility", {
            ip: candidate.ip,
            range: candidate.range,
            eligibility: summary.eligibility,
          }));
      }
      ((sinceSave += results.length),
        (sinceSave >= settings.hard.saveEvery || canceled) &&
          ((state.status = canceled ? "paused" : "in_progress"),
          persistState(layout, state),
          writeSnapshot(state),
          (sinceSave = 0)));
    }
    ((state.status = canceled ? "paused" : "completed"),
      persistState(layout, state),
      writeSnapshot(state));
  } finally {
    removeCancelWatcher();
  }
  const topEligibility = await (async function (file, limit) {
      const entries = [];
      if (!fs.existsSync(file)) return entries;
      const lines = readline.createInterface({
        input: fs.createReadStream(file, "utf8"),
        crlfDelay: 1 / 0,
      });
      for await (const line of lines) {
        const text = line.trim();
        if (text)
          try {
            const entry = JSON.parse(text),
              existing = entries.find((item) => item.ip === entry.ip);
            (existing && entries.splice(entries.indexOf(existing), 1),
              entries.push(entry),
              entries.sort(compareEligibilitySummaries),
              entries.length > limit && (entries.length = limit));
          } catch {}
      }
      return entries;
    })(state.files.eligibilityFile, settings.hard.finalTop),
    retrySummaries = canceled
      ? []
      : await runDelayedRetries({
          state,
          settings,
          logger,
          onProgress: (event) => emitProgress(event, "finalize"),
          task: probeTask,
        }),
    finalists = [
      ...topEligibility.filter(
        (entry) => !retrySummaries.some((summary) => summary.ip === entry.ip),
      ),
      ...retrySummaries,
    ]
      .sort(compareEligibilitySummaries)
      .slice(0, settings.hard.finalTop),
    verified = await (async function ({
      candidates,
      settings,
      logger,
      onProgress,
    }) {
      const count = Math.min(
        candidates.length,
        clampInt(settings.hard.recheckTop, 20, 200),
      );
      if (0 === count) return candidates;
      // The recheck budget is spent under the per-block diversity cap
      // (hard.recheckPerBlock): at most that many finalists from any one
      // catalog block are re-verified, and the walk continues deeper
      // into the list so a single hot /24 cannot crowd out the rest of
      // the catalog's finalists.
      const finalists = selectRecheckFinalists(candidates, {
          limit: count,
          perBlock: clampInt(settings.hard.recheckPerBlock, 4, 200),
        })
          .map((entry) => ({
            ip: entry.ip,
            range: entry.range,
            block: entry.block,
          })),
        concurrency = clampInt(
          settings.hard.concurrency,
          settings.scan.concurrency,
        ),
        useSprt = !1 !== settings.verification?.enabled;
      let accepted = 0,
        rejected = 0;
      logger.info("hard.verify.start", {
        candidates: finalists.length,
        method: useSprt ? "sprt" : "fixed-rounds",
        concurrency,
      });
      const reportProgress = ({ candidate, finished, total, decision }) =>
          onProgress({
            phase: "hard-verify",
            completed: finished,
            total,
            eligible: accepted,
            failed: rejected,
            currentRange: candidate.range,
            note: decision
              ? `verifying finalists (${decision})`
              : "verifying finalists",
          }),
        results = useSprt
          ? await runAdaptiveEligibilityBatch({
              candidates: finalists,
              concurrency,
              sprt: settings.verification?.sprt,
              task: probeTask,
              onCandidateDone: (result) => {
                ("accept" === result.decision
                  ? (accepted += 1)
                  : "reject" === result.decision && (rejected += 1),
                  reportProgress(result));
              },
            })
          : await runEligibilityBatch({
              candidates: finalists,
              rounds: settings.scan.rounds,
              concurrency,
              minimumSuccessRate: settings.scan.minimumSuccessRate,
              task: probeTask,
              onCandidateDone: (result) => {
                (successRate(result.observations) >=
                settings.scan.minimumSuccessRate
                  ? (accepted += 1)
                  : (rejected += 1),
                  reportProgress(result));
              },
            }),
        verifiedByIp = new Map(
          results.map(({ candidate, observations, decision }) => {
            const summary = buildEligibilitySummary({
              ip: candidate.ip,
              range: candidate.range,
              eligibility: observations,
              temporalBlocks: 2,
              block: candidate.block,
            });
            return (
              (summary.verification = {
                method: useSprt ? "sprt" : "fixed-rounds",
                decision: decision || "measured",
                rounds: observations.length,
              }),
              [candidate.ip, summary]
            );
          }),
        );
      return (
        logger.info("hard.verify.complete", {
          candidates: results.length,
          accepted,
          rejected,
        }),
        candidates
          .map((entry) => verifiedByIp.get(entry.ip) || entry)
          .sort(compareEligibilitySummaries)
      );
    })({
      candidates: finalists,
      settings,
      logger,
      onProgress: (event) => emitProgress(event, "finalize"),
    }),
    { xrayInfo, tunnelResults } = await (async function ({
      candidates,
      settings,
      layout,
      logger,
      vless,
      onProgress,
      xrayArgs,
    }) {
      const tunnelResults = new Map();
      let xrayInfo = {
        enabled: !1,
        path: null,
        // "disabled" only when the stage is off; an enabled stage with
        // nothing to measure says so — the summaries print this reason,
        // and conflating the two hid empty finalist pools.
        reason: settings.tunnel.enabled ? "no-candidates" : "disabled",
      };
      if (!settings.tunnel.enabled || 0 === candidates.length)
        return { xrayInfo, tunnelResults };
      const located = locateXray({
        configuredPath: settings.tunnel.xrayPath,
        root: layout.root,
      });
      if (!located.found)
        return (
          (xrayInfo = { enabled: !1, path: null, reason: "xray_not_found" }),
          logger.warn("xray.missing", {
            searched: located.searched,
            mode: "hard",
          }),
          { xrayInfo, tunnelResults }
        );
      xrayInfo = { enabled: !0, path: located.path, reason: null };
      const catalog = loadCatalog(layout.workloadsFile),
        browsingWorkloads = settings.browsing.enabled
          ? resolveWorkloads({ settings, catalog, kind: "browsing" })
          : [],
        streamingWorkloads = settings.streaming.enabled
          ? resolveWorkloads({ settings, catalog, kind: "streaming" })
          : [],
        // The full rate-passing pool is kept, not just the first
        // `limit`: backfill (P-3) walks deeper whenever an attempt
        // yields no scored stage, exactly as in the Full path.
        pool = candidates.filter(
          (entry) =>
            entry.eligibility.successRate >= settings.scan.minimumSuccessRate,
        ),
        attemptBudget = tunnelAttemptBudget(settings.tunnel.limit, pool.length),
        // Same derivation as the `requirements` the summaries below are
        // built with — the backfill verdict and the report must agree
        // on which stages count.
        tunnelRequirements = {
          browsing: settings.browsing.enabled,
          streaming: settings.streaming.enabled,
          load: Boolean(settings.load?.enabled),
        };
      let completed = 0,
        attempts = 0,
        scoredSlots = 0,
        plannedCandidates = 0,
        total = 0;
      // The progress total counts the candidates the stage currently
      // plans to measure: the slot limit at first, growing by one per
      // earned promotion, never beyond the attempt budget. It is
      // recomputed at each candidate's start from accounted state
      // (attempts/scored of finished candidates only), so a total never
      // shrinks or overshoots mid-candidate.
      const computePlannedCandidates = () =>
        Math.min(
          attempts +
            Math.max(
              0,
              Math.min(
                settings.tunnel.limit - scoredSlots,
                pool.length - attempts,
              ),
            ),
          attemptBudget,
        );
      plannedCandidates = computePlannedCandidates();
      total = plannedCandidates * settings.tunnel.rounds;
      onProgress({
        phase: "hard-finalize",
        completed,
        total,
        eligible: plannedCandidates,
        failed: 0,
        note: "final QoE ranking",
      });
      for (const candidate of pool) {
        if (
          !shouldAttemptTunnelCandidate({
            attempts,
            scored: scoredSlots,
            limit: settings.tunnel.limit,
            budget: attemptBudget,
          })
        )
          break;
        // Past the first `limit` attempts every attempt is a promotion
        // into a slot an unscored candidate left empty — log it, so a
        // report with more tested rows than the limit is explainable.
        if (attempts >= settings.tunnel.limit)
          logger.info("hard.tunnel.backfill", {
            ip: candidate.ip,
            attempts,
            scored: scoredSlots,
          });
        plannedCandidates = computePlannedCandidates();
        total = plannedCandidates * settings.tunnel.rounds;
        attempts += 1;
        const browsingResults = [],
          streamingResults = [],
          loadResults = [];
        // One Xray session per candidate across rounds, as in the Full
        // path: restart only when a round fails (see scan.js).
        let xrayHandle = null;
        for (let round = 1; round <= settings.tunnel.rounds; round += 1) {
          try {
            xrayHandle ??= await startXray({
              xrayPath: located.path,
              xrayArgs,
              vless,
              candidateIp: candidate.ip,
              startupTimeoutMs: settings.tunnel.startupTimeoutMs,
              shutdownGraceMs: settings.tunnel.shutdownGraceMs,
              logger,
            });
            // Sub-stage notes mirror the Full path's tunnel stage: a
            // multi-minute finalist session must say which workload
            // is running, not sit on the bare "final QoE ranking".
            onProgress({
              phase: "hard-finalize",
              completed,
              total,
              note: `web transfer · ${candidate.ip}`,
            });
            for (const workload of browsingWorkloads)
              browsingResults.push(
                await probeBrowsing({
                  workload,
                  proxy: xrayHandle.socks,
                  timeoutMs: settings.browsing.timeoutMs,
                  assetLimit: settings.browsing.assetLimit,
                  maxSockets: settings.browsing.maxSockets,
                  maxBytes: settings.browsing.maxBytes,
                  logger,
                }),
              );
            onProgress({
              phase: "hard-finalize",
              completed,
              total,
              note: `streaming · ${candidate.ip}`,
            });
            for (const workload of streamingWorkloads)
              streamingResults.push(
                await probeStreaming({
                  workload,
                  proxy: xrayHandle.socks,
                  timeoutMs: settings.streaming.timeoutMs,
                  maxSegments: settings.streaming.maxSegments,
                  maxBytes: settings.streaming.maxBytes,
                  startupBufferSec: settings.streaming.startupBufferSec,
                  safetyFactor: settings.streaming.safetyFactor,
                  variantMode: settings.streaming.variantMode,
                  targetMbps: settings.streaming.targetMbps,
                  logger,
                }),
              );
            if (settings.load?.enabled) {
              onProgress({
                phase: "hard-finalize",
                completed,
                total,
                note: `real load · ${candidate.ip}`,
              });
              const loadResult = await runLoadProbe({
                proxy: xrayHandle.socks,
                endpoints: settings.load.endpoints,
                durationMs: settings.load.durationMs,
                chunkBytes: settings.load.chunkBytes,
                maxDownloadBytes: settings.load.maxDownloadBytes,
                flows: settings.load.flows,
                uploadBytes: settings.load.uploadBytes,
                uploadFlows: settings.load.uploadFlows,
                fanoutRequests: settings.load.fanoutRequests,
                control: Boolean(settings.load.control?.enabled),
                controlBytes: settings.load.control?.bytes,
                idleSamples: settings.load.idleSamples,
                timeoutMs: settings.load.timeoutMs,
              });
              (loadResults.push(loadResult),
                logger.info("hard.load.probe", {
                  ip: candidate.ip,
                  round,
                  bytes:
                    (loadResult.downlink?.totalBytes || 0) +
                    (loadResult.uplink?.totalBytes || 0),
                  sustainedMbps: loadResult.downlink?.sustainedMbps ?? null,
                  shapingRatio: loadResult.downlink?.shapingRatio ?? null,
                  loadedRttMs: loadResult.latency?.loadedRttMs ?? null,
                }));
            }
          } catch (error) {
            logger.warn("hard.tunnel.failed", {
              ip: candidate.ip,
              round,
              error: error.message,
            });
            await xrayHandle?.stop();
            xrayHandle = null;
          }
          ((completed += 1),
            onProgress({
              phase: "hard-finalize",
              completed,
              total,
              eligible: plannedCandidates,
              failed: 0,
              currentRange: candidate.range,
              note: candidate.ip,
            }));
        }
        await xrayHandle?.stop();
        tunnelResults.set(candidate.ip, {
          browsing: browsingResults,
          streaming: streamingResults,
          load: loadResults,
        });
        // Only a candidate that scored in some enabled stage fills its
        // slot; anything else leaves the slot open for the next pool
        // entry (bounded by the attempt budget in the loop header).
        if (
          hasScoredTunnelStage(
            tunnelResults.get(candidate.ip),
            tunnelRequirements,
          )
        )
          scoredSlots += 1;
      }
      return { xrayInfo, tunnelResults };
    })({
      candidates: verified,
      settings,
      layout,
      logger,
      vless,
      onProgress: (event) => emitProgress(event, "finalize"),
      xrayArgs,
    }),
    requirements = {
      browsing: settings.browsing.enabled,
      streaming: settings.streaming.enabled,
      load: Boolean(settings.load?.enabled),
    },
    finalCandidates = verified.map((entry) => {
      const summary = applyTunnelResults(
          entry,
          tunnelResults.get(entry.ip) || null,
          requirements,
          {
            gateOverrides: settings.load?.gates,
            gateProfile: settings.load?.gateProfile,
          },
        ),
        eligibleForTunnel =
          entry.eligibility.successRate >= settings.scan.minimumSuccessRate;
      return (
        (summary.selection = {
          ...(summary.selection || {}),
          eligibleForTunnel,
          tunnelTested: tunnelResults.has(entry.ip),
          tunnelReason: tunnelResults.has(entry.ip)
            ? null
            : eligibleForTunnel
              ? settings.tunnel.enabled
                ? xrayInfo.enabled
                  ? "outside-tunnel-limit"
                  : "xray_not_found" === xrayInfo.reason
                    ? "xray-not-found"
                    : "tunnel-disabled"
                : "tunnel-disabled"
              : "not-eligible",
        }),
        summary
      );
    }),
    written = (function ({
      layout,
      state,
      target,
      settings,
      candidates,
      xrayInfo,
      canceled,
      engineOutcome,
    }) {
      const ranked = rankCandidates(candidates),
        report = {
          schema: REPORT_SCHEMA,
          generator: "cfqoe-scanner",
          version: GENERATOR_VERSION,
          scoreLabel: "Experimental CFQoE Score",
          scope: "run-relative",
          mode: "hard",
          traversal: traversalForState(state),
          execution: "parallel-batched",
          runId: state.runId,
          startedAt: state.startedAt,
          finishedAt: new Date().toISOString(),
          platform: `${process.platform}-${process.arch}`,
          canceled,
          target,
          settings,
          checkpoints: state.files,
          xray: xrayInfo,
          totals: {
            tested: state.counts.tested,
            eligible: state.counts.eligible,
            failed: state.counts.failed,
            retryQueued: state.counts.retryQueued,
            retryRecovered: state.counts.retryRecovered,
            includedInReport: ranked.length,
            complete: ranked.filter(
              (entry) => "complete" === entry.measurement?.status,
            ).length,
            highConfidence: ranked.filter(
              (entry) => "high" === entry.eligibility.confidence,
            ).length,
            withBrowsing: ranked.filter(
              (entry) => null !== entry.scores.browsing,
            ).length,
            withStreaming: ranked.filter(
              (entry) => null !== entry.scores.streaming,
            ).length,
            // Block-adaptive runs only: the legacy totals keep their
            // exact shape (additive-only report changes, schema 10).
            ...(engineOutcome
              ? {
                  probesSpent: engineOutcome.totals.probesSpent,
                  primerProbes: engineOutcome.totals.primerProbes,
                  expansionProbes: engineOutcome.totals.expansionProbes,
                  reserveProbes: engineOutcome.totals.reserveProbes,
                  blocksTotal: engineOutcome.totals.blocksTotal,
                  blocksPrimed: engineOutcome.totals.blocksPrimed,
                  blocksExpanded: engineOutcome.totals.blocksExpanded,
                  blocksExhausted: engineOutcome.totals.blocksExhausted,
                  blocksByTier: engineOutcome.totals.blocksByTier,
                  blocksExtended: engineOutcome.totals.blocksExtended,
                  suspectsServed: engineOutcome.totals.suspectsServed,
                  blocksPromoted: engineOutcome.totals.blocksPromoted,
                  blocksSplit: engineOutcome.totals.blocksSplit,
                }
              : {}),
          },
          results: ranked,
        },
        jsonPath = path.join(layout.results, `run-${state.runId}.json`),
        latestPath = path.join(layout.results, "latest.json"),
        topPath = path.join(layout.results, "best-ips.txt");
      return (
        writeJsonFile(jsonPath, report),
        writeJsonFile(latestPath, report),
        fs.writeFileSync(topPath, `${renderTopList(ranked)}\n`, { mode: 384 }),
        {
          jsonPath,
          latestPath,
          topPath,
          report,
          xray: xrayInfo,
          eligibleCount: state.counts.eligible,
          runId: state.runId,
          canceled,
        }
      );
    })({
      layout,
      state,
      target,
      settings,
      candidates: finalCandidates,
      xrayInfo,
      canceled,
      engineOutcome,
    });
  return (
    (state.lastReport = written.jsonPath),
    persistState(layout, state),
    canceled || removeStateFile(layout),
    // The engine's stop reason and the reputation outcome ride the
    // RETURN value, never report.totals (whose key set is pinned by
    // the report contract): the end-of-run summaries and run.end need
    // them, and until now the engine computed the reason and dropped
    // it on the floor.
    (written.stoppedReason =
      engineOutcome?.stoppedReason ?? (canceled ? "canceled" : "completed")),
    (written.reputationSaved = Boolean(engineOutcome?.completed)),
    (written.reputationBlocks = reputationStore
      ? Object.keys(reputationStore.blocks).length
      : 0),
    logger.info("hard.complete", {
      runId: state.runId,
      canceled,
      stoppedReason: written.stoppedReason,
      tested: state.counts.tested,
      eligible: state.counts.eligible,
      retryQueued: state.counts.retryQueued,
      retryRecovered: state.counts.retryRecovered,
      traversal: state.traversal,
      execution: state.execution,
      report: written.jsonPath,
    }),
    signal &&
      "function" == typeof signal.removeEventListener &&
      signal.removeEventListener("abort", onExternalAbort),
    written
  );
}
