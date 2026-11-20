// Results surface (0.9.1, Mahan's directive: tabulated, sorted,
// precise, professional). Three contracts are pinned here:
//  (1) ORDER — the ranking is the report builder's contract
//      (rankCandidates: complete above partial, then score order);
//      the web view preserves report order exactly and never
//      re-sorts, and rank numbers are positions in the FULL ranking
//      (a filtered subset cannot crown its own first row as #1).
//  (2) PRECISION — every displayed number equals the report JSON
//      value under the stated display rules: scores 1 decimal,
//      sustained Mbps 2 decimals, RPM 1 decimal, Wilson lower bound
//      as the report's own percent (scores.reliabilityLower95),
//      missing data as the honest dash.
//  (3) WORDS — verdicts, gate states and limiting factors render as
//      plain localized words (EN+FA), the score components are
//      visible at a glance, the detail expansion is a structured
//      ledger, and the run-relative scope is stated on the page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { rankCandidates } from "../src/report.js";

const APP_JS = fs.readFileSync(fileURLToPath(new URL("../src/web/public/app.js", import.meta.url)), "utf8");
const CLI_JS = fs.readFileSync(fileURLToPath(new URL("../src/cli.js", import.meta.url)), "utf8");

/* ---------------- the vm harness (same pattern as web-ui-live) ---------------- */
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
  focus() {}
  click() { (this.handlers.click || []).forEach((fn) => fn({ currentTarget: this, preventDefault() {} })); }
  getContext() { return new Proxy({}, { get: () => () => {} }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 26 }; }
}

function makeHarness() {
  const bySel = new Map();
  const document = {
    documentElement: Object.assign(new FakeEl("html"), { lang: "en", dir: "ltr" }),
    hidden: false,
    addEventListener() {},
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (_ns, tag) => new FakeEl(tag),
    querySelector(sel) {
      if (!bySel.has(sel)) bySel.set(sel, new FakeEl());
      return bySel.get(sel);
    },
    querySelectorAll() { return []; },
  };
  const storage = new Map();
  const harness = {
    fetchImpl: async () => { throw new Error("unreachable"); },
    eventSources: [],
  };
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; harness.eventSources.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    close() {}
  }
  const sandbox = {
    console,
    document,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    location: { search: "", pathname: "/", hash: "", href: "http://127.0.0.1:8797/" },
    history: { replaceState() {} },
    navigator: { language: "en" },
    innerWidth: 1200,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    IntersectionObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    EventSource: FakeEventSource,
    AbortController,
    URLSearchParams,
    URL,
    Blob,
    fetch: (...args) => harness.fetchImpl(...args),
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
  harness.el = (sel) => document.querySelector(sel);
  harness.eval = (expr) => vm.runInContext(expr, ctx);
  return harness;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

/* ---------------- fixtures: report-shaped rows ---------------- */
const ROW_A = {
  ip: "104.16.10.20", block: "104.16.0.0/24",
  verdict: { label: "recommended", summary: "Passed every gate with headroom." },
  measurement: { status: "complete", completeness: 1, bytesMeasured: 125829120, qoeConfidence: "high" },
  scores: { browsing: 88, streaming: 74.5, load: 91.2, reliability: 100, reliabilityLower95: 83.4, overall: 87.3, conservative: 86.1, overallUncapped: 90, conservativeUncapped: 92 },
  eligibility: { successes: 24, attempts: 24, successRate: 1, confidence95: { lower: 0.862 }, confidence: "high", handshakeMedianMs: 96.25, pops: { dominant: "FRA" } },
  load: { sustainedMbps: 12.3, rpm: 812.3, shapingRatio: 0.94, rttIncreaseMs: 41.5 },
  streaming: { sustainableMbps: 18.75, quality: "1080p" },
  gates: { status: "pass", limiting: null }, limitingFactor: null,
};
const ROW_B = {
  ip: "172.64.5.9", block: "172.64.0.0/24",
  verdict: { label: "usable", summary: "Usable, held back by jitter." },
  measurement: { status: "partial", completeness: 0.6, bytesMeasured: 8388608, qoeConfidence: "medium" },
  scores: { browsing: 70, streaming: null, load: null, reliability: 83.3, reliabilityLower95: 62.1, overall: 70, conservative: 70, overallUncapped: 78.4, conservativeUncapped: 81 },
  eligibility: { successes: 10, attempts: 12, successRate: 0.833, confidence95: { lower: 0.552 }, confidence: "medium", handshakeMedianMs: 132.4, pops: { dominant: "AMS" } },
  load: null, streaming: null,
  gates: { status: "warn", limiting: "jitterMs" }, limitingFactor: "Jitter (p95 - p50)",
};
const ROW_C = {
  ip: "188.114.97.3", block: "188.114.96.0/24",
  verdict: null,
  measurement: { status: "unmeasured", completeness: 0, bytesMeasured: 0, qoeConfidence: null },
  scores: { browsing: null, streaming: null, load: null, reliability: null, reliabilityLower95: null, overall: null, conservative: null, overallUncapped: null, conservativeUncapped: null },
  eligibility: { successes: 0, attempts: 3, successRate: 0, confidence95: { lower: 0 }, confidence: "provisional", handshakeMedianMs: null, pops: { dominant: null } },
  load: null, streaming: null, gates: null, limitingFactor: null,
};
const REPORT = {
  runId: "run-results-fixture", mode: "full", finishedAt: "2026-11-20T20:00:00.000Z", scope: "run-relative",
  totals: { candidates: 3, eligible: 2, complete: 1, partial: 1 },
  results: [ROW_A, ROW_B, ROW_C],
};

/* ---------------- (1) order ---------------- */
test("ranking contract: rankCandidates orders complete above partial, then by conservative score", () => {
  const cand = (ip, status, cons) => ({
    ip,
    measurement: { status, completeness: status === "complete" ? 1 : 0.5 },
    verdict: { label: "good" },
    scores: { conservative: cons, conservativeUncapped: cons, overallUncapped: cons },
    load: { sustainedMbps: 10, rpm: 100 },
    eligibility: { handshakeMedianMs: 100 },
  });
  const scrambled = [cand("p-high", "partial", 99), cand("c-low", "complete", 50), cand("u-none", "unmeasured", null), cand("c-high", "complete", 80)];
  assert.deepEqual(rankCandidates(scrambled).map((c) => c.ip), ["c-high", "c-low", "p-high", "u-none"],
    "a partial with the highest score still ranks below every complete row");
});

test("the view preserves report order exactly and numbers ranks by position", async () => {
  const h = makeHarness();
  await flush();
  h.eval(`window.__rows = ${JSON.stringify([ROW_A, ROW_B, ROW_C])}`);
  const html = h.eval("resultsTable(window.__rows, false)");
  const order = [html.indexOf(ROW_A.ip), html.indexOf(ROW_B.ip), html.indexOf(ROW_C.ip)];
  assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], "rows render in report order");
  // A scrambled input renders scrambled: the view itself never sorts —
  // ranking truth lives in the report, and only there.
  h.eval(`window.__scr = ${JSON.stringify([ROW_C, ROW_A, ROW_B])}`);
  const scr = h.eval("resultsTable(window.__scr, false)");
  const sOrder = [scr.indexOf(ROW_C.ip), scr.indexOf(ROW_A.ip), scr.indexOf(ROW_B.ip)];
  assert.ok(sOrder[0] < sOrder[1] && sOrder[1] < sOrder[2], "no client-side re-sort");
});

