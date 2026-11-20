import { performance } from "node:perf_hooks";
import { createHttpClient } from "../net/http.js";
const MIB = 1048576;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 24 * MIB;
export const DEFAULT_LOAD_ENDPOINTS = {
  download: "https://speed.cloudflare.com/__down",
  upload: "https://speed.cloudflare.com/__up",
  ping: "https://speed.cloudflare.com/__down?bytes=1000",
  control: "https://ash-speed.hetzner.com/100MB.bin",
};
// Megabits per second for a byte count over a duration; null when the
// duration cannot support a rate.
function toMbps(bytes, durationMs) {
  return !Number.isFinite(bytes) || !Number.isFinite(durationMs) || durationMs <= 0
    ? null
    : (8 * bytes) / (durationMs / 1e3) / 1e6;
}
function roundTo(value, digits = 2) {
  if ("number" != typeof value || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
export function quantile(values, q) {
  const sorted = values
    .filter((value) => "number" == typeof value && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (0 === sorted.length) return null;
  if (1 === sorted.length) return sorted[0];
  const rank = (sorted.length - 1) * q,
    lower = Math.floor(rank),
    upper = Math.ceil(rank);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}
export function createByteBudget(limit) {
  const limitBytes = Math.max(0, Math.floor(Number(limit) || 0));
  let reservedBytes = 0;
  return {
    // Grants at most the remaining budget; returns the granted amount.
    reserve(amount) {
      const available = Math.max(0, limitBytes - reservedBytes),
        granted = Math.min(
          available,
          Math.max(0, Math.floor(Number(amount) || 0)),
        );
      reservedBytes += granted;
      return granted;
    },
    get limitBytes() {
      return limitBytes;
    },
    get reservedBytes() {
      return reservedBytes;
    },
    get remainingBytes() {
      return Math.max(0, limitBytes - reservedBytes);
    },
  };
}
export function summarizeWindows(windows = []) {
  const okWindows = windows.filter(
      (window) => window && window.ok && window.ms > 0 && window.bytes > 0,
    ),
    summary = {
      samples: 0,
      sustainedMbps: null,
      peakMbps: null,
      earlyMbps: null,
      lateMbps: null,
      shapingRatio: null,
      totalBytes: 0,
      totalMs: 0,
      failures: windows.length - okWindows.length,
    };
  if (0 === okWindows.length) return summary;
  const totalBytes = okWindows.reduce((sum, window) => sum + window.bytes, 0),
    totalMs = okWindows.reduce((sum, window) => sum + window.ms, 0),
    rates = okWindows.map((window) => toMbps(window.bytes, window.ms)),
    third = Math.max(1, Math.floor(okWindows.length / 3)),
    earlyMedian = quantile(rates.slice(0, third), 0.5),
    lateMedian = quantile(rates.slice(-third), 0.5),
    // Shaping compares the first and last thirds; needs at least 3 windows.
    hasShaping = okWindows.length >= 3 && earlyMedian > 0;
  return {
    samples: okWindows.length,
    sustainedMbps: roundTo(toMbps(totalBytes, totalMs)),
    peakMbps: roundTo(Math.max(...rates)),
    earlyMbps: roundTo(earlyMedian),
    lateMbps: roundTo(lateMedian),
    shapingRatio: hasShaping
      ? roundTo(Math.min(lateMedian / earlyMedian, 2), 3)
      : null,
    totalBytes,
    totalMs: roundTo(totalMs),
    failures: windows.length - okWindows.length,
  };
}
export function summarizeSaturation({
  windows = [],
  wallClockMs = null,
  flows = 1,
} = {}) {
  const okWindows = windows.filter(
      (window) => window && window.ok && window.bytes > 0,
    ),
    failures = windows.length - okWindows.length;
  if (
    0 === okWindows.length ||
    !Number.isFinite(wallClockMs) ||
    wallClockMs <= 0
  )
    return {
      flows,
      samples: 0,
      failures,
      totalBytes: 0,
      wallClockMs: roundTo(wallClockMs),
      sustainedMbps: null,
      peakMbps: null,
      earlyMbps: null,
      lateMbps: null,
      shapingRatio: null,
      perFlowMbps: null,
    };
  const totalBytes = okWindows.reduce((sum, window) => sum + window.bytes, 0),
    rates = okWindows
      .map((window) => toMbps(window.bytes, window.ms))
      .filter((rate) => null !== rate),
    byFlow = new Map();
  for (const window of okWindows) {
    const flow = Number.isFinite(window.flow) ? window.flow : 0;
    if (!byFlow.has(flow)) byFlow.set(flow, []);
    byFlow.get(flow).push(window);
  }
  let earlyMedian = null,
    lateMedian = null;
  const multiWindowFlows = [...byFlow.values()].filter(
    (flowWindows) => flowWindows.length >= 2,
  );
  if (multiWindowFlows.length > 0) {
    earlyMedian = quantile(
      multiWindowFlows.map((flowWindows) =>
        toMbps(flowWindows[0].bytes, flowWindows[0].ms),
      ),
      0.5,
    );
    lateMedian = quantile(
      multiWindowFlows.map((flowWindows) => {
        const last = flowWindows.at(-1);
        return toMbps(last.bytes, last.ms);
      }),
      0.5,
    );
  }
  const hasShaping =
      "number" == typeof earlyMedian &&
      earlyMedian > 0 &&
      "number" == typeof lateMedian,
    aggregateMbps = toMbps(totalBytes, wallClockMs);
  return {
    flows,
    samples: okWindows.length,
    failures,
    totalBytes,
    wallClockMs: roundTo(wallClockMs),
    sustainedMbps: roundTo(aggregateMbps),
    peakMbps: rates.length ? roundTo(Math.max(...rates)) : null,
    earlyMbps: roundTo(earlyMedian),
    lateMbps: roundTo(lateMedian),
    shapingRatio: hasShaping
      ? roundTo(Math.min(lateMedian / earlyMedian, 2), 3)
      : null,
    perFlowMbps: roundTo(aggregateMbps / Math.max(1, flows)),
  };
}
export function loadLatencyTimeout(timeoutMs) {
  return Math.min(Math.max(1, Number(timeoutMs) || 1), 3e3);
}
export function responsivenessRpm(medianMs) {
  return "number" != typeof medianMs || !Number.isFinite(medianMs) || medianMs <= 0
    ? null
    : roundTo(6e4 / medianMs);
}
export function summarizeLatency({
  idle = [],
  loaded = [],
  attempts = 0,
  failures = 0,
} = {}) {
  const idleMedian = quantile(idle, 0.5),
    loadedMedian = quantile(loaded, 0.5),
    loadedP95 = quantile(loaded, 0.95),
    totalAttempts = attempts || idle.length + loaded.length + failures,
    hasBoth = "number" == typeof idleMedian && "number" == typeof loadedMedian;
  return {
    idleRttMs: roundTo(idleMedian),
    loadedRttMs: roundTo(loadedMedian),
    loadedP95Ms: roundTo(loadedP95),
    rttIncreaseMs: hasBoth
      ? roundTo(Math.max(0, loadedMedian - idleMedian))
      : null,
    rttInflation:
      hasBoth && idleMedian > 0
        ? roundTo(Math.max(1, loadedMedian / idleMedian), 2)
        : null,
    rpm: responsivenessRpm(loadedMedian),
    idleRpm: responsivenessRpm(idleMedian),
    jitterMs:
      "number" == typeof loadedP95 && "number" == typeof loadedMedian
        ? roundTo(loadedP95 - loadedMedian)
        : null,
    lossRate: totalAttempts > 0 ? roundTo(failures / totalAttempts, 4) : null,
    samples: {
      idle: idle.length,
      loaded: loaded.length,
      attempts: totalAttempts,
      failures,
    },
  };
}
export function summarizeFanout(results = [], wallClockMs = null) {
  if (0 === results.length)
    return {
      requests: 0,
      fanoutSuccess: null,
      freshConnectionMs: null,
      wallClockMs: null,
    };
  const succeeded = results.filter((result) => result && result.ok),
    times = succeeded
      .map((result) =>
        "number" == typeof result.ttfbMs ? result.ttfbMs : result.totalMs,
      )
      .filter(Number.isFinite);
  return {
    requests: results.length,
    fanoutSuccess: roundTo(succeeded.length / results.length, 4),
    freshConnectionMs: roundTo(quantile(times, 0.9)),
    wallClockMs: roundTo(wallClockMs),
  };
}
export function summarizeControl({ edgeMbps, controlMbps } = {}) {
  const comparable =
    "number" == typeof edgeMbps &&
    Number.isFinite(edgeMbps) &&
    "number" == typeof controlMbps &&
    Number.isFinite(controlMbps) &&
    controlMbps > 0;
  return {
    controlMbps: roundTo(controlMbps),
    edgeMbps: roundTo(edgeMbps),
    edgeShare: comparable ? roundTo(edgeMbps / controlMbps, 3) : null,
    bottleneck: comparable
      ? edgeMbps / controlMbps < 0.6
        ? "cloudflare-edge"
        : "local-or-server"
      : null,
  };
}
export function toGateMetrics({ downlink, latency, fanout, uplink } = {}) {
  return {
    sustainedMbps: downlink?.sustainedMbps ?? null,
    shapingRatio: downlink?.shapingRatio ?? null,
    rpm: latency?.rpm ?? null,
    rttIncreaseMs: latency?.rttIncreaseMs ?? null,
    rttInflation: latency?.rttInflation ?? null,
    jitterMs: latency?.jitterMs ?? null,
    lossRate: latency?.lossRate ?? null,
    fanoutSuccess: fanout?.fanoutSuccess ?? null,
    freshConnectionMs: fanout?.freshConnectionMs ?? null,
    uplinkMbps: uplink?.sustainedMbps ?? null,
  };
}
function withBytesParam(url, bytes) {
  return url.includes("{bytes}")
    ? url.replace("{bytes}", String(bytes))
    : `${url}${url.includes("?") ? "&" : "?"}bytes=${bytes}`;
}
async function sampleIdleLatency({ client, url, samples }) {
  const values = [];
  let failures = 0;
  for (let index = 0; index < samples; index += 1) {
    const response = await client.request(url, { maxBytes: 65536 });
    if (response.ok && "number" == typeof response.ttfbMs)
      values.push(response.ttfbMs);
    else failures += 1;
  }
  return { values, failures };
}
export async function runLoadProbe({
  proxy = null,
  endpoints = DEFAULT_LOAD_ENDPOINTS,
  durationMs = 12e3,
  chunkBytes = 1 * MIB,
  maxDownloadBytes = 25165824,
  flows = 4,
  uploadBytes = 2 * MIB,
  uploadFlows = 2,
  fanoutRequests = 6,
  idleSamples = 4,
  timeoutMs = 2e4,
  control = false,
  controlBytes = 6 * MIB,
} = {}) {
  const pingUrl = endpoints.ping || DEFAULT_LOAD_ENDPOINTS.ping,
    downloadUrl = endpoints.download || DEFAULT_LOAD_ENDPOINTS.download,
    uploadUrl = endpoints.upload || DEFAULT_LOAD_ENDPOINTS.upload,
    controlUrl = endpoints.control || DEFAULT_LOAD_ENDPOINTS.control,
    flowCount = Math.max(1, Math.floor(flows)),
    uploadFlowCount = Math.max(1, Math.floor(uploadFlows)),
    budget = createByteBudget(maxDownloadBytes),
    latencyTimeout = loadLatencyTimeout(timeoutMs),
    latencyClient = createHttpClient({
      proxy,
      timeoutMs: latencyTimeout,
      maxSockets: 1,
    }),
    downloadClients = Array.from({ length: flowCount }, () =>
      createHttpClient({ proxy, timeoutMs, maxSockets: 1 }),
    ),
    uploadClients = Array.from({ length: uploadFlowCount }, () =>
      createHttpClient({ proxy, timeoutMs, maxSockets: 1 }),
    ),
    fanoutClient = createHttpClient({
      proxy,
      timeoutMs,
      maxSockets: fanoutRequests,
    });
  try {
    const idle = await sampleIdleLatency({
        client: latencyClient,
        url: pingUrl,
        samples: idleSamples,
      }),
      loadedSamples = [];
    let loadedFailures = 0,
      loadedAttempts = 0,
      loading = true;
    const startedAt = performance.now(),
      // Background loop: keeps sampling latency for the whole download stage.
      latencyLoop = (async () => {
        while (loading) {
          loadedAttempts += 1;
          const response = await latencyClient.request(pingUrl, {
            maxBytes: 65536,
          });
          if (response.ok && "number" == typeof response.ttfbMs)
            loadedSamples.push(response.ttfbMs);
          else loadedFailures += 1;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })(),
      windows = [],
      deadline = startedAt + durationMs;
    await Promise.all(
      downloadClients.map(async (client, flow) => {
        let consecutiveFailures = 0;
        while (performance.now() < deadline && consecutiveFailures < 2) {
          const granted = budget.reserve(chunkBytes);
          if (granted <= 0) break;
          const response = await client.request(
              withBytesParam(downloadUrl, granted),
              { maxBytes: granted },
            ),
            transferMs =
              "number" == typeof response.ttfbMs &&
              "number" == typeof response.totalMs
                ? Math.max(response.totalMs - response.ttfbMs, 1)
                : response.totalMs,
            ok = Boolean(response.ok) && response.bytes > 0;
          consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
          windows.push({
            flow,
            bytes: response.bytes,
            requestedBytes: granted,
            ms: transferMs,
            ok,
            offsetMs: roundTo(performance.now() - startedAt),
          });
        }
      }),
    );
    const wallClockMs = performance.now() - startedAt;
    loading = false;
    await latencyLoop;
    const fanoutStartedAt = performance.now(),
      fanoutResults = await Promise.all(
        Array.from({ length: fanoutRequests }, () =>
          fanoutClient.request(withBytesParam(downloadUrl, 131072), {
            maxBytes: 131072,
            keepAlive: false,
          }),
        ),
      ),
      fanoutWallClockMs = performance.now() - fanoutStartedAt,
      perFlowUploadBytes = Math.max(
        1,
        Math.ceil(uploadBytes / uploadFlowCount),
      ),
      uploadChunkBytes = Math.min(perFlowUploadBytes, 524288),
      uploadWindows = [],
      uploadStartedAt = performance.now();
    await Promise.all(
      uploadClients.map(async (client, flow) => {
        let sent = 0;
        while (sent < perFlowUploadBytes) {
          const size = Math.min(uploadChunkBytes, perFlowUploadBytes - sent),
            body = Buffer.alloc(size, 97),
            response = await client.request(uploadUrl, {
              method: "POST",
              body,
              maxBytes: 131072,
            });
          uploadWindows.push({
            flow,
            bytes: response.ok ? size : 0,
            ms: response.totalMs,
            ok: Boolean(response.ok),
            offsetMs: roundTo(performance.now() - uploadStartedAt),
          });
          sent += size;
          if (!response.ok) break;
        }
      }),
    );
    const uploadWallClockMs = performance.now() - uploadStartedAt,
      downlink = summarizeSaturation({
        windows,
        wallClockMs,
        flows: flowCount,
      });
    let controlResult = null;
    if (control) {
      const controlClient = createHttpClient({
        proxy,
        timeoutMs,
        maxSockets: 1,
      });
      try {
        const response = await controlClient.request(controlUrl, {
            maxBytes: controlBytes,
          }),
          transferMs =
            "number" == typeof response.ttfbMs &&
            "number" == typeof response.totalMs
              ? Math.max(response.totalMs - response.ttfbMs, 1)
              : response.totalMs;
        controlResult = summarizeControl({
          edgeMbps: downlink.sustainedMbps,
          controlMbps: response.ok ? toMbps(response.bytes, transferMs) : null,
        });
      } finally {
        controlClient.close();
      }
    }
    const latency = summarizeLatency({
        idle: idle.values,
        loaded: loadedSamples,
        attempts: idleSamples + loadedAttempts,
        failures: idle.failures + loadedFailures,
      }),
      fanout = summarizeFanout(fanoutResults, fanoutWallClockMs),
      uplink = summarizeSaturation({
        windows: uploadWindows,
        wallClockMs: uploadWallClockMs,
        flows: uploadFlowCount,
      });
    return {
      ok: downlink.samples > 0,
      downlink,
      latency,
      fanout,
      uplink,
      control: controlResult,
      gateMetrics: toGateMetrics({ downlink, latency, fanout, uplink }),
      budget: {
        durationMs,
        chunkBytes,
        flows: flowCount,
        maxDownloadBytes: budget.limitBytes,
        reservedDownloadBytes: budget.reservedBytes,
        uploadBytes,
        uploadFlows: uploadFlowCount,
        fanoutRequests,
        latencyTimeoutMs: latencyTimeout,
      },
    };
  } finally {
    latencyClient.close();
    fanoutClient.close();
    for (const client of downloadClients) client.close();
    for (const client of uploadClients) client.close();
  }
}
