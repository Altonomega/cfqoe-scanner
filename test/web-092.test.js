// 0.9.2 web fix wave — reproduction rig first, pins second.
//
// Unlike the canned harnesses in web-clarity/web-ui-live, this one
// wires the shipped app.js (in a vm) to a REAL web server: fetch is
// real HTTP with the bootstrap session cookie, EventSource is a real
// SSE consumer, and the settings form's HTML is parsed into a mini
// DOM so the exact user actions — toggle a setting, click Save,
// start a run, switch views, watch it end — are exercised end to
// end, with the settings file on disk as the ground truth.
//
// Pins:
//  D5  Settings save: the happy path lands on disk; a refusal names
//      the invalid fields, opens their collapsed group, and moves
//      focus/scroll to the first one (a refusal the user cannot
//      see is a refusal that looks like a dead button).
//  D6a A run that ends while a non-run view (Settings) is mounted
//      must flip the banner to its terminal state by itself —
//      Mahan's standing rule: no manual refresh, ever.
//  D6c Late-entering views backfill from the log ring: Diagnostics'
//      tail and the scan journal show the finished run's records
//      after it ended, not an empty pane.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { ensureDirectories, writeSecretFile } from "../src/platform/paths.js";
import { loadSettings, saveSettings } from "../src/config/settings.js";
import { createWebServer } from "../src/web/server.js";

const APP_JS = fs.readFileSync(fileURLToPath(new URL("../src/web/public/app.js", import.meta.url)), "utf8");
const RANGES_FILE = fileURLToPath(new URL("../config/cloudflare-ipv4.txt", import.meta.url));
const WORKLOADS_FILE = fileURLToPath(new URL("../config/workloads.default.json", import.meta.url));
const TEST_UUID = "11111111-2222-3333-4444-555555555555";

/* ---------------- mini DOM ---------------- */
class FakeEl {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.handlers = {};
    this.attrs = {};
    this.classList = {
      _set: new Set(),
      add: (...cs) => cs.forEach((c) => this.classList._set.add(c)),
      remove: (...cs) => cs.forEach((c) => this.classList._set.delete(c)),
      toggle: (c, on) => (on ? this.classList._set.add(c) : this.classList._set.delete(c)),
      contains: (c) => this.classList._set.has(c),
    };
    this._bySel = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.clientWidth = 300;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.focused = false;
    this.scrolledIntoView = false;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  removeEventListener() {}
  appendChild(child) { this.children.push(child); return child; }
  querySelector(sel) {
    if (!this._bySel.has(sel)) this._bySel.set(sel, new FakeEl());
    return this._bySel.get(sel);
  }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolledIntoView = true; }
  closest(sel) { return sel === "details" ? (this._details ?? null) : null; }
  remove() {}
  after() {}
  click() { (this.handlers.click || []).forEach((fn) => fn({ currentTarget: this, preventDefault() {} })); }
  getContext() { return new Proxy({}, { get: () => () => {} }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 26 }; }
}

const unescapeHtml = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function parseAttrs(str) {
  const attrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)(?:="([^"]*)")?/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = m[2] === undefined ? true : unescapeHtml(m[2]);
  return attrs;
}
const datasetKey = (name) => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Parse the settings form's HTML into registered fake elements:
// inputs/selects/buttons in document order, ids addressable, and
// elements inside <details> knowing their (closed) details parent.
function parseSettingsForm(doc, html) {
  doc._byId.clear();
  doc._formEls = [];
  doc._details = Object.assign(new FakeEl("details"), { open: false });
  let depth = 0;
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*")*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const slash = m[1] === "/", name = m[2].toLowerCase(), attrStr = m[3];
    if (name === "details") { depth += slash ? -1 : 1; continue; }
    if (slash) continue;
    const attrs = parseAttrs(attrStr);
    if (name === "form") { doc._formEl = new FakeEl("form"); continue; }
    if (name !== "input" && name !== "select" && name !== "button") continue;
    const el = new FakeEl(name);
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) el.dataset[datasetKey(k)] = v;
    if (attrs.id) { el.id = attrs.id; doc._byId.set(attrs.id, el); }
    if (depth > 0) el._details = doc._details;
    if (name === "input") {
      el.type = attrs.type || "text";
      el.value = attrs.value === true || attrs.value === undefined ? "" : attrs.value;
      el.checked = attrs.checked === true;
    } else if (name === "select") {
      const close = html.indexOf("</select>", tagRe.lastIndex);
      const inner = html.slice(tagRe.lastIndex, close === -1 ? undefined : close);
      const opts = [...inner.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)]
        .map((o) => ({ attrs: parseAttrs(o[1]), text: unescapeHtml(o[2]) }));
      const sel = opts.find((o) => o.attrs.selected === true) || opts[0];
      el.value = sel ? sel.text : "";
      if (close !== -1) tagRe.lastIndex = close + "</select>".length;
    } else {
      el.type = attrs.type || "submit";
    }
    doc._formEls.push(el);
  }
}