test("global ranks: a filtered subset keeps its true rank and cannot crown itself #1", async () => {
  const h = makeHarness();
  await flush();
  h.eval(`window.__b = ${JSON.stringify([ROW_B])}`);
  const sub = h.eval("resultsTable(window.__b, false, [2])");
  assert.ok(sub.includes(">2</td>"), "the subset row shows its global rank 2");
  assert.ok(!sub.includes("rank-stamp") && !sub.includes('class="best '), "no best-row treatment away from rank 1");
  h.eval(`window.__all = ${JSON.stringify([ROW_A, ROW_B, ROW_C])}`);
  const full = h.eval("resultsTable(window.__all, false, [1, 2, 3])");
  assert.ok(full.includes("rank-stamp"), "the true #1 carries the rank stamp");
  assert.equal((full.match(/rank-stamp/g) || []).length, 1, "exactly one stamped row");
});

/* ---------------- (2) precision ---------------- */
test("cells equal the report values under the stated display rules", async () => {
  const h = makeHarness();
  await flush();
  h.eval(`window.__rows = ${JSON.stringify([ROW_A, ROW_B, ROW_C])}`);
  const html = h.eval("resultsTable(window.__rows, false)");
  for (const cell of ["86.1", "92.0", "87.3", "12.30", "812.3", "83.4%", "24/24"])
    assert.ok(html.includes(cell), "cell present: " + cell);
  // The score-parts strip: all four components, report values at 1dp.
  for (const part of ["88.0", "74.5", "91.2", "100.0"])
    assert.ok(html.includes(part), "component present: " + part);
  // Row B: capped scores print as 70.0; unmeasured components are dashes.
  assert.ok(html.includes("70.0"), "partial cap prints as 70.0");
  assert.ok(!html.includes("0.862") && !html.includes("86.2%"), "the raw Wilson fraction is never displayed — the report's own percent rules");
  assert.ok(!html.includes("undefined") && !html.includes("NaN"), "no undefined-shaped noise");
  // Compact (dashboard) keeps the anchor numbers + parts, drops raw/overall.
  const compact = h.eval("resultsTable(window.__rows, true)");
  assert.ok(compact.includes("86.1") && compact.includes("91.2"), "compact keeps conservative + parts");
  assert.ok(!compact.includes("92.0"), "compact drops the raw column");
});

