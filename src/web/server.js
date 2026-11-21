// Web UI server: node:http only, zero dependencies (plan ch. 3,
// Shield's WEB-UI-SECURITY requirements R-01…R-17 — each is enforced
// here or in the modules this one composes, and pinned by
// test/web-server.test.js).
//
// Shape of the defense, in request order:
//   1. Host must be the literal loopback authority the server bound
//      (R-06) — checked before anything else, on every request.
//   2. The one-time bootstrap exchanges the URL token for an
//      HttpOnly SameSite=Strict cookie and redirects to a clean URL
//      (R-04/R-05). The key has two spellings of one shared exchange:
//      the query form (/?t=…) and, for the Android-delivered link,
//      the path form (/t/<token>) — some intent handler chains lose
//      the query, the path is the address itself (0.9.5, Shield
//      C1–C5). Everything else needs the session cookie or the
//      equivalent header (R-03).
//   3. Mutations additionally require the custom request header and,
//      when present, an exact Origin match (R-07). No CORS headers
//      are ever emitted (R-08).
//   4. Bodies are capped while streaming (R-14); handlers run inside
//      a per-request containment boundary (R-17); every response
//      carries the security headers (R-11) and every error body is a
//      static string per failure class (R-13).
// The token lives only in this closure (R-02): never logged, never
// on disk, never in a response after the bootstrap redirect.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  loadSettings,
  saveSettings,
  migrateSettings,
  loadCatalog,
  estimateTrafficBytes,
  DEFAULT_SETTINGS,
} from "../config/settings.js";
import {
  parseVlessUri,
  describeVless,
  assertWebsocketCapable,
  normalizeVlessInput,
} from "../config/vless.js";
import {
  writeSecretFile,
  readSecretFile,
  removeSecretFile,
  fileIsProtected,
} from "../platform/paths.js";
import { locateXray, xrayVersion } from "../platform/xray.js";
import { renderTopList } from "../report.js";
import { createLogger, summarizeLogFile } from "../logging/logger.js";
import { createWebState } from "./state.js";
import { createRunManager } from "./runs.js";
import { openInBrowser, bootstrapUrlForPlatform } from "./open.js";

export const WEB_PORT = 8797;

// Plain-language notices the launching surface prints once at start
// (Shield §3.3). On Android/Termux the honest position is that other
// apps on the device can reach a loopback address, so the private
// link is the protection — the user deserves to hear that in words,
// not discover it.
export function platformNoticeLines(platform = process.platform) {
  if (platform !== "android") return [];
  return [
    "On this device, other apps can also reach the scanner's local address.",
    "The private link is what protects it — don't share the link, and stop the web UI when you're done.",
    "Tip: run termux-wake-lock so Android doesn't pause a long scan in the background.",
  ];
}
const BIND_HOST = "127.0.0.1";
const COOKIE_NAME = "cfqoe_session";
const REQUEST_HEADER = "x-cfqoe-request";
const TOKEN_HEADER = "x-cfqoe-token";
const BODY_CAP_SMALL = 16 * 1024; // config import, run control, misc POSTs
const BODY_CAP_SETTINGS = 256 * 1024; // settings save / estimate
const AUTH_FAIL_VERBATIM = 20; // Shield §4 flood guard
const AUTH_FAIL_SUMMARY_EVERY = 50;
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";

// Option B (Shield, 0.9.5): the page a session-less top-level
// navigation to the shell receives instead of the raw JSON refusal
// — the page a user stares at when the private link's key never
// reached the browser, the Android auto-open failure class. One
// fixed static string: no script, no form, no input, nothing
// fetched, nothing reflected from the request. It never contains
// or asks for the token; it only points at the terminal, where
// the private link is printed.
const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CFQoE Scanner — private link needed</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 34rem; padding: 0 1rem; line-height: 1.55; }
  h1 { font-size: 1.25rem; }
