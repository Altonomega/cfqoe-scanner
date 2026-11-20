#!/usr/bin/env node
// Reproducible end-to-end smoke for the web UI's simulation source
// (src/web/public/app.js — the WEB-UI CONTRACT's reference
// implementation, see src/web/CONTRACT.md).
//
// Fixed seeds everywhere: the catalog builds from mulberry32(20261)
// and every run from mulberry32(404), so the counters printed here are
// identical on every machine, every time. This script is the ONLY
// smoke whose numbers may be quoted for the sim; if a number is not
// printed here, it was not measured.
//
// The script loads app.js in a vm with the browser globals stubbed
// (DOM elements are inert dummies — the smoke's subject is the sim's
// arithmetic, not rendering), then drives Sim.tick() synchronously
// through one full Hard Deep Scan and prints the run's counters as
// JSON on stdout.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const appJs = fs.readFileSync(
  fileURLToPath(new URL("../src/web/public/app.js", import.meta.url)),
  "utf8",
);

const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true });
const dummyEl = {
  textContent: "", innerHTML: "", className: "", hidden: false, value: "",
  style: {}, dataset: {}, clientWidth: 300, clientHeight: 100,
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {}, addEventListener() {}, focus() {},
  querySelector: () => dummyEl, querySelectorAll: () => [],
  getContext: () => ctxStub,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 100 }),
};
class ObserverStub { observe() {} unobserve() {} disconnect() {} }

const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  atob, btoa, URLSearchParams, performance, innerWidth: 1280, innerHeight: 800,
  navigator: { language: "en", platform: "smoke" },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  matchMedia: () => ({ matches: false }),
  location: { search: "", pathname: "/", hash: "" },
  history: { replaceState() {} },
  ResizeObserver: ObserverStub, IntersectionObserver: ObserverStub,
  document: {
    documentElement: { dataset: {}, lang: "", dir: "" },
    querySelector: () => dummyEl, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => dummyEl,
  },
};
sandbox.window = { matchMedia: sandbox.matchMedia, addEventListener() {}, __plate: null };
vm.createContext(sandbox);

const driver = `
;(() => {
  app.src = Sim;
  app.refreshChrome = () => {}; // DOM chrome is not the smoke's subject
  app.showNotice = () => {};
  Sim.buildCatalog();
  Sim.cfgDesc = { address: "smoke.invalid", port: 443, host: "smoke.invalid", sni: "", path: "/", transport: "ws", security: "tls", label: "smoke", idPresent: true };
  const R = Sim.newRun("hard");
  Sim.startRun(R);
  let ticks = 0;
  while (Sim.run && ticks < 100000) { Sim.tick(); ticks++; }
  const c = R.counters;
  console.log(JSON.stringify({
    ticks, finalPhase: R.phase, expansionStop: R.expStop || null,
    probesSpent: c.probesSpent, primerProbes: c.primerProbes,
    reserveProbes: c.reserveProbes, expansionProbes: c.expansionProbes,
    blocksPrimed: c.blocksPrimed, blocksExpanded: c.blocksExpanded,
    blocksSplit: c.blocksSplit, expansionWaves: R.wave, eligible: c.eligible,
    liveTop: Sim.liveTop().length,
    results: Sim.latestReport ? Sim.latestReport.results.length : 0,
  }, null, 2));
})();`;

vm.runInContext(appJs + driver, sandbox, { filename: "app.js" });