test("the detail ledger is structured, precise and honest about unmeasured stages", async () => {
  const h = makeHarness();
  await flush();
  h.eval(`window.__a = ${JSON.stringify(ROW_A)}; window.__b = ${JSON.stringify(ROW_B)}; window.__c = ${JSON.stringify(ROW_C)}`);
  const da = h.eval("resultDetail(window.__a)");
  for (const frag of ["Eligibility", "Scores", "Real load", "Gates", "83.4%", "12.30", "96.25", "Passed every gate with headroom."])
    assert.ok(da.includes(frag), "detail A contains: " + frag);
  const db = h.eval("resultDetail(window.__b)");
  assert.ok(db.includes("not measured"), "B's unmeasured load stage says so in words");
  assert.ok(db.includes("jitter — uneven timing"), "B's limiting factor is a plain phrase, not the code jitterMs");
  assert.ok(db.includes("83.3%"), "B's success rate prints as a 1dp percent");
  const dc = h.eval("resultDetail(window.__c)");
  assert.ok(!dc.includes("undefined") && !dc.includes("NaN") && !dc.includes("null"), "the unmeasured row's detail stays clean");
});

/* ---------------- (3) words, framing, both languages ---------------- */
test("the results page states its scope, names its top row, and localizes its strip", async () => {
  const h = makeHarness();
  await flush();
  h.fetchImpl = async (path) => ({
    ok: true, status: 200,
    json: async () => {
      if (path.includes("/api/results/")) return REPORT;
      throw new Error("unexpected " + path);
    },
  });
  h.eval("Views.results(document.querySelector('#view'), [], new URLSearchParams(''))");
  await flush();
  const html = h.el("#res-body").innerHTML;
  assert.ok(html.includes("run-relative"), "the scope line is on the page");
  assert.ok(html.includes("capped at 70"), "the complete/partial legend is on the page");
  assert.ok(html.includes("Top of this run") && html.includes(ROW_A.ip), "the top line names the ranking's head");
  assert.ok(html.includes("complete <b>1</b>") && html.includes("partial <b>1</b>"), "the strip counts complete/partial in words");
});

test("FA rendering: verdicts, parts and detail speak Persian; data stays isolated", async () => {
  const h = makeHarness();
  await flush();
  h.eval(`window.__rows = ${JSON.stringify([ROW_A, ROW_B])}; window.__b = window.__rows[1]`);
  h.eval("lang = 'fa'");
  const html = h.eval("resultsTable(window.__rows, false)");
  assert.ok(html.includes("پیشنهادشده"), "the recommended verdict is a Persian word");
  assert.ok(html.includes("پایایی"), "the reliability component is labeled in Persian");
  assert.ok(html.includes("قبول با هشدار"), "the warn gate state is a Persian phrase");
  const db = h.eval("resultDetail(window.__b)");
  assert.ok(db.includes("عامل محدودکننده") && db.includes("جیتر"), "the FA detail names the limiting factor in Persian");
  h.eval("lang = 'en'");
});

test("bilingual parity: every results key exists in both string tables", () => {
  const keys = ["col.parts", "comp.web", "comp.streaming", "comp.load", "comp.reliability",
    "verdict.recommended", "verdict.good", "verdict.usable", "verdict.browsing-only", "verdict.unverified", "verdict.unusable",
    "gate.pass", "gate.warn", "gate.fail", "gate.unknown",
    "ms.complete", "ms.partial", "ms.incomplete", "ms.unmeasured",
    "conf.provisional", "conf.low", "conf.medium", "conf.high",
    "limit.sustainedMbps", "limit.shapingRatio", "limit.rpm", "limit.rttIncreaseMs", "limit.rttInflation", "limit.jitterMs", "limit.lossRate", "limit.fanoutSuccess", "limit.freshConnectionMs", "limit.uplinkMbps",
    "res.scope", "res.legend", "res.top", "res.notMeasured",
    "det.eligibility", "det.scores", "det.load", "det.streaming", "det.gates", "det.measurement",
    "det.success", "det.rate", "det.lower95", "det.median", "det.confidence",
    "det.overall", "det.rawOverall", "det.cons", "det.rawCons",
    "det.sustained", "det.rpm", "det.shaping", "det.addedRtt", "det.sustainable", "det.quality",
    "det.status", "det.limiting", "det.verdict", "det.mstatus", "det.bytes", "det.qoe",
    "unit.ms", "unit.mbps"];
  for (const key of keys) {
    const occurrences = APP_JS.split('"' + key + '":').length - 1;
    assert.ok(occurrences >= 2, "string key in both en and fa tables: " + key + " (found " + occurrences + ")");
  }
});

/* ---------------- terminal parity ---------------- */
test("terminal parity: printResults renders the report array in order, unsorted, from the same fields", () => {
  const start = CLI_JS.indexOf("function printResults");
  assert.ok(start >= 0, "printResults exists in the terminal fallback");
  const body = CLI_JS.slice(start, CLI_JS.indexOf("\nasync function ", start + 10));
  assert.ok(!body.includes(".sort("), "the terminal never re-sorts the ranking");
  assert.ok(body.includes("slice(0, limit)"), "the terminal takes a prefix of the ranked array");
  assert.ok(body.includes("result.scores.conservative") && body.includes("result.scores.reliabilityLower95"),
    "the terminal reads the same report fields the web table formats");
});