</style>
</head>
<body>
<h1>This page needs the scanner's private link</h1>
<p>The scanner on this device opens only through its private link. The address that brought you here does not carry the session key, so there is nothing to show.</p>
<p>Go back to the terminal where the scanner is running and open the full private link it printed when it started. Keep that link to yourself — on this device, it is what protects the scanner.</p>
<div dir="rtl" lang="fa">
<h1>این صفحه به لینک خصوصی اسکنر نیاز دارد</h1>
<p>اسکنر روی این دستگاه فقط از طریق لینک خصوصی‌اش باز می‌شود. آدرسی که با آن به این صفحه رسیده‌اید کلید نشست را ندارد، برای همین چیزی برای نمایش داده نمی‌شود.</p>
<p>به ترمینالی برگردید که اسکنر در آن در حال اجراست و لینک خصوصی کاملی را که هنگام شروع چاپ کرده، در مرورگر باز کنید. آن لینک را با کسی به اشتراک نگذارید؛ روی این دستگاه، همان لینک از اسکنر محافظت می‌کند.</p>
</div>
</body>
</html>
`;

// The whole static surface: the three code assets plus the bundled
// Vazirmatn subsets, read once at startup from the resolved public
// directory. Serving from memory makes the confinement property
// (R-15) structural — no request path is ever resolved against the
// filesystem for static content.
function loadAssets() {
  const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
  const read = (name) => fs.readFileSync(path.join(publicDir, name));
  return new Map([
    ["/", { body: read("index.html"), type: "text/html; charset=utf-8" }],
    ["/index.html", { body: read("index.html"), type: "text/html; charset=utf-8" }],
    ["/app.css", { body: read("app.css"), type: "text/css; charset=utf-8" }],
    ["/app.js", { body: read("app.js"), type: "text/javascript; charset=utf-8" }],
    ["/fonts/Vazirmatn-Regular.woff2", { body: read("fonts/Vazirmatn-Regular.woff2"), type: "font/woff2" }],
    ["/fonts/Vazirmatn-Bold.woff2", { body: read("fonts/Vazirmatn-Bold.woff2"), type: "font/woff2" }],
  ]);
}

function safeEqual(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Leaf-level changed key names between two settings objects (names
// only — values are never logged, Shield §4).
function changedKeyNames(before, after, prefix = "", out = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changedKeyNames(before[key], after[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.push(prefix || "(root)");
  return out;
}

export function createWebServer({ layout, onStopRequest = null } = {}) {
  if (!layout) throw new Error("createWebServer requires a layout");
  const assets = loadAssets();
  const token = randomBytes(16).toString("base64url"); // 128 bits, URL-safe (R-02)
  const webLog = createLogger({ level: "info", directory: layout.logs });
  const state = createWebState({ layout });
  const runs = createRunManager({ layout, state, webLog });
  const sseResponses = new Set();
  const reportCache = new Map();
  let server = null;
  let boundPort = null;
  let stopped = false;
  let authFails = 0;

  const expectedHost = () => `${BIND_HOST}:${boundPort}`;
  const origin = () => `http://${BIND_HOST}:${boundPort}`;

  function applySecurityHeaders(res) {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
  }

  function sendJson(res, status, value) {
    applySecurityHeaders(res);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }

  function sendError(res, status, code, message, extra = {}) {
    sendJson(res, status, { error: code, message, ...extra });
  }

  // Shield §4: auth failures are logged with reason class only, the
  // first AUTH_FAIL_VERBATIM verbatim per server run, then periodic
  // summaries — a flood cannot flood the log.
  function logAuthFail(reason, method) {
    authFails += 1;
    if (authFails <= AUTH_FAIL_VERBATIM) {
      webLog.warn("web.auth.fail", { reason, method });
    } else if (authFails % AUTH_FAIL_SUMMARY_EVERY === 0) {
      webLog.warn("web.auth.fail-summary", { count: authFails });
    }
  }

  function logReject(reason, method) {
    webLog.warn("web.serve.reject", { reason, method });
  }

  function sessionFrom(req) {
    const headerToken = req.headers[TOKEN_HEADER];
    if (typeof headerToken === "string" && safeEqual(headerToken, token)) return true;
    const cookieHeader = req.headers.cookie;
    if (typeof cookieHeader === "string") {
      for (const part of cookieHeader.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === COOKIE_NAME) {
          return safeEqual(part.slice(eq + 1).trim(), token);
        }
      }
    }
    return false;
  }

  function readBody(req, cap) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let overflow = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        // Cap enforced while streaming (R-14): past the cap the body
        // is drained and discarded — memory stays bounded, and the
        // socket survives long enough to deliver the 413.
        if (size > cap) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        if (!overflow) chunks.push(chunk);
      });
      req.on("end", () => {
        if (overflow) {
          reject(Object.assign(new Error("Request body too large"), { httpStatus: 413, code: "too_large" }));
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
      req.on("error", reject);
    });
  }

  async function readJsonBody(req, cap) {
    const contentType = req.headers["content-type"];
    const hasBody =
      (req.headers["content-length"] && req.headers["content-length"] !== "0") ||
      req.headers["transfer-encoding"];
    if (hasBody && (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json"))) {
      throw Object.assign(new Error("Content-Type must be application/json"), {
        httpStatus: 415,
        code: "unsupported_media_type",
      });
    }
    const buffer = await readBody(req, cap);
    if (buffer.length === 0) return {};
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      throw Object.assign(new Error("Request body must be valid JSON"), {
        httpStatus: 400,
        code: "invalid_json",
      });
    }
  }

  // -- Route handlers (each returns after writing its response) ------------

  function handleState(req, res) {
    sendJson(res, 200, state.buildSnapshot(runs.statusFacts()));
  }

  function handleCatalog(req, res) {
    sendJson(res, 200, state.tracker.catalog());
  }

  function handleEvents(req, res, url) {
    applySecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseResponses.add(res);
    const client = {
      wantsTail: url.searchParams.get("tail") === "1",
      send(type, payload, seq) {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`);
      },
    };
    const remove = state.addClient(client);
    const heartbeat = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        // The close handler cleans up.
      }
    }, 25000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      sseResponses.delete(res);
      remove();
    });
  }

  function workloadsCatalog() {
    const catalog = loadCatalog(layout.workloadsFile);
    const pick = (entries) =>
      (Array.isArray(entries) ? entries : []).map((entry) => ({
        name: entry.name,
        description: entry.description,
      }));
    return { browsing: pick(catalog.browsing), streaming: pick(catalog.streaming) };
  }

  function handleSettingsGet(req, res) {
    sendJson(res, 200, { settings: loadSettings(layout.settingsFile), catalog: workloadsCatalog() });
  }

  async function handleSettingsSave(req, res) {
    const body = await readJsonBody(req, BODY_CAP_SETTINGS);
    if (!isPlainObject(body.settings)) {
      webLog.warn("web.control.reject", { action: "settings-save", reason: "invalid_settings" });
      return sendError(res, 400, "invalid_settings", "Settings must be a JSON object.");
    }
    const next = migrateSettings(body.settings);
    const previous = loadSettings(layout.settingsFile);
    const changed = changedKeyNames(previous, next).slice(0, 100);
    saveSettings(layout.settingsFile, next);
    webLog.info("web.control.settings-save", { changedKeys: changed });
    return sendJson(res, 200, { ok: true, settings: next });
  }

  async function handleSettingsEstimate(req, res) {
    const body = await readJsonBody(req, BODY_CAP_SETTINGS);
    const source = isPlainObject(body.settings)
      ? migrateSettings(body.settings)
      : loadSettings(layout.settingsFile);
    return sendJson(res, 200, { perCandidateBytes: estimateTrafficBytes(source) });
  }

  async function handleSettingsDefaults(req, res) {
    await readJsonBody(req, BODY_CAP_SMALL);
    const next = migrateSettings(structuredClone(DEFAULT_SETTINGS));
    const previous = loadSettings(layout.settingsFile);
    const changed = changedKeyNames(previous, next).slice(0, 100);
    saveSettings(layout.settingsFile, next);
    webLog.info("web.control.settings-save", { changedKeys: changed, defaults: true });
    return sendJson(res, 200, { ok: true, settings: next });
  }

  function handleConfigGet(req, res) {
    const stored = fs.existsSync(layout.secretFile);
    let descriptor = null;
    if (stored) {
      try {
        descriptor = describeVless(parseVlessUri(readSecretFile(layout.secretFile)));
      } catch {
        descriptor = null; // A corrupt store reads as "no usable config", never as an echo.
      }
    }
    sendJson(res, 200, {
      stored,
      protected: stored ? fileIsProtected(layout.secretFile) : false,
      descriptor,
    });
  }

  async function handleConfigImport(req, res) {
    const body = await readJsonBody(req, BODY_CAP_SMALL);
    if (typeof body.uri !== "string" || body.uri.trim() === "") {
      webLog.warn("web.control.reject", { action: "config-import", reason: "invalid_config" });
      return sendError(res, 400, "invalid_config", "Paste a VLESS link.");
    }
    // The terminal import's exact code path (R-09): normalize, parse,
    // capability check, protected write, re-read and re-verify. The
    // URI itself never enters a response or a log record, and neither
    // does the parser's error wording: two of its messages quote the
    // submitted port/transport fragments, and request bodies never
    // appear in error bodies (R-13) — so every failure here maps to
    // one static web-layer message. The terminal surface keeps its
    // detailed wording; only this handler flattens it.
    const normalized = normalizeVlessInput(body.uri);
    let descriptor;
    try {
      const parsed = parseVlessUri(normalized);
      assertWebsocketCapable(parsed);
      writeSecretFile(layout.secretFile, normalized);
      const stored = parseVlessUri(readSecretFile(layout.secretFile));
      assertWebsocketCapable(stored);
      descriptor = describeVless(stored);
    } catch {
      webLog.warn("web.control.reject", { action: "config-import", reason: "invalid_config" });
      return sendError(
        res,
        400,
        "invalid_config",
        "The link could not be imported. Check that it is a complete VLESS WebSocket link.",
      );
    }
    webLog.info("web.control.config-import", { descriptor });
    return sendJson(res, 200, { ok: true, descriptor });
  }

  async function handleConfigRemove(req, res) {
    await readJsonBody(req, BODY_CAP_SMALL);
    if (runs.isActive()) {
      webLog.warn("web.control.reject", { action: "config-remove", reason: "run_active" });
      return sendError(res, 409, "run_active", "A scan is using the configuration.", {
        runId: runs.activeRunId(),
      });
    }
    removeSecretFile(layout.secretFile);
    webLog.info("web.control.config-remove", {});
    return sendJson(res, 200, { ok: true });
  }

  async function handleRunStart(req, res) {
    const body = await readJsonBody(req, BODY_CAP_SMALL);
    try {
      const { runId } = await runs.start({ mode: body.mode, resume: body.resume === true });
      return sendJson(res, 200, { ok: true, runId });
    } catch (error) {
      if (error.code === "run_active") {
        return sendError(res, 409, "run_active", error.message, { runId: error.runId });
      }
      if (error.code === "config_missing" || error.code === "no_resume" || error.code === "bad_mode") {
        return sendError(res, 400, error.code, error.message);
      }
      throw error;
    }
  }

  async function handleRunStop(req, res) {
    await readJsonBody(req, BODY_CAP_SMALL);
    try {
      runs.stop();
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      if (error.code === "no_active_run") return sendError(res, 400, "no_active_run", error.message);
      throw error;
    }
  }

  async function handleServerStop(req, res) {
    await readJsonBody(req, BODY_CAP_SMALL);
    if (runs.isActive()) {
      webLog.warn("web.control.reject", { action: "server-stop", reason: "run_active" });
      return sendError(res, 409, "run_active", "Stop the run first, or close it from the terminal.", {
        runId: runs.activeRunId(),
      });
    }
    sendJson(res, 200, { ok: true });
    // Respond first, then shut down: the host (CLI command or menu)
    // decides through onStopRequest what the process does next.
    setImmediate(() => {
      void stop("user").then(() => {
        if (onStopRequest) onStopRequest();
      });
    });
    return undefined;
  }

  // Results are addressed by the run ids the server itself issued;
  // the on-disk file is found by enumeration, never by joining a
  // client-supplied name into a path (R-15).
  function enumerateReports() {
    let names = [];
    try {
      names = fs.readdirSync(layout.results);
    } catch {
      return [];
    }
    const found = [];
    for (const name of names) {
      const match = /^run-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$/.exec(name);
      if (!match) continue;
      const file = path.join(layout.results, name);
      try {
        const stat = fs.statSync(file);
        found.push({ runId: match[1], file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Vanished between listing and stat: not a report we serve.
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  function readReport(entry) {
    const key = `${entry.runId}:${entry.mtimeMs}:${entry.size}`;
    const cached = reportCache.get(key);
    if (cached) return cached;
    const report = JSON.parse(fs.readFileSync(entry.file, "utf8"));
    reportCache.set(key, report);
    if (reportCache.size > 32) reportCache.delete(reportCache.keys().next().value);
    return report;
  }

  // Scan reports carry no mode field; the run's own log is the
  // authority (its run.start record), read once per server lifetime.
  const logModeCache = new Map();
  function modeFromLog(runId) {
    if (logModeCache.has(runId)) return logModeCache.get(runId);
    let mode = null;
    try {
      const head = fs.readFileSync(path.join(layout.logs, `run-${runId}.ndjson`), "utf8").slice(0, 16384);
      for (const line of head.split("\n")) {
        if (!line.includes('"run.start"')) continue;
        const record = JSON.parse(line);
        if (record.event === "run.start" && typeof record.mode === "string") mode = record.mode;
        break;
      }
    } catch {
      mode = null;
    }
    logModeCache.set(runId, mode);
    return mode;
  }

  function handleReportsList(req, res) {
    const reports = enumerateReports().map((entry) => {
      let mode;
      let finishedAt;
      try {
        const report = readReport(entry);
        mode = report.mode ?? modeFromLog(entry.runId) ?? undefined;
        finishedAt = report.finishedAt ?? undefined;
      } catch {
        mode = modeFromLog(entry.runId) ?? undefined;
      }
      return { runId: entry.runId, mode, finishedAt, size: entry.size };
    });
    sendJson(res, 200, reports);
  }

  function findReport(runId) {
    return enumerateReports().find((entry) => entry.runId === runId) ?? null;
  }

  function handleResult(req, res, runId) {
    if (runId === "latest") {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(layout.results, "latest.json"), "utf8"));
        return sendJson(res, 200, report);
      } catch {
        return sendError(res, 404, "not_found", "No results yet.");
      }
    }
    const entry = findReport(runId);
    if (!entry) return sendError(res, 404, "not_found", "Unknown run.");
    try {
      return sendJson(res, 200, readReport(entry));
    } catch {
      return sendError(res, 404, "not_found", "Unknown run.");
    }
  }

  function handleReportDownload(req, res, runId) {
    const entry = findReport(runId);
    if (!entry) return sendError(res, 404, "not_found", "Unknown run.");
    applySecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="run-${entry.runId}.json"`,
      "Content-Length": entry.size,
    });
    fs.createReadStream(entry.file).pipe(res);
    return undefined;
  }

  function handleReportBestIps(req, res, runId) {
    const entry = findReport(runId);
    if (!entry) return sendError(res, 404, "not_found", "Unknown run.");
    let report;
    try {
      report = readReport(entry);
    } catch {
      return sendError(res, 404, "not_found", "Unknown run.");
    }
    applySecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="best-ips.txt"',
    });
    res.end(`${renderTopList(report.results ?? [])}\n`);
    return undefined;
  }

  function handleBlock(req, res, indexText) {
    if (!/^\d+$/.test(indexText)) return sendError(res, 404, "not_found", "Unknown block.");
    const detail = state.tracker.blockDetail(Number(indexText));
    if (!detail) return sendError(res, 404, "not_found", "Unknown block.");
    return sendJson(res, 200, detail);
  }

  async function handleSystem(req, res) {
    const facts = runs.statusFacts();
    let settings = null;
    try {
      settings = loadSettings(layout.settingsFile);
    } catch {
      settings = null;
    }
    const located = settings ? locateXray(settings, layout) : { found: false, path: null };
    const version = located.found ? await xrayVersion(located.path).catch(() => null) : null;
    let catalogLine = "unavailable";
    try {
      const catalog = state.tracker.catalog();
      catalogLine = `${catalog.rangesTotal} ranges · ${catalog.blocksTotal} blocks`;
    } catch {
      catalogLine = "unavailable";
    }
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
    sendJson(res, 200, {
      rows: [
        {
          component: "Config",
          value: facts.configReady
            ? fileIsProtected(layout.secretFile)
              ? "stored · protected"
              : "stored · check permissions"
            : "not imported",
          ok: facts.configReady,
        },
        { component: "Node.js", value: process.version, ok: nodeMajor >= 20 },
        { component: "Platform", value: `${process.platform}-${process.arch}`, ok: true },
        {
          component: "Xray",
          value: located.found ? (version ?? "found") : "not found — tunnel stages will be skipped",
          ok: located.found,
        },
        { component: "Catalog", value: catalogLine, ok: catalogLine !== "unavailable" },
        {
          component: "Verification",
          value: facts.verifyEnabled ? "SPRT enabled" : "disabled",
          ok: true,
        },
      ],
    });
  }

  function enumerateLogs() {
    let names = [];
    try {
      names = fs.readdirSync(layout.logs);
    } catch {
      return [];
    }
    const found = [];
    for (const name of names) {
      if (!/^run-[0-9a-fA-F-]+\.ndjson$/.test(name)) continue;
      try {
        const stat = fs.statSync(path.join(layout.logs, name));
        found.push({ name, size: stat.size, modified: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs });
      } catch {
        // Vanished mid-listing: skip.
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  function handleLogsList(req, res) {
    sendJson(
      res,
      200,
      enumerateLogs().map(({ name, size, modified }) => ({ name, size, modified })),
    );
  }

  function handleLogSummary(req, res, name) {
    const entry = enumerateLogs().find((item) => item.name === name);
    if (!entry) return sendError(res, 404, "not_found", "Unknown log.");
    const digest = summarizeLogFile(path.join(layout.logs, entry.name));
    return sendJson(res, 200, {
      name: entry.name,
      total: digest.total,
      errors: digest.byLevel.error ?? 0,
      warnings: digest.byLevel.warn ?? 0,
      byLevel: digest.byLevel,
      endStatus: digest.endStatus,
      lastPhase: digest.lastPhase,
      lastProgress: digest.lastProgress,
      lastRecordAt: digest.lastRecordAt,
      hasRunStart: digest.hasRunStart,
      mode: digest.mode,
      appVersion: digest.appVersion,
      phases: digest.phases,
      calibration: digest.calibration,
      reputation: digest.reputation,
      errorEvents: digest.errors,
      slowestEvents: digest.slowest,
    });
  }

  // -- Dispatch --------------------------------------------------------------

  const routes = [
    ["GET", /^\/api\/state$/, (req, res) => handleState(req, res)],
    ["GET", /^\/api\/events$/, (req, res, match, url) => handleEvents(req, res, url)],
    ["GET", /^\/api\/catalog$/, (req, res) => handleCatalog(req, res)],
    ["GET", /^\/api\/settings$/, (req, res) => handleSettingsGet(req, res)],
    ["POST", /^\/api\/settings$/, (req, res) => handleSettingsSave(req, res)],
    ["POST", /^\/api\/settings\/estimate$/, (req, res) => handleSettingsEstimate(req, res)],
    ["POST", /^\/api\/settings\/defaults$/, (req, res) => handleSettingsDefaults(req, res)],
    ["POST", /^\/api\/run$/, (req, res) => handleRunStart(req, res)],
    ["POST", /^\/api\/run\/stop$/, (req, res) => handleRunStop(req, res)],
    ["POST", /^\/api\/server\/stop$/, (req, res) => handleServerStop(req, res)],
    ["GET", /^\/api\/config$/, (req, res) => handleConfigGet(req, res)],
    ["POST", /^\/api\/config$/, (req, res) => handleConfigImport(req, res)],
    ["POST", /^\/api\/config\/remove$/, (req, res) => handleConfigRemove(req, res)],
    ["GET", /^\/api\/results\/([A-Za-z0-9-]+)$/, (req, res, match) => handleResult(req, res, match[1])],
    ["GET", /^\/api\/reports$/, (req, res) => handleReportsList(req, res)],
    ["GET", /^\/api\/reports\/([A-Za-z0-9-]+)\/download$/, (req, res, match) => handleReportDownload(req, res, match[1])],
    ["GET", /^\/api\/reports\/([A-Za-z0-9-]+)\/best-ips$/, (req, res, match) => handleReportBestIps(req, res, match[1])],
    ["GET", /^\/api\/block\/([^/]+)$/, (req, res, match) => handleBlock(req, res, match[1])],
    ["GET", /^\/api\/system$/, (req, res) => handleSystem(req, res)],
    ["GET", /^\/api\/logs$/, (req, res) => handleLogsList(req, res)],
    ["GET", /^\/api\/logs\/([^/]+)\/summary$/, (req, res, match) => handleLogSummary(req, res, match[1])],
  ];

  // R-04/R-05: the one-time bootstrap exchange — one token, one
  // comparison, one cookie, one shared failure counter, whichever
  // spelling carried the key (Shield C1). The token never appears
  // in a response again: the 302 target is the clean URL and the
  // body is empty.
  function exchangeBootstrap(req, res, candidate) {
    if (safeEqual(candidate, token)) {
      webLog.info("web.auth.bootstrap", {});
      applySecurityHeaders(res);
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return res.end();
    }
    logAuthFail("session", req.method);
    return sendError(res, 403, "forbidden", "Forbidden");
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;

    // R-06: the Host authority must be exactly the one the server
    // bound — before routing, before auth, on every request. The
    // server never builds anything from the request's Host.
    if (req.headers.host !== expectedHost()) {
      logAuthFail("host", req.method);
      return sendError(res, 403, "forbidden", "Forbidden");
    }

    // The query spelling of the bootstrap: a correct token in the
    // query is exchanged for the session cookie.
    if (req.method === "GET" && pathname === "/" && url.searchParams.has("t")) {
      return exchangeBootstrap(req, res, url.searchParams.get("t"));
    }

    // The path spelling, delivered only to the Android opener
    // (Shield C2, C5): the raw segment is compared as-is — no
    // decoding step exists, so an encoded or malformed segment
    // simply fails the comparison. The route serves nothing; it
    // only performs the same exchange. Every other /t/ shape
    // (missing segment, extra segments, trailing slash) is not
    // this route and falls through to the unknown-route refusal.
    const pathKey = req.method === "GET" ? /^\/t\/([^/]+)$/.exec(pathname) : null;
    if (pathKey) {
      return exchangeBootstrap(req, res, pathKey[1]);
    }

    const isApi = pathname.startsWith("/api/");
    const asset = req.method === "GET" ? assets.get(pathname) : undefined;
    if (!isApi && !asset) {
      logReject("unknown-route", req.method);
      return sendError(res, 404, "not_found", "Not found");
    }

    // R-03: every route — static and API alike — requires the session.
    if (!sessionFrom(req)) {
      logAuthFail("session", req.method);
      // Option B: a session-less top-level navigation to the shell
      // gets the fixed landing page instead of the machine-readable
      // refusal — same 403, same security headers, no data either
      // way. Asset and API paths keep the JSON shape exactly.
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        applySecurityHeaders(res);
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(LANDING_PAGE);
      }
      return sendError(res, 403, "forbidden", "Forbidden");
    }

    if (asset) {
      applySecurityHeaders(res);
      res.writeHead(200, { "Content-Type": asset.type });
      return res.end(asset.body);
    }

    // R-07: mutations need the session (above), the custom header,
    // and an exact Origin match when an Origin is sent. No CORS
    // headers exist anywhere in this server (R-08); a preflight is
    // just an unsupported method, answered by the routing layer's
    // 405 below — never with an allowance.
    if (req.method === "POST") {
      if (req.headers[REQUEST_HEADER] !== "1") {
        logAuthFail("header", req.method);
        return sendError(res, 403, "forbidden", "Forbidden");
      }
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== origin()) {
        logAuthFail("origin", req.method);
        return sendError(res, 403, "forbidden", "Forbidden");
      }
    }

    let pathMatched = false;
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      return handler(req, res, match, url);
    }
    if (pathMatched) {
      logReject("method", req.method);
      return sendError(res, 405, "method_not_allowed", "Method not allowed");
    }
    logReject("unknown-route", req.method);
    return sendError(res, 404, "not_found", "Not found");
  }

  async function onRequest(req, res) {
    // R-17: a throwing handler kills neither the server nor a run.
    try {
      await dispatch(req, res);
    } catch (error) {
      webLog.error("web.serve.error", {
        error: { class: error?.name ?? "Error", message: error?.message ?? "unknown" },
      });
      if (!res.headersSent) {
        const status = error?.httpStatus ?? 500;
        // Only this layer's own deliberate HTTP errors may surface
        // their code; anything else (fs errors carry codes like
        // ENOENT) collapses to the one static 500 shape (R-13).
        sendError(
          res,
          status,
          status === 500 ? "internal" : (error?.code ?? "internal"),
          status === 500 ? "Internal error" : error.message,
        );
      } else {
        try {
          res.end();
        } catch {
          // Already gone.
        }
      }
    }
  }

  function tryListen(port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, BIND_HOST);
    });
  }

  async function start({ openBrowser = false } = {}) {
    if (server) throw new Error("web server already started");
    server = http.createServer((req, res) => {
      void onRequest(req, res);
    });
    try {
      await tryListen(WEB_PORT);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      // R-01: the preferred port is taken — fall back to an ephemeral
      // one and report the truth from address(), never the hope.
      await tryListen(0);
    }
    boundPort = server.address().port;
    webLog.info("web.start", { port: boundPort, bind: BIND_HOST });
    const url = `http://${BIND_HOST}:${boundPort}/`;
    const bootstrapUrl = `${url}?t=${token}`;
    // The path spelling of the same key, returned for the Android
    // opener only (Shield C5): it is never printed and never
    // logged — the printed link stays the query form everywhere.
    const bootstrapPathUrl = `${url}t/${token}`;
    if (openBrowser) {
      await openInBrowser(
        bootstrapUrlForPlatform(process.platform, { bootstrapUrl, bootstrapPathUrl }),
      );
    }
    return { port: boundPort, url, bootstrapUrl, bootstrapPathUrl };
  }

  async function stop(reason = "shutdown") {
    if (!server || stopped) return;
    stopped = true;
    webLog.info("web.stop", { reason });
    for (const res of sseResponses) {
      try {
        res.end();
      } catch {
        // Already gone.
      }
    }
    sseResponses.clear();
    const closed = new Promise((resolve) => server.close(() => resolve()));
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    await webLog.close();
  }

  return {
    start,
    stop,
    state,
    runs,
    get port() {
      return boundPort;
    },
    get origin() {
      return boundPort ? origin() : null;
    },
  };
}
