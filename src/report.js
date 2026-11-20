import fs from "node:fs";
import path from "node:path";
import {
  median,
  percentile,
  mad,
  weightedScore,
  scoreHigherBetter,
  scoreLowerBetter,
  round,
} from "./stats.js";
import {
  wilsonInterval,
  confidenceLabel,
  summarizePops,
} from "./measurement/confidence.js";
import { summarizeProbeErrors } from "./probe/errors.js";
import {
  evaluateGates,
  capScore,
  buildVerdict,
  GATE_DEFINITIONS,
} from "./measurement/gates.js";
import { VERSION } from "./version.js";
export const REPORT_SCHEMA = 10;
// The report's version stamp is the single-sourced application version
// (src/version.js ← package.json), never a literal: a hand-maintained
// copy here is exactly how report versions drift from the release.
export const GENERATOR_VERSION = VERSION;
export const VERDICT_RANK = {
  recommended: 0,
  good: 1,
  usable: 2,
  "browsing-only": 3,
  unverified: 4,
  unusable: 5,
};
const gateLabels = new Map(
  GATE_DEFINITIONS.map((definition) => [definition.name, definition.label]),
);
export function buildEligibilitySummary({
  ip,
  range,
  eligibility,
  temporalBlocks = 1,
  block = null,
}) {
  const successful = eligibility.filter((observation) => observation.ok),
    attempts = eligibility.length,
    successes = successful.length,
    summary = {
    ip,
    range,
    eligibility: {
      attempts,
      successes,
      successRate: round(attempts ? successes / attempts : 0, 3),
      confidence95: wilsonInterval(successes, attempts),
      confidence: confidenceLabel({ attempts, successes, temporalBlocks }),
      handshakeMedianMs: round(
        median(successful.map((observation) => observation.handshakeMs)),
        2,
      ),
      handshakeP90Ms: round(
        percentile(
          successful.map((observation) => observation.handshakeMs),
          90,
        ),
        2,
      ),
      handshakeMadMs: round(
        mad(successful.map((observation) => observation.handshakeMs)),
        2,
      ),
      connectMedianMs: round(
        median(successful.map((observation) => observation.connectMs)),
        2,
      ),
      pops: summarizePops(successful),
      errors: summarizeProbeErrors(eligibility),
    },
  };
  // Block-adaptive runs tag the summary with its catalog block so the
  // report can attribute candidates to blocks. Callers that pass no block
  // (every legacy path) get the exact pre-redesign shape back — the key
  // is only ever added, never defaulted.
  if (block) summary.block = block;
  return summary;
}
function medianOf(values, pick) {
  return median(values.map(pick).filter(Number.isFinite));
}
export function summarizeLoad(results) {
  const okResults = (results || []).filter((result) => result?.ok);
  if (!okResults.length) return null;
  const latencySamples = okResults.reduce(
    (acc, result) => {
      const samples = result.latency?.samples || {};
      acc.idle += Number(samples.idle) || 0;
      acc.loaded += Number(samples.loaded) || 0;
      acc.attempts += Number(samples.attempts) || 0;
      acc.failures += Number(samples.failures) || 0;
      return acc;
    },
    { idle: 0, loaded: 0, attempts: 0, failures: 0 },
  );
  return {
    observations: okResults.length,
    bytes: okResults.reduce(
      (sum, result) =>
        sum +
        (result.downlink?.totalBytes || 0) +
        (result.uplink?.totalBytes || 0),
      0,
    ),
    flows:
      okResults.find((result) => result.downlink?.flows)?.downlink?.flows ??
      null,
    sustainedMbps: round(
      medianOf(okResults, (result) => result.downlink?.sustainedMbps),
      2,
    ),
    perFlowMbps: round(
      medianOf(okResults, (result) => result.downlink?.perFlowMbps),
      2,
    ),
    peakMbps: round(
      medianOf(okResults, (result) => result.downlink?.peakMbps),
      2,
    ),
    earlyMbps: round(
      medianOf(okResults, (result) => result.downlink?.earlyMbps),
      2,
    ),
    lateMbps: round(
      medianOf(okResults, (result) => result.downlink?.lateMbps),
      2,
    ),
    shapingRatio: round(
      medianOf(okResults, (result) => result.downlink?.shapingRatio),
      3,
    ),
    idleRttMs: round(
      medianOf(okResults, (result) => result.latency?.idleRttMs),
      2,
    ),
    loadedRttMs: round(
      medianOf(okResults, (result) => result.latency?.loadedRttMs),
      2,
    ),
    rttIncreaseMs: round(
      medianOf(okResults, (result) => result.latency?.rttIncreaseMs),
      2,
    ),
    rttInflation: round(
      medianOf(okResults, (result) => result.latency?.rttInflation),
      2,
    ),
    rpm: round(
      medianOf(okResults, (result) => result.latency?.rpm),
      1,
    ),
    idleRpm: round(
      medianOf(okResults, (result) => result.latency?.idleRpm),
      1,
    ),
    jitterMs: round(
      medianOf(okResults, (result) => result.latency?.jitterMs),
      2,
    ),
    lossRate: round(
      medianOf(okResults, (result) => result.latency?.lossRate),
      4,
    ),
    fanoutSuccess: round(
      medianOf(okResults, (result) => result.fanout?.fanoutSuccess),
      4,
    ),
    freshConnectionMs: round(
      medianOf(okResults, (result) => result.fanout?.freshConnectionMs),
      2,
    ),
    uplinkMbps: round(
      medianOf(okResults, (result) => result.uplink?.sustainedMbps),
      2,
    ),
    latencySamples,
    controlMbps: round(
      medianOf(okResults, (result) => result.control?.controlMbps),
      2,
    ),
    edgeShare: round(
      medianOf(okResults, (result) => result.control?.edgeShare),
      3,
    ),
    bottleneck:
      okResults.find((result) => result.control?.bottleneck)?.control
        ?.bottleneck || null,
  };
}
export function scoreLoad(summary) {
  return summary
    ? weightedScore(
        [
          {
            score: scoreHigherBetter(summary.sustainedMbps, 25, 1),
            weight: 25,
          },
          {
            score: scoreHigherBetter(summary.shapingRatio, 0.95, 0.3),
            weight: 15,
          },
          { score: scoreHigherBetter(summary.rpm, 900, 60), weight: 20 },
          {
            score: scoreLowerBetter(summary.rttIncreaseMs, 30, 600),
            weight: 5,
          },
          { score: scoreLowerBetter(summary.jitterMs, 20, 250), weight: 8 },
          { score: scoreLowerBetter(summary.lossRate, 0, 0.1), weight: 7 },
          {
            score: scoreLowerBetter(summary.freshConnectionMs, 250, 3e3),
            weight: 10,
          },
          {
            score: scoreHigherBetter(summary.fanoutSuccess, 1, 0.7),
            weight: 5,
          },
          { score: scoreHigherBetter(summary.uplinkMbps, 5, 0.2), weight: 5 },
        ],
        { requireAll: !1 },
      )
    : null;
}
export function limitingFactor(gateResult) {
  if (!gateResult?.limiting) return null;
  const check = (gateResult.checks || []).find(
      (entry) => entry.name === gateResult.limiting,
    ),
    label = gateLabels.get(gateResult.limiting) || gateResult.limiting;
  return check
    ? `${label}: ${null === check.value ? "not measured" : `${check.value}${"ratio" === check.unit || "x" === check.unit ? "" : ` ${check.unit}`}`}`
    : label;
}
export function gateIssues(gateResult) {
  if (!gateResult?.checks) return [];
  const statusRank = { fail: 3, warn: 2, unknown: 1, pass: 0 };
  return gateResult.checks
    .filter((check) => "pass" !== check.status)
    .map((check) => ({
      name: check.name,
      label: check.label,
      status: check.status,
      value: check.value,
      unit: check.unit,
      direction: check.direction,
      warn: check.warn,
      fail: check.fail,
      severity: check.severity,
    }))
    .sort(
      (left, right) =>
        statusRank[right.status] - statusRank[left.status] ||
        (right.severity || 0) - (left.severity || 0),
    );
}
function computeQoeConfidence({
  measurementStatus,
  loadRequired,
  load,
  gates,
}) {
  if ("unmeasured" === measurementStatus) return "none";
  const checks = gates?.checks || [],
    knownCount = checks.filter((check) => "unknown" !== check.status).length,
    coverage = checks.length ? knownCount / checks.length : null;
  return "complete" !== measurementStatus || (loadRequired && coverage < 1)
    ? "low"
    : (load?.observations || 0) >= 3
      ? "medium"
      : "provisional";
}
export function applyTunnelResults(
  summary,
  tunnel,
  requirements = { browsing: !0, streaming: !0, load: !1 },
  gateOptions = {},
) {
  const browsingScores = (tunnel?.browsing || [])
      .map((result) => result.score)
      .filter(Number.isFinite),
    streamingScores = (tunnel?.streaming || [])
      .map((result) => result.score)
      .filter(Number.isFinite),
    browsingScore = browsingScores.length
      ? round(median(browsingScores), 1)
      : null,
    streamingScore = streamingScores.length
      ? round(median(streamingScores), 1)
      : null,
    loadSummary = summarizeLoad(tunnel?.load || []),
    loadScore = scoreLoad(loadSummary),
    loadRequired = Boolean(requirements.load),
    components = loadRequired
      ? [
          {
            name: "browsing",
            score: null === browsingScore ? null : browsingScore / 100,
            weight: requirements.browsing ? 30 : 0,
          },
          {
            name: "streaming",
            score: null === streamingScore ? null : streamingScore / 100,
            weight: requirements.streaming ? 30 : 0,
          },
          {
            name: "load",
            score: null === loadScore ? null : loadScore / 100,
            weight: 25,
          },
          {
            name: "reliability",
            score: summary.eligibility.successRate,
            weight: 15,
          },
        ]
      : [
          {
            name: "browsing",
            score: null === browsingScore ? null : browsingScore / 100,
            weight: requirements.browsing ? 45 : 0,
          },
          {
            name: "streaming",
            score: null === streamingScore ? null : streamingScore / 100,
            weight: requirements.streaming ? 40 : 0,
          },
          {
            name: "reliability",
            score: summary.eligibility.successRate,
            weight: 15,
          },
        ],
    activeComponents = components.filter((component) => component.weight > 0),
    scoredComponents = activeComponents.filter((component) =>
      Number.isFinite(component.score),
    ),
    allScored =
      activeComponents.length > 0 &&
      scoredComponents.length === activeComponents.length,
    hasMeasuredComponent = scoredComponents.some(
      (component) => "reliability" !== component.name,
    ),
    overallUncapped = hasMeasuredComponent
      ? weightedScore(components, { requireAll: allScored })
      : null,
    conservativeUncapped =
      null === overallUncapped
        ? null
        : weightedScore(
            components.map((component) =>
              "reliability" === component.name
                ? {
                    ...component,
                    score: summary.eligibility.confidence95.lower,
                  }
                : component,
            ),
            { requireAll: allScored },
          ),
    gateResult =
      loadRequired && loadSummary
        ? evaluateGates(
            // Extract only the metrics the gate definitions consume.
            ((load) =>
              load
                ? {
                    sustainedMbps: load.sustainedMbps,
                    shapingRatio: load.shapingRatio,
                    rpm: load.rpm,
                    rttIncreaseMs: load.rttIncreaseMs,
                    rttInflation: load.rttInflation,
                    jitterMs: load.jitterMs,
                    lossRate: load.lossRate,
                    fanoutSuccess: load.fanoutSuccess,
                    freshConnectionMs: load.freshConnectionMs,
                    uplinkMbps: load.uplinkMbps,
                  }
                : {})(loadSummary),
            {
              overrides: gateOptions.gateOverrides,
              profile: gateOptions.gateProfile,
            },
          )
        : null,
    gatedOverall = gateResult
      ? capScore(overallUncapped, gateResult)
      : overallUncapped,
    gatedConservative = gateResult
      ? capScore(conservativeUncapped, gateResult)
      : conservativeUncapped,
    overall =
      !allScored && Number.isFinite(gatedOverall)
        ? Math.min(gatedOverall, 70)
        : gatedOverall,
    conservative =
      !allScored && Number.isFinite(gatedConservative)
        ? Math.min(gatedConservative, 70)
        : gatedConservative;
  let verdict = gateResult
    ? buildVerdict({
        gateResult,
        cappedScore: conservative,
        streamingScore,
        confidence: summary.eligibility.confidence,
      })
    : null;
  loadRequired &&
    !loadSummary &&
    (verdict = {
      label: "unverified",
      summary: hasMeasuredComponent
        ? "Tunnel workloads were only partially measured; real-load evidence is missing."
        : "Eligibility evidence only; this candidate was not measured through the tunnel.",
      limiting: null,
      reasons: hasMeasuredComponent ? ["load was not scored"] : [],
    });
  const browsingRuns = tunnel?.browsing || [],
    browsingSummary = browsingRuns.length
      ? {
          metric: "web-transfer",
          observations: browsingRuns.length,
          coldMedianMs: round(
            median(browsingRuns.map((result) => result.coldMs)),
            2,
          ),
          warmMedianMs: round(
            median(browsingRuns.map((result) => result.warmMs)),
            2,
          ),
          ttfbP90Ms: round(
            median(browsingRuns.map((result) => result.ttfbP90Ms)),
            2,
          ),
          successRate: round(
            median(browsingRuns.map((result) => result.successRate)),
            3,
          ),
          scoredObservations: browsingRuns.filter((result) =>
            Number.isFinite(result.score),
          ).length,
          errors: browsingRuns
            .filter((result) => result.error)
            .map((result) => ({
              workload: result.workload,
              error: result.error,
            })),
          bytes: browsingRuns.reduce(
            (sum, result) => sum + (result.bytes || 0),
            0,
          ),
        }
      : null,
    streamingSummary = ((runs) =>
      runs.length
        ? {
            observations: runs.length,
            sustainableMbps: round(
              median(runs.map((result) => result.sustainableMbps)),
              3,
            ),
            estimator:
              runs.find((result) => result.estimator)?.estimator || null,
            sampleCount: runs.reduce(
              (sum, result) =>
                sum + (result.sampleCount || result.segments || 0),
              0,
            ),
            quality: runs.find((result) => result.quality)?.quality || null,
            ladderMaxMbps:
              runs.find((result) => Number.isFinite(result.ladderMaxMbps))
                ?.ladderMaxMbps ?? null,
            ladderLimited: runs.some((result) => result.ladderLimited),
            startupDelaySec: round(
              median(runs.map((result) => result.startupDelaySec)),
              3,
            ),
            rebufferRatio: round(
              median(runs.map((result) => result.rebufferRatio)),
              4,
            ),
            scoredObservations: runs.filter((result) =>
              Number.isFinite(result.score),
            ).length,
            errors: runs
              .filter((result) => result.error)
              .map((result) => ({
                workload: result.workload,
                error: result.error,
              })),
            bytes: runs.reduce((sum, result) => sum + (result.bytes || 0), 0),
          }
        : null)(tunnel?.streaming || []);
  const measurementStatus = allScored
      ? "complete"
      : hasMeasuredComponent
        ? "partial"
        : "unmeasured",
    gateChecks = gateResult?.checks || [],
    knownChecks = gateChecks.filter(
      (check) => "unknown" !== check.status,
    ).length,
    gateCoverage = gateChecks.length
      ? round(knownChecks / gateChecks.length, 3)
      : null;
  return {
    ...summary,
    browsing: browsingSummary,
    streaming: streamingSummary,
    load: loadSummary,
    gates: gateResult,
    gateIssues: gateIssues(gateResult),
    verdict:
      "unmeasured" === measurementStatus ||
      allScored ||
      "unusable" === verdict?.label
        ? verdict
        : {
            label: "unverified",
            summary:
              "Measured partially; one or more required workloads did not produce a score.",
            limiting: verdict?.limiting || null,
            reasons: activeComponents
              .filter((component) => !Number.isFinite(component.score))
              .map((component) => `${component.name} was not scored`),
          },
    limitingFactor: limitingFactor(gateResult),
    measurement: {
      status: measurementStatus,
      completeness: round(
        activeComponents.length
          ? scoredComponents.length / activeComponents.length
          : 0,
        3,
      ),
      missingComponents: activeComponents
        .filter((component) => !Number.isFinite(component.score))
        .map((component) => component.name),
      bytesMeasured:
        (loadSummary?.bytes || 0) +
        (browsingSummary?.bytes || 0) +
        (streamingSummary?.bytes || 0),
      gateCoverage,
      qoeConfidence: computeQoeConfidence({
        measurementStatus,
        loadRequired,
        load: loadSummary,
        gates: gateResult,
      }),
      experimental: !0,
    },
    scores: {
      browsing: browsingScore,
      streaming: streamingScore,
      load: loadScore,
      reliability: round(100 * summary.eligibility.successRate, 1),
      reliabilityLower95: round(
        100 * summary.eligibility.confidence95.lower,
        1,
      ),
      overall,
      conservative,
      overallUncapped,
      conservativeUncapped,
    },
  };
}
// The tunnel backfill policy's verdict (Probe P-3): did this candidate
// produce a score in at least one ENABLED stage? Defined here, from the
// same primitives applyTunnelResults scores with — a finite browsing or
// streaming observation score, a finite load score — so the pipelines'
// notion of "scored" can never drift from the report's own. A stage that
// is disabled cannot score and does not count; when no stage is enabled
// there is nothing to score, so the candidate counts as scored and the
// caller must not spend backfill attempts on it.
export function hasScoredTunnelStage(tunnel, requirements = {}) {
  const browsing = Boolean(requirements.browsing),
    streaming = Boolean(requirements.streaming),
    load = Boolean(requirements.load);
  if (!browsing && !streaming && !load) return true;
  if (
    browsing &&
    (tunnel?.browsing || []).some((result) => Number.isFinite(result?.score))
  )
    return true;
  if (
    streaming &&
    (tunnel?.streaming || []).some((result) => Number.isFinite(result?.score))
  )
    return true;
  if (load && Number.isFinite(scoreLoad(summarizeLoad(tunnel?.load || []))))
    return true;
  return false;
}
export function buildCandidateSummary({
  ip,
  range,
  eligibility,
  tunnel,
  requirements,
  temporalBlocks,
  gateOverrides,
  gateProfile,
}) {
  return applyTunnelResults(
    buildEligibilitySummary({ ip, range, eligibility, temporalBlocks }),
    tunnel,
    requirements,
    { gateOverrides, gateProfile },
  );
}
export function rankCandidates(candidates) {
  return candidates.slice().sort((left, right) => {
    const statusRank = {
        complete: 0,
        partial: 1,
        incomplete: 2,
        unmeasured: 2,
      },
      leftStatus = statusRank[left.measurement.status] ?? 3,
      rightStatus = statusRank[right.measurement.status] ?? 3;
    if (leftStatus !== rightStatus) return leftStatus - rightStatus;
    if (
      (right.measurement.completeness ?? 0) !==
      (left.measurement.completeness ?? 0)
    )
      return (
        (right.measurement.completeness ?? 0) -
        (left.measurement.completeness ?? 0)
      );
    const leftVerdict = VERDICT_RANK[left.verdict?.label] ?? 4,
      rightVerdict = VERDICT_RANK[right.verdict?.label] ?? 4;
    return leftVerdict !== rightVerdict
      ? leftVerdict - rightVerdict
      : (right.scores.conservative ?? -1) !== (left.scores.conservative ?? -1)
        ? (right.scores.conservative ?? -1) - (left.scores.conservative ?? -1)
        : (right.scores.conservativeUncapped ?? -1) !==
            (left.scores.conservativeUncapped ?? -1)
          ? (right.scores.conservativeUncapped ?? -1) -
            (left.scores.conservativeUncapped ?? -1)
          : (right.scores.overallUncapped ?? -1) !==
              (left.scores.overallUncapped ?? -1)
            ? (right.scores.overallUncapped ?? -1) -
              (left.scores.overallUncapped ?? -1)
            : (right.load?.sustainedMbps ?? -1) !==
                (left.load?.sustainedMbps ?? -1)
              ? (right.load?.sustainedMbps ?? -1) -
                (left.load?.sustainedMbps ?? -1)
              : (right.load?.rpm ?? -1) - (left.load?.rpm ?? -1) ||
                (left.eligibility.handshakeMedianMs ?? 1 / 0) -
                  (right.eligibility.handshakeMedianMs ?? 1 / 0);
  });
}
export function writeReport({
  directory,
  runId,
  target,
  settings,
  candidates,
  startedAt,
}) {
  fs.mkdirSync(directory, { recursive: !0 });
  const ranked = rankCandidates(candidates),
    report = {
      schema: REPORT_SCHEMA,
      generator: "cfqoe-scanner",
      version: GENERATOR_VERSION,
      scoreLabel: "Experimental CFQoE Score",
      scope: "run-relative",
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      target,
      settings,
      totals: {
        candidates: ranked.length,
        eligible: ranked.filter(
          (candidate) => candidate.eligibility.successRate > 0,
        ).length,
        complete: ranked.filter(
          (candidate) => "complete" === candidate.measurement.status,
        ).length,
        partial: ranked.filter(
          (candidate) => "partial" === candidate.measurement.status,
        ).length,
        unmeasured: ranked.filter(
          (candidate) => "unmeasured" === candidate.measurement.status,
        ).length,
        highConfidence: ranked.filter(
          (candidate) => "high" === candidate.eligibility.confidence,
        ).length,
        gatePassed: ranked.filter(
          (candidate) => "pass" === candidate.gates?.status,
        ).length,
        gateFailed: ranked.filter(
          (candidate) => "fail" === candidate.gates?.status,
        ).length,
        recommended: ranked.filter(
          (candidate) => "recommended" === candidate.verdict?.label,
        ).length,
        bytesMeasured: ranked.reduce(
          (sum, candidate) => sum + (candidate.measurement?.bytesMeasured || 0),
          0,
        ),
        limitingFactors: countLimitingFactors(ranked),
      },
      results: ranked,
    },
    jsonPath = path.join(directory, `run-${runId}.json`),
    latestPath = path.join(directory, "latest.json"),
    topPath = path.join(directory, "best-ips.txt");
  for (const filePath of [jsonPath, latestPath])
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 384,
    });
  return (
    fs.writeFileSync(topPath, `${renderTopList(ranked)}\n`, { mode: 384 }),
    { jsonPath, latestPath, topPath, report }
  );
}
export function countLimitingFactors(candidates) {
  const counts = {};
  for (const candidate of candidates) {
    if (!["complete", "partial"].includes(candidate.measurement?.status))
      continue;
    const limiting = candidate.gates?.limiting;
    limiting && (counts[limiting] = (counts[limiting] || 0) + 1);
  }
  return counts;
}
export function renderTopList(candidates, limit = 20) {
  return [
    [
      "IP",
      "Verdict",
      "Conservative",
      "RawConservative",
      "Overall",
      "RawOverall",
      "Mbps",
      "RPM",
      "Shaping",
      "AddedRTT",
      "Successes",
      "Attempts",
      "Lower95",
      "EligibilityConfidence",
      "QoEConfidence",
      "POP",
      "Gate",
      "Why",
    ].join("\t"),
    ...candidates
      .slice(0, limit)
      .map((candidate) =>
        [
          candidate.ip,
          candidate.verdict?.label || candidate.measurement.status,
          candidate.scores.conservative ?? "-",
          candidate.scores.conservativeUncapped ?? "-",
          candidate.scores.overall ?? "-",
          candidate.scores.overallUncapped ?? "-",
          candidate.load?.sustainedMbps ?? "-",
          candidate.load?.rpm ?? "-",
          candidate.load?.shapingRatio ?? "-",
          candidate.load?.rttIncreaseMs ?? "-",
          candidate.eligibility.successes ?? "-",
          candidate.eligibility.attempts ?? "-",
          candidate.scores.reliabilityLower95 ?? "-",
          candidate.eligibility.confidence || "-",
          candidate.measurement?.qoeConfidence || "-",
          candidate.eligibility.pops.dominant || "-",
          candidate.gates?.status || "-",
          candidate.gates?.limiting || candidate.selection?.tunnelReason || "-",
        ].join("\t"),
      ),
  ].join("\n");
}