class FormHostEl extends FakeEl {
  constructor(doc) { super("div"); this._doc = doc; this._html = ""; }
  set innerHTML(html) { this._html = html; if (html && this._doc) parseSettingsForm(this._doc, html); }
  get innerHTML() { return this._html; }
}

function makeDocument() {
  const generic = new Map();
  const genericFor = (sel) => {
    if (!generic.has(sel)) generic.set(sel, new FakeEl());
    return generic.get(sel);
  };
  const doc = {
    _byId: new Map(),
    _formEls: [],
    _formEl: null,
    _details: null,
    documentElement: Object.assign(new FakeEl("html"), { lang: "en", dir: "ltr" }),
    body: new FakeEl("body"),
    hidden: false,
    addEventListener() {},
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
    querySelector(sel) {
      if (sel === "#set-body") return doc._setBody;
      if (sel === "#set-form" && doc._formEl) return doc._formEl;
      if (sel.startsWith("#") && doc._byId.has(sel.slice(1))) return doc._byId.get(sel.slice(1));
      return genericFor(sel);
    },
    querySelectorAll(sel) {
      if (sel === "#set-form [data-path]") return doc._formEls.filter((i) => i.dataset.path);
      if (sel === "#set-form [data-wl]") return doc._formEls.filter((i) => i.dataset.wl);
      if (sel === "#set-form [data-custom-add]") return doc._formEls.filter((i) => i.dataset.customAdd);
      if (sel === "#set-form [data-custom-del]") return doc._formEls.filter((i) => i.dataset.customDel);
      return [];
    },
  };
  doc._setBody = new FormHostEl(doc);
  return doc;
}

