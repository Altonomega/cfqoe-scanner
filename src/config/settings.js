import fs from "node:fs";
import path from "node:path";
export const SETTINGS_VERSION = 7;
// Bytes in one mebibyte; most byte budgets below are expressed in MiB.
const MIB = 1048576;
export function createDefaultSettings(platform = process.platform) {
  const isAndroid = "android" === platform,
    concurrency = isAndroid ? 6 : 12;
  return {
    version: 7,
    scan: {
      perRange: 3,
      maxCandidates: 120,
      rounds: 3,
      concurrency,
      timeoutMs: 6e3,
      minimumSuccessRate: 0.6,
      // The seed governs only the block-adaptive Hard engine's sampling.
      // runScan ignores it: Full/Quick/Research draw a fresh random seed
      // per run and record the used seed in the report instead.
      seed: 404,
      delayedRetry: { enabled: true, maxCandidates: isAndroid ? 30 : 60 },
    },
    verification: {
      enabled: true,
      limit: isAndroid ? 12 : 20,
      sprt: {
        p0: 0.6,
        p1: 0.9,
        alpha: 0.05,
        beta: 0.1,
        minRounds: 2,
        maxRounds: 16,
      },
    },
    calibration: {
      enabled: true,
      levels: isAndroid ? [1, 2, 4, 6] : [1, 2, 4, 8, 12, 16],
      latencyInflationLimit: 0.1,
      // At level L the control is probed L times, so one failure moves
      // the failure rate by 1/L — at least 6.25% at every level. A 0.02
      // limit was finer than that granularity: a single dropped control
      // handshake vetoed every level and pinned the scan to concurrency
      // 1. At 0.10 one failure at the top levels (8.3% at 12) no longer
      // vetoes; two (16.7%) still do.
      failureRateIncreaseLimit: 0.1,
      eventLoopLagLimitMs: isAndroid ? 80 : 50,
    },
    tunnel: {
      enabled: true,
      xrayPath: "auto",
      limit: 5,
      rounds: 1,
      startupTimeoutMs: 8e3,
      shutdownGraceMs: 1500,
    },
    browsing: {
      enabled: true,
      workloads: isAndroid
        ? ["cloudflare-docs"]
        : ["cloudflare-docs", "cdnjs"],
      assetLimit: isAndroid ? 8 : 10,
      timeoutMs: 2e4,
      maxSockets: 1,
      maxBytes: isAndroid ? 3 * MIB : 5 * MIB,
      estimatedMaxBytes: isAndroid ? 3 * MIB : 5 * MIB,
    },
    streaming: {
      enabled: true,
      workloads: ["apple-advanced-hevc"],
      maxSegments: isAndroid ? 3 : 4,
      quickSegments: 2,
      researchSegments: 6,
      maxBytes: isAndroid ? 8 * MIB : 12 * MIB,
      estimatedMaxBytes: isAndroid ? 8 * MIB : 12 * MIB,
      startupBufferSec: 4,
      safetyFactor: 1.25,
      timeoutMs: 3e4,
      variantMode: "fixed",
      targetMbps: 6,
    },
    load: {
      enabled: true,
      durationMs: isAndroid ? 6e3 : 8e3,
      chunkBytes: 1 * MIB,
      maxDownloadBytes: isAndroid ? 8 * MIB : 12 * MIB,
      flows: isAndroid ? 2 : 4,
      uploadBytes: isAndroid ? 524288 : 1 * MIB,
      uploadFlows: 1,
      fanoutRequests: isAndroid ? 3 : 4,
      idleSamples: 2,
      timeoutMs: isAndroid ? 5e3 : 7e3,
      // "balanced" warns below 8 Mbps and fails below 2 Mbps sustained —
      // above the whole path class this scanner is used on (~3–6 Mbps
      // through the tunnel), where every decent candidate capped at 75
      // and "recommended" was unreachable. "tolerant" (warn 4 / fail 1)
      // restores label headroom where the candidates actually live; its
      // fail lines still catch genuinely dead candidates.
      gateProfile: "tolerant",
      endpoints: {
        download: "https://speed.cloudflare.com/__down",
        upload: "https://speed.cloudflare.com/__up",
        ping: "https://speed.cloudflare.com/__down?bytes=1000",
        control: "https://ash-speed.hetzner.com/100MB.bin",
      },
      control: { enabled: false, bytes: 6 * MIB },
      gates: {},
    },
    hard: {
      concurrency,
      screeningRounds: 1,
      recheckTop: isAndroid ? 12 : 20,
      saveEvery: isAndroid ? 10 : 25,
      liveTop: 30,
      finalTop: 200,
      delayedRetry: true,
      retryLimit: isAndroid ? 1e3 : 5e3,
      // Block-adaptive engine (DNA redesign): these keys are read only when
      // engine is "blocks" (the default); under "round-robin" they are inert.
      engine: "blocks",
      primerPerBlock: 3,
      budgetProbes: isAndroid ? 4e4 : 72e3,
      banditExploration: 1,
      maxDepthPerBlock: 32,
      // Expansion runs in waves of expansionWaveFactor × concurrency
      // probes, at most expansionChunk per block per pass, and no single
      // range may take more than rangeWaveCapFraction of a wave.
      expansionWaveFactor: 10,
      expansionChunk: 4,
      rangeWaveCapFraction: 0.25,
      poolPerBlock: 8,
      recheckPerBlock: 4,
      // A block splits only when a Fisher test clears splitAlpha AND the
      // two halves differ by at least splitMinEffect, at most
      // splitMaxDepth times.
      splitMaxDepth: 2,
      splitAlpha: 0.05,
      splitMinEffect: 0.5,
      // Split-coverage pass (5b analysis): between the primer and UCB
      // expansion, a bounded reserve guarantees split-trigger depth to
      // the blocks the primer flags — mixed primers, plus 0-success
      // blocks via targeted draws into their less-observed half. The
      // split signal lives in the per-half counters, which pure index
      // order starves; the pass is capped at splitReserveFraction of
      // the post-primer headroom so the adaptive phase always keeps a
      // meaningful budget. splitReserveAlpha is the looser Fisher
      // threshold that earns a near-miss suspect one deeper stage —
      // the split itself still requires splitAlpha.
      splitReserveFraction: 0.85,
      splitReserveAlpha: 0.25,
      // Reputation has no staleness cutoff: stored evidence decays with a
      // reputationHalfLifeDays half-life and only steers the primer —
      // blocks seen within reputationSkipAgeDays skip it, blocks up to
      // reputationConfirmAgeDays old get one confirmation probe, older
      // blocks get a full primer; the decayed prior is always retained.
      // Per-block history is capped at reputationMaxStoredAttempts.
      reputationSkipAgeDays: 3,
      reputationConfirmAgeDays: 21,
      reputationHalfLifeDays: 14,
      reputationMaxStoredAttempts: 64,
    },
    customWorkloads: { browsing: [], streaming: [] },
    logging: { level: "info" },
  };
}
export const DEFAULT_SETTINGS = createDefaultSettings();
function isPlainObject(value) {
  return Boolean(value) && "object" == typeof value && !Array.isArray(value);
}
export function mergeSettings(base, overrides) {
  const result = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(overrides)) return result;
  for (const [key, value] of Object.entries(overrides))
    if (isPlainObject(value) && isPlainObject(result[key]))
      result[key] = mergeSettings(result[key], value);
    else result[key] = value;
  return result;
}
// Pre-v7 default values for individual keys: a stored value that still equals
// the old default is upgraded to the current default; user changes are kept.
// Inherent limitation of the mechanism, stated once here: it cannot
// distinguish "never touched" from "deliberately set to the old default" —
// a user who intentionally chose the old value is upgraded along with
// everyone else. That collision is accepted because the alternative
// (version-gating every default change) strands existing installs on
// values the team has already judged wrong.
const OLD_SCALAR_DEFAULTS = [
    ["streaming", "maxSegments", 10],
    ["streaming", "quickSegments", 3],
    // The v2-era Research default: files that old were never migrated
    // past it, so their Research scans still run 29 segments per
    // candidate against a current default of 6.
    ["streaming", "researchSegments", 29],
    ["streaming", "timeoutMs", 25e3],
    ["browsing", "assetLimit", 6],
    ["browsing", "timeoutMs", 15e3],
  ],
  // Defaults whose value changed in 0.9.0. SETTINGS_VERSION stays 7 (no
  // key changed shape), so the equals-old-default rule is the only way
  // the new values reach existing installs — and it must run for
  // current-version files too, which the pre-v7 path never touches.
  CHANGED_SCALAR_DEFAULTS = [
    ["calibration", "failureRateIncreaseLimit", 0.02],
    ["load", "gateProfile", "balanced"],
  ],
  // Keys removed in 0.9.0 after the settings audits found no reader
  // anywhere (dead config the settings UI happily edited). mergeSettings
  // copies unknown stored keys verbatim, so without an explicit strip an
  // old file would resurrect them on every load and the next save would
  // write them back out.
  REMOVED_SETTINGS_KEYS = [
    ["mode"],
    ["traffic"],
    ["scan", "screeningRounds"],
    ["tunnel", "concurrency"],
    ["browsing", "metricName"],
    ["load", "minBytes"],
  ],
  OLD_WORKLOAD_DEFAULTS = [
    ["browsing", ["wikipedia"]],
    ["streaming", ["apple-bipbop"]],
  ];
