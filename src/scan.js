import fs from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import {
  parseVlessUri,
  describeVless,
  assertWebsocketCapable,
} from "./config/vless.js";
import { parseRangeList, sampleCandidates } from "./candidate/ipv4.js";
import { probeWebsocket } from "./probe/websocket.js";
import { runInterleaved } from "./scheduler.js";
import {
  runEligibilityBatch,
  runAdaptiveEligibilityBatch,
  selectDelayedRetries,
  orderForTunnelSelection,
  tunnelAttemptBudget,
  shouldAttemptTunnelCandidate,
} from "./hard-scheduler.js";
import { probeBrowsing } from "./browsing/probe.js";
import { probeStreaming } from "./streaming/probe.js";
import { runLoadProbe } from "./probe/load.js";
import { startXray } from "./xray/manager.js";
import { locateXray } from "./platform/xray.js";
import {
  buildCandidateSummary,
  hasScoredTunnelStage,
  writeReport,
} from "./report.js";
import { resolveWorkloads, loadCatalog } from "./config/settings.js";
import { calibrateWebsocketConcurrency } from "./measurement/scan-calibration.js";
import { isAbortError } from "./measurement/abort.js";
import { createProgressRecorder } from "./logging/logger.js";
function successRate(observations) {
  return observations.length
    ? observations.filter((observation) => observation.ok).length /
        observations.length
    : 0;
}
function medianHandshakeMs(observations) {
  const sorted = observations
    .filter(
      (observation) =>
        observation.ok && Number.isFinite(observation.handshakeMs),
    )
    .map((observation) => observation.handshakeMs)
    .sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1 / 0;
}
export async function runScan({
  vlessUri,
  settings,
  layout,
  logger,
  onProgress = () => {},
  runId = randomUUID(),
  // Optional external cancel token (AbortSignal-shaped): the web
  // layer's stop button. When it aborts, the scan stops starting new
  // work at the next stage/batch boundary and still writes its report
  // from the evidence gathered, marked canceled — the graceful stop
  // the terminal never needed (its Ctrl+C kills the process) and
  // therefore never passes. Absent, every path below is unchanged.
  signal = null,
}) {
  const startedAt = new Date().toISOString(),
    vless = parseVlessUri(vlessUri);
  assertWebsocketCapable(vless);
  // Every progress event is mirrored into the log as a scan.progress
  // record (debug per event, info throttled) — one definition for the
  // terminal and the file, so a frozen run stays reconstructable.
  const recordProgress = createProgressRecorder(logger, {
      event: "scan.progress",
    }),
    emitProgress = (event) => {
      onProgress(event);
      recordProgress(event);
    },
    isCanceled = () => Boolean(signal && signal.aborted);
  const target = describeVless(vless),
    seed = randomInt(0, 4294967296);
  let effectiveSettings = { ...settings, scan: { ...settings.scan, seed } };
  // Calibration probes the path before the scan starts (up to ~80 s of
  // probing); announce it, or the run opens with a silent minute.
  emitProgress({ phase: "calibrating", completed: 0, total: 1 });
  const ranges = parseRangeList(fs.readFileSync(layout.rangesFile, "utf8")),
    candidates = sampleCandidates({
      ranges,
      perRange: effectiveSettings.scan.perRange,
      max: effectiveSettings.scan.maxCandidates,
      seed,
    });
  let calibration = null;
  if (!isCanceled()) {
    try {
      calibration = await calibrateWebsocketConcurrency({
        candidates,
        vless,
        calibration: effectiveSettings.calibration,
        requestedConcurrency: effectiveSettings.scan.concurrency,
        timeoutMs: effectiveSettings.scan.timeoutMs,
        seed,
        signal,
        // Ladder positions ride the calibrating phase's own progress
        // channel: completed/total become levels measured / ladder
        // size, so the consoles count calibration instead of
        // watching a silent minute.
        onProgress: ({ completed, total, level }) =>
          emitProgress({
            phase: "calibrating",
            completed,
            total,
            ...(level != null ? { level } : {}),
          }),
      });
    } catch (error) {
      // A stop that lands mid-calibration is not a calibration
      // outcome: no verdict was measured, so — exactly as when the
      // stop lands before calibration — none is applied or logged
      // below, and the run ends canceled through the normal path.
      if (!isAbortError(error) || !isCanceled()) throw error;
      calibration = null;
    }
  }
  // A run canceled before calibration keeps the configured settings
  // verbatim: no verdict was measured, so none is applied or logged.
  effectiveSettings = calibration
    ? {
        ...effectiveSettings,
        scan: {
          ...effectiveSettings.scan,
          concurrency: calibration.selectedConcurrency,
        },
        calibration: { ...effectiveSettings.calibration, result: calibration },
      }
    : effectiveSettings;
  calibration &&
    emitProgress({
      phase: "calibrating",
      completed: 1,
      total: 1,
      note: `concurrency ${calibration.selectedConcurrency} selected`,
    });
  // Calibration chose the operative concurrency (the configured value
  // is only its ceiling); record the verdict with the per-level results
  // or "why is this scan crawling at concurrency 1?" is unanswerable
  // from the log.
  calibration &&
    logger.info("scan.calibration", {
      requestedConcurrency: calibration.requestedConcurrency,
      selectedConcurrency: calibration.selectedConcurrency,
      reason: calibration.reason,
      controlIp: calibration.controlIp ?? null,
      levels: calibration.levels,
    });
  // A no-control outcome means calibration silently no-ops and the scan
  // runs at the requested concurrency unmeasured — on exactly the
  // filtered paths that most needed measuring. Surface it at warn.
  if (calibration && "no_working_control" === calibration.reason)
    logger.warn("scan.calibration.no_control", {
      requestedConcurrency: calibration.requestedConcurrency,
      controlProbes: calibration.controlProbes ?? null,
    });
  logger.info("scan.start", {
    runId,
    target,
    settings: effectiveSettings,
    scoreLabel: "Experimental CFQoE Score",
  });
  const rounds = Math.max(1, effectiveSettings.scan.rounds || 1);
  emitProgress({
    phase: "screening",
    completed: 0,
    total: candidates.length * rounds,
  });
  const screeningResults = isCanceled()
    ? []
    : await runInterleaved({
      items: candidates,
      rounds,
      concurrency: effectiveSettings.scan.concurrency,
      seed,
      isCanceled,
      task: async (item, round) => {
        const observation = await probeWebsocket({
          ip: item.ip,
          vless,
          timeoutMs: effectiveSettings.scan.timeoutMs,
        });
        return (
          logger.debug("eligibility.screen", { ...observation, round }),
          observation
        );
      },
      onProgress: ({ completed, total, round, item }) =>
        emitProgress({ phase: "screening", completed, total, round, ip: item?.ip }),
    }),
    observationsByIp = new Map(
      screeningResults.map((result) => [result.item.ip, result.observations]),
    );
  if (effectiveSettings.scan.delayedRetry?.enabled && !isCanceled()) {
    const retryCandidates = selectDelayedRetries(
      screeningResults.map((result) => ({
        candidate: result.item,
        observations: result.observations,
      })),
      {
        maxRetries: effectiveSettings.scan.delayedRetry.maxCandidates,
        minimumSuccessRate: effectiveSettings.scan.minimumSuccessRate,
        singleProbe: true,
      },
    );
    if (retryCandidates.length) {
      logger.info("scan.delayed_retry.start", {
        candidates: retryCandidates.length,
      });
      const retryResults = await runEligibilityBatch({
        candidates: retryCandidates,
        rounds: 1,
        concurrency: effectiveSettings.scan.concurrency,
        minimumSuccessRate: effectiveSettings.scan.minimumSuccessRate,
        task: (candidate) =>
          probeWebsocket({
            ip: candidate.ip,
            vless,
            timeoutMs: effectiveSettings.scan.timeoutMs,
          }),
        isCanceled,
        onCandidateDone: ({ finished, total, candidate }) =>
          emitProgress({ phase: "delayed-retry", completed: finished, total, ip: candidate?.ip }),
      });
      for (const result of retryResults)
        observationsByIp.get(result.candidate.ip).push(...result.observations);
      logger.info("scan.delayed_retry.complete", {
        candidates: retryResults.length,
      });
    }
  }
  const screenedRanked = candidates
      .map((candidate) => ({
        candidate,
        observations: observationsByIp.get(candidate.ip) || [],
      }))
      .filter((entry) =>
        entry.observations.some((observation) => observation.ok),
      )
      .sort(
        (left, right) =>
          successRate(right.observations) - successRate(left.observations) ||
          medianHandshakeMs(left.observations) -
            medianHandshakeMs(right.observations),
      ),
    verificationByIp = new Map(),
    decisionsByIp = new Map();
  if (
    effectiveSettings.verification?.enabled &&
    screenedRanked.length &&
    !isCanceled()
  ) {
    const finalists = screenedRanked
      .slice(0, effectiveSettings.verification.limit)
      .map((entry) => entry.candidate);
    logger.info("verification.start", {
      candidates: finalists.length,
      sprt: effectiveSettings.verification.sprt,
    });
    const verificationResults = await runAdaptiveEligibilityBatch({
      candidates: finalists,
      concurrency: Math.min(
        effectiveSettings.scan.concurrency,
        finalists.length,
      ),
      sprt: effectiveSettings.verification.sprt,
      task: (candidate) =>
        probeWebsocket({
          ip: candidate.ip,
          vless,
          timeoutMs: effectiveSettings.scan.timeoutMs,
        }),
      isCanceled,
      onCandidateDone: ({ finished, total, decision, candidate }) =>
        emitProgress({
          phase: "verification",
          completed: finished,
          total,
          note: decision,
          ip: candidate?.ip,
        }),
    });
    for (const result of verificationResults)
      (verificationByIp.set(result.candidate.ip, result.observations),
        decisionsByIp.set(result.candidate.ip, result.decision));
    logger.info("verification.complete", {
      accepted: verificationResults.filter(
        (result) => "accept" === result.decision,
      ).length,
      rejected: verificationResults.filter(
        (result) => "reject" === result.decision,
      ).length,
      inconclusive: verificationResults.filter(
        (result) => "inconclusive" === result.decision,
      ).length,
    });
  }
  const eligible = screenedRanked.filter(({ candidate, observations }) => {
      const verificationObs = verificationByIp.get(candidate.ip);
      if (!verificationObs)
        return (
          successRate(observations) >= effectiveSettings.scan.minimumSuccessRate
        );
      const decision = decisionsByIp.get(candidate.ip);
      return (
        "accept" === decision ||
        ("inconclusive" === decision &&
          successRate(verificationObs) >=
            effectiveSettings.scan.minimumSuccessRate)
      );
    }),
    tunnelByIp = new Map();
  // One requirements object for the tunnel stage and the summaries: the
  // backfill verdict and the report must agree on which stages count.
  const tunnelRequirements = {
    browsing: effectiveSettings.browsing.enabled,
    streaming: effectiveSettings.streaming.enabled,
    load: Boolean(effectiveSettings.load?.enabled),
  };
  let xrayStatus = { enabled: !1, path: null, reason: "disabled" };
  if (effectiveSettings.tunnel.enabled && eligible.length > 0 && !isCanceled()) {
    const xrayLocation = locateXray({
      configuredPath: effectiveSettings.tunnel.xrayPath,
      root: layout.root,
    });
    if (xrayLocation.found) {
      xrayStatus = { enabled: !0, path: xrayLocation.path, reason: null };
      const catalog = loadCatalog(layout.workloadsFile),
        browsingWorkloads = effectiveSettings.browsing.enabled
          ? resolveWorkloads({
              settings: effectiveSettings,
              catalog,
              kind: "browsing",
            })
          : [],
        streamingWorkloads = effectiveSettings.streaming.enabled
          ? resolveWorkloads({
              settings: effectiveSettings,
              catalog,
              kind: "streaming",
            })
          : [],
        // Slots are dealt in post-verification order (accepted, then
        // inconclusive, then screening-only), not the screening order
        // `eligible` arrives in — a finalist SPRT accepted after ranking
        // 6th on screening evidence must not lose its slot to an
        // inconclusive finalist that ranked 3rd. The full ordered pool
        // is kept, not just the first `limit`: backfill (P-3) walks
        // deeper whenever an attempt yields no scored stage.
        tunnelCandidates = orderForTunnelSelection(eligible, {
          decisionByIp: decisionsByIp,
          verificationRateByIp: new Map(
            [...verificationByIp].map(([ip, observations]) => [
              ip,
              successRate(observations),
            ]),
          ),
        });
      let completedCount = 0,
        attempts = 0,
        scoredSlots = 0,
        totalCount = 0;
      const attemptBudget = tunnelAttemptBudget(
          effectiveSettings.tunnel.limit,
          tunnelCandidates.length,
        ),
        // The progress total counts the candidates the stage currently
        // plans to measure: the slot limit at first, growing by one per
        // earned promotion, never beyond the attempt budget. It is
        // recomputed at each candidate's start from accounted state
        // (attempts/scored of finished candidates only), so a total
        // never shrinks or overshoots mid-candidate.
        computeTotalCount = () =>
          Math.min(
            attempts +
              Math.max(
                0,
                Math.min(
                  effectiveSettings.tunnel.limit - scoredSlots,
                  tunnelCandidates.length - attempts,
                ),
              ),
            attemptBudget,
          ) * effectiveSettings.tunnel.rounds;
      totalCount = computeTotalCount();
      emitProgress({
        phase: "tunnel",
        completed: completedCount,
        total: totalCount,
      });
      for (const { candidate } of tunnelCandidates) {
        if (isCanceled()) break;
        if (
          !shouldAttemptTunnelCandidate({
            attempts,
            scored: scoredSlots,
            limit: effectiveSettings.tunnel.limit,
            budget: attemptBudget,
          })
        )
          break;
        // Past the first `limit` attempts every attempt is a promotion
        // into a slot an unscored candidate left empty — log it, so a
        // report with more tested rows than the limit is explainable.
        if (attempts >= effectiveSettings.tunnel.limit)
          logger.info("tunnel.backfill", {
            ip: candidate.ip,
            attempts,
            scored: scoredSlots,
          });
        totalCount = computeTotalCount();
        attempts += 1;
        const browsingResults = [],
          streamingResults = [],
          loadResults = [];
        // One Xray session per candidate serves every round: the rounds
        // are measurement repetitions, and a per-round restart paid a
        // fresh process startup — and its failure surface — for each
        // (Research ran 24 launches per run). A failed round stops the
        // session, so the next round starts a fresh one; a healthy
        // session is stopped once, after the final round.
        let xrayHandle = null;
        for (
          let round = 1;
          round <= effectiveSettings.tunnel.rounds;
          round += 1
        ) {
          if (isCanceled()) break;
          try {
            xrayHandle ??= await startXray({
              xrayPath: xrayLocation.path,
              vless,
              candidateIp: candidate.ip,
              startupTimeoutMs: effectiveSettings.tunnel.startupTimeoutMs,
              shutdownGraceMs: effectiveSettings.tunnel.shutdownGraceMs,
              logger,
            });
            emitProgress({
              phase: "tunnel",
              completed: completedCount,
              total: totalCount,
              note: `web transfer · ${candidate.ip}`,
              ip: candidate.ip,
            });
            for (const workload of browsingWorkloads) {
              const browsingResult = await probeBrowsing({
                workload,
                proxy: xrayHandle.socks,
                timeoutMs: effectiveSettings.browsing.timeoutMs,
                assetLimit: effectiveSettings.browsing.assetLimit,
                maxSockets: effectiveSettings.browsing.maxSockets,
                maxBytes: effectiveSettings.browsing.maxBytes,
                logger,
              });
              browsingResults.push(browsingResult);
              logger.info("browsing.probe", {
                ip: candidate.ip,
                round,
                workload: workload.name,
                score: browsingResult.score,
                successRate: browsingResult.successRate,
                bytes: browsingResult.bytes,
                error: browsingResult.error,
              });
              Number.isFinite(browsingResult.score) ||
                logger.warn("browsing.unscored", {
                  ip: candidate.ip,
                  workload: workload.name,
                  reason: browsingResult.error || "required metrics missing",
                });
            }
            emitProgress({
              phase: "tunnel",
              completed: completedCount,
              total: totalCount,
              note: `streaming · ${candidate.ip}`,
              ip: candidate.ip,
            });
            for (const workload of streamingWorkloads) {
              const streamingResult = await probeStreaming({
                workload,
                proxy: xrayHandle.socks,
                timeoutMs: effectiveSettings.streaming.timeoutMs,
                maxSegments: effectiveSettings.streaming.maxSegments,
                maxBytes: effectiveSettings.streaming.maxBytes,
                startupBufferSec: effectiveSettings.streaming.startupBufferSec,
                safetyFactor: effectiveSettings.streaming.safetyFactor,
                variantMode: effectiveSettings.streaming.variantMode,
                targetMbps: effectiveSettings.streaming.targetMbps,
                logger,
              });
              streamingResults.push(streamingResult);
              logger.info("streaming.probe", {
                ip: candidate.ip,
                round,
                workload: workload.name,
                score: streamingResult.score,
                successRate: streamingResult.successRate,
                segments: streamingResult.segments,
                bytes: streamingResult.bytes,
                quality: streamingResult.quality,
                error: streamingResult.error,
              });
              Number.isFinite(streamingResult.score) ||
                logger.warn("streaming.unscored", {
                  ip: candidate.ip,
                  workload: workload.name,
                  reason: streamingResult.error || "playback did not start",
                });
            }
            if (effectiveSettings.load?.enabled) {
              emitProgress({
                phase: "tunnel",
                completed: completedCount,
                total: totalCount,
                note: `real load · ${candidate.ip}`,
              ip: candidate.ip,
              });
              const loadResult = await runLoadProbe({
                proxy: xrayHandle.socks,
                endpoints: effectiveSettings.load.endpoints,
                durationMs: effectiveSettings.load.durationMs,
                chunkBytes: effectiveSettings.load.chunkBytes,
                maxDownloadBytes: effectiveSettings.load.maxDownloadBytes,
                flows: effectiveSettings.load.flows,
                uploadBytes: effectiveSettings.load.uploadBytes,
                uploadFlows: effectiveSettings.load.uploadFlows,
                fanoutRequests: effectiveSettings.load.fanoutRequests,
                control: Boolean(effectiveSettings.load.control?.enabled),
                controlBytes: effectiveSettings.load.control?.bytes,
                idleSamples: effectiveSettings.load.idleSamples,
                timeoutMs: effectiveSettings.load.timeoutMs,
              });
              loadResults.push(loadResult);
              logger.info("load.probe", {
                ip: candidate.ip,
                round,
                bytes:
                  (loadResult.downlink?.totalBytes || 0) +
                  (loadResult.uplink?.totalBytes || 0),
                flows: loadResult.downlink?.flows ?? null,
                sustainedMbps: loadResult.downlink?.sustainedMbps ?? null,
                perFlowMbps: loadResult.downlink?.perFlowMbps ?? null,
                shapingRatio: loadResult.downlink?.shapingRatio ?? null,
                loadedRttMs: loadResult.latency?.loadedRttMs ?? null,
                rttIncreaseMs: loadResult.latency?.rttIncreaseMs ?? null,
                rpm: loadResult.latency?.rpm ?? null,
                rttInflation: loadResult.latency?.rttInflation ?? null,
                uplinkMbps: loadResult.uplink?.sustainedMbps ?? null,
              });
              loadResult.ok
                ? (Number.isFinite(loadResult.uplink?.sustainedMbps) &&
                    Number.isFinite(loadResult.downlink?.shapingRatio)) ||
                  logger.debug("load.partial", {
                    ip: candidate.ip,
                    reason: [
                      Number.isFinite(loadResult.uplink?.sustainedMbps)
                        ? null
                        : "uplink not measured",
                      Number.isFinite(loadResult.downlink?.shapingRatio)
                        ? null
                        : "shaping not measured",
                    ]
                      .filter(Boolean)
                      .join(", "),
                  })
                : logger.warn("load.failed", {
                    ip: candidate.ip,
                    reason: "no successful downlink samples",
                  });
            }
          } catch (error) {
            logger.warn("tunnel.failed", {
              ip: candidate.ip,
              round,
              error: error.message,
            });
            // A session that failed a round is not reused: stop it and
            // let the next round start a fresh one.
            await xrayHandle?.stop();
            xrayHandle = null;
          }
          completedCount += 1;
          emitProgress({
            phase: "tunnel",
            completed: completedCount,
            total: totalCount,
            ip: candidate.ip,
          });
        }
        await xrayHandle?.stop();
        tunnelByIp.set(candidate.ip, {
          browsing: browsingResults,
          streaming: streamingResults,
          load: loadResults,
        });
        // Only a candidate that scored in some enabled stage fills its
        // slot; anything else leaves the slot open for the next pool
        // entry (bounded by the attempt budget in the loop header).
        if (
          hasScoredTunnelStage(
            tunnelByIp.get(candidate.ip),
            tunnelRequirements,
          )
        )
          scoredSlots += 1;
      }
    } else
      ((xrayStatus = { enabled: !1, path: null, reason: "xray_not_found" }),
        logger.warn("xray.missing", { searched: xrayLocation.searched }));
  }
  const eligibleIps = new Set(eligible.map((entry) => entry.candidate.ip)),
    summaries = candidates.map((candidate) => {
      const verificationObs = verificationByIp.get(candidate.ip),
        summary = buildCandidateSummary({
          ip: candidate.ip,
          range: candidate.range,
          eligibility:
            verificationObs || observationsByIp.get(candidate.ip) || [],
          tunnel: tunnelByIp.get(candidate.ip) || null,
          requirements: tunnelRequirements,
          gateOverrides: effectiveSettings.load?.gates,
          gateProfile: effectiveSettings.load?.gateProfile,
          temporalBlocks: verificationObs ? 2 : 1,
        });
      return (
        (summary.selection = {
          attempts: (observationsByIp.get(candidate.ip) || []).length,
          successRate: successRate(observationsByIp.get(candidate.ip) || []),
          independentlyVerified: Boolean(verificationObs),
          decision: decisionsByIp.get(candidate.ip) || "screened",
          eligibleForTunnel: eligibleIps.has(candidate.ip),
          tunnelTested: tunnelByIp.has(candidate.ip),
          tunnelReason: tunnelByIp.has(candidate.ip)
            ? null
            : eligibleIps.has(candidate.ip)
              ? effectiveSettings.tunnel.enabled
                ? xrayStatus.enabled
                  ? "outside-tunnel-limit"
                  : "xray_not_found" === xrayStatus.reason
                    ? "xray-not-found"
                    : "tunnel-disabled"
                : "tunnel-disabled"
              : "not-eligible",
        }),
        summary
      );
    }),
    written = writeReport({
      directory: layout.results,
      runId,
      target,
      settings: {
        ...effectiveSettings,
        tunnel: {
          ...effectiveSettings.tunnel,
          xray: xrayStatus.reason || "ok",
        },
      },
      candidates: summaries,
      startedAt,
    });
  return (
    logger.info("scan.complete", {
      runId,
      candidates: summaries.length,
      eligible: eligible.length,
      independentlyVerified: verificationByIp.size,
      tunnelTested: tunnelByIp.size,
      complete: written.report.totals.complete,
      partial: written.report.totals.partial,
      unmeasured: written.report.totals.unmeasured,
      samplingSeed: seed,
      report: written.jsonPath,
      bytesMeasured: written.report.totals.bytesMeasured,
      canceled: isCanceled(),
    }),
    {
      ...written,
      xray: xrayStatus,
      eligibleCount: eligible.length,
      candidateCount: candidates.length,
      rangeCount: ranges.length,
      samplingSeed: seed,
      runId,
      // Same vocabulary as the Hard path's return, so callers (the
      // web run manager today, lifecycle records at the entry points)
      // read one shape from both engines.
      canceled: isCanceled(),
      stoppedReason: isCanceled() ? "canceled" : "completed",
    }
  );
}