/* ---------------- real transport ---------------- */
function rawHttp({ port, method = "GET", path: requestPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function makeEventSourceClass({ port, cookie, dropFrame }) {
  return class RealEventSource {
    constructor(url) {
      this.listeners = {};
      const full = new URL(url, `http://127.0.0.1:${port}`);
      this.req = http.get(
        { host: "127.0.0.1", port, path: full.pathname + full.search, headers: { cookie }, agent: false },
        (res) => {
          if (this.onopen) this.onopen();
          let buffer = "";
          res.on("data", (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const type = /event: (\S+)/.exec(frame)?.[1];
              const dataLine = /data: (.*)/s.exec(frame)?.[1];
              if (!type || !dataLine) continue;
              if (dropFrame && dropFrame(type, dataLine)) continue; // a frame lost on the wire
              (this.listeners[type] || []).forEach((fn) => fn({ data: dataLine }));
            }
          });
        },
      );
      this.req.on("error", () => { if (this.onerror) this.onerror(); });
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    close() { this.req.destroy(); }
  };
}

class StubEventSource {
  addEventListener() {}
  close() {}
}

// Canned mode: no server at all — fetch answers from fixtures, the
// event stream stays silent, and the app runs on snapshots alone.
// For view-level pins (D3/D4/D6b/D7) that do not need a real run.
function cannedFetch(canned) {
  return async (url) => {
    const p = new URL(url, "http://127.0.0.1").pathname;
    let body = {};
    if (p === "/api/state") body = canned.snapshot;
    else if (p === "/api/settings") body = canned.settings ?? { settings: {}, catalog: null };
    else if (p.startsWith("/api/results/")) body = canned.results ?? {};
    else if (p === "/api/catalog") throw new Error("no catalog");
    return { ok: true, status: 200, json: async () => body };
  };
}

function makeHarness({ port, cookie, dropFrame, canned }) {
  const document = makeDocument();
  const storage = new Map();
  const harness = {};
  const fetchImpl = canned ? cannedFetch(canned) : async (url, opts = {}) => {
    const full = new URL(url, `http://127.0.0.1:${port}`);
    const headers = { cookie, ...(opts.headers || {}) };
    const res = await rawHttp({ port, method: opts.method || "GET", path: full.pathname + full.search, headers, body: opts.body ?? null });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => JSON.parse(res.body),
    };
  };
  const sandbox = {
    console,
    document,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    location: { search: "", pathname: "/", hash: "", href: `http://127.0.0.1:${port}/` },
    history: { replaceState() {} },
    navigator: { language: "en" },
    innerWidth: 1200,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: () => ({ getPropertyValue: () => "monospace" }),
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    EventSource: canned ? StubEventSource : makeEventSourceClass({ port, cookie, dropFrame }),
    AbortController,
    URLSearchParams,
    URL,
    Blob,
    atob,
    btoa,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; },
    clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    performance,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(APP_JS, ctx, { filename: "app.js" });
  harness.ctx = ctx;
  harness.document = document;
  harness.location = sandbox.location;
  harness.el = (sel) => document.querySelector(sel);
  harness.eval = (expr) => vm.runInContext(expr, ctx);
  harness.formInput = (p) => document._formEls.find((i) => i.dataset.path === p);
  harness.goto = (hash) => { sandbox.location.hash = hash; harness.eval("route()"); };
  return harness;
}

/* ---------------- server fixture ---------------- */
async function startTestServer({ scan = false } = {}) {
  let blackhole = null;
  const sockets = new Set();
  let rangesText = null;
  if (scan) {
    blackhole = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => blackhole.listen(18543, "0.0.0.0", resolve));
    const ranges = [];
    for (let i = 0; i < 300; i += 1) ranges.push(`127.${(i >> 8) & 255}.${i & 255}.0/24`);
    rangesText = `${ranges.join("\n")}\n`;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfqoe-092-"));
  const layout = ensureDirectories(root);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  if (rangesText === null) fs.copyFileSync(RANGES_FILE, layout.rangesFile);
  else fs.writeFileSync(layout.rangesFile, rangesText);
  fs.copyFileSync(WORKLOADS_FILE, layout.workloadsFile);
  if (scan) {
    writeSecretFile(
      layout.secretFile,
      `vless://${TEST_UUID}@edge.example.com:18543?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#test`,
    );
    const s = loadSettings(layout.settingsFile);
    s.calibration.enabled = false;
    s.scan.timeoutMs = 300;
    s.scan.delayedRetry.enabled = false;
    saveSettings(layout.settingsFile, s);
  }
  const api = createWebServer({ layout });
  const { port, bootstrapUrl } = await api.start();
  const bootUrl = new URL(bootstrapUrl);
  const boot = await rawHttp({ port, path: `${bootUrl.pathname}${bootUrl.search}` });
  const cookie = (boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.ok(cookie, "bootstrap issued a session cookie");
  return {
    api, layout, port, cookie, root,
    async stop() {
      await api.stop("test");
      if (blackhole) {
        for (const s of sockets) s.destroy();
        await new Promise((resolve) => blackhole.close(resolve));
      }
    },
  };
}

const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
// The UI wraps LTR tokens (numbers, IPs) in bidi isolates inside
// localized text — by design. Assertions compare the plain text.
const plain = (s) => String(s).replace(/[\u2066-\u2069]/g, "");
async function until(fn, ms = 30000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`until: timed out waiting for ${what}`);
    await flush(100);
  }
}

