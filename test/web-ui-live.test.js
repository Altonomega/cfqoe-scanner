// Front-end live behavior (0.9.1): the shipped app.js, driven in a
// vm against a stub DOM — the two boot truths Mahan's rulings made
// contractual. (1) When the server does not answer, the page lands
// on the plain offline state and NOTHING simulated exists to fall
// back to. (2) Retry, once the server answers, connects the one
// real source and the offline plate goes away — hands-off, no
// manual refresh anywhere in the flow.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const APP_JS = fs.readFileSync(fileURLToPath(new URL("../src/web/public/app.js", import.meta.url)), "utf8");

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
    matchMedia: () => ({ matches: true }), // reduced motion: calm on, loops stay still
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

test("boot with a dead server: plain offline state, no simulated feed exists, retry connects the real source", async () => {
  const h = makeHarness();
  await flush();
  // The offline plate is what renders — in plain words.
  assert.equal(h.eval("app.offline"), true);
  assert.ok(h.el("#view").innerHTML.includes("Your scanner is not answering"), "offline title renders");
  assert.equal(h.el("#conn-pill").textContent, "○ NO CONNECTION");
  // There is no other source to be on, by construction.
  assert.equal(h.eval("typeof Sim"), "undefined");
  assert.equal(h.eval("typeof window.__setSource"), "undefined");
  assert.equal(h.eventSources.length, 0, "no event stream is opened against a dead server");

  // The server comes back; one click on Retry must land the page
  // on the live source by itself.
  const snapshot = {
    server: { version: "0.9.1", platform: "linux-x64", startedAt: new Date().toISOString() },
    status: { configReady: false, xrayFound: false, verifyEnabled: false, resumeAvailable: false },
    genome: null,
    run: null,
    latest: null,
  };
  h.fetchImpl = async (path) => ({
    ok: true,
    status: 200,
    json: async () => (path === "/api/catalog" ? { ranges: [], blocksTotal: 0, rangesTotal: 0, addressesTotal: 0 } : snapshot),
  });
  const retry = h.el("#off-retry").handlers.click?.[0];
  assert.ok(retry, "the offline plate offers its retry action");
  await retry();
  assert.equal(h.eventSources.length, 1, "the real event stream is open");
  h.eventSources[0].onopen(); // the browser fires this when the stream opens
  await flush();
  assert.equal(h.eval("app.offline"), false);
  assert.equal(h.eval("app.conn"), "live");
  assert.equal(h.el("#conn-pill").textContent, "● LIVE — your scanner");
});
