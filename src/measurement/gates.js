export const GATE_DEFINITIONS = [
  {
    name: "sustainedMbps",
    label: "Sustained downlink",
    unit: "Mbps",
    direction: "higher",
    warn: 8,
    fail: 2,
    reason: "not enough sustained bandwidth for video or heavy pages",
  },
  {
    name: "shapingRatio",
    label: "Late/early throughput",
    unit: "ratio",
    direction: "higher",
    warn: 0.7,
    fail: 0.4,
    reason: "throughput collapses after the first seconds (traffic shaping)",
  },
  {
    name: "rpm",
    label: "Responsiveness under load",
    unit: "rpm",
    direction: "higher",
    warn: 300,
    fail: 100,
    reason: "too few round trips per minute under load, so pages crawl",
  },
  {
    name: "rttIncreaseMs",
    label: "Added delay under load",
    unit: "ms",
    direction: "lower",
    warn: 120,
    fail: 400,
    reason: "the path adds a lot of delay as soon as it is busy (bufferbloat)",
  },
  {
    name: "rttInflation",
    label: "RTT inflation under load",
    unit: "x",
    direction: "lower",
    warn: 2,
    fail: 4,
    reason: "latency multiplies as soon as traffic starts",
  },
  {
    name: "jitterMs",
    label: "Jitter (p95 - p50)",
    unit: "ms",
    direction: "lower",
    warn: 80,
    fail: 250,
    reason: "latency is unstable, so interactive traffic stalls",
  },
  {
    name: "lossRate",
    label: "Request loss under load",
    unit: "ratio",
    direction: "lower",
    warn: 0.02,
    fail: 0.08,
    reason: "requests are dropped while the link is busy",
  },
  {
    name: "fanoutSuccess",
    label: "Parallel request success",
    unit: "ratio",
    direction: "higher",
    warn: 0.98,
    fail: 0.9,
    reason: "parallel requests fail, which is what a real page load does",
  },
  {
    name: "freshConnectionMs",
    label: "Fresh connection setup p90",
    unit: "ms",
    direction: "lower",
    warn: 1200,
    fail: 3e3,
    reason: "opening new connections is too slow, so pages feel dead",
  },
  {
    name: "uplinkMbps",
    label: "Sustained uplink",
    unit: "Mbps",
    direction: "higher",
    warn: 1,
    fail: 0.25,
    reason: "uplink is too weak to carry requests and handshakes",
  },
];
export const GATE_PROFILES = {
  balanced: {},
  strict: {
    sustainedMbps: { warn: 20, fail: 6 },
    rpm: { warn: 600, fail: 200 },
    rttIncreaseMs: { warn: 60, fail: 200 },
    rttInflation: { warn: 1.5, fail: 2.5 },
    jitterMs: { warn: 50, fail: 120 },
    freshConnectionMs: { warn: 700, fail: 1800 },
    uplinkMbps: { warn: 3, fail: 1 },
  },
  tolerant: {
    sustainedMbps: { warn: 4, fail: 1 },
    shapingRatio: { warn: 0.55, fail: 0.3 },
    rpm: { warn: 150, fail: 60 },
    rttIncreaseMs: { warn: 250, fail: 800 },
    rttInflation: { warn: 3, fail: 6 },
    jitterMs: { warn: 150, fail: 400 },
    fanoutSuccess: { warn: 0.9, fail: 0.75 },
    freshConnectionMs: { warn: 2e3, fail: 5e3 },
    uplinkMbps: { warn: 0.5, fail: 0.1 },
  },
};
export const DEFAULT_GATE_PROFILE = "balanced";
export function resolveGateOverrides(
  profileName = "balanced",
  customOverrides = {},
) {
  const profile = GATE_PROFILES[profileName] || GATE_PROFILES.balanced,
    resolved = {};
  for (const definition of GATE_DEFINITIONS) {
    const merged = {
      ...(profile[definition.name] || {}),
      ...((customOverrides && customOverrides[definition.name]) || {}),
    };
    if (Object.keys(merged).length > 0) resolved[definition.name] = merged;
  }
  return resolved;
}
export const SCORE_CAPS = { pass: 100, warn: 75, fail: 45 };
// Rank used to pick the worst of several gate statuses.
const STATUS_SEVERITY = { pass: 0, unknown: 1, warn: 2, fail: 3 };
function resolveThresholds(definition, overrides) {
  const override = (overrides && overrides[definition.name]) || {};
  return {
    warn: "number" == typeof override.warn ? override.warn : definition.warn,
    fail: "number" == typeof override.fail ? override.fail : definition.fail,
  };
}
function classifyValue(definition, value, thresholds) {
  if (!("number" == typeof value && Number.isFinite(value))) return "unknown";
  if ("higher" === definition.direction)
    return value < thresholds.fail
      ? "fail"
      : value < thresholds.warn
        ? "warn"
        : "pass";
  return value > thresholds.fail
    ? "fail"
    : value > thresholds.warn
      ? "warn"
      : "pass";
}
// How far past the breached threshold the value sits, relative to that
// threshold; -1 for unknown, 0 for pass. Used to rank the limiting gate.
function computeSeverity(definition, value, thresholds, status) {
  if ("unknown" === status) return -1;
  if ("pass" === status || !Number.isFinite(value)) return 0;
  const threshold = "fail" === status ? thresholds.fail : thresholds.warn,
    scale = Math.max(Math.abs(threshold), Number.EPSILON);
  return (
    ("higher" === definition.direction
      ? Math.max(0, threshold - value)
      : Math.max(0, value - threshold)) / scale
  );
}
export function evaluateGates(metrics = {}, options = {}) {
  const { overrides, profile, requireAll = true } = options,
    effectiveOverrides = profile
      ? resolveGateOverrides(profile, overrides)
      : overrides,
    checks = [],
    failures = [],
    warnings = [],
    missing = [],
    reasons = [];
  for (const definition of GATE_DEFINITIONS) {
    const thresholds = resolveThresholds(definition, effectiveOverrides),
      rawValue = metrics[definition.name],
      value =
        "number" == typeof rawValue && Number.isFinite(rawValue)
          ? rawValue
          : null,
      status = classifyValue(definition, value, thresholds);
    checks.push({
      name: definition.name,
      label: definition.label,
      unit: definition.unit,
      direction: definition.direction,
      value,
      warn: thresholds.warn,
      fail: thresholds.fail,
      status,
      severity: computeSeverity(definition, value, thresholds, status),
    });
    if ("fail" === status) {
      failures.push(definition.name);
      reasons.push(definition.reason);
    } else if ("warn" === status) warnings.push(definition.name);
    else if ("unknown" === status) missing.push(definition.name);
  }
  let overallStatus = "pass";
  if (failures.length > 0) overallStatus = "fail";
  else if (warnings.length > 0) overallStatus = "warn";
  else if (missing.length > 0) overallStatus = requireAll ? "unknown" : "pass";
  const scoreCap =
      "unknown" === overallStatus
        ? SCORE_CAPS.warn
        : SCORE_CAPS[overallStatus],
    limitingCheck = checks
      .filter((check) => "pass" !== check.status)
      .sort(
        (a, b) =>
          STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status] ||
          b.severity - a.severity,
      )[0];
  return {
    status: overallStatus,
    scoreCap,
    profile: profile || "balanced",
    checks,
    failures,
    warnings,
    missing,
    reasons,
    limiting: limitingCheck?.name || null,
  };
}
export function capScore(score, gateResult) {
  if ("number" != typeof score || !Number.isFinite(score)) return null;
  const cap = (gateResult && gateResult.scoreCap) || SCORE_CAPS.pass;
  return Math.min(score, cap);
}
export function buildVerdict({
  gateResult,
  cappedScore,
  streamingScore,
  confidence,
} = {}) {
  const gateStatus = (gateResult && gateResult.status) || "unknown";
  if ("fail" === gateStatus)
    return {
      label: "unusable",
      summary: "Fails at least one absolute quality gate.",
      limiting: (gateResult && gateResult.limiting) || null,
      reasons: (gateResult && gateResult.reasons) || [],
    };
  if ("unknown" === gateStatus)
    return {
      label: "unverified",
      summary: "Some load stages were not measured, so the score is provisional.",
      limiting: (gateResult && gateResult.limiting) || null,
      reasons: ((gateResult && gateResult.missing) || []).map(
        (name) => `${name} was not measured`,
      ),
    };
  // A passing/warning gate result still caps the verdict when streaming is weak.
  const weakStreaming = "number" == typeof streamingScore && streamingScore < 70;
  if ("warn" === gateStatus || weakStreaming)
    return {
      label: weakStreaming ? "browsing-only" : "usable",
      summary: weakStreaming
        ? "Acceptable for pages, not reliable for video."
        : "Usable, but at least one metric is close to its limit.",
      limiting: (gateResult && gateResult.limiting) || null,
      reasons: (gateResult && gateResult.warnings) || [],
    };
  const trusted = "medium" === confidence || "high" === confidence;
  return {
    label:
      "number" == typeof cappedScore && cappedScore >= 80 && trusted
        ? "recommended"
        : "good",
    summary: trusted
      ? "Passes every absolute gate with a stable measurement."
      : "Passes every absolute gate, but needs more samples to be trusted.",
    limiting: null,
    reasons: [],
  };
}
export function worstStatus(statuses = []) {
  return statuses.reduce(
    (worst, status) =>
      (STATUS_SEVERITY[status] || 0) > (STATUS_SEVERITY[worst] || 0)
        ? status
        : worst,
    "pass",
  );
}