async function bootApp(server) {
  const h = makeHarness(server);
  await until(() => h.eval("app.conn") === "live", 10000, "app to connect live");
  await until(() => h.eval("app.viewName") === "dashboard", 10000, "dashboard to mount");
  return h;
}

/* ---------------- D5: settings save ---------------- */
test("D5: toggling calibration.enabled off and clicking Save lands on disk with the saved notice", async () => {
  const server = await startTestServer();
  try {
    const h = await bootApp(server);
    h.goto("#/settings");
    await until(() => h.formInput("calibration.enabled"), 10000, "settings form to build");
    const toggle = h.formInput("calibration.enabled");
    assert.equal(toggle.checked, true, "calibration starts enabled (the served default)");
    toggle.checked = false;
    h.el("#set-save").click();
    await until(() => h.el("#notice").textContent === "Settings saved.", 10000, "the saved notice");
    const onDisk = loadSettings(server.layout.settingsFile);
    assert.equal(onDisk.calibration.enabled, false, "the settings file on disk reflects the toggle");
  } finally {
    await server.stop();
  }
});

test("D5: a refused save names the invalid field, opens its collapsed group, and focuses it", async () => {
  const server = await startTestServer();
  try {
    const h = await bootApp(server);
    h.goto("#/settings");
    await until(() => h.formInput("calibration.enabled"), 10000, "settings form to build");
    // Establish a known-good saved state first.
    h.formInput("calibration.enabled").checked = false;
    h.el("#set-save").click();
    await until(() => h.el("#notice").textContent === "Settings saved.", 10000, "baseline save");
    const before = fs.readFileSync(server.layout.settingsFile, "utf8");
    // Rebuild the form from the saved state, then break a field that
    // lives inside the collapsed Advanced <details>. (Wait for the
    // REBUILT form: the old form's elements stay addressable until
    // the new load lands, and a stale element would test nothing.)
    const staleField = h.formInput("calibration.latencyInflationLimit");
    h.goto("#/dashboard");
    h.goto("#/settings");
    await until(() => h.formInput("calibration.latencyInflationLimit") && h.formInput("calibration.latencyInflationLimit") !== staleField,
      10000, "form to rebuild");
    const field = h.formInput("calibration.latencyInflationLimit");
    const goodValue = field.value;
    field.value = "not-a-number";
    h.el("#set-save").click();
    await flush(300);
    const notice = h.el("#notice").textContent;
    assert.ok(notice.includes("calibration.latencyInflationLimit"),
      `the refusal notice names the invalid field (got: "${notice}")`);
    assert.equal(fs.readFileSync(server.layout.settingsFile, "utf8"), before,
      "a refused save writes nothing");
    assert.ok(field.classList.contains("invalid"), "the invalid field is marked");
    assert.equal(h.document._details.open, true, "the collapsed group containing the field is opened");
    assert.ok(field.scrolledIntoView, "the first invalid field is scrolled into view");
    assert.ok(field.focused, "the first invalid field is focused");
    // Correcting the value and saving again must succeed.
    field.value = goodValue;
    h.el("#set-save").click();
    await until(() => h.el("#notice").textContent === "Settings saved.", 10000, "save after correction");
    assert.equal(loadSettings(server.layout.settingsFile).calibration.enabled, false,
      "the corrected save lands on disk");
  } finally {
    await server.stop();
  }
});

