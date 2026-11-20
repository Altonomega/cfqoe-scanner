import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  assert.ok(css.includes('"Vazirmatn"'), 'Persian font stack present');
  // The bundled Vazirmatn (W5): @font-face may exist, but only for
  // the local subset files — never a fetched font.
  assert.ok(css.includes('@font-face'), 'the bundled Vazirmatn is wired via @font-face');
  assert.ok(css.includes('font-display: swap'), 'text stays visible while the font loads');
  assert.ok(css.includes('unicode-range:'), 'the face is range-gated to the subset coverage');
  assert.ok(!/@font-face[^}]*url\(\s*["']?https?:/.test(css), 'no fetched fonts');
  assert.ok(css.includes('url("fonts/Vazirmatn-Regular.woff2")'), 'regular weight is the local subset');
  assert.ok(css.includes('url("fonts/Vazirmatn-Bold.woff2")'), 'bold weight is the local subset');
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

test('single source (0.9.1): no simulated feed ships in the product', () => {
  // Mahan's ruling: the shipped UI has exactly one source — the real
  // server. The sim source object, its run machines, the sim bar and
  // its playback-speed selector, and the Diagnostics source switcher
  // are gone; what remains is the offline state + retry.
  const js = read('app.js'), html = read('index.html'), css = read('app.css');
  assert.ok(!js.includes('__setSource'), 'no source-switch hook');
  assert.ok(!/const Sim\s*=/.test(js), 'no Sim source object');
  assert.ok(!js.includes('simDefaultSettings'), 'no sim settings factory');
  assert.ok(!js.includes('"tick.'), 'no sim ticker strings');
  assert.ok(!html.includes('sim-bar') && !js.includes('sim-bar'), 'no sim bar');
  assert.ok(!js.includes('dg-sim') && !js.includes('dg-live'), 'no Diagnostics source switcher');
  assert.ok(!js.includes('sim-speed'), 'no playback-speed selector');
  assert.ok(!css.includes('.sim-bar') && !css.includes('.sim-speed'), 'no orphaned sim CSS');
  assert.ok(js.includes('renderOffline') && js.includes('enterOffline'), 'the offline state ships instead');
});

test('0.9.1 wave markers: narration, stopping state, offline + failure strings in both languages', () => {
  const js = read('app.js');
  for (const marker of ['sc-journal', 'g-journal', 'ui.stopping', '_resyncSeq', 'calibration.no_control', 'ev.hard.calibration'])
    assert.ok(js.includes(marker), 'marker present: ' + marker);
  // Every string the wave added exists in BOTH tables (a key missing
  // from fa would render the key name itself to a Persian user).
  const keys = ['conn.none', 'run.stopping', 'run.here', 'note.canceled', 'note.noRun', 'note.noResume',
    'note.settingsInvalid', 'console.failed', 'console.stopped', 'console.journal', 'err.unknown',
    'ev.scan.calibration', 'ev.scan.calibration.no_control', 'ev.scan.calibration.no_control.plain',
    'ev.hard.calibration', 'ev.hard.calibration.no_control', 'ev.hard.calibration.no_control.plain',
    'dg.conn', 'dg.connLive', 'dg.connOff', 'dg.calibTruth', 'off.title', 'off.body', 'off.retry', 'off.still'];
  for (const key of keys) {
    const occurrences = js.split('"' + key + '":').length - 1;
    assert.ok(occurrences >= 2, 'string key in both en and fa tables: ' + key + ' (found ' + occurrences + ')');
  }
});

test('defect 9 pin: no file: URL can be constructed by the shipped assets', () => {
  // Filesystem paths from the server are rendered as text, never as
  // links; downloads flow through the authenticated /api/reports
  // endpoints. The shipped assets must not even contain the scheme.
  for (const name of ['app.js', 'index.html', 'app.css'])
    assert.ok(!read(name).includes('file:'), 'no file: URL in ' + name);
  const js = read('app.js');
  assert.ok(js.includes('href="/api/reports/'), 'report downloads use the authenticated API');
});

test('defect 8 pin: the plate label reads the catalog cidr, never firstBlock as a string', () => {
  const js = read('app.js');
  assert.ok(js.includes('r.cidr.split("/")'), 'plateBlockCidr derives the base from the cidr string');
  assert.ok(!js.includes('firstBlock.split'), 'firstBlock (a numeric index) is never split as a string');
});

test('defect 10 pin: the helix is drawn phase-shifted, never transform-squashed', () => {
  const js = read('app.js'), css = read('app.css');
  assert.ok(!css.includes('helixbreath'), 'the scaleY breath keyframes are gone');
  assert.ok(js.includes('createElementNS'), 'the helix strands are real SVG elements');
  assert.ok(js.includes('prefs.calm'), 'the helix motion obeys the calm gate');
});

test('size ratchet: the three assets stay a localhost-instant payload', () => {
  const total = ['index.html', 'app.css', 'app.js'].reduce((n, name) => n + fs.statSync(pub(name)).size, 0);
  // Design budget was ≤120 KB pre-bilingual; two full string tables and
  // RTL support legitimately grew it. Ratchet at 160 KB so it cannot
  // creep silently from here (see the W4 report for the revision note).
  // 0.9.2's second web wave (in-place results on both consoles, the
  // localized + animated notes stream, the legend rebuild, the phone
  // pass) raised it one deliberate 8 KB step to 168 KB — after the
  // duplicated inline-results bodies were factored into one factory
  // and the dead .rail-h/.plate-wrap/.mini-plate rules were removed.
  assert.ok(total <= 168 * 1024, 'total ' + total + ' bytes exceeds the 168 KB ratchet');
});

test('D9: the eleven plate states have pairwise-distinct legend swatches in both themes', () => {
  const css = read('app.css'), js = read('app.js');
  const varBlock = (re) => {
    const out = {};
    for (const [, k, v] of css.match(re)[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
    return out;
  };
  const light = varBlock(/:root\s*\{([^}]*)\}/);
  const dark = { ...light, ...varBlock(/\[data-theme="dark"\]\s*\{([^}]*)\}/) };
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = (sel) => {
    const m = css.match(new RegExp(escRe(sel) + '\\s*\\{([^}]*)\\}'));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  const resolve = (s, vars) => s.replace(/var\((--[\w-]+)\)/g, (_, k) => vars[k] || k);
  const states = [['', 'unprobed'], ['sw-known', 'known'], ['sw-g', 'priming'], ['sw-a', 'alive'],
    ['sw-absent', 'absent'], ['sw-edge', 'hot'], ['sw-suspect', 'suspect'], ['sw-split', 'split'],
    ['sw-ink', 'exhausted'], ['sw-ring', 'finalist'], ['sw-win', 'winner']];
  for (const [themeName, vars] of [['light', light], ['dark', dark]]) {
    const sigs = states.map(([cls]) => {
      const base = cls ? '.legend .' + cls : '.legend .sw';
      return resolve(rule(base) + '|' + rule(base + '::after'), vars);
    });
    assert.equal(new Set(sigs).size, states.length, themeName + ': every state reads differently');
    const sig = Object.fromEntries(states.map(([, k], i) => [k, sigs[i]]));
    assert.notEqual(sig.absent, sig.unprobed, themeName + ': absent carries its tick, unprobed is bare');
    assert.notEqual(sig.winner, sig.finalist, themeName + ': winner carries its dot, finalist only the ring');
    assert.notEqual(sig.known, sig.exhausted, themeName + ': known carries its corner tick');
    assert.notEqual(sig.suspect, sig.hot, themeName + ': gold below is not gold on top');
  }
  // The markup gives every state its own class — no shared swatch,
  // no inline-style hacks.
  for (const [cls, k] of states.slice(1)) assert.ok(js.includes(`"${cls}", "${k}"`), 'legend entry: ' + k);
  assert.ok(!js.includes('"sw-c", "winner"'), 'winner no longer shares the finalist swatch');
  assert.ok(!js.includes('border-top:2px solid var(--g)'), 'the quote-hack inline styles are gone');
});

test('D10a: run cards pin the Start button to a shared baseline by construction', () => {
  const css = read('app.css');
  assert.ok(/\.run-card \{[^}]*display: flex; flex-direction: column/.test(css), 'cards are flex columns');
  assert.ok(/\.run-card \.btn \{[^}]*margin-top: auto/.test(css), 'the button is pinned to the card bottom');
  assert.ok(!/\.run-card p \{[^}]*min-height/.test(css), 'the fixed description-height hack is gone');
});

test('D10b: phone rules — tap floors, live-top column shed, data-span wrapping', () => {
  const css = read('app.css');
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
  for (const pin of ['.switch { min-height: 40px', '.checks label { min-height: 40px', '.chip { min-height: 40px',
    'details.advanced > summary { min-height: 40px', '#g-top .c-block { display: none',
    '.d { display: inline; overflow-wrap: anywhere'])
    assert.ok(phone.includes(pin), 'phone pin present: ' + pin);
});

test('bundled font: Vazirmatn subsets stay within their own byte budget, license included', () => {
  // The font bytes are accounted separately from the code-asset
  // ratchet above: they are data, not code, they download lazily
  // (unicode-range + font-display: swap, only when Persian text
  // renders), and folding them into the 160 KB would either blow the
  // ratchet or force the code budget down for a one-time typography
  // purchase. Their own cap is 70 KB for all weights combined.
  const fontDir = pub('fonts');
  const weights = ['Vazirmatn-Regular.woff2', 'Vazirmatn-Bold.woff2'];
  const total = weights.reduce((n, name) => n + fs.statSync(path.join(fontDir, name)).size, 0);
  assert.ok(total <= 70 * 1024, 'font total ' + total + ' bytes exceeds the 70 KB font cap');
  // SIL OFL 1.1 requires the license to travel with the font.
  const license = fs.readFileSync(path.join(fontDir, 'OFL.txt'), 'utf8');
  assert.ok(license.includes('SIL Open Font License'), 'the OFL license ships with the fonts');
  for (const name of weights) {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(path.join(fontDir, name), 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    assert.equal(head.toString('ascii'), 'wOF2', name + ' is a real woff2 file');
  }
});
