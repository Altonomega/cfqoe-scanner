import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
  rankCandidates,
  renderTopList,
  REPORT_SCHEMA,
  GENERATOR_VERSION,
} from "./report.js";
import { runLoadProbe } from "./probe/load.js";
import { calibrateWebsocketConcurrency } from "./measurement/scan-calibration.js";
import { compareEligibilitySummaries } from "./hard-engine.js";
export const HARD_STATE_VERSION = 3;
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
function writeSnapshot(state) {
  const legacy = isLegacyState(state),
    snapshot = {
      runId: state.runId,
      status: state.status,
      scope: "run-relative",
      traversal: legacy ? "legacy-range-sequential" : "range-round-robin",
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
        rangeIndex: state.cursor.rangeIndex,
        passIndex: legacy ? null : state.cursor.passIndex,
        hostIndex: legacy ? state.cursor.hostIndex : null,
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
async function runDelayedRetries({
  state,
  settings,
  vless,
  logger,
  onProgress,
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
            entries.push({ ip: entry.ip, range: entry.range }),
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
    rounds: clampInt(settings.scan.rounds, 2, 16),
    concurrency,
    minimumSuccessRate: settings.scan.minimumSuccessRate,
    task: async (candidate) =>
      probeWebsocket({
        ip: candidate.ip,
        vless,
        timeoutMs: settings.scan.timeoutMs,
      }),
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
  runId,
  resume = !1,
}) {
  const vless = parseVlessUri(vlessUri);
  assertWebsocketCapable(vless);
  const target = describeVless(vless),
    ranges = parseRangeList(fs.readFileSync(layout.rangesFile, "utf8")),
    plan = buildRangePlan(ranges);
  let state;
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
      (state.traversal = isLegacyState(state)
        ? "legacy-range-sequential"
        : "range-round-robin"));
  else {
    ((state = (function ({
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
  const requestedConcurrency = clampInt(
      settings.hard.concurrency,
      settings.scan.concurrency,
    ),
    calibrationCandidates = sampleCandidates({
      ranges,
      perRange: 1,
      max: Math.max(4, requestedConcurrency),
      seed: 404,
    }),
    calibration = await calibrateWebsocketConcurrency({
      candidates: calibrationCandidates,
      vless,
      calibration: settings.calibration,
      requestedConcurrency,
      timeoutMs: settings.scan.timeoutMs,
    });
  ((settings = {
    ...settings,
    hard: { ...settings.hard, concurrency: calibration.selectedConcurrency },
    calibration: { ...settings.calibration, result: calibration },
  }),
    (state.settings = settings));
  const concurrency = calibration.selectedConcurrency,
    screeningRounds = clampInt(settings.hard.screeningRounds, 1, 5);
  let canceled = !1;
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
  logger.info("hard.start", {
    runId: state.runId,
    target,
    totalCandidates: plan.total,
    ranges: ranges.length,
    traversal: legacy ? "legacy-range-sequential" : "range-round-robin",
    execution: "parallel-batched",
    concurrency,
    screeningRounds,
    delayedRetry: Boolean(settings.hard.delayedRetry),
    resume,
  });
  let sinceSave = 0;
  try {
    for (; !canceled;) {
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
        task: async (candidate) =>
          probeWebsocket({
            ip: candidate.ip,
            vless,
            timeoutMs: settings.scan.timeoutMs,
          }),
        onCandidateDone: ({ candidate, observations, finished }) => {
          (successRate(observations) >= settings.scan.minimumSuccessRate
            ? (batchEligible += 1)
            : (batchFailed += 1),
            onProgress({
              phase: "hard-scan",
              completed: state.counts.tested + finished,
              total: state.total,
              eligible: state.counts.eligible + batchEligible,
              failed: state.counts.failed + batchFailed,
              currentRange: candidate.range,
              note: legacy
                ? `legacy parallel resume x${concurrency}; Q or Ctrl+C to stop safely`
                : `parallel x${concurrency}; range pass ${candidate.hostIndex + 1}; Q or Ctrl+C to stop safely`,
            }));
        },
      });
      if (settings.hard.delayedRetry)
        for (const retry of selectDelayedRetries(results, {
          maxRetries: concurrency,
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
      : await runDelayedRetries({ state, settings, vless, logger, onProgress }),
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
      vless,
      logger,
      onProgress,
    }) {
      const count = Math.min(
        candidates.length,
        clampInt(settings.hard.recheckTop, 20, 200),
      );
      if (0 === count) return candidates;
      const finalists = candidates
          .slice(0, count)
          .map((entry) => ({ ip: entry.ip, range: entry.range })),
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
              task: async (candidate) =>
                probeWebsocket({
                  ip: candidate.ip,
                  vless,
                  timeoutMs: settings.scan.timeoutMs,
                }),
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
              task: async (candidate) =>
                probeWebsocket({
                  ip: candidate.ip,
                  vless,
                  timeoutMs: settings.scan.timeoutMs,
                }),
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
    })({ candidates: finalists, settings, vless, logger, onProgress }),
    { xrayInfo, tunnelResults } = await (async function ({
      candidates,
      settings,
      layout,
      logger,
      vless,
      onProgress,
    }) {
      const tunnelResults = new Map();
      let xrayInfo = { enabled: !1, path: null, reason: "disabled" };
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
        finalists = candidates
          .filter(
            (entry) =>
              (entry.eligibility.confidence95?.lower ??
                entry.eligibility.successRate) >= 0 &&
              entry.eligibility.successRate >= settings.scan.minimumSuccessRate,
          )
          .slice(0, settings.tunnel.limit),
        total = finalists.length * settings.tunnel.rounds;
      let completed = 0;
      onProgress({
        phase: "hard-finalize",
        completed,
        total,
        eligible: finalists.length,
        failed: 0,
        note: "final QoE ranking",
      });
      for (const candidate of finalists) {
        const browsingResults = [],
          streamingResults = [],
          loadResults = [];
        for (let round = 1; round <= settings.tunnel.rounds; round += 1) {
          let xrayHandle = null;
          try {
            xrayHandle = await startXray({
              xrayPath: located.path,
              vless,
              candidateIp: candidate.ip,
              startupTimeoutMs: settings.tunnel.startupTimeoutMs,
              shutdownGraceMs: settings.tunnel.shutdownGraceMs,
              logger,
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
          } finally {
            await xrayHandle?.stop();
          }
          ((completed += 1),
            onProgress({
              phase: "hard-finalize",
              completed,
              total,
              eligible: finalists.length,
              failed: 0,
              currentRange: candidate.range,
              note: candidate.ip,
            }));
        }
        tunnelResults.set(candidate.ip, {
          browsing: browsingResults,
          streaming: streamingResults,
          load: loadResults,
        });
      }
      return { xrayInfo, tunnelResults };
    })({
      candidates: verified,
      settings,
      layout,
      logger,
      vless,
      onProgress,
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
    }) {
      const ranked = rankCandidates(candidates),
        report = {
          schema: REPORT_SCHEMA,
          generator: "cfqoe-scanner",
          version: GENERATOR_VERSION,
          scoreLabel: "Experimental CFQoE Score",
          scope: "run-relative",
          mode: "hard",
          traversal: isLegacyState(state)
            ? "legacy-range-sequential"
            : "range-round-robin",
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
    });
  return (
    (state.lastReport = written.jsonPath),
    persistState(layout, state),
    canceled || removeStateFile(layout),
    logger.info("hard.complete", {
      runId: state.runId,
      canceled,
      tested: state.counts.tested,
      eligible: state.counts.eligible,
      retryQueued: state.counts.retryQueued,
      retryRecovered: state.counts.retryRecovered,
      traversal: state.traversal,
      execution: state.execution,
      report: written.jsonPath,
    }),
    written
  );
}