/* ---------------- D6a + D6c: run lifecycle across views ---------------- */
test("D6a/D6c: a run ending while Settings is mounted flips the banner; late views backfill the log", async () => {
  const server = await startTestServer({ scan: true });
  try {
    const h = await bootApp(server);
    await h.eval("startRun('quick')");
    await until(() => h.eval("app.runStatus") === "running", 10000, "run to start");
    // The user walks away to Settings while the run finishes.
    h.goto("#/settings");
    await until(() => h.formInput("calibration.enabled"), 10000, "settings form to build");
    await until(() => h.eval("app.runStatus") !== "running", 90000,
      `run to reach a terminal state in the app (still "${h.eval("app.runStatus")}", banner hidden=${h.el("#run-banner").hidden}, text="${h.el("#rb-text").textContent}")`);
    assert.equal(h.eval("app.runStatus"), "complete", "the run completed naturally");
    await until(() => h.el("#run-banner").hidden === true, 5000,
      `the banner leaves the running state by itself (text was "${h.el("#rb-text").textContent}")`);

    // D6c: Diagnostics, entered only now, must show the run's tail.
    h.goto("#/diagnostics");
    await until(() => h.el("#dg-tail").innerHTML.includes("run.start"), 10000,
      "diagnostics tail to backfill the finished run's records");
    assert.ok(!h.el("#dg-tail").innerHTML.includes("The tail is quiet"),
      "the tail is not the empty placeholder after a finished run");

    // D6c: the scan journal, entered only now, must narrate the run.
    h.goto("#/scan/quick");
    await until(() => h.el("#sc-journal").innerHTML.includes("Scan started"), 10000,
      "scan journal to backfill the finished run's narration");

    // D7a in place: the console itself shows the finished run's
    // outcome — the all-unmeasured headline — with no navigation.
    await until(() => h.el("#sc-results").innerHTML.includes("none responded"), 10000,
      "console to render the finished run's headline in place");
  } finally {
    await server.stop();
  }
});

/* ---------------- D6a: the lost terminal frame ---------------- */
test("D6a: a lost terminal frame cannot freeze the banner — the watchdog resyncs the truth", async () => {
  const server = await startTestServer({ scan: true });
  try {
    // The terminal run-state frame is lost on the wire; every other
    // frame arrives. After it, the stream goes quiet — exactly the
    // conditions of Mahan's frozen "Running · 06:10" banner.
    const h = makeHarness({
      ...server,
      dropFrame: (type, data) => type === "run-state" && data.includes('"complete"'),
    });
    await until(() => h.eval("app.conn") === "live", 10000, "app to connect live");
    await until(() => h.eval("app.viewName") === "dashboard", 10000, "dashboard to mount");
    await h.eval("startRun('quick')");
    await until(() => h.eval("app.runStatus") === "running", 10000, "run to start");
    h.goto("#/settings");
    // Wait for the run to be over server-side (report written).
    await until(async () => {
      const res = await rawHttp({ port: server.port, path: "/api/state", headers: { cookie: server.cookie } });
      return JSON.parse(res.body).latest?.runId;
    }, 60000, "run to finish server-side");
    await flush(2000);
    assert.equal(h.eval("app.runStatus"), "running",
      "with the terminal frame lost, the client still believes the run is live (the defect)");
    assert.equal(h.el("#run-banner").hidden, false, "the banner still shows the run");
    // …and then, with no refresh and no view change, the watchdog
    // must fetch the truth and put the banner away by itself.
    await until(() => h.eval("app.runStatus") === "complete" && h.el("#run-banner").hidden === true, 40000,
      "watchdog to resync the terminal state and hide the banner");
  } finally {
    await server.stop();
  }
});

