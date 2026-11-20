import { createHttpClient } from "../net/http.js";
import {
  median,
  scoreLowerBetter,
  scoreHigherBetter,
  weightedScore,
  round,
} from "../stats.js";
import {
  parseHlsManifest,
  simulateBuffer,
  estimateSustainableThroughput,
} from "./metrics.js";
const MIB = 1048576;
const DEFAULT_STREAMING_MAX_BYTES = 12 * MIB;
// Requests stop once the remaining budget reaches this reserve, so a probe
// never spends its very last bytes on a partial fetch.
const BUDGET_RESERVE_BYTES = 65536;
function chooseVariant(variants, { mode = "fixed", targetMbps = 6 } = {}) {
  const sorted = variants
    .slice()
    .sort((a, b) => (a.bandwidth || Infinity) - (b.bandwidth || Infinity));
  if (0 === sorted.length) return null;
  if ("lowest" === mode || "abr" === mode) return sorted[0];
  const targetBps = 1e6 * targetMbps;
  return (
    sorted
      .filter(
        (variant) =>
          (variant.averageBandwidth || variant.bandwidth || Infinity) <=
          targetBps,
      )
      .at(-1) || sorted[0]
  );
}
function ladderCeilingMbps(variants = []) {
  const values = variants
    .map((variant) => variant.bandwidth || variant.averageBandwidth)
    .filter(
      (value) => "number" == typeof value && Number.isFinite(value) && value > 0,
    );
  return 0 === values.length ? null : round(Math.max(...values) / 1e6, 3);
}
export function createStreamingBudget(limit = 12582912) {
  const limitBytes = Math.max(0, Math.floor(Number(limit) || 0));
  let actualBytes = 0;
  return {
    get limitBytes() {
      return limitBytes;
    },
    get actualBytes() {
      return actualBytes;
    },
    get remainingBytes() {
      return Math.max(0, limitBytes - actualBytes);
    },
    account(bytes) {
      actualBytes += Math.max(0, Math.floor(Number(bytes) || 0));
    },
  };
}
// One HTTP request charged against the streaming budget; the per-request cap
// is clamped so the reserve always stays unspent.
async function requestWithinBudget(client, budget, url, options = {}) {
  if (budget.remainingBytes <= BUDGET_RESERVE_BYTES)
    return {
      url,
      ok: false,
      error: "traffic_budget_exhausted",
      bytes: 0,
      totalMs: 0,
      ttfbMs: null,
    };
  const requestedMax = Math.max(
      1,
      Math.floor(Number(options.maxBytes) || budget.remainingBytes),
    ),
    effectiveMax = Math.max(
      1,
      Math.min(requestedMax, budget.remainingBytes - BUDGET_RESERVE_BYTES),
    ),
    response = await client.request(url, { ...options, maxBytes: effectiveMax });
  budget.account(response.bytes);
  return response;
}
function rangeHeaders(byteRange) {
  return byteRange ? { Range: `bytes=${byteRange}` } : void 0;
}
// Init segments and encryption keys are shared between media segments, so
// each unique resource is fetched (and charged) only once per probe.
async function fetchSharedResource(client, resource, cache, budget) {
  if (!resource?.url) return { ok: true, totalMs: 0, bytes: 0 };
  const cacheKey = `${resource.url}|${resource.byteRange || ""}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const response = await requestWithinBudget(client, budget, resource.url, {
    maxBytes: 4 * MIB,
    headers: rangeHeaders(resource.byteRange),
  });
  cache.set(cacheKey, response);
  return response;
}
export async function probeStreaming({
  workload,
  proxy = null,
  timeoutMs = 25e3,
  maxSegments = 4,
  maxBytes = 12582912,
  startupBufferSec = 4,
  safetyFactor = 1.25,
  variantMode = "fixed",
  targetMbps = 6,
  logger = null,
}) {
  const client = createHttpClient({ proxy, timeoutMs }),
    budget = createStreamingBudget(maxBytes);
  let startupOverheadMs = 0,
    selectedVariant = null,
    ladderMaxMbps =
      "number" == typeof workload.ladderMaxMbps ? workload.ladderMaxMbps : null,
    usedManifestUrl = null;
  const sharedCache = new Map();
  try {
    let segments = [];
    if (Array.isArray(workload.segmentUrls) && workload.segmentUrls.length > 0)
      segments = workload.segmentUrls.map((url) => ({
        url,
        durationSec: workload.segmentDurationSec || 4,
      }));
    else {
      const manifestUrls = (function (wl) {
        const urls = [];
        if (wl.manifestUrl) urls.push(wl.manifestUrl);
        for (const fallback of wl.fallbackManifestUrls || [])
          if (fallback && !urls.includes(fallback)) urls.push(fallback);
        return urls;
      })(workload);
      if (0 === manifestUrls.length)
        return emptyStreamingResult(
          workload,
          "manifest_missing",
          startupOverheadMs,
          budget,
        );
      let lastError = "manifest_failed";
      for (const manifestUrl of manifestUrls) {
        const attempt = await fetchManifestSegments({
          client,
          budget,
          manifestUrl,
          variantMode,
          targetMbps,
        });
        startupOverheadMs += attempt.overheadMs;
        if (attempt.ok) {
          segments = attempt.segments;
          selectedVariant = attempt.selectedVariant;
          usedManifestUrl = manifestUrl;
          if (attempt.ladderMaxMbps) ladderMaxMbps = attempt.ladderMaxMbps;
          break;
        }
        lastError = attempt.error;
        logger?.debug("streaming.manifest.fallback", {
          manifestUrl,
          error: attempt.error,
        });
        if ("traffic_budget_exhausted" === lastError) break;
      }
      if (0 === segments.length)
        return emptyStreamingResult(
          workload,
          lastError,
          startupOverheadMs,
          budget,
        );
    }
    if (0 === segments.length)
      return emptyStreamingResult(
        workload,
        "no_segments",
        startupOverheadMs,
        budget,
      );
    const results = [];
    for (const segment of segments.slice(0, maxSegments)) {
      if (budget.remainingBytes <= BUDGET_RESERVE_BYTES) break;
      const initResult = await fetchSharedResource(
          client,
          segment.initMap,
          sharedCache,
          budget,
        ),
        keyResult = await fetchSharedResource(
          client,
          segment.key,
          sharedCache,
          budget,
        ),
        // Startup overhead counts each shared resource once, even when the
        // resource fetch itself was already charged through the cache.
        initMarker = segment.initMap?.url
          ? `accounted:${segment.initMap.url}|${segment.initMap.byteRange || ""}`
          : null,
        keyMarker = segment.key?.url ? `accounted:${segment.key.url}` : null;
      if (initMarker && !sharedCache.has(initMarker)) {
        startupOverheadMs += initResult.totalMs || 0;
        sharedCache.set(initMarker, true);
      }
      if (keyMarker && !sharedCache.has(keyMarker)) {
        startupOverheadMs += keyResult.totalMs || 0;
        sharedCache.set(keyMarker, true);
      }
      const prerequisitesOk = initResult.ok && keyResult.ok,
        segmentResult = prerequisitesOk
          ? await requestWithinBudget(client, budget, segment.url, {
              maxBytes: 16 * MIB,
              headers: rangeHeaders(segment.byteRange),
            })
          : {
              ok: false,
              totalMs: 0,
              bytes: 0,
              error:
                initResult.error || keyResult.error || "prerequisite_failed",
            };
      logger?.debug("streaming.segment", {
        ok: segmentResult.ok,
        bytes: segmentResult.bytes,
        totalMs: segmentResult.totalMs,
        range: segment.byteRange,
        discontinuity: segment.discontinuity,
      });
      const ok = Boolean(segmentResult.ok && prerequisitesOk && segmentResult.bytes > 0),
        seconds = Math.max(segmentResult.totalMs || 0, 1) / 1e3;
      results.push({
        ...segment,
        ok,
        downloadMs: segmentResult.totalMs || 0,
        ttfbMs: segmentResult.ttfbMs ?? null,
        bytes: ok ? segmentResult.bytes : 0,
        mbps: ok ? round((8 * segmentResult.bytes) / seconds / 1e6, 3) : null,
        error: ok ? null : segmentResult.error || "segment_failed",
      });
      if ("traffic_budget_exhausted" === segmentResult.error) break;
    }
    const succeeded = results.filter((result) => result.ok),
      successRate = results.length ? succeeded.length / results.length : 0,
      throughputs = succeeded.map((result) => result.mbps),
      playback = simulateBuffer(results, startupBufferSec, startupOverheadMs),
      sustainable = estimateSustainableThroughput(throughputs, safetyFactor),
      overallScore = weightedScore(
        [
          { score: successRate, weight: 35 },
          { score: scoreLowerBetter(playback.startupDelaySec, 0.8, 8), weight: 15 },
          { score: scoreLowerBetter(playback.rebufferRatio, 0.005, 0.25), weight: 30 },
          { score: scoreHigherBetter(sustainable.value ?? NaN, 6, 0.4), weight: 20 },
        ],
        { requireAll: true },
      ),
      score = playback.playbackStarted ? overallScore : null,
      quality = qualityLabel(sustainable.value, ladderMaxMbps),
      ladderLimited =
        "number" == typeof sustainable.value &&
        "number" == typeof ladderMaxMbps &&
        sustainable.value > ladderMaxMbps,
      error = playback.playbackStarted
        ? null
        : 0 === results.length && budget.remainingBytes <= BUDGET_RESERVE_BYTES
          ? "traffic_budget_exhausted"
          : 0 === succeeded.length
            ? results.find((result) => result.error)?.error ||
              "all_segments_failed"
            : "playback_not_started";
    return {
      workload: workload.name,
      manifestUrl: usedManifestUrl || workload.manifestUrl || null,
      segments: results.length,
      sampleCount: throughputs.length,
      successRate: round(successRate, 3),
      medianMbps: round(median(throughputs), 3),
      p10Mbps: sustainable.p10,
      sustainableMbps: sustainable.value,
      estimator: sustainable.estimator,
      estimatorConfidence: sustainable.confidence,
      ladderMaxMbps,
      ladderLimited,
      quality,
      startupDelaySec: playback.startupDelaySec,
      startupOverheadMs: round(startupOverheadMs, 2),
      playbackStarted: playback.playbackStarted,
      stalls: playback.stalls,
      stallSec: playback.stallSec,
      rebufferRatio: playback.rebufferRatio,
      variantMode,
      selectedVariant,
      bytes: budget.actualBytes,
      budget: {
        maxBytes: budget.limitBytes,
        remainingBytes: budget.remainingBytes,
        exhausted: budget.remainingBytes <= BUDGET_RESERVE_BYTES,
      },
      score,
      error,
      detail: results,
    };
  } finally {
    client.close();
  }
}
async function fetchManifestSegments({
  client,
  budget,
  manifestUrl,
  variantMode,
  targetMbps,
}) {
  let overheadMs = 0;
  const manifestResponse = await requestWithinBudget(client, budget, manifestUrl, {
    captureBody: true,
    maxBytes: MIB,
  });
  overheadMs += manifestResponse.totalMs || 0;
  if (!manifestResponse.ok)
    return {
      ok: false,
      error: manifestResponse.error || "manifest_failed",
      overheadMs,
      segments: [],
    };
  let playlist = parseHlsManifest(
      manifestResponse.body.toString("utf8"),
      manifestUrl,
    ),
    ladderMaxMbps = null,
    selectedVariant = null;
  if (playlist.isMaster) {
    ladderMaxMbps = ladderCeilingMbps(playlist.variants);
    selectedVariant = chooseVariant(playlist.variants, {
      mode: variantMode,
      targetMbps,
    });
    if (!selectedVariant)
      return { ok: false, error: "variant_missing", overheadMs, segments: [] };
    const variantResponse = await requestWithinBudget(
      client,
      budget,
      selectedVariant.url,
      { captureBody: true, maxBytes: MIB },
    );
    overheadMs += variantResponse.totalMs || 0;
    if (!variantResponse.ok)
      return {
        ok: false,
        error: variantResponse.error || "variant_failed",
        overheadMs,
        segments: [],
      };
    playlist = parseHlsManifest(
      variantResponse.body.toString("utf8"),
      selectedVariant.url,
    );
  }
  return playlist.segments && 0 !== playlist.segments.length
    ? {
        ok: true,
        error: null,
        overheadMs,
        segments: playlist.segments,
        selectedVariant,
        ladderMaxMbps,
      }
    : { ok: false, error: "no_segments", overheadMs, segments: [] };
}
function qualityLabel(value, ladderMax = null) {
  if (!Number.isFinite(value)) return null;
  const capped =
    "number" == typeof ladderMax && Number.isFinite(ladderMax) && ladderMax > 0
      ? Math.min(value, ladderMax)
      : value;
  return capped >= 15
    ? "4K"
    : capped >= 6
      ? "1080p"
      : capped >= 3
        ? "720p"
        : capped >= 1
          ? "480p"
          : "360p";
}
function emptyStreamingResult(
  workload,
  error,
  overheadMs = 0,
  budget = createStreamingBudget(),
) {
  return {
    workload: workload.name,
    manifestUrl: workload.manifestUrl || null,
    segments: 0,
    sampleCount: 0,
    successRate: 0,
    medianMbps: null,
    p10Mbps: null,
    sustainableMbps: null,
    estimator: "none",
    estimatorConfidence: "none",
    ladderMaxMbps: workload.ladderMaxMbps ?? null,
    ladderLimited: false,
    quality: null,
    startupDelaySec: round(overheadMs / 1e3, 3),
    startupOverheadMs: round(overheadMs, 2),
    playbackStarted: false,
    stalls: 0,
    stallSec: 0,
    rebufferRatio: null,
    bytes: budget.actualBytes,
    budget: {
      maxBytes: budget.limitBytes,
      remainingBytes: budget.remainingBytes,
      exhausted: budget.remainingBytes <= BUDGET_RESERVE_BYTES,
    },
    score: null,
    error,
    detail: [],
  };
}
export {
  parseHlsManifest,
  simulateBuffer,
  chooseVariant,
  qualityLabel,
  ladderCeilingMbps,
  DEFAULT_STREAMING_MAX_BYTES,
};
