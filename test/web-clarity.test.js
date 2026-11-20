// Whole-product clarity sweep (0.9.1): every view must teach a
// first-time user what they are looking at, and every displayed
// number must be DERIVED from what the server serves — never a
// literal copied into the client. Pinned here:
//  - the genome subtitle + ideogram counts come from the served
//    catalog payload (rangesTotal/blocksTotal/addressesTotal);
//  - the genome budget meter reads hard.budgetProbes from the
//    served settings (the server's platform call), and shows a
//    spent-only line rather than a copied denominator when the
//    settings cannot be read;
//  - both phase rails carry plain-language station notes (the
//    st-note spans were designed for this and shipped empty);
//  - the genome lane + live top speak localized words and the
//    product's percent convention, not raw codes and fractions;
//  - the results table's responsive tiers are deliberate (columns
//    retire at tablet width; ledger rows at phone width) — the
//    payoff data is never sideways-scrolled.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const read = (name) => fs.readFileSync(fileURLToPath(new URL("../src/web/public/" + name, import.meta.url)), "utf8");
const APP_JS = read("app.js");
const APP_CSS = read("app.css");

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
    body: new FakeEl("body"),
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
    getComputedStyle: () => ({ getPropertyValue: () => "monospace" }),
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
// t() wraps substituted values in Unicode bidi isolates by design;
// assertions compare the plain text.
const plain = (s) => String(s).replace(/[⁨⁩]/g, "");

test("genome counts are derived from the served catalog, never literals", async () => {
  const h = makeHarness();
  await flush();
  h.eval("app.catalog = { ranges: [], blocksTotal: 9, rangesTotal: 3, addressesTotal: 99 }");
  h.eval("Views.genome(document.querySelector('#view'))");
  await flush();
  const sub = plain(h.el("#g-sub").textContent);
  assert.ok(sub.includes("3 ranges") && sub.includes("9 blocks") && sub.includes("99 addresses"),
    "the subtitle speaks the served catalog's own totals: " + sub);
  assert.ok(plain(h.el("#g-ideo-head").textContent).includes("3 ranges"), "the ideogram head derives too");
  assert.ok(!APP_JS.includes("fmt(753)") && !APP_JS.includes("fmt(1970432)") && !APP_JS.includes("fmt(7697)"),
    "no catalog total survives as a client literal");
});

test("genome budget derives from the served settings; without them it claims no denominator", async () => {
  const h = makeHarness();
  await flush();
  h.eval("Views.genome(document.querySelector('#view'))");
  await flush();
  assert.equal(plain(h.el("#g-budget-text").textContent), "0 probes spent",
    "settings unread: spent-only, no copied 72,000");
  const h2 = makeHarness();
  await flush();
  h2.fetchImpl = async (path) => ({
    ok: true, status: 200,
    json: async () => {
      if (path === "/api/settings") return { settings: { hard: { budgetProbes: 40000 } } };
      throw new Error("unexpected " + path);
    },
  });
  h2.eval("Views.genome(document.querySelector('#view'))");
  await flush();
  assert.ok(plain(h2.el("#g-budget-text").textContent).includes("40,000"),
    "the meter's total is the served budgetProbes: " + h2.el("#g-budget-text").textContent);
  assert.ok(!APP_JS.includes("72000"), "the desktop budget literal is gone from the client");
});

test("both rails teach: every station carries a plain-language note", async () => {
  const h = makeHarness();
  await flush();
  h.eval("Views.genome(document.querySelector('#view'))");
  const gel = h.el("#view").innerHTML;
  assert.ok(gel.includes("three quick probes in every block"), "primer station teaches");
  assert.ok(gel.includes("more probes where life showed up"), "expansion station teaches");
  assert.ok(gel.includes("This scan walks the whole catalog"), "the genome intro line teaches the whole view");
  h.eval("Views.scan(document.querySelector('#view'), ['scan', 'quick'])");
  const sel = h.el("#view").innerHTML;
  assert.ok(sel.includes("quick eligibility probes for everyone"), "screening station teaches");
  assert.ok(sel.includes("early-verdict test"), "the ledger note explains SPRT in plain words");
});

test("genome lane and live top: localized words, product display rules, no raw codes", async () => {
  const h = makeHarness();
  await flush();
  h.eval(`app.lane = [{ ip: "104.16.10.20", scores: { overall: 87.3 }, streaming: { sustainableMbps: 18.75 }, load: { sustainedMbps: 12.3, rpm: 812.3 }, verdict: { label: "recommended" } }]`);
  h.eval(`app.state = { status: {}, run: { top: [{ ip: "104.16.10.20", block: "104.16.0.0/24", eligibility: { successes: 24, attempts: 24, confidence95: { lower: 0.834 }, pops: { dominant: "FRA" } } }] } }`);
  h.eval("Views.genome(document.querySelector('#view'))");
  await flush();
  const lane = h.el("#g-lane").innerHTML;
  assert.ok(lane.includes("Overall") && lane.includes("87.3"), "lane head value is the overall, formatted");
  assert.ok(lane.includes("12.30 Mbps") && lane.includes("812.3 rpm"), "lane load values follow the display rules");
  assert.ok(lane.includes("Recommended") && !lane.includes(">transfer <"), "lane verdict is a word, not a code; no raw English stage names");
  const top = h.el("#g-top").innerHTML;
  assert.ok(top.includes("83.4%"), "live top shows the Wilson bound as the product's percent");
  assert.ok(!top.includes("0.83"), "the raw fraction never renders");
});

test("results responsiveness is deliberate tiers, never a sideways scroll", async () => {
  for (const name of ["app.js", "app.css", "index.html"])
    assert.ok(!read(name).includes("tbl-scroll"), "no sideways-scroll frame remains in " + name);
  assert.ok(APP_CSS.includes("max-width: 1020px") && APP_CSS.includes(".c-raw"), "tablet tier retires raw/overall/why into the detail");
  assert.ok(APP_CSS.includes("max-width: 760px") && APP_CSS.includes("tr.clickable") && APP_CSS.includes("display: flex"),
    "phone tier renders ledger rows");
  assert.ok(APP_CSS.includes("min-height: 40px"), "phone buttons are finger-sized");
  const h = makeHarness();
  await flush();
  h.eval(`window.__rows = [{ ip: "104.16.10.20", verdict: { label: "good" }, measurement: { status: "complete" }, scores: { conservative: 80, reliabilityLower95: 70.5 }, eligibility: { successes: 3, attempts: 4, pops: { dominant: "FRA" } }, load: { sustainedMbps: 9.5, rpm: 700 }, gates: { status: "pass" } }]`);
  const html = h.eval("resultsTable(window.__rows, false)");
  assert.ok(html.includes('class="data res res-f"'), "the table carries its tier classes");
  assert.ok(html.includes('data-l="Mbps"') && html.includes('data-l="Eligibility"'),
    "phone ledger labels travel with the cells, localized at render");
});

test("bilingual parity: every clarity key exists in both string tables", () => {
  const keys = ["genome.intro", "genome.spentOnly", "console.ledgerNote",
    "phn.calibrating", "phn.screening", "phn.delayed-retry", "phn.verification", "phn.tunnel",
    "phn.hard-primer", "phn.hard-coverage", "phn.hard-expansion", "phn.hard-retry", "phn.hard-verify", "phn.hard-finalize"];
  for (const key of keys) {
    const occurrences = APP_JS.split('"' + key + '":').length - 1;
    assert.ok(occurrences >= 2, "string key in both en and fa tables: " + key + " (found " + occurrences + ")");
  }
});