/* ---------------- canned fixtures ---------------- */
const cannedSnapshot = (over = {}) => ({
  server: { version: "0.9.2", platform: "linux-x64", startedAt: "2026-11-21T00:00:00.000Z" },
  status: { configReady: true, xrayFound: true, verifyEnabled: true, resumeAvailable: false },
  genome: null, run: null, latest: null, ...over,
});
const measuredRow = (ip, label = "good") => ({
  ip, block: "1.1.1.0/24",
  eligibility: { successes: 3, attempts: 3, successRate: 1, confidence95: { lower: 0.44 }, pops: { dominant: "FRA" } },
  scores: { browsing: 80, streaming: 70, load: 60, reliability: 100, overall: 75, conservative: 72, overallUncapped: 78, conservativeUncapped: 74, reliabilityLower95: 44 },
  verdict: { label, summary: "" }, gates: { status: "pass", limiting: null }, limitingFactor: null,
  measurement: { status: "complete", completeness: 1 }, load: { sustainedMbps: 12.5, rpm: 40 }, streaming: null, browsing: null,
});
const measuredReport = {
  runId: "run-d7", mode: "full", finishedAt: "2026-11-21T00:10:00.000Z",
  totals: { candidates: 2, eligible: 2, complete: 2, partial: 0, unmeasured: 0 },
  results: [measuredRow("1.1.1.1", "recommended"), measuredRow("1.1.1.2")],
};
const unmeasuredReport = {
  runId: "run-d6b", mode: "full", finishedAt: "2026-11-21T00:10:00.000Z",
  totals: { candidates: 120, eligible: 0, complete: 0, partial: 0, unmeasured: 120 },
  results: ["1.1.1.1", "1.1.1.2"].map((ip) => ({
    ip, eligibility: { successes: 0, attempts: 3 }, scores: {}, verdict: null, gates: null,
    measurement: { status: "unmeasured" }, load: null,
  })),
};
async function bootCanned(canned) {
  const h = makeHarness({ canned });
  await until(() => h.eval("app.viewName") === "dashboard", 10000, "dashboard to mount");
  return h;
}

/* ---------------- D3: resume line from snapshot.resume ---------------- */
test("D3: the resume line renders the checkpoint's phase word and probe count, never the raw key", async () => {
  const withResume = (resume, topLevel = false) => cannedSnapshot(topLevel
    ? { resume, status: { configReady: true, xrayFound: true, verifyEnabled: true, resumeAvailable: true } }
    : { status: { configReady: true, xrayFound: true, verifyEnabled: true, resumeAvailable: true, resume } });
  const h = await bootCanned({ snapshot: withResume({ phase: "primer", probesSpent: 23091 }), results: {} });
  await flush(150);
  const line = () => h.el("#d-resume").innerHTML;
  assert.ok(line().includes("Primers"), `primer renders its UI word: ${line()}`);
  assert.ok(line().includes("23,091"), `the checkpoint's probe count renders: ${line()}`);
  assert.ok(!line().includes("phase."), `no raw key anywhere: ${line()}`);
  const cases = [
    ["coverage", "Proofreading"], ["expansion", "Replication forks"], ["finalize", "Final QoE"],
    ["hard-primer", "Primers"], ["hard-retry", "Delayed retries"], ["hard-verify", "Verifying finalists"],
    ["calibrating", "Calibrating"],
  ];
  for (const [stored, word] of cases) {
    h.eval(`app.applySnapshot(${JSON.stringify(withResume({ phase: stored, probesSpent: 7 }))})`);
    assert.ok(line().includes(word), `stored "${stored}" renders "${word}": ${line()}`);
    assert.ok(!line().includes("phase."), `stored "${stored}" never leaks a raw key: ${line()}`);
  }
  // The contract may also land at the snapshot's top level.
  h.eval(`app.applySnapshot(${JSON.stringify(withResume({ phase: "expansion", probesSpent: 9 }, true))})`);
  assert.ok(line().includes("Replication forks"), `top-level resume renders: ${line()}`);
  // Unknown stored value: plain words, never the raw key.
  h.eval(`app.applySnapshot(${JSON.stringify(withResume({ phase: "mystery", probesSpent: 3 }))})`);
  assert.ok(line().includes("an unspecified phase"), `unknown phase gets plain words: ${line()}`);
  assert.ok(!line().includes("mystery"), `the raw stored value never prints: ${line()}`);
  // No resume facts: no line — but the Resume button is still offered.
  h.eval(`app.applySnapshot(${JSON.stringify(withResume(undefined))})`);
  assert.ok(!line().includes("probes spent"), `no facts, no line: ${line()}`);
  assert.ok(line().includes("d-resume-btn"), "the resume button survives missing facts");
});