// The current-version pass, applied on every migrateSettings return
// path: upgrade stored values that still equal a changed 0.9.0 default,
// and strip keys that no longer exist so removed config cannot persist.
function applyCurrentDefaults(merged, input, defaults) {
  for (const [section, key, oldValue] of CHANGED_SCALAR_DEFAULTS)
    if (input[section]?.[key] === oldValue)
      merged[section][key] = defaults[section][key];
  for (const path of REMOVED_SETTINGS_KEYS)
    if (1 === path.length) delete merged[path[0]];
    else delete merged[path[0]][path[1]];
  return merged;
}
function arraysEqual(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}
export function migrateSettings(input, platform = process.platform) {
  if (!isPlainObject(input)) return createDefaultSettings(platform);
  const defaults = createDefaultSettings(platform),
    version = Number(input.version) || 1;
  if (version >= 7)
    return applyCurrentDefaults(mergeSettings(defaults, input), input, defaults);
  const merged = mergeSettings(defaults, input);
  for (const [section, key, oldValue] of OLD_SCALAR_DEFAULTS)
    if (input[section] && input[section][key] === oldValue)
      merged[section][key] = defaults[section][key];
  for (const [section, oldNames] of OLD_WORKLOAD_DEFAULTS)
    if (input[section] && arraysEqual(input[section].workloads, oldNames))
      merged[section].workloads = defaults[section].workloads;
  const savedGates =
    isPlainObject(input.load) && isPlainObject(input.load.gates)
      ? input.load.gates
      : {};
  // Pre-v4 files kept no load settings beyond the gates; rebuild the rest.
  if (version < 4) merged.load = mergeSettings(defaults.load, { gates: savedGates });
  else if (version < 6) {
    // Pre-v6 load budgets could exceed the current caps; clamp them.
    merged.load = mergeSettings(merged.load, {
      maxDownloadBytes: defaults.load.maxDownloadBytes,
      durationMs: Math.min(
        Number(merged.load.durationMs) || defaults.load.durationMs,
        defaults.load.durationMs,
      ),
      uploadBytes: Math.min(
        Number(merged.load.uploadBytes) || defaults.load.uploadBytes,
        defaults.load.uploadBytes,
      ),
      fanoutRequests: Math.min(
        Number(merged.load.fanoutRequests) || defaults.load.fanoutRequests,
        defaults.load.fanoutRequests,
      ),
    });
    merged.streaming.maxSegments = Math.min(
      Number(merged.streaming.maxSegments) || defaults.streaming.maxSegments,
      defaults.streaming.maxSegments,
    );
    merged.browsing.assetLimit = Math.min(
      Number(merged.browsing.assetLimit) || defaults.browsing.assetLimit,
      defaults.browsing.assetLimit,
    );
  }
  if (version < 6) {
    merged.browsing.maxBytes =
      Number(input.browsing?.maxBytes) ||
      Number(input.browsing?.estimatedMaxBytes) ||
      defaults.browsing.maxBytes;
    merged.streaming.maxBytes =
      Number(input.streaming?.maxBytes) ||
      Number(input.streaming?.estimatedMaxBytes) ||
      defaults.streaming.maxBytes;
    if ("abr" === merged.streaming.variantMode)
      merged.streaming.variantMode = "lowest";
  }
  if (version < 7) {
    // v6 load defaults: stored values equal to these are upgraded, per key.
    const isAndroid = "android" === platform,
      oldLoadDefaults = {
        durationMs: isAndroid ? 1e4 : 12e3,
        maxDownloadBytes: isAndroid ? 12 * MIB : 24 * MIB,
        flows: isAndroid ? 3 : 6,
        uploadBytes: isAndroid ? 1 * MIB : 2 * MIB,
        uploadFlows: 2,
        fanoutRequests: isAndroid ? 4 : 6,
        idleSamples: 4,
        timeoutMs: 2e4,
      };
    for (const [key, oldValue] of Object.entries(oldLoadDefaults))
      if (input.load?.[key] === oldValue) merged.load[key] = defaults.load[key];
  }
  applyCurrentDefaults(merged, input, defaults);
  merged.version = 7;
  merged.migratedFrom = version;
  return merged;
}
// The fallback settings must be an isolated deep copy: mergeSettings
// is a shallow merge, so returning it over DEFAULT_SETTINGS would
// hand every caller the defaults' own nested objects — one caller's
// in-place edit (a profile transform, a calibration verdict) would
// silently rewrite the defaults for the whole process.
function defaultSettingsCopy() {
  return structuredClone(DEFAULT_SETTINGS);
}
export function loadSettings(filePath, { logger } = {}) {
  // The optional logger is the entry points' bootstrap logger, created
  // before any settings exist. Without it this function is structurally
  // unloggable — it runs before every logger creation site — so a
  // corrupt file or a settings migration would leave no trace anywhere.
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    logger?.info?.("settings.loaded", { source: "defaults", reason: "no-file" });
    return defaultSettingsCopy();
  }
  try {
    const settings = migrateSettings(JSON.parse(raw));
    if (Number.isFinite(settings.migratedFrom))
      logger?.info?.("settings.migrated", {
        from: settings.migratedFrom,
        to: SETTINGS_VERSION,
      });
    logger?.info?.("settings.loaded", {
      source: "file",
      version: settings.version,
    });
    return settings;
  } catch (error) {
    logger?.warn?.("settings.loaded", {
      source: "defaults",
      error: { class: "settings_load", message: error.message },
    });
    return defaultSettingsCopy();
  }
}
export function saveSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 384,
  });
  return filePath;
}
export function estimateTrafficBytes(settings) {
  const load = settings.load || {},
    streaming = settings.streaming || {},
    browsing = settings.browsing || {},
    loadDisabled = false === load.enabled,
    downloadBytes = loadDisabled
      ? 0
      : Number(load.maxDownloadBytes) || 24 * MIB,
    uploadBytes = loadDisabled ? 0 : Number(load.uploadBytes) || 0,
    fanoutBytes = loadDisabled
      ? 0
      : 128 * (Number(load.fanoutRequests) || 0) * 1024,
    controlBytes =
      loadDisabled || !load.control?.enabled
        ? 0
        : Number(load.control.bytes) || 0,
    streamingBytes =
      false === streaming.enabled
        ? 0
        : Number(streaming.maxBytes ?? streaming.estimatedMaxBytes) || 0,
    browsingBytes =
      false === browsing.enabled
        ? 0
        : Number(browsing.maxBytes ?? browsing.estimatedMaxBytes) || 0;
  return Math.round(
    downloadBytes +
      uploadBytes +
      fanoutBytes +
      controlBytes +
      streamingBytes +
      browsingBytes,
  );
}
export function resolveWorkloads({ settings, catalog, kind }) {
  const selectedNames = settings[kind]?.workloads || [],
    custom = settings.customWorkloads?.[kind] || [];
  return [
    ...(catalog[kind] || []).filter((workload) =>
      selectedNames.includes(workload.name),
    ),
    ...custom,
  ];
}
export function loadCatalog(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
