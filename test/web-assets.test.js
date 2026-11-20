import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Guards for the web UI assets (src/web/public/): the §1.6 anti-pattern
// ban list, the bilingual EN/FA contract, Shield's token hygiene, and a
// size ratchet. These are static checks over the shipped files — the
// behavioral suite for the UI logic lives with the W4 review harness.
const pub = (name) => fileURLToPath(new URL('../src/web/public/' + name, import.meta.url));
const read = (name) => fs.readFileSync(pub(name), 'utf8');

test('web assets exist and app.js parses', () => {
  for (const name of ['index.html', 'app.css', 'app.js']) assert.ok(fs.existsSync(pub(name)), name);
  assert.doesNotThrow(() => new vm.Script(read('app.js'), { filename: 'app.js' }));
});

test('anti-pattern ban list (§1.6) holds in the shipped CSS/JS', () => {
  const css = read('app.css'), js = read('app.js'), html = read('index.html');
  for (const banned of ['linear-gradient', 'radial-gradient', 'backdrop-filter', 'glassmorphism'])
    assert.ok(!css.includes(banned) && !js.includes(banned), 'banned pattern: ' + banned);
  assert.ok(!/https?:\/\//.test(html.replace('http://127.0.0.1', '')), 'no external asset URLs in index.html');
  assert.ok(!html.includes('<script src="http'), 'no CDN scripts');
});

test('bilingual contract: both string tables, RTL switch, bidi isolation, Persian font stack', () => {
  const js = read('app.js'), css = read('app.css');
  assert.ok(js.includes('en: {') && js.includes('fa: {'), 'both STR tables present');
  assert.ok(js.includes('document.documentElement.dir = lang === "fa" ? "rtl" : "ltr"'), 'root dir switches with language');
  assert.ok(css.includes('unicode-bidi: isolate'), 'data spans are bidi-isolated');
  assert.ok(css.includes('"Vazirmatn"'), 'Persian font stack present (system fonts only, no fetch)');
  assert.ok(!css.includes('@font-face'), 'no bundled or fetched fonts');
});

test('token hygiene (Shield R-04): the client never stores or sends a token', () => {
  const js = read('app.js');
  assert.ok(!js.includes('sessionStorage'), 'no sessionStorage token keeping');
  assert.ok(!/localStorage\.setItem\([^)]*t["\']/.test(js), 'no token in localStorage');
  assert.ok(js.includes('"X-CFQoE-Request": "1"'), 'state-changing POSTs carry the R-07 header');
  assert.ok(!js.includes('X-CFQ-Key'), 'the retired Pixel token header is gone (cookie model governs)');
});

test('the VLESS secret is never rendered: config view binds only descriptor fields', () => {
  const js = read('app.js');
  assert.ok(js.includes('cfg.f.idPresent'), 'descriptor rendering present');
  assert.ok(!/innerHTML[^;]*descriptor\.uri/.test(js) && !js.includes('d.uri'), 'no descriptor.uri rendering');
});

test('sim smoke: the fixed-seed Hard run spends its budget and expands blocks', { timeout: 180000 }, () => {
  // The reproducible smoke (scripts/web-sim-smoke.mjs) is the only
  // source of quotable sim numbers: fixed seeds (catalog 20261, run
  // 404), scripted end-to-end. Two runs must print identical counters,
  // and the expansion must be able to spend the full 72,000 budget —
  // the structural caps that once held it to 27,731 are gone.
  const script = fileURLToPath(new URL('../scripts/web-sim-smoke.mjs', import.meta.url));
  const run = () => JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8' }));
  const a = run(), b = run();
  assert.deepEqual(b, a, 'the fixed-seed smoke is deterministic');
  assert.equal(a.primerProbes, 23091, 'primer spends 3 per block');
  assert.equal(a.blocksPrimed, 7697, 'every block primed');
  assert.equal(a.expansionStop, 'budget', 'expansion ends on the budget, not a structural cap');
  assert.equal(a.probesSpent, 72000, 'the full budget is spent');
  assert.ok(a.expansionWaves > 300, 'hundreds of real 120-probe waves: ' + a.expansionWaves);
  assert.ok(a.blocksExpanded > 0, 'blocks actually expand (depth cap 32 is reachable)');
  assert.ok(a.blocksSplit > 0, 'split-coverage still splits blocks');
});

test('size ratchet: the three assets stay a localhost-instant payload', () => {
  const total = ['index.html', 'app.css', 'app.js'].reduce((n, name) => n + fs.statSync(pub(name)).size, 0);
  // Design budget was ≤120 KB pre-bilingual; two full string tables and
  // RTL support legitimately grew it. Ratchet at 160 KB so it cannot
  // creep silently from here (see the W4 report for the revision note).
  assert.ok(total <= 160 * 1024, 'total ' + total + ' bytes exceeds the 160 KB ratchet');
});