/* ---------------- D4: calibrating wording + hunt ---------------- */
test("D4: the calibrating note is honest about slow paths, and hunt progress renders plainly", async () => {
  const h = await bootCanned({ snapshot: cannedSnapshot(), results: {} });
  h.goto("#/scan/full");
  h.eval("app.runStatus = 'running'; app.runMode = 'full'; app.phase = 'calibrating';");
  h.eval("app.onEvent('counters', { total: 1, completed: 0 })");
  const now = () => plain(h.el("#sc-now").innerHTML);
  assert.ok(now().includes("several minutes"), `the note no longer promises a minute: ${now()}`);
  assert.ok(!now().includes("up to a minute"), `the false promise is gone: ${now()}`);
  h.eval("app.onEvent('counters', { total: 32, completed: 5, hunt: true })");
  assert.ok(now().includes("control probe 5 of 32"), `hunt progress renders as control probes: ${now()}`);
});

/* ---------------- D6b: results view, all-unmeasured ---------------- */
test("D6b: an all-unmeasured report presents the plain headline with the run's totals", async () => {
  const h = await bootCanned({ snapshot: cannedSnapshot(), results: unmeasuredReport });
  h.goto("#/results");
  await until(() => h.el("#res-body").innerHTML.includes("none responded"), 10000, "headline to render");
  const html = h.el("#res-body").innerHTML;
  assert.ok(plain(html).includes("120 candidates — none responded"), `the headline carries the count: ${plain(html).slice(0, 200)}`);
  assert.ok(html.includes("candidates <b>120</b>"), "the totals line still shows the run's numbers");
  assert.ok(!html.includes("<table"), "no empty table is dressed up as a result");
});

test("D6b: a mixed report still renders its table (the headline is only for all-unmeasured)", async () => {
  const h = await bootCanned({ snapshot: cannedSnapshot(), results: measuredReport });
  h.goto("#/results");
  await until(() => h.el("#res-body").innerHTML.includes("<table"), 10000, "table to render");
  assert.ok(!h.el("#res-body").innerHTML.includes("none responded"), "no headline over measured results");
});

/* ---------------- D7a/D7b: the console at terminal state ---------------- */
test("D7b: the console ledger renders the run's final rows instead of the empty-stage copy", async () => {
  const h = await bootCanned({ snapshot: cannedSnapshot(), results: measuredReport });
  h.goto("#/scan/full");
  h.eval(`app.onEvent('candidate', { row: ${JSON.stringify(measuredRow("1.1.1.1"))} })`);
  const html = h.el("#sc-ledger").innerHTML;
  assert.ok(html.includes("1.1.1.1"), `the finished candidate is in the ledger: ${html.slice(0, 200)}`);
  assert.ok(html.includes("3/3"), "its real eligibility count shows");
  assert.ok(!html.includes("No candidates have completed"), "the empty-stage copy is gone at terminal state");
});

test("D7a: at natural completion the ranked table appears in the console without navigation", async () => {
  const h = await bootCanned({ snapshot: cannedSnapshot(), results: measuredReport });
  h.goto("#/scan/full");
  h.eval("app.onEvent('run-state', { status: 'complete', mode: 'full', runId: 'run-d7' })");
  await until(() => h.el("#sc-results").innerHTML.includes("1.1.1.1"), 10000, "in-place table to render");
  const html = h.el("#sc-results").innerHTML;
  assert.equal((html.match(/clickable/g) || []).length, 2, "both ranked rows are on the console page");
  assert.equal(h.eval("app.viewName"), "scan", "no navigation happened");
});

test("D7a: after a stop, the partial results also render in place", async () => {
  const h = await bootCanned({ snapshot: cannedSnapshot(), results: measuredReport });
  h.goto("#/scan/full");
  h.eval("app.onEvent('run-state', { status: 'canceled', mode: 'full', runId: 'run-d7' })");
  await until(() => h.el("#sc-results").innerHTML.includes("1.1.1.1"), 10000, "in-place table after stop");
  assert.equal(h.eval("app.viewName"), "scan", "no navigation happened");
});
