"use strict";
/* CFQoE Scanner web UI — "The Sequencer's Notebook". Hand-written, zero
   dependencies, no build step. Consumes the WEB-UI-DESIGN.md §5 contract
   (GET /api/state snapshot + SSE deltas + POST actions) through a data-
   source abstraction: a live source (the W3 server) and a simulation
   source speaking the same contract, for preview and Proof testing.
   Security (Shield, binding): the bootstrap session cookie is the only
   credential — this file never reads, stores, or sends a token; POSTs
   carry X-CFQoE-Request: 1 (R-07); the VLESS URI is never rendered,
   echoed, or kept client-side (descriptor only).
   Bilingual EN/FA: all user-facing strings live in STR; data values
   (IPs, CIDRs, numbers, paths, IDs) are always LTR tabular mono inside
   bidi-isolated spans (.d / <bdi>) so Persian can never scramble them.
   The canvases are instrument readouts — catalog order is data, so
   their geometry stays LTR in both languages; the journal mirrors. */

/* ---------------- utilities ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US"));
const fmt2 = (n) => (n == null || !Number.isFinite(n) ? "–" : (Math.round(n * 100) / 100).toString());
/* Results display rules: a results number is the report's own value,
   formatted — never recomputed, never rounded past the engine's
   precision. Scores leave the engine at one decimal (f1), sustained
   Mbps at two (f2), RPM at one (f1); millisecond figures carry at
   most two decimals and print trimmed (fTrim). The Wilson lower
   bound is read from the report's own percent field
   (scores.reliabilityLower95), never re-derived from the fraction. */
const f1 = (n) => (n == null || !Number.isFinite(n) ? "–" : n.toFixed(1));
const f2 = (n) => (n == null || !Number.isFinite(n) ? "–" : n.toFixed(2));
const fTrim = (n) => (n == null || !Number.isFinite(n) ? "–" : String(Math.round(n * 100) / 100));
const pct1 = (frac) => (frac == null || !Number.isFinite(frac) ? "–" : (Math.round(frac * 1000) / 10).toFixed(1) + "%");
const pct = (x) => (x == null || !Number.isFinite(x) ? "–" : Math.round(x * 100) + "%");
const mmss = (ms) => { const s = Math.floor((ms || 0) / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
const D = (x) => `<bdi class="d mono">${esc(x)}</bdi>`; // bidi-isolated data span
function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const b64ToU8 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const b64ToU32 = (b) => { const u8 = b64ToU8(b); return new Uint32Array(u8.buffer, 0, Math.floor(u8.length / 4)); };
const u8ToB64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); };
const u32ToB64 = (u) => u8ToB64(new Uint8Array(u.buffer, u.byteOffset, u.byteLength));

/* ---------------- preferences (theme / calm / language) ---------------- */
const store = {
  get(k) { try { return localStorage.getItem("cfqoe-" + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem("cfqoe-" + k) : localStorage.setItem("cfqoe-" + k, v); } catch { /* private mode */ } },
};
const prefs = {
  theme: store.get("theme"), // null = follow OS
  calm: store.get("calm") === "1" || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches),
  lang: store.get("lang") || ((navigator.language || "en").toLowerCase().startsWith("fa") ? "fa" : "en"),
};
function applyTheme() {
  const dark = prefs.theme ? prefs.theme === "dark" : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("#theme-toggle").textContent = t(dark ? "ui.day" : "ui.night");
  if (window.__plate) __plate.setTheme(dark);
}
function applyCalm() {
  document.documentElement.dataset.calm = prefs.calm ? "true" : "false";
  const b = $("#calm-toggle"); b.setAttribute("aria-pressed", String(prefs.calm)); b.textContent = t("ui.calm");
}

/* ---------------- i18n ---------------- */
const STR = {
en: {
  "app.tagline": "· Cloudflare IP Scanner", "app.subtitle": "the sequencer's notebook — local session",
  "app.colophon": "CFQoE Scanner — measurements are run-relative; scores compare candidates within one run.",
  "ui.calm": "Calm", "ui.night": "Night plate", "ui.day": "Day plate", "ui.stopServer": "Stop the scanner",
  "ui.stopServerArm": "Really stop?", "ui.stopRun": "Stop safely", "ui.stopRunArm": "Really stop?", "ui.stopping": "Stopping…",
  "ui.start": "Start", "ui.resume": "Resume", "ui.beginReplication": "Begin replication",
  "ui.save": "Save settings", "ui.restoreDefaults": "Restore defaults", "ui.restoreArm": "Really restore?",
  "ui.remove": "Remove", "ui.removeArm": "Really remove?", "ui.import": "Import configuration",
  "ui.openResults": "Open full results", "ui.downloadJson": "Download JSON", "ui.downloadBest": "Download best IPs",
  "ui.close": "Close", "ui.pause": "Pause", "ui.unpause": "Resume tail", "ui.add": "Add",
  "conn.connecting": "connecting…", "conn.live": "● LIVE — your scanner", "conn.reconnecting": "reconnecting…", "conn.offline": "scanner stopped",
  "run.running": "RUNNING", "run.stopping": "STOPPING", "run.openConsole": "open console →", "run.here": "console open — you are here", "run.idle": "No run yet this session.",
  "conn.none": "○ NO CONNECTION",
  "off.title": "Your scanner is not answering", "off.body": "The app on this machine is not responding — it may have been closed. Check the terminal window that launched it, then retry.",
  "off.retry": "Retry connection", "off.still": "Still no answer — last tried {time}.",
  "nav.head": "Notebook", "nav.notes": "Run notes",
  "nav.dashboard": "Plate", "nav.genome": "Genome", "nav.results": "Results", "nav.reports": "Reports",
  "nav.settings": "Settings", "nav.config": "Config", "nav.diagnostics": "Diagnostics",
  "dash.status": "Status", "dash.runScan": "Run a scan", "dash.plateRest": "The plate, at rest",
  "dash.latest": "Latest result", "dash.noRuns": "No runs yet. The plate is blank.",
  "dash.fromRuns": "From your recorded runs: {alive} blocks known alive · {absent} known absent · {known} known in total.",
  "dash.resumeLine": "Resume the paused Hard run — {phase}, {probes} probes spent.",
  "status.config": "config", "status.xray": "xray", "status.verify": "verify", "status.resume": "resume", "status.platform": "platform",
  "status.ready": "ready", "status.missing": "missing", "status.found": "found", "status.notFound": "not found",
  "status.sprt": "SPRT", "status.off": "off", "status.available": "available", "status.none": "none saved",
  "mode.quick": "Quick", "mode.full": "Full", "mode.research": "Research", "mode.hard": "Hard Deep Scan",
  "mode.quick.d": "A screening pass: 16 IPs, 2 rounds. Fast, shallow — a first look at the path.",
  "mode.full.d": "The everyday run: 120 IPs, 3 rounds, SPRT verification of 20 finalists, full QoE on the best 5.",
  "mode.research.d": "Deep evidence: 240 candidates, 6 rounds, 24 finalists, triple tunnel passes. Slow and thorough.",
  "mode.hard.d": "The whole catalog, block by block: 23,091 primer probes, adaptive expansion, resumable.",
  "console.preflight": "Pre-flight", "console.candidates": "candidates", "console.rounds": "screening rounds",
  "console.finalists": "finalists", "console.tunnel": "tunnel passes", "console.estTraffic": "estimated traffic",
  "console.ledger": "Candidate ledger", "console.noCandidates": "No candidates have completed a stage yet.",
  "console.finished": "Run finished.", "console.viewResults": "See the results",
  "console.stopped": "Run stopped — the partial results are saved.", "console.journal": "Event journal",
  "console.idleHint": "No run is running. Start one here — its progress will appear on this page, live, as it happens.",
  "op.starting": "Starting the run…", "op.calibrating": "Calibrating — testing your path to choose a safe speed. On a slow path this can take up to a minute.",
  "op.calibratingLevel": "Calibrating — testing speed level {done} of {total} on your path.",
  "op.screening": "Screening — round {round} of {rounds} · probing {ip} · {done} of {total} checks done",
  "op.screeningNoIp": "Screening — round {round} of {rounds} · {done} of {total} checks done",
  "op.delayed-retry": "Delayed retry — {total} silent candidates get one more chance · {done} of {total} done",
  "op.verification": "Verification — finalist {done} of {total} is re-tested (SPRT)",
  "op.tunnel": "Tunnel QoE — measuring {ip} through a real tunnel · candidate {done} of {total}",
  "op.tunnelNoIp": "Tunnel QoE — finalists are measured through a real tunnel · {done} of {total} done",
  "op.phase": "{phase} · {done} of {total} done",
  "ev.phase": "▸ {phase}", "ev.scan.start": "Scan started", "ev.scan.calibration": "Calibration finished — the run continues at the chosen speed",
  "ev.scan.calibration.no_control": "The path check couldn't verify a reference point — continuing at full speed {n}; results may be less certain",
  "ev.scan.calibration.no_control.plain": "The path check couldn't verify a reference point — continuing at the configured speed; results may be less certain",
  "ev.hard.calibration": "Calibration finished — the run continues at the chosen speed",
  "ev.hard.calibration.no_control": "The path check couldn't verify a reference point — continuing at full speed {n}; results may be less certain",
  "ev.hard.calibration.no_control.plain": "The path check couldn't verify a reference point — continuing at the configured speed; results may be less certain",
  "ev.scan.delayed_retry.start": "Delayed retry started", "ev.verification.start": "Verification started — finalists are re-tested",
  "ev.verification.complete": "Verification finished", "ev.web.control.scan-stop": "Stop requested",
  "ev.tunnel.backfill": "A finalist slot was empty — the next candidate takes it",
  "ev.accept": "A finalist was accepted", "ev.reject": "A finalist was rejected", "ev.inconclusive": "A finalist stayed inconclusive — its screening evidence decides",
  "phase.screening": "Screening", "phase.delayed-retry": "Delayed retry", "phase.verification": "Verification (SPRT)",
  "phase.tunnel": "Tunnel QoE", "phase.calibrating": "Calibrating",
  "phase.hard-primer": "Primers — origins of replication", "phase.hard-coverage": "Proofreading — checking uneven blocks",
  "phase.hard-expansion": "Replication forks — expanding the living blocks", "phase.hard-retry": "Delayed retries",
  "phase.hard-verify": "Verifying finalists (SPRT)", "phase.hard-finalize": "Final QoE — the sequencing lane",
  "genome.title": "Hard Deep Scan", "genome.sub": "The whole Cloudflare catalog as one plate: {ranges} ranges · {blocks} blocks · {addrs} addresses. One cell = one \u2068/24\u2069 block.",
  "genome.ideo": "Ideogram — {ranges} ranges (width ∝ blocks)", "genome.plate": "The plate — {blocks} blocks",
  "genome.trace": "Trace — last probes (height = speed)", "genome.liveTop": "Live top", "genome.liveNotes": "Live notes",
  "genome.budget": "Budget", "genome.spent": "{spent} / {total} probes", "genome.spentOnly": "{spent} probes spent",
  "genome.intro": "This scan walks the whole catalog block by block. Stop it any time — progress is checkpointed, and Resume continues where it stopped.",
  "phn.calibrating": "finding the speed this path can carry", "phn.screening": "quick eligibility probes for everyone",
  "phn.delayed-retry": "a second chance for the silent ones", "phn.verification": "re-probing the survivors, verdicts early",
  "phn.tunnel": "full measurement through the tunnel",
  "phn.hard-primer": "three quick probes in every block", "phn.hard-coverage": "evening out the lopsided blocks",
  "phn.hard-expansion": "more probes where life showed up", "phn.hard-retry": "a second chance for the silent ones",
  "phn.hard-verify": "finalists re-probed; early verdicts", "phn.hard-finalize": "the best, measured end to end",
  "console.ledgerNote": "Bars show progress through each stage. SPRT is the early-verdict test — it can settle a candidate before every round finishes.",
  "genome.counters": "elapsed time {elapsed} · alive {alive} · primed {primed} · expanded {expanded} · split {split}",
  "genome.legend": "Legend", "genome.tapHint": "Tap a cell for the block inspector.",
  "lg.unprobed": "unprobed", "lg.known": "known (reputation)", "lg.priming": "priming", "lg.alive": "alive (depth = rate)",
  "lg.absent": "absent (tick mark)", "lg.hot": "expanding (gold edge)", "lg.suspect": "suspect (underline)", "lg.split": "split",
  "lg.exhausted": "exhausted", "lg.finalist": "finalist (ring)", "lg.winner": "winner (dot)",
  "lane.title": "Sequencing lane — finalists under measurement",
  "insp.thisRun": "This run", "insp.primer": "Primer", "insp.halves": "Halves", "insp.reputation": "Reputation",
  "insp.candidates": "Candidates", "insp.openResults": "Open in Results", "insp.range": "range {range} · lane {lane}",
  "insp.probes": "{ok} ok of {n} probes · rate {rate} · lower95 {lower}", "insp.splitNo": "split: no (p {p})",
  "insp.splitYes": "split: yes — sub-blocks in the quadrants", "insp.tier": "tier: {tier}",
  "insp.repLine": "{n} probes over {runs} runs · decayed rate {rate} · last seen {date} · best {ip} ({colo})",
  "insp.unknown": "Not probed in a previous run.", "insp.noCand": "No candidate from this block yet.",
  "res.title": "Results", "res.fromRun": "Run {run} · {mode} · finished {when}",
  "res.filterBlock": "Showing only block {block}", "res.clearFilter": "clear filter",
  "res.empty": "No results yet. Run a scan and the rankings will appear here.",
  "col.rank": "#", "col.ip": "IP", "col.verdict": "Verdict", "col.cons": "Conservative", "col.raw": "Raw", "col.overall": "Overall",
  "col.elig": "Eligibility", "col.mbps": "Mbps", "col.rpm": "RPM", "col.pop": "POP", "col.gate": "Gate", "col.why": "Why",
  "col.parts": "Score parts", "col.file": "File",
  "comp.web": "Web", "comp.streaming": "Streaming", "comp.load": "Real load", "comp.reliability": "Reliability",
  "verdict.recommended": "Recommended", "verdict.good": "Good", "verdict.usable": "Usable", "verdict.browsing-only": "Browsing only", "verdict.unverified": "Unverified", "verdict.unusable": "Unusable",
  "gate.pass": "Passed", "gate.warn": "Warning", "gate.fail": "Failed", "gate.unknown": "Unknown",
  "ms.complete": "complete", "ms.partial": "partial", "ms.incomplete": "incomplete", "ms.unmeasured": "unmeasured",
  "conf.provisional": "provisional", "conf.low": "low", "conf.medium": "medium", "conf.high": "high",
  "limit.sustainedMbps": "sustained download speed", "limit.shapingRatio": "speed fading over the run", "limit.rpm": "responsiveness under load", "limit.rttIncreaseMs": "added delay under load", "limit.rttInflation": "delay growing under load", "limit.jitterMs": "jitter — uneven timing", "limit.lossRate": "requests lost under load", "limit.fanoutSuccess": "parallel requests failing", "limit.freshConnectionMs": "slow fresh connections", "limit.uplinkMbps": "sustained upload speed",
  "res.scope": "Scores are run-relative: they rank these candidates against each other inside this run — they are not grades against the whole internet.",
  "res.legend": "Complete means every stage was measured. Partial means some stages are missing, and a partial score is capped at 70.",
  "res.top": "Top of this run", "res.notMeasured": "not measured",
  "det.eligibility": "Eligibility", "det.scores": "Scores", "det.load": "Real load", "det.streaming": "Streaming", "det.gates": "Gates", "det.measurement": "Measurement",
  "det.success": "Successful probes", "det.rate": "Success rate", "det.lower95": "Wilson lower bound · 95%", "det.median": "Median handshake", "det.confidence": "Confidence",
  "det.overall": "Overall", "det.rawOverall": "Overall before caps", "det.cons": "Conservative", "det.rawCons": "Conservative before caps",
  "det.sustained": "Sustained", "det.rpm": "Responsiveness (RPM)", "det.shaping": "Shaping ratio", "det.addedRtt": "Added RTT",
  "det.sustainable": "Sustainable", "det.quality": "Quality",
  "det.status": "Gate status", "det.limiting": "Limiting factor", "det.verdict": "The engine's words",
  "det.mstatus": "Measurement status", "det.bytes": "Traffic measured", "det.qoe": "QoE confidence",
  "unit.ms": "ms", "unit.mbps": "Mbps",
  "rep.title": "Reports archive", "rep.sub": "Every saved run. Opening one reads it into the results view.",
  "rep.empty": "No saved reports yet.", "col.run": "Run", "col.mode": "Mode", "col.when": "Finished", "col.size": "Size", "col.open": "",
  "set.title": "Scan settings", "set.sub": "The full settings tree. The web form writes through the same merge-and-migrate path as the terminal editor; the scanner itself saves and applies every change — this form only presents them.",
  "set.workloads": "Workloads", "set.customBrowsing": "Custom browsing page", "set.customStreaming": "Custom HLS stream",
  "set.name": "Name", "set.pageUrl": "Page URL", "set.manifestUrl": "Manifest URL (.m3u8)",
  "set.advanced": "Advanced", "set.estimate": "Estimated traffic per candidate: {bytes}",
  "set.saved": "Settings saved.", "set.restored": "Default settings restored.", "set.invalid": "Some fields are not valid numbers — they are marked; nothing was saved.",
  "set.simNote": "Validated by simulation — change with care.",
  "cfg.title": "VLESS configuration", "cfg.sub": "The stored configuration is managed by reference. The URI itself is never displayed, sent back, or logged — only this safe descriptor.",
  "cfg.stored": "A configuration is stored.", "cfg.notStored": "No configuration stored yet.",
  "cfg.protected": "Secret file protected: {yes}", "cfg.yes": "yes", "cfg.no": "no",
  "cfg.paste": "Paste a vless:// link", "cfg.pastePh": "vless://… (the field clears the moment it is saved)",
  "cfg.imported": "Configuration imported and stored.", "cfg.removed": "Configuration removed.",
  "cfg.removeNote": "Removing is refused while a run is active — a running scan keeps the configuration it started with.",
  "cfg.f.address": "Address", "cfg.f.port": "Port", "cfg.f.host": "Host", "cfg.f.sni": "SNI", "cfg.f.path": "Path",
  "cfg.f.transport": "Transport", "cfg.f.security": "Security", "cfg.f.label": "Label", "cfg.f.idPresent": "ID present",
  "dg.title": "Diagnostics", "dg.system": "System check", "dg.conn": "Connection", "dg.connLive": "Connected to your scanner — everything here is live.", "dg.connOff": "Not connected to your scanner.",
  "dg.calibTruth": "Real scan speed is automatic: every run opens with a short calibration that picks the concurrency your path can carry. There is no manual speed setting.",
  "dg.logs": "Log files", "dg.summary": "Summary", "dg.tail": "Live tail",
  "dg.events": "events", "dg.errors": "errors", "dg.warnings": "warnings",
  "dg.noLogs": "No log files yet.", "dg.tailEmpty": "The tail is quiet. Log lines of the active run will appear here.",
  "note.runActive": "A run is already active ({run}).", "note.configMissing": "No VLESS configuration is stored — import one first.",
  "note.serverStopped": "The scanner on this device stopped. The plate above is the last known state — relaunch from the terminal to continue.",
  "note.stopped": "Run stopped safely; progress is checkpointed.", "note.resumed": "Resumed from the checkpoint.",
  "note.failed": "The run failed — see Diagnostics for what the log recorded.",
  "note.canceled": "Run stopped — partial results are saved.", "note.noRun": "No run is running.",
  "note.noResume": "No paused hard scan was found to resume.", "note.settingsInvalid": "The saved settings could not be loaded — see Diagnostics.",
  "console.failed": "Run failed — {reason}", "err.unknown": "unknown error",
},
fa: {
  "app.tagline": "· اسکنر آی‌پی‌های کلودفلر", "app.subtitle": "دفتر یادداشت توالی‌یاب — نشست محلی",
  "app.colophon": "اسکنر CFQoE — اندازه‌گیری‌ها نسبیِ هر اجرا هستند؛ امتیازها کاندیدها را درون همان اجرا مقایسه می‌کنند.",
  "ui.calm": "آرام", "ui.night": "پلیت شب", "ui.day": "پلیت روز", "ui.stopServer": "توقف اسکنر",
  "ui.stopServerArm": "واقعاً متوقف شود؟", "ui.stopRun": "توقف ایمن", "ui.stopRunArm": "واقعاً متوقف شود؟", "ui.stopping": "در حال توقف…",
  "ui.start": "شروع", "ui.resume": "ادامه", "ui.beginReplication": "آغاز همانندسازی",
  "ui.save": "ذخیره تنظیمات", "ui.restoreDefaults": "بازگردانی پیش‌فرض‌ها", "ui.restoreArm": "واقعاً بازگردانده شود؟",
  "ui.remove": "حذف", "ui.removeArm": "واقعاً حذف شود؟", "ui.import": "وارد کردن پیکربندی",
  "ui.openResults": "مشاهده نتایج کامل", "ui.downloadJson": "دانلود JSON", "ui.downloadBest": "دانلود بهترین آی‌پی‌ها",
  "ui.close": "بستن", "ui.pause": "مکث", "ui.unpause": "ادامهٔ دنبال‌کردن", "ui.add": "افزودن",
  "conn.connecting": "در حال اتصال…", "conn.live": "● زنده — اسکنر شما", "conn.reconnecting": "در حال اتصال مجدد…", "conn.offline": "اسکنر متوقف است",
  "run.running": "در حال اجرا", "run.stopping": "در حال توقف", "run.openConsole": "باز کردن کنسول ←", "run.here": "کنسول باز است — همین‌جا هستید", "run.idle": "هنوز در این نشست اجرایی شروع نشده است.",
  "conn.none": "○ بدون اتصال",
  "off.title": "اسکنر شما پاسخ نمی‌دهد", "off.body": "برنامه روی این دستگاه پاسخ نمی‌دهد — شاید بسته شده باشد. پنجرهٔ ترمینالی را که برنامه را اجرا کرد بررسی کنید و دوباره تلاش کنید.",
  "off.retry": "تلاش دوباره برای اتصال", "off.still": "هنوز پاسخی نیست — آخرین تلاش {time}.",
  "nav.head": "دفتر", "nav.notes": "یادداشت‌های اجرا",
  "nav.dashboard": "پلیت", "nav.genome": "ژنوم", "nav.results": "نتایج", "nav.reports": "گزارش‌ها",
  "nav.settings": "تنظیمات", "nav.config": "پیکربندی", "nav.diagnostics": "عیب‌یابی",
  "dash.status": "وضعیت", "dash.runScan": "شروع یک اسکن", "dash.plateRest": "پلیت، در حالت سکون",
  "dash.latest": "آخرین نتیجه", "dash.noRuns": "هنوز اجرایی انجام نشده است؛ پلیت خالی است.",
  "dash.fromRuns": "از اجراهای ثبت‌شدهٔ شما: {alive} بلاک زنده شناخته شده‌اند · {absent} بلاک غایب · در مجموع {known} بلاک شناخته‌شده.",
  "dash.resumeLine": "ادامهٔ اجرای متوقف‌شدهٔ اسکن عمیق — مرحلهٔ {phase}، {probes} پروب مصرف شده است.",
  "status.config": "پیکربندی", "status.xray": "xray", "status.verify": "راستی‌آزمایی", "status.resume": "ادامه", "status.platform": "پلتفرم",
  "status.ready": "آماده", "status.missing": "موجود نیست", "status.found": "پیدا شد", "status.notFound": "پیدا نشد",
  "status.sprt": "SPRT", "status.off": "خاموش", "status.available": "موجود است", "status.none": "ندارد",
  "mode.quick": "سریع (Quick)", "mode.full": "کامل (Full)", "mode.research": "پژوهشی (Research)", "mode.hard": "اسکن عمیق (Hard Deep Scan)",
  "mode.quick.d": "یک غربال سریع: ۱۶ آی‌پی در ۲ دور. سریع و سطحی — نگاهی نخست به مسیر.",
  "mode.full.d": "اجرای روزمره: ۱۲۰ آی‌پی در ۳ دور، راستی‌آزمایی SPRT روی ۲۰ فینالیست و سنجش کامل کیفیت روی ۵ فینالیست برتر.",
  "mode.research.d": "شواهد عمیق: ۲۴۰ کاندیدا، ۶ دور، ۲۴ فینالیست و سه گذر تونل. کند و موشکافانه.",
  "mode.hard.d": "کل کاتالوگ، بلاک به بلاک: ۲۳٬۰۹۱ پروب پرایمر، گسترش تطبیقی و امکان ادامهٔ اجرا.",
  "console.preflight": "پیش‌پرواز", "console.candidates": "کاندیدا", "console.rounds": "دور غربال",
  "console.finalists": "فینالیست", "console.tunnel": "گذر تونل", "console.estTraffic": "ترافیک تخمینی",
  "console.ledger": "دفتر کاندیداها", "console.noCandidates": "هنوز هیچ کاندیدی مرحله‌ای را کامل نکرده است.",
  "console.finished": "اجرا تمام شد.", "console.viewResults": "مشاهده نتایج",
  "console.stopped": "اجرا متوقف شد — نتایج جزئی ذخیره شدند.", "console.journal": "گزارش رویدادها",
  "console.idleHint": "هیچ اجرایی در حال انجام نیست. از همین‌جا شروع کنید — پیشرفتش زنده و لحظه‌به‌لحظه روی همین صفحه نمایش داده می‌شود.",
  "op.starting": "در حال شروع اجرا…", "op.calibrating": "کالیبراسیون — مسیر شما آزموده می‌شود تا سرعت ایمن انتخاب شود. در مسیرهای کند ممکن است تا یک دقیقه طول بکشد.",
  "op.calibratingLevel": "کالیبراسیون — پلهٔ سرعت {done} از {total} روی مسیر شما آزموده می‌شود.",
  "op.screening": "غربال — دور {round} از {rounds} · در حال آزمودن {ip} · {done} از {total} بررسی انجام شده",
  "op.screeningNoIp": "غربال — دور {round} از {rounds} · {done} از {total} بررسی انجام شده",
  "op.delayed-retry": "تلاش مجدد با تأخیر — به {total} کاندیدای بی‌پاسخ یک فرصت دیگر داده می‌شود · {done} از {total} انجام شده",
  "op.verification": "راستی‌آزمایی — فینالیست {done} از {total} با SPRT دوباره آزموده می‌شود",
  "op.tunnel": "سنجش کیفیت تونل — {ip} از یک تونل واقعی سنجیده می‌شود · کاندیدا {done} از {total}",
  "op.tunnelNoIp": "سنجش کیفیت تونل — فینالیست‌ها از یک تونل واقعی سنجیده می‌شوند · {done} از {total} انجام شده",
  "op.phase": "{phase} · {done} از {total} انجام شده",
  "ev.phase": "▸ {phase}", "ev.scan.start": "اسکن شروع شد", "ev.scan.calibration": "کالیبراسیون تمام شد — اجرا با سرعت انتخاب‌شده ادامه می‌یابد",
  "ev.scan.calibration.no_control": "بررسی مسیر نتوانست نقطهٔ مرجعی را راستی‌آزمایی کند — با سرعت کامل {n} ادامه می‌دهیم؛ نتایج ممکن است قطعیت کمتری داشته باشند",
  "ev.scan.calibration.no_control.plain": "بررسی مسیر نتوانست نقطهٔ مرجعی را راستی‌آزمایی کند — با سرعت پیکربندی‌شده ادامه می‌دهیم؛ نتایج ممکن است قطعیت کمتری داشته باشند",
  "ev.hard.calibration": "کالیبراسیون تمام شد — اجرا با سرعت انتخاب‌شده ادامه می‌یابد",
  "ev.hard.calibration.no_control": "بررسی مسیر نتوانست نقطهٔ مرجعی را راستی‌آزمایی کند — با سرعت کامل {n} ادامه می‌دهیم؛ نتایج ممکن است قطعیت کمتری داشته باشند",
  "ev.hard.calibration.no_control.plain": "بررسی مسیر نتوانست نقطهٔ مرجعی را راستی‌آزمایی کند — با سرعت پیکربندی‌شده ادامه می‌دهیم؛ نتایج ممکن است قطعیت کمتری داشته باشند",
  "ev.scan.delayed_retry.start": "تلاش مجدد با تأخیر شروع شد", "ev.verification.start": "راستی‌آزمایی شروع شد — فینالیست‌ها دوباره آزموده می‌شوند",
  "ev.verification.complete": "راستی‌آزمایی تمام شد", "ev.web.control.scan-stop": "درخواست توقف داده شد",
  "ev.tunnel.backfill": "یک جای فینالیست خالی بود — کاندیدای بعدی جایش را می‌گیرد",
  "ev.accept": "یک فینالیست پذیرفته شد", "ev.reject": "یک فینالیست رد شد", "ev.inconclusive": "یک فینالیست نامشخص ماند — شواهد غربالش تصمیم می‌گیرد",
  "phase.screening": "غربال", "phase.delayed-retry": "تلاش مجدد با تأخیر", "phase.verification": "راستی‌آزمایی (SPRT)",
  "phase.tunnel": "سنجش کیفیت تونل", "phase.calibrating": "کالیبراسیون",
  "phase.hard-primer": "پرایمرها — نقاط آغاز همانندسازی", "phase.hard-coverage": "تصحیح — بررسی بلاک‌های ناهموار",
  "phase.hard-expansion": "چنگال‌های همانندسازی — گسترش بلاک‌های زنده", "phase.hard-retry": "تلاش‌های مجدد با تأخیر",
  "phase.hard-verify": "راستی‌آزمایی فینالیست‌ها (SPRT)", "phase.hard-finalize": "سنجش نهایی کیفیت — خط توالی‌یابی",
  "genome.title": "اسکن عمیق (Hard Deep Scan)", "genome.sub": "کل کاتالوگ کلودفلر به‌صورت یک پلیت: {ranges} بازه · {blocks} بلاک · {addrs} آدرس. هر خانه = یک بلاک \u2068/24\u2069.",
  "genome.ideo": "ایدیوگرام — {ranges} بازه (عرض متناسب با تعداد بلاک)", "genome.plate": "پلیت — {blocks} بلاک",
  "genome.trace": "ردّ — آخرین پروب‌ها (ارتفاع = سرعت)", "genome.liveTop": "برترهای زنده", "genome.liveNotes": "یادداشت‌های زنده",
  "genome.budget": "بودجه", "genome.spent": "{spent} / {total} پروب", "genome.spentOnly": "{spent} پروب مصرف‌شده",
  "genome.intro": "این اسکن کل کاتالوگ را بلاک‌به‌بلاک طی می‌کند. هر وقت خواستید متوقفش کنید — پیشرفت چک‌پوینت می‌شود و «ادامه» از همان‌جا برمی‌دارد.",
  "phn.calibrating": "پیدا کردن سرعتی که این مسیر می‌تواند حمل کند", "phn.screening": "پروب‌های سریع صلاحیت برای همه",
  "phn.delayed-retry": "فرصت دوباره برای بی‌پاسخ‌ها", "phn.verification": "پروب دوباره بازمانده‌ها، با حکم زودهنگام",
  "phn.tunnel": "اندازه‌گیری کامل از درون تونل",
  "phn.hard-primer": "سه پروب سریع در هر بلاک", "phn.hard-coverage": "هم‌سطح‌کردن بلاک‌های ناهموار",
  "phn.hard-expansion": "پروب بیشتر، هرجا نشانه حیات بود", "phn.hard-retry": "فرصت دوباره برای بی‌پاسخ‌ها",
  "phn.hard-verify": "پروب دوباره فینالیست‌ها؛ حکم زودهنگام", "phn.hard-finalize": "بهترین‌ها، اندازه‌گیری‌شده از سر تا ته",
  "console.ledgerNote": "نوارها پیشرفت هر مرحله را نشان می‌دهند. SPRT آزمون حکم زودهنگام است — می‌تواند پیش از پایان همه دورها تکلیف یک کاندید را روشن کند.",
  "genome.counters": "زمان سپری‌شده {elapsed} · زنده {alive} · پرایمر‌شده {primed} · گسترش‌یافته {expanded} · شکافته {split}",
  "genome.legend": "راهنما", "genome.tapHint": "برای بازرسی بلاک، روی یک خانه بزنید.",
  "lg.unprobed": "پروب‌نشده", "lg.known": "شناخته‌شده (اعتبار)", "lg.priming": "پرایمر در حال انجام", "lg.alive": "زنده (عمق = نرخ)",
  "lg.absent": "غایب (تیک)", "lg.hot": "در حال گسترش (لبه طلایی)", "lg.suspect": "مشکوک (خط زیرین)", "lg.split": "شکافته",
  "lg.exhausted": "تمام‌شده", "lg.finalist": "فینالیست (حلقه)", "lg.winner": "برنده (نقطه)",
  "lane.title": "خط توالی‌یابی — فینالیست‌ها در حال اندازه‌گیری",
  "insp.thisRun": "این اجرا", "insp.primer": "پرایمر", "insp.halves": "نیمه‌ها", "insp.reputation": "اعتبار",
  "insp.candidates": "کاندیداها", "insp.openResults": "باز کردن در نتایج", "insp.range": "بازه {range} · خط {lane}",
  "insp.probes": "{ok} موفق از {n} پروب · نرخ {rate} · کران پایین ۹۵٪ {lower}", "insp.splitNo": "شکافت: نه (p {p})",
  "insp.splitYes": "شکافت: بله — زیر‌بلاک‌ها در ربع‌ها", "insp.tier": "رده: {tier}",
  "insp.repLine": "{n} پروب در {runs} اجرا · نرخ افت‌یافته {rate} · آخرین مشاهده {date} · بهترین {ip} ({colo})",
  "insp.unknown": "در اجرای قبلی پروب نشده است.", "insp.noCand": "هنوز کاندیدی از این بلاک نیست.",
  "res.title": "نتایج", "res.fromRun": "اجرای {run} · {mode} · پایان‌یافته در {when}",
  "res.filterBlock": "فقط بلاک {block} نمایش داده می‌شود", "res.clearFilter": "حذف فیلتر",
  "res.empty": "هنوز نتیجه‌ای نیست. یک اسکن اجرا کنید تا رتبه‌بندی اینجا ظاهر شود.",
  "col.rank": "#", "col.ip": "آی‌پی", "col.verdict": "حکم", "col.cons": "محافظه‌کار", "col.raw": "خام", "col.overall": "کلی",
  "col.elig": "صلاحیت", "col.mbps": "Mbps", "col.rpm": "RPM", "col.pop": "POP", "col.gate": "گیت", "col.why": "چرا",
  "col.parts": "اجزای امتیاز", "col.file": "فایل",
  "comp.web": "وب", "comp.streaming": "استریم", "comp.load": "بار واقعی", "comp.reliability": "پایایی",
  "verdict.recommended": "پیشنهادشده", "verdict.good": "خوب", "verdict.usable": "قابل استفاده", "verdict.browsing-only": "فقط وب‌گردی", "verdict.unverified": "تأییدنشده", "verdict.unusable": "غیرقابل استفاده",
  "gate.pass": "قبول", "gate.warn": "قبول با هشدار", "gate.fail": "رد", "gate.unknown": "نامشخص",
  "ms.complete": "کامل", "ms.partial": "ناقص", "ms.incomplete": "ناتمام", "ms.unmeasured": "اندازه‌گیری‌نشده",
  "conf.provisional": "موقت", "conf.low": "کم", "conf.medium": "متوسط", "conf.high": "زیاد",
  "limit.sustainedMbps": "سرعت دانلود پایدار", "limit.shapingRatio": "افت سرعت در طول اجرا", "limit.rpm": "پاسخ‌گویی زیر بار", "limit.rttIncreaseMs": "تأخیر اضافه زیر بار", "limit.rttInflation": "رشد تأخیر زیر بار", "limit.jitterMs": "جیتر — نوسان زمان‌بندی", "limit.lossRate": "درخواست‌های گم‌شده زیر بار", "limit.fanoutSuccess": "خطای درخواست‌های موازی", "limit.freshConnectionMs": "کندی اتصال‌های تازه", "limit.uplinkMbps": "سرعت آپلود پایدار",
  "res.scope": "امتیازها نسبیِ همین اجرا هستند: کاندیدها را فقط با یکدیگر در همین اجرا مقایسه می‌کنند — نمره‌ای در برابر کل اینترنت نیستند.",
  "res.legend": "کامل یعنی همه مراحل اندازه‌گیری شده‌اند. ناقص یعنی بعضی مراحل غایب‌اند و امتیاز ناقص سقف ۷۰ دارد.",
  "res.top": "برترین این اجرا", "res.notMeasured": "اندازه‌گیری نشده",
  "det.eligibility": "صلاحیت", "det.scores": "امتیازها", "det.load": "بار واقعی", "det.streaming": "استریم", "det.gates": "گیت‌ها", "det.measurement": "اندازه‌گیری",
  "det.success": "پروب‌های موفق", "det.rate": "نرخ موفقیت", "det.lower95": "کران پایین ویلسون · ۹۵٪", "det.median": "میانه هندشیک", "det.confidence": "اطمینان",
  "det.overall": "کلی", "det.rawOverall": "کلی پیش از سقف", "det.cons": "محافظه‌کار", "det.rawCons": "محافظه‌کار پیش از سقف",
  "det.sustained": "پایدار", "det.rpm": "پاسخ‌گویی (RPM)", "det.shaping": "نسبت شکل‌دهی", "det.addedRtt": "RTT اضافه",
  "det.sustainable": "ماندگار", "det.quality": "کیفیت",
  "det.status": "وضعیت گیت", "det.limiting": "عامل محدودکننده", "det.verdict": "حکم موتور",
  "det.mstatus": "وضعیت اندازه‌گیری", "det.bytes": "ترافیک اندازه‌گیری‌شده", "det.qoe": "اطمینان QoE",
  "unit.ms": "ms", "unit.mbps": "Mbps",
  "rep.title": "بایگانی گزارش‌ها", "rep.sub": "همهٔ اجراهای ذخیره‌شده. باز کردن هرکدام، آن را در نمای نتایج می‌خواند.",
  "rep.empty": "هنوز گزارش ذخیره‌شده‌ای نیست.", "col.run": "اجرا", "col.mode": "حالت", "col.when": "پایان", "col.size": "حجم", "col.open": "",
  "set.title": "تنظیمات اسکن", "set.sub": "کل درخت تنظیمات. فرم وب از همان مسیر ادغام و مهاجرت ویرایشگر ترمینال می‌نویسد؛ تغییرات را خود اسکنر ذخیره و اعمال می‌کند و این فرم فقط آن‌ها را ارائه می‌کند.",
  "set.workloads": "بارهای کاری", "set.customBrowsing": "صفحهٔ مرور سفارشی", "set.customStreaming": "استریم HLS سفارشی",
  "set.name": "نام", "set.pageUrl": "نشانی صفحه", "set.manifestUrl": "نشانی مانیفست (.m3u8)",
  "set.advanced": "پیشرفته", "set.estimate": "ترافیک تخمینی به‌ازای هر کاندیدا: {bytes}",
  "set.saved": "تنظیمات ذخیره شد.", "set.restored": "تنظیمات پیش‌فرض بازگردانده شد.", "set.invalid": "برخی فیلدها عدد معتبر نیستند — علامت خوردند؛ چیزی ذخیره نشد.",
  "set.simNote": "با شبیه‌سازی اعتبارسنجی شده — با احتیاط تغییر دهید.",
  "cfg.title": "پیکربندی VLESS", "cfg.sub": "پیکربندی ذخیره‌شده با ارجاع مدیریت می‌شود. خود URI هیچ‌وقت نمایش داده نمی‌شود، برگردانده نمی‌شود و در لاگ ثبت نمی‌شود — فقط همین توصیف ایمن.",
  "cfg.stored": "یک پیکربندی ذخیره شده است.", "cfg.notStored": "هنوز پیکربندی‌ای ذخیره نشده است.",
  "cfg.protected": "فایل محرمانه محافظت‌شده است: {yes}", "cfg.yes": "بله", "cfg.no": "نه",
  "cfg.paste": "یک لینک vless:// جای‌گذاری کنید", "cfg.pastePh": "vless://… (فیلد همان لحظهٔ ذخیره پاک می‌شود)",
  "cfg.imported": "پیکربندی وارد و ذخیره شد.", "cfg.removed": "پیکربندی حذف شد.",
  "cfg.removeNote": "حذف هنگام اجرای فعال رد می‌شود — اسکن در حال اجرا پیکربندی شروع خودش را نگه می‌دارد.",
  "cfg.f.address": "آدرس", "cfg.f.port": "پورت", "cfg.f.host": "هاست", "cfg.f.sni": "SNI", "cfg.f.path": "مسیر",
  "cfg.f.transport": "ترانسپورت", "cfg.f.security": "امنیت", "cfg.f.label": "برچسب", "cfg.f.idPresent": "شناسه موجود است",
  "dg.title": "عیب‌یابی", "dg.system": "بررسی سیستم", "dg.conn": "اتصال", "dg.connLive": "به اسکنر شما متصل است — همه‌چیز اینجا زنده است.", "dg.connOff": "به اسکنر شما متصل نیست.",
  "dg.calibTruth": "سرعت اسکن واقعی خودکار است: هر اجرا با یک کالیبراسیون کوتاه شروع می‌شود که هم‌روندی قابل‌تحمل مسیر شما را انتخاب می‌کند. هیچ تنظیم سرعت دستی وجود ندارد.",
  "dg.logs": "فایل‌های لاگ", "dg.summary": "خلاصه", "dg.tail": "دنبالهٔ زندهٔ لاگ",
  "dg.events": "رویداد", "dg.errors": "خطا", "dg.warnings": "هشدار",
  "dg.noLogs": "هنوز فایل لاگی نیست.", "dg.tailEmpty": "دنباله ساکت است. خطوط لاگ اجرای فعال اینجا ظاهر می‌شوند.",
  "note.runActive": "اجرایی هم‌اکنون فعال است ({run}).", "note.configMissing": "پیکربندی VLESS ذخیره نشده است — اول یکی وارد کنید.",
  "note.serverStopped": "اسکنر روی این دستگاه متوقف شد. پلیت بالا آخرین وضعیت شناخته‌شده است — برای ادامه از ترمینال دوباره اجرا کنید.",
  "note.stopped": "اجرا به‌صورت ایمن متوقف شد؛ پیشرفت چک‌پوینت شده است.", "note.resumed": "از چک‌پوینت ادامه یافت.",
  "note.failed": "اجرا ناموفق بود — برای جزئیات، لاگ را در عیب‌یابی ببینید.",
  "note.canceled": "اجرا متوقف شد — نتایج جزئی ذخیره شده‌اند.", "note.noRun": "هیچ اجرایی در حال انجام نیست.",
  "note.noResume": "اسکن عمیقِ متوقف‌شده‌ای برای ادامه یافت نشد.", "note.settingsInvalid": "تنظیمات ذخیره‌شده بارگذاری نشدند — عیب‌یابی را ببینید.",
  "console.failed": "اجرا ناموفق بود — {reason}", "err.unknown": "خطای نامشخص",
}};
let lang = prefs.lang === "fa" ? "fa" : "en";
/* Substitutions are data (IPs, CIDRs, run IDs, counts, rates). Every
   value is wrapped in Unicode bidi isolates (FSI…PDI) at substitution
   time, so Persian prose can never reorder it — the same isolation the
   .d/<bdi> spans give standalone fields, in the one form that survives
   every render context this app uses: textContent, esc()'d HTML and
   plain notices alike, where a literal tag would show or be escaped.
   FSI picks the embedded direction from the value's first strong
   character, so a Persian label parameter isolates as RTL and an IP or
   number as LTR. */
function t(key, params) {
  let s = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll("{" + k + "}", "\u2068" + v + "\u2069");
  return s;
}
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dataset.lang = lang;
  document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  $("#lang-toggle").textContent = lang === "fa" ? "EN" : "فارسی";
  $$("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
  applyTheme(); applyCalm();
}

/* ---------------- shared stats ---------------- */
function wilson(s, n) { // Wilson 95% interval, z = 1.96
  if (!n) return { lower: 0, upper: 0 };
  const z = 1.96, p = s / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lower: Math.max(0, (c - m) / d), upper: Math.min(1, (c + m) / d) };
}
const ipToInt = (s) => s.split(".").reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0);
const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/* ---------------- live source (the W3 server) ---------------- */
const Live = {
  kind: "live", es: null, tail: false,
  async api(path, opts) {
    const r = await fetch(path, { credentials: "same-origin", ...opts });
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  },
  async post(path, body) {
    // Mutations resolve with the server's JSON body on every status:
    // the contract's error codes (run_active, config_missing, …) are
    // how the UI explains a refused action, so a 4xx body is a result,
    // not a connection failure. Only a network-level failure (or a
    // non-JSON body) maps to the synthetic errors.
    try {
      const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CFQoE-Request": "1" }, body: JSON.stringify(body || {}) });
      const data = await r.json().catch(() => null);
      return data && typeof data === "object" ? data : { error: "bad_response" };
    } catch { return { error: "unreachable" }; }
  },
  async probe() {
    try { const c = new AbortController(); const id = setTimeout(() => c.abort(), 1500); const r = await fetch("/api/state", { credentials: "same-origin", signal: c.signal }); clearTimeout(id); return r.ok; }
    catch { return false; }
  },
  getState() { return this.api("/api/state"); },
  getCatalog() { return this.api("/api/catalog"); },
  getSettings() { return this.api("/api/settings"); },
  estimate(settings) { return this.post("/api/settings/estimate", { settings }); },
  getReports() { return this.api("/api/reports"); },
  getResults(id) { return this.api("/api/results/" + encodeURIComponent(id || "latest")); },
  getConfig() { return this.api("/api/config"); },
  getSystem() { return this.api("/api/system"); },
  getLogs() { return this.api("/api/logs"); },
  getLogSummary(name) { return this.api("/api/logs/" + encodeURIComponent(name) + "/summary"); },
  async getBlock(i) { try { return await this.api("/api/block/" + i); } catch { return null; } },
  action(name, body) {
    const map = { run: "/api/run", stop: "/api/run/stop", serverStop: "/api/server/stop", saveSettings: "/api/settings", defaults: "/api/settings/defaults", workloads: "/api/workloads", importConfig: "/api/config", removeConfig: "/api/config/remove" };
    return this.post(map[name], name === "saveSettings" ? { settings: body } : name === "importConfig" ? { uri: body } : body);
  },
  connect() {
    this.disconnect();
    const es = new EventSource("/api/events" + (this.tail ? "?tail=1" : ""));
    this.es = es;
    for (const type of ["phase", "counters", "blocks", "trace", "ticker", "candidate", "log", "run-state"])
      es.addEventListener(type, (e) => { try { app.onEvent(type, JSON.parse(e.data)); } catch { /* malformed frame */ } });
    es.onopen = () => app.onConn("live");
    es.onerror = () => { app.onConn("reconnecting"); scheduleReachCheck(); };
  },
  disconnect() { if (this.es) { this.es.close(); this.es = null; } },
  setTail(on) { if (this.tail !== on) { this.tail = on; if (this.es) this.connect(); } },
};

/* ---------------- app store & event plumbing ---------------- */
const app = {
  src: null, state: null, catalog: null, conn: "connecting",
  runStatus: "idle", runMode: null, runId: null, phase: null, counters: {}, startedAt: 0,
  stopping: false, offline: false, serverStopped: false, runStartedAtMs: 0, viewParts: [], runError: null,
  genome: null, // {state, heat, quads, quadHeat, known} Uint arrays, 7,697 cells
  tracePts: [], ticker: [], ledger: new Map(), lane: [], logs: [],
  lastSeq: 0, view: null, viewName: "",
  onConn(s) {
    this.conn = s;
    const pill = $("#conn-pill");
    if (s === "live") { pill.textContent = t("conn.live"); pill.className = "pill pill-live"; }
    else if (s === "offline") { pill.textContent = t("conn.offline"); pill.className = "pill pill-off"; this.showNotice(t("note.serverStopped"), "info"); }
    else if (s === "none") { pill.textContent = t("conn.none"); pill.className = "pill pill-off"; }
    else { pill.textContent = t("conn.reconnecting"); pill.className = "pill pill-off"; }
    if (s === "live") this.resync();
  },
  showNotice(msg, kind) {
    const n = $("#notice"); n.textContent = msg; n.className = "notice" + (kind === "info" ? " info" : ""); n.hidden = false;
    clearTimeout(this._noticeT); this._noticeT = setTimeout(() => { n.hidden = true; }, 9000);
  },
  async resync() {
    // Snapshots are fetched concurrently (event resyncs, view
    // mounts, reconnects) and may resolve out of order; only the
    // newest fetch may apply, or a snapshot taken while the run was
    // live can land after its terminal event and resurrect it.
    const token = (this._resyncSeq = (this._resyncSeq || 0) + 1);
    try { const s = await this.src.getState(); if (token !== this._resyncSeq) return; this.applySnapshot(s); } catch { /* server gone; pill already says so */ }
  },
  applySnapshot(s) {
    this.state = s;
    if (s.server && s.server.version) $("#version").textContent = "v" + s.server.version;
    const g = (s.run && s.run.genome) || s.genome;
    if (g) this.genome = { state: b64ToU8(g.state), heat: b64ToU8(g.heat), quads: b64ToU32(g.quads), quadHeat: g.quadHeat ? b64ToU32(g.quadHeat) : new Uint32Array(7697), known: b64ToU8(g.known) };
    // A snapshot whose fetch began before a run ended can still
    // carry that run as "running"; the terminal run-state event is
    // newer truth for the same runId and wins (backend truth is the
    // terminal status the state store now also serves at rest, so
    // this guard only ever fires on the in-flight race).
    if (s.run && s.run.status === "running" && s.run.runId === this.runId && ["complete", "canceled", "failed", "paused-done"].includes(this.runStatus)) s.run = { ...s.run, status: this.runStatus };
    if (s.run) { this.runStatus = s.run.status; this.runMode = s.run.mode; this.runId = s.run.runId; this.phase = s.run.phase; this.counters = s.run.counters || {}; if (s.run.error) this.runError = s.run.error; if (s.run.status === "running") this.runError = null; const started = Date.parse(s.run.startedAt); if (Number.isFinite(started)) this.runStartedAtMs = started; }
    else { this.runStatus = s.status && s.status.resumeAvailable ? "paused-done" : this.runStatus === "complete" ? "complete" : "idle"; if (this.runStatus !== "running") this.stopping = false; }
    this.refreshChrome();
    if (this.view && this.view.onSnapshot) this.view.onSnapshot(s);
  },
  onEvent(type, d) {
    if (d && d.seq) { if (this.lastSeq && d.seq > this.lastSeq + 1 && this.src.kind === "live") this.resync(); this.lastSeq = Math.max(this.lastSeq, d.seq); }
    if (type === "phase") { this.phase = d.phase; this.startedAt = d.startedAt || this.startedAt; }
    if (type === "counters") { this.counters = { ...this.counters, ...d }; }
    if (type === "blocks" && this.genome) {
      for (const [i, st, heat, q, qh] of d.deltas) { this.genome.state[i] = st; this.genome.heat[i] = heat; if (q != null) { this.genome.quads[i] = q; this.genome.quadHeat[i] = qh || 0; } if (window.__plate) __plate.noteDirty(i, st); }
    }
    if (type === "trace") { this.tracePts.push(...d.points); if (this.tracePts.length > 400) this.tracePts.splice(0, this.tracePts.length - 400); }
    if (type === "ticker") { this.ticker.unshift(d.text); this.ticker = this.ticker.slice(0, 40); this.refreshNotes(); }
    if (type === "candidate") { this.ledger.set(d.row.ip, d.row); if (d.lane) this.lane.push(d.row); }
    if (type === "log" && d.event && d.event.endsWith("calibration.no_control")) { const txt = journalText("log", d); if (txt) this.showNotice(txt); }
    if (type === "run-state") {
      if (d.status === "running") this.runError = null;
      if (d.error) this.runError = d.error;
      if (d.status === "running" && d.runId !== this._lastRunId) { this.ledger.clear(); this.lane = []; this.tracePts = []; this.runStartedAtMs = Date.now(); }
      this._lastRunId = d.runId;
      this.runStatus = d.status; this.runMode = d.mode; this.runId = d.runId;
      if (d.status !== "running") this.stopping = false;
      if (d.status === "complete" || d.status === "paused-done" || d.status === "failed" || d.status === "canceled") setTimeout(() => this.resync(), 350);
      if (d.status === "paused-done") this.showNotice(t("note.stopped"), "info");
      if (d.status === "canceled") this.showNotice(t("note.canceled"), "info");
      if (d.status === "failed") this.showNotice(t("note.failed"));
    }
    this.refreshChrome();
    if (this.view && this.view.onEvent) this.view.onEvent(type, d);
  },
  refreshNotes(force) {
    const el = $("#margin-notes"); if (!el) return;
    const top = this.ticker.slice(0, 3);
    const sig = lang + "|" + top.join("");
    if (sig === this._notesSig) return; // rebuild only when the visible notes actually change
    const now = performance.now();
    if (!force && this._notesAt && now - this._notesAt < 500) { // …and never faster than 2/s
      if (!this._notesTimer) this._notesTimer = setTimeout(() => { this._notesTimer = null; this._notesSig = null; this.refreshNotes(true); }, 510);
      return;
    }
    this._notesSig = sig; this._notesAt = now;
    el.innerHTML = top.length ? top.map((x) => `<div>${esc(x)}</div>`).join("") : esc(t("run.idle"));
  },
  // Elapsed time is read off the local clock, never off the last
  // counters frame: a quiet phase emits nothing for stretches, and a
  // frozen clock is exactly what makes a live run look dead.
  elapsedMs() { return this.runStartedAtMs ? Math.max(0, Date.now() - this.runStartedAtMs) : (this.counters.elapsedMs || 0); },
  refreshChrome(force) {
    // Chrome is a summary, not a counter: events arrive per probe, so
    // this renders only when something it shows actually changed, at
    // most twice a second — a trailing render always lands the final
    // state, so nothing visible is ever lost to the throttle.
    const c = this.counters;
    const sig = [lang, this.runStatus, this.runMode, this.runId, this.phase, this.stopping, this.viewName, this.viewParts[1] || "",
      Math.floor(this.elapsedMs() / 1000), c.probesSpent || c.completed || 0,
      ((this.state || {}).latest || {}).runId || ""].join("|");
    if (sig === this._chromeSig) return;
    const now = performance.now();
    if (!force && this._chromeAt && now - this._chromeAt < 500) {
      if (!this._chromeTimer) this._chromeTimer = setTimeout(() => { this._chromeTimer = null; this._chromeSig = null; this.refreshChrome(true); }, 510);
      return;
    }
    this._chromeSig = sig; this._chromeAt = now;
    const b = $("#run-banner");
    if (this.runStatus === "running") {
      b.hidden = false;
      $(".rb-label", b).textContent = t(this.stopping ? "run.stopping" : "run.running");
      const jump = $("#rb-jump");
      const here = (this.runMode === "hard" && this.viewName === "genome") || (this.runMode !== "hard" && this.viewName === "scan" && this.viewParts[1] === this.runMode);
      if (here) { jump.removeAttribute("href"); jump.textContent = t("run.here"); jump.classList.add("dim"); }
      else { jump.setAttribute("href", this.runMode === "hard" ? "#/genome" : "#/scan/" + this.runMode); jump.textContent = t("run.openConsole"); jump.classList.remove("dim"); }
      $("#rb-text").textContent = `${t("mode." + this.runMode)} · ${this.phase ? t("phase." + this.phase) : ""} · ${mmss(this.elapsedMs())} · ${fmt(this.counters.probesSpent || this.counters.completed || 0)}`;
    } else b.hidden = true;
    $("#foot-status").textContent = this.state && this.state.latest ? `${this.state.latest.runId} · ${this.state.latest.finishedAt || ""}` : "";
    this.refreshNotes();
  },
};

/* ---------------- chrome wiring ---------------- */
function refreshStatic() {
  $$("#margin a[data-nav]").forEach((a) => { a.textContent = t("nav." + a.dataset.nav); });
  app.refreshNotes(); app.refreshChrome();
}
function armButton(btn, armKey, fn) {
  if (btn.dataset.armed) { btn.dataset.armed = ""; btn.classList.remove("armed"); btn.textContent = btn.dataset.label; fn(); return; }
  btn.dataset.label = btn.textContent; btn.dataset.armed = "1"; btn.classList.add("armed"); btn.textContent = t(armKey);
  setTimeout(() => { if (btn.dataset.armed) { btn.dataset.armed = ""; btn.classList.remove("armed"); btn.textContent = btn.dataset.label; } }, 4000);
}
function drawHelix() {
  const svg = $("#helix"); if (!svg) return;
  // The mark is DRAWN, never transformed: the two strands are sine
  // curves whose shared phase advances slowly, so the eye reads a
  // rotating double helix. (The previous CSS scaleY "breath" scaled
  // the whole element — strokes shimmered, the mark bled outside
  // its box, and the motion read as a rubber band, not DNA.) Points
  // are recomputed per frame: stroke widths never distort and the
  // drawing stays inside its 72×18 box. Rungs fade with strand
  // separation as the depth cue. Calm / reduced-motion keeps the
  // static frame — the same gate every other motion obeys.
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.appendChild(el); return el; };
  const XS = []; for (let x = 0; x <= 72; x += 3) XS.push(x);
  const RUNG_XS = [6, 18, 30, 42, 54, 66];
  const rungs = RUNG_XS.map((x) => mk("line", { x1: x, x2: x, style: "stroke:var(--ink-40)", "stroke-width": 1 }));
  const s1 = mk("polyline", { fill: "none", style: "stroke:var(--a)", "stroke-width": 1.4 });
  const s2 = mk("polyline", { fill: "none", style: "stroke:var(--c)", "stroke-width": 1.4 });
  const frame = (phase) => {
    const y = (x, sgn) => 9 + sgn * 6 * Math.sin((x / 72) * Math.PI * 2 + phase);
    s1.setAttribute("points", XS.map((x) => `${x},${y(x, 1).toFixed(1)}`).join(" "));
    s2.setAttribute("points", XS.map((x) => `${x},${y(x, -1).toFixed(1)}`).join(" "));
    rungs.forEach((r, i) => { const x = RUNG_XS[i]; r.setAttribute("y1", y(x, 1).toFixed(1)); r.setAttribute("y2", y(x, -1).toFixed(1)); r.style.opacity = (0.2 + 0.7 * Math.abs(Math.sin((x / 72) * Math.PI * 2 + phase))).toFixed(2); });
  };
  frame(0);
  if (prefs.calm) return;
  const loop = makeLoop(() => { if (!prefs.calm) frame((performance.now() / 14000) * Math.PI * 2); }); // one slow turn ≈ 14 s; calm holds the still frame
  loop.start(svg);
}

/* ---------------- router ---------------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  return { parts, q: new URLSearchParams(qs || "") };
}
const Views = {}; // filled below: dashboard, genome, scan, results, reports, settings, config, diagnostics
function route() {
  if (app.offline) { renderOffline(); return; }
  const { parts, q } = parseHash();
  const name = parts[0] || "dashboard";
  if (app.view && app.view.destroy) app.view.destroy();
  window.__plate = null;
  $$("#margin a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name || (name === "scan" && a.dataset.nav === "dashboard")));
  const el = $("#view"); el.innerHTML = "";
  const fn = name === "scan" ? Views.scan : Views[name] || Views.dashboard;
  app.viewName = name;
  app.viewParts = parts;
  app.view = fn(el, parts, q) || {};
  el.focus({ preventScroll: true });
  app.refreshChrome(true);
}

/* ---------------- canvas palettes (hex twins of the OKLCH tokens) ---------------- */
const PAL = {
  light: { a: "#35934B", c: "#3867B0", g: "#C77400", t: "#BC3F27", ink: "#23201A", ink40: "rgba(35,32,26,0.40)", ink12: "rgba(35,32,26,0.12)", ink08: "rgba(35,32,26,0.07)", paper: "#FAF6EE", plate: "#F1EADD", plate2: "#EAE1CE" },
  dark: { a: "#55B877", c: "#6E97D6", g: "#E08E1A", t: "#D96A4E", ink: "#E8E2D4", ink40: "rgba(232,226,212,0.40)", ink12: "rgba(232,226,212,0.12)", ink08: "rgba(232,226,212,0.07)", paper: "#171410", plate: "#221E18", plate2: "#2A251D" },
};

/* ---------------- the plate ----------------
   Two-layer canvas: a cached static layer (paper, ghost slots, the
   reputation wash) and a dynamic layer that redraws only dirty cells,
   batched by color. State lives in the app's typed arrays; the plate
   owns geometry, animation clocks and hit-testing — never the data. */
class Plate {
  constructor(wrap, opts = {}) {
    this.wrap = wrap; this.mini = !!opts.mini; this.onTap = opts.onTap || null;
    this.inspect = null; this.dirty = new Set(); this.anims = new Map(); this.priming = new Set();
    this.dark = document.documentElement.dataset.theme === "dark";
    wrap.innerHTML = `<div class="plate-stack" dir="ltr" style="position:relative;line-height:0">
      <canvas class="cv-static"></canvas><canvas class="cv-dyn" style="position:absolute;left:0;top:0"></canvas></div>`;
    this.cvS = $(".cv-static", wrap); this.cvD = $(".cv-dyn", wrap);
    this.cxS = this.cvS.getContext("2d"); this.cxD = this.cvD.getContext("2d", { alpha: true });
    this.dpr = Math.min(window.devicePixelRatio || 1, (matchMedia("(pointer: coarse)").matches || innerWidth < 600) ? 1.5 : 2);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    if (!this.mini) {
      this.cvD.addEventListener("click", (e) => { const i = this.hit(e); if (i >= 0 && this.onTap) this.onTap(i, e); });
      this.cvD.addEventListener("mousemove", (e) => { const i = this.hit(e); this.hover = i; this.cvD.style.cursor = i >= 0 ? "pointer" : "default"; if (this.onHover) this.onHover(i); });
    } else this.cvD.addEventListener("click", () => { location.hash = "#/genome"; });
    this.loop = makeLoop(() => this.frame());
    this.resize();
  }
  setTheme(dark) { this.dark = dark; this.drawStatic(); this.allDirty(); }
  pal() { return PAL[this.dark ? "dark" : "light"]; }
  geometry() {
    const W = this.wrap.clientWidth || 300;
    let cell, gap, cols, count = 7697, origin = 0;
    if (this.inspect != null && app.catalog) {
      const r = app.catalog.ranges[this.inspect]; count = r.blocks; origin = app.catalog.ranges.slice(0, this.inspect).reduce((a, x) => a + x.blocks, 0);
      cell = 16; gap = 2; cols = Math.max(1, Math.min(count, Math.floor((W + gap) / (cell + gap))));
    } else if (this.mini) { cell = W >= 600 ? 4 : 3; gap = 1; cols = Math.floor((W + gap) / (cell + gap)); }
    else { cell = W >= 900 ? 9 : W >= 600 ? 6 : 4; gap = W >= 600 ? 2 : 1; cols = Math.floor((W + gap) / (cell + gap)); }
    const rows = Math.ceil(count / cols), H = rows * (cell + gap) - gap;
    return { W, cell, gap, cols, rows, H, count, origin };
  }
  resize() {
    const g = this.geometry(); this.geo = g;
    for (const cv of [this.cvS, this.cvD]) { cv.width = Math.round(g.W * this.dpr); cv.height = Math.round(g.H * this.dpr); cv.style.width = g.W + "px"; cv.style.height = g.H + "px"; }
    this.drawStatic(); this.allDirty();
  }
  allDirty() { if (app.genome) for (let i = 0; i < 7697; i++) this.dirty.add(i); }
  noteDirty(i, st) {
    this.dirty.add(i);
    if (st === 2) this.priming.add(i); else this.priming.delete(i);
    if ((st === 3 || st === 5 || st === 7 || st === 9) && !prefs.calm) this.anims.set(i, performance.now());
    if (this.mini) this.drawDynamic(performance.now());
  }
  cellXY(i) { const g = this.geo, k = i - g.origin; if (k < 0 || k >= g.count) return null; const x = (k % g.cols) * (g.cell + g.gap), y = Math.floor(k / g.cols) * (g.cell + g.gap); return { x, y, s: g.cell }; }
  hit(e) {
    const r = this.cvD.getBoundingClientRect(), g = this.geo;
    const x = (e.clientX - r.left), y = (e.clientY - r.top);
    const col = Math.floor(x / (g.cell + g.gap)), row = Math.floor(y / (g.cell + g.gap));
    if (col >= g.cols || x % (g.cell + g.gap) > g.cell || y % (g.cell + g.gap) > g.cell) return -1;
    const k = row * g.cols + col; return k < g.count ? g.origin + k : -1;
  }
  drawStatic() {
    const { cxS: cx } = this, g = this.geo, P = this.pal(); if (!g) return;
    cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    cx.fillStyle = P.plate; cx.fillRect(0, 0, g.W, g.H);
    if (!app.genome) return;
    const { state, known } = app.genome;
    for (let k = 0; k < g.count; k++) {
      const i = g.origin + k, x = (k % g.cols) * (g.cell + g.gap), y = Math.floor(k / g.cols) * (g.cell + g.gap), s = g.cell;
      cx.strokeStyle = P.ink08; cx.lineWidth = 1; cx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      if (state[i] === 1 && known[i]) { // reputation wash — yesterday's evidence, faintly present
        cx.fillStyle = known[i] >= 128 ? P.a : P.ink; cx.globalAlpha = known[i] >= 128 ? 0.10 + 0.14 * (known[i] / 255) : 0.08;
        cx.fillRect(x, y, s, s); cx.globalAlpha = 1;
        cx.fillStyle = P.ink40; cx.fillRect(x + s - 3, y, 3, 2); // corner tick: "we have been here"
      }
    }
    if (!this.mini) this.drawDynamic(performance.now());
  }
  drawDynamic(now) {
    const { cxD: cx } = this, g = this.geo, P = this.pal(); if (!g || !app.genome) return;
    cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { state, heat, quads, quadHeat } = app.genome;
    const groups = new Map();
    const put = (color, fn) => { (groups.get(color) || groups.set(color, []).get(color)).push(fn); };
    for (const i of this.dirty) {
      const pos = this.cellXY(i); if (!pos) continue;
      const { x, y, s } = pos, st = state[i];
      cx.clearRect(x - 1, y - 1, s + 2, s + 2);
      if (st === 0 || st === 1) continue;
      const anim = this.anims.get(i), age = anim ? now - anim : 1e9;
      if (st === 2) { const a = prefs.calm ? 0.55 : 0.35 + 0.33 * (0.5 + 0.5 * Math.sin(now / 260 + (i % 7))); put(P.g, (c) => { c.globalAlpha = a; c.fillRect(x, y, s, s); c.globalAlpha = 1; }); }
      else if (st === 3 || st === 5) {
        const p = age < 500 ? age / 500 : 1, h = Math.max(1, (heat[i] / 255) * s * (age < 500 ? 0.55 + 0.45 * p : 1));
        put(P.a, (c) => { c.globalAlpha = age < 500 ? 0.35 + 0.65 * p : 1; c.fillRect(x, y + s - h, s, h); c.globalAlpha = 1; });
        if (st === 5) put(P.g, (c) => c.fillRect(x, y, s, 2)); // the fork's leading edge
      }
      else if (st === 4) put(P.ink40, (c) => c.fillRect(x + s / 2 - 1.5, y + s - 3, 3, 2)); // absence: a tick, not an alarm
      else if (st === 6) { if (heat[i]) put(P.a, (c) => c.fillRect(x, y + s - Math.max(1, heat[i] / 255 * s), s, Math.max(1, heat[i] / 255 * s))); put(P.g, (c) => c.fillRect(x, y + s - 2, s, 2)); }
      else if (st === 8) put(P.ink12, (c) => c.fillRect(x, y, s, s));
      else if (st === 7) this.drawSplit(cx, i, x, y, s, age);
      else if (st === 9 || st === 10) {
        put(P.a, (c) => c.fillRect(x, y + s - Math.max(1, heat[i] / 255 * s), s, Math.max(1, heat[i] / 255 * s)));
        const frac = age < 400 ? age / 400 : 1, per = 4 * Math.max(0, s - 2);
        put(P.c, (c) => { c.lineWidth = 1.5; c.setLineDash([per * frac, per]); c.strokeRect(x + 1, y + 1, s - 2, s - 2); c.setLineDash([]); });
        if (st === 10) put(P.paper, (c) => { c.beginPath(); c.arc(x + s / 2, y + s / 2, Math.max(1.2, s * 0.16), 0, 7); c.fill(); });
      }
    }
    for (const [color, fns] of groups) { cx.fillStyle = color; cx.strokeStyle = color; for (const f of fns) f(cx); }
    this.dirty.clear();
  }
  drawSplit(cx, i, x, y, s, age) {
    const P = this.pal(), q = app.genome.quads[i], qh = app.genome.quadHeat[i];
    const qs = [q & 255, (q >>> 8) & 255, (q >>> 16) & 255, (q >>> 24) & 255], hs = [qh & 255, (qh >>> 8) & 255, (qh >>> 16) & 255, (qh >>> 24) & 255];
    const inset = age < 450 && !prefs.calm ? (1 - age / 450) * 1.5 : 0; // the unzip: halves part along the seam
    cx.strokeStyle = P.ink40; cx.lineWidth = 1; cx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    const half = (qx, qw, top, bot, th, bh) => {
      if (top === bot && th === bh) { if (top === 3) { cx.fillStyle = P.a; const h = Math.max(1, th / 255 * s); cx.fillRect(qx, y + s - h, qw, h); } else if (top === 4) { cx.fillStyle = P.ink40; cx.fillRect(qx + qw / 2 - 1, y + s - 3, 2, 2); } else if (top === 8) { cx.fillStyle = P.ink12; cx.fillRect(qx, y, qw, s); } return; }
      const hh = s / 2;
      for (const [st, ht, yy] of [[top, th, y], [bot, bh, y + hh]]) {
        if (st === 3) { cx.fillStyle = P.a; const h = Math.max(1, ht / 255 * hh); cx.fillRect(qx, yy + hh - h, qw, h); }
        else if (st === 8) { cx.fillStyle = P.ink12; cx.fillRect(qx, yy, qw, hh); }
      }
    };
    const hw = s / 2;
    half(x, hw - inset, qs[0], qs[1], hs[0], hs[1]);
    half(x + hw + inset, hw - inset, qs[2], qs[3], hs[2], hs[3]);
    cx.fillStyle = P.ink40; cx.fillRect(x + hw - 0.5, y, 1, s); // the seam
  }
  frame() {
    if (!app.genome) return;
    const now = performance.now();
    for (const i of this.priming) this.dirty.add(i); // pulses keep breathing while probes fly
    for (const [i, t0] of this.anims) { if (now - t0 > 600) this.anims.delete(i); else this.dirty.add(i); }
    if (this.dirty.size > 1500) { this.drawStatic(); this.allDirty(); this.drawDynamic(now); return; }
    if (this.dirty.size) this.drawDynamic(now);
  }
  destroy() { this.ro.disconnect(); this.loop.stop(); }
}
function makeLoop(fn) {
  let raf = 0, visible = true, on = false;
  const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { threshold: 0.02 });
  const step = () => { if (!on) return; if (visible && !document.hidden) fn(); raf = requestAnimationFrame(step); };
  return { start(target) { on = true; if (target) io.observe(target); raf = requestAnimationFrame(step); }, stop() { on = false; cancelAnimationFrame(raf); io.disconnect(); } };
}

/* ---------------- the chromatogram trace ---------------- */
class Trace {
  constructor(canvas) { this.cv = canvas; this.cx = canvas.getContext("2d"); }
  draw() {
    const { cx, cv } = this, P = PAL[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];
    const W = cv.clientWidth || 300, H = 56, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + "px"; }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, H);
    cx.strokeStyle = P.ink40; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(0, H - 8.5); cx.lineTo(W, H - 8.5); cx.stroke();
    const pts = app.tracePts, n = Math.min(pts.length, Math.floor(W / 3), 320), base = H - 8;
    for (let k = 0; k < n; k++) {
      const [outcome, ms] = pts[pts.length - n + k], x = W - (n - k) * 3;
      if (outcome === "ok" || outcome === "recovered") {
        const h = Math.max(4, Math.min(46, 2600 / Math.max(30, ms)));
        cx.fillStyle = P.a; cx.fillRect(x, base - h, 2, h);
        if (outcome === "recovered") { cx.fillStyle = P.g; cx.fillRect(x, base - h - 3, 2, 2); }
      } else if (outcome === "error") { cx.fillStyle = P.t; cx.fillRect(x, base - 14, 2, 5); }
      else { cx.fillStyle = P.ink40; cx.fillRect(x, base - 3, 2, 3); }
    }
  }
}

/* ---------------- views ---------------- */
function statusKv(s) {
  if (!s) return `<span class="dim">${esc(t("conn.connecting"))}</span>`;
  const st = s.status || {}, on = (v, a, b) => `<b>${esc(v ? a : b)}</b>`;
  return `<span>${t("status.config")} ${on(st.configReady, t("status.ready"), t("status.missing"))}</span> ·
    <span>xray ${on(st.xrayFound, t("status.found"), t("status.notFound"))}</span> ·
    <span>${t("status.verify")} ${on(st.verifyEnabled, t("status.sprt"), t("status.off"))}</span> ·
    <span>${t("status.resume")} ${on(st.resumeAvailable, t("status.available"), t("status.none"))}</span> ·
    <span>${t("status.platform")} <b>${esc((s.server || {}).platform || "")}</b></span>`;
}
async function startRun(mode, resume) {
  const r = await app.src.action("run", resume ? { mode: "hard", resume: true } : { mode });
  if (r && r.error) {
    if (r.error === "config_missing") { app.showNotice(t("note.configMissing")); location.hash = "#/config"; }
    else if (r.error === "run_active") app.showNotice(t("note.runActive", { run: r.runId || "—" }));
    else if (r.error === "no_resume") app.showNotice(t("note.noResume"));
    else if (r.error === "settings_invalid") app.showNotice(t("note.settingsInvalid"));
    else app.showNotice(r.message || r.error);
    return;
  }
  location.hash = mode === "hard" ? "#/genome" : "#/scan/" + mode;
}
// The one stop path for every run view. Confirming a stop must be
// visible the moment it happens — the button, the banner and the
// narration all switch to "stopping" before the request is even
// sent, and stay there until the run's terminal state arrives. A
// refused stop (the run already ended) is explained, never swallowed.
async function stopRun() {
  if (app.stopping || app.runStatus !== "running") return;
  app.stopping = true; app.refreshChrome(true);
  if (app.view && app.view.onEvent) app.view.onEvent("stopping");
  const r = await app.src.action("stop");
  if (r && r.error) {
    app.stopping = false;
    app.showNotice(r.error === "no_active_run" ? t("note.noRun") : (r.message || r.error));
    app.refreshChrome(true);
    if (app.view && app.view.onEvent) app.view.onEvent("stopping");
    app.resync();
  }
}
// Journal lines are humanized from the run's real event stream —
// phase changes, the server's own ticker notes, and the log events
// whose names the journal knows how to say in plain words. Anything
// else stays out (the raw tail lives in Diagnostics, unedited).
const EV_KEYS = { "scan.start": "ev.scan.start", "scan.calibration": "ev.scan.calibration", "scan.calibration.no_control": "ev.scan.calibration.no_control", "hard.calibration": "ev.hard.calibration", "hard.calibration.no_control": "ev.hard.calibration.no_control", "scan.delayed_retry.start": "ev.scan.delayed_retry.start", "verification.start": "ev.verification.start", "verification.complete": "ev.verification.complete", "web.control.scan-stop": "ev.web.control.scan-stop", "tunnel.backfill": "ev.tunnel.backfill" };
function journalText(type, d) {
  if (type === "phase") return t("ev.phase", { phase: t("phase." + d.phase) });
  if (type === "ticker") { const word = { accept: "ev.accept", reject: "ev.reject", inconclusive: "ev.inconclusive" }[d.text]; return word ? t(word) : d.text; }
  if (type === "log") { const k = EV_KEYS[d.event]; if (!k) return null; if (d.event.endsWith("no_control")) return d.n != null ? t(k, { n: fmt(d.n) }) : t(k + ".plain"); return t(k); }
  return null;
}
/* Plain words for the report's coded values: the results surface
   speaks the reader's language, in both languages. The raw codes
   stay in the JSON download, one click away — never on the table. */
const word = (prefix, value) => (value && STR[lang] && STR[lang][prefix + value] ? t(prefix + value) : null);
const verdictWord = (r) => word("verdict.", r.verdict?.label) || r.verdict?.label || word("ms.", r.measurement?.status) || r.measurement?.status || "–";
const gateWord = (s) => word("gate.", s) || s || "–";
const statusWord = (s) => word("ms.", s) || s || "–";
const confWord = (c) => word("conf.", c) || c || "–";
const limitingWord = (r) => word("limit.", r.gates?.limiting) || r.limitingFactor || r.gates?.limiting || statusWord(r.measurement?.status);
/* The four weighted components, typeset as one strip: a micro-label
   per stage (Web · Streaming · Load · Reliability) over the report's
   own one-decimal scores. Missing stages show the honest dash. */
function partsCell(r) {
  const s = r.scores || {};
  const cells = [["W", "comp.web", s.browsing], ["S", "comp.streaming", s.streaming], ["L", "comp.load", s.load], ["R", "comp.reliability", s.reliability]];
  return `<span class="parts" dir="ltr">${cells.map(([k, key, v]) => `<span class="part" title="${esc(t(key))}"><i>${k}</i>${f1(v)}</span>`).join("")}</span>`;
}
const lower95Of = (r) => (r.scores?.reliabilityLower95 == null ? "–" : f1(r.scores.reliabilityLower95) + "%");
/* The results table. Row order IS the report's order — the report
   builder ranks (complete above partial, then its score order) and
   this view never re-sorts; rank numbers are the rows' positions in
   the full ranking, passed in as `ranks` when a filtered subset is
   shown, so a subset can never crown its own first row as #1. */
function resultsTable(rows, compact, ranks) {
  const rk = ranks || rows.map((_, i) => i + 1);
  const head = `<tr><th class="num c-rank">${t("col.rank")}</th><th class="c-ip">${t("col.ip")}</th><th class="c-verdict">${t("col.verdict")}</th><th class="num c-cons">${t("col.cons")}</th><th class="c-parts">${t("col.parts")}</th>${compact ? "" : `<th class="num c-raw">${t("col.raw")}</th><th class="num c-over">${t("col.overall")}</th>`}<th class="c-elig">${t("col.elig")}</th><th class="num c-mbps">${t("col.mbps")}</th><th class="num c-rpm">${t("col.rpm")}</th><th class="c-pop">${t("col.pop")}</th><th class="c-gate">${t("col.gate")}</th>${compact ? "" : `<th class="c-why">${t("col.why")}</th>`}</tr>`;
  const body = rows.map((r, i) => {
    const rank = rk[i], best = rank === 1;
    return `<tr class="${best ? "best " : ""}clickable" data-i="${i}">
    <td class="num c-rank">${best ? `<span class="rank-stamp">1</span>` : rank}</td><td class="c-ip">${best ? '<span class="tick-a">▸</span> ' : ""}${D(r.ip)}</td><td class="c-verdict">${esc(verdictWord(r))}</td>
    <td class="num score c-cons">${f1(r.scores?.conservative)}</td><td class="c-parts">${partsCell(r)}</td>${compact ? "" : `<td class="num dim c-raw">${f1(r.scores?.conservativeUncapped)}</td><td class="num c-over">${f1(r.scores?.overall)}</td>`}
    <td class="c-elig" data-l="${esc(t("col.elig"))}">${D((r.eligibility?.successes ?? "–") + "/" + (r.eligibility?.attempts ?? "–"))} <span class="dim">↓${lower95Of(r)}</span></td>
    <td class="num c-mbps" data-l="${esc(t("col.mbps"))}">${f2(r.load?.sustainedMbps)}</td><td class="num c-rpm" data-l="${esc(t("col.rpm"))}">${f1(r.load?.rpm)}</td><td class="c-pop" data-l="${esc(t("col.pop"))}">${esc(r.eligibility?.pops?.dominant || "–")}</td>
    <td class="c-gate" data-l="${esc(t("col.gate"))}">${esc(gateWord(r.gates?.status))}</td>${compact ? "" : `<td class="c-why">${esc(limitingWord(r))}</td>`}</tr>`;
  }).join("");
  return `<table class="data res ${compact ? "res-c" : "res-f"}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
/* The row expansion: a structured ledger, not a text dump. Every
   value is the report's, under the same display rules as the table;
   a stage the engine did not measure says so, in the reader's
   language, instead of printing undefined-shaped noise. */
function resultDetail(r) {
  const s = r.scores || {}, e = r.eligibility || {}, g = r.gates || {}, m = r.measurement || {};
  const withUnit = (txt, unit) => (txt === "–" ? "–" : txt + " " + unit);
  const ms = (n) => withUnit(fTrim(n), t("unit.ms"));
  const field = (label, value) => `<div class="dfield"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const sec = (title, inner) => `<section class="dsec"><h4>${esc(title)}</h4><div class="dgrid">${inner}</div></section>`;
  const notMeasured = `<p class="dnote">${esc(t("res.notMeasured"))}</p>`;
  const elig = sec(t("det.eligibility"),
    field(t("det.success"), D((e.successes ?? "–") + "/" + (e.attempts ?? "–"))) +
    field(t("det.rate"), D(pct1(e.successRate))) +
    field(t("det.lower95"), D(lower95Of(r))) +
    field(t("det.median"), D(ms(e.handshakeMedianMs))) +
    field(t("det.confidence"), esc(confWord(e.confidence))));
  const scores = sec(t("det.scores"),
    field(t("comp.web"), f1(s.browsing)) + field(t("comp.streaming"), f1(s.streaming)) +
    field(t("comp.load"), f1(s.load)) + field(t("comp.reliability"), f1(s.reliability)) +
    field(t("det.overall"), f1(s.overall)) + field(t("det.rawOverall"), f1(s.overallUncapped)) +
    field(t("det.cons"), f1(s.conservative)) + field(t("det.rawCons"), f1(s.conservativeUncapped)));
  const loadSec = `<section class="dsec"><h4>${esc(t("det.load"))}</h4>${r.load ? `<div class="dgrid">` +
    field(t("det.sustained"), D(withUnit(f2(r.load.sustainedMbps), t("unit.mbps")))) +
    field(t("det.rpm"), f1(r.load.rpm)) +
    field(t("det.shaping"), fTrim(r.load.shapingRatio)) +
    field(t("det.addedRtt"), D(ms(r.load.rttIncreaseMs))) + `</div>` : notMeasured}</section>`;
  const streamSec = `<section class="dsec"><h4>${esc(t("det.streaming"))}</h4>${r.streaming ? `<div class="dgrid">` +
    field(t("det.sustainable"), D(withUnit(fTrim(r.streaming.sustainableMbps), t("unit.mbps")))) +
    field(t("det.quality"), esc(r.streaming.quality || "–")) + `</div>` : notMeasured}</section>`;
  const gates = `<section class="dsec"><h4>${esc(t("det.gates"))}</h4><div class="dgrid">` +
    field(t("det.status"), esc(gateWord(g.status))) +
    field(t("det.limiting"), esc(limitingWord(r))) + `</div>` +
    (r.verdict?.summary ? `<p class="dnote">${esc(t("det.verdict"))}: ${esc(r.verdict.summary)}</p>` : "") + `</section>`;
  const meas = sec(t("det.measurement"),
    field(t("det.mstatus"), esc(statusWord(m.status))) +
    field(t("det.bytes"), fmtBytes(m.bytesMeasured)) +
    field(t("det.qoe"), esc(m.qoeConfidence || "–")));
  return `<div class="detail">${elig}${scores}${loadSec}${streamSec}${gates}${meas}</div>`;
}

Views.dashboard = (el) => {
  el.innerHTML = `
    <h2 class="view-title">${esc(t("nav.dashboard"))}</h2>
    <p class="view-sub">${esc(t("app.subtitle"))}</p>
    <h3 class="sec-head">${esc(t("dash.status"))}</h3>
    <div class="kv" id="d-status">${statusKv(app.state)}</div>
    <h3 class="sec-head">${esc(t("dash.runScan"))}</h3>
    <div class="run-cards">${["quick", "full", "research", "hard"].map((m) => `
      <div class="run-card"><h3><span class="base-dot" style="background:var(--${{ quick: "a", full: "c", research: "g", hard: "t" }[m]})"></span>${esc(t("mode." + m))}</h3>
      <p>${esc(t("mode." + m + ".d"))}</p><button class="btn" data-start="${m}">${esc(t("ui.start"))}</button></div>`).join("")}
    </div>
    <div id="d-resume"></div>
    <h3 class="sec-head">${esc(t("dash.plateRest"))}<span class="right">${esc(t("genome.tapHint"))}</span></h3>
    <div class="plate-frame"><div id="d-plate"></div></div>
    <p class="plain-note" id="d-known"></p>
    <h3 class="sec-head">${esc(t("dash.latest"))}</h3>
    <div id="d-latest"></div>`;
  const plate = new Plate($("#d-plate"), { mini: true });
  window.__plate = plate;
  $$("[data-start]", el).forEach((b) => b.addEventListener("click", () => startRun(b.dataset.start)));
  const update = () => {
    $("#d-status").innerHTML = statusKv(app.state);
    const st = (app.state || {}).status || {};
    $("#d-resume").innerHTML = st.resumeAvailable ? `<p class="plain-note">${esc(t("dash.resumeLine", { phase: t("phase." + (app.phase || "hard-primer")), probes: fmt(app.counters.probesSpent || 0) }))} <button class="btn" id="d-resume-btn">${esc(t("ui.resume"))}</button></p>` : "";
    const rb = $("#d-resume-btn"); if (rb) rb.addEventListener("click", () => startRun("hard", true));
    if (app.genome) {
      let alive = 0, absent = 0, known = 0;
      for (let i = 0; i < 7697; i++) { const k = app.genome.known[i]; if (k) { known++; if (k >= 128) alive++; else absent++; } }
      $("#d-known").textContent = known ? t("dash.fromRuns", { alive: fmt(alive), absent: fmt(absent), known: fmt(known) }) : t("dash.noRuns");
      plate.drawStatic();
    }
    const lat = (app.state || {}).latest;
    $("#d-latest").innerHTML = lat && lat.best && lat.best.length ? resultsTable(lat.best, true) + `<p><a href="#/results">${esc(t("ui.openResults"))}</a></p>` : `<p class="empty">${esc(t("dash.noRuns"))}</p>`;
  };
  update();
  return { destroy() { plate.destroy(); }, onSnapshot: update, onEvent(type) { if (type === "run-state") update(); } };
};

const HARD_PHASES = ["hard-primer", "hard-coverage", "hard-expansion", "hard-retry", "hard-verify", "hard-finalize"];
Views.genome = (el) => {
  el.innerHTML = `
    <h2 class="view-title">${esc(t("genome.title"))}</h2>
    <p class="view-sub" id="g-sub"></p>
    <div class="form-actions" style="margin:0 0 14px">
      <button class="btn btn-primary" id="g-begin">${esc(t("ui.beginReplication"))}</button>
      <button class="btn" id="g-resume" hidden>${esc(t("ui.resume"))}</button>
      <button class="btn danger" id="g-stop" hidden>${esc(t("ui.stopRun"))}</button>
      <span class="readout" id="g-phase"></span>
    </div>
    <p class="plain-note">${esc(t("genome.intro"))}</p>
    <p class="plain-note" id="g-resume-line" hidden></p>
    <div class="console-grid">
      <div class="console-side">
        <div class="rail" id="g-rail">${HARD_PHASES.map((p) => `<div class="station" data-ph="${p}">${esc(t("phase." + p))}<span class="st-note">${esc(t("phn." + p))}</span></div>`).join("")}</div>
        <h3 class="sec-head">${esc(t("genome.budget"))}</h3>
        <div class="budget-meter"><div id="g-budget-fill"></div></div>
        <div class="readout" id="g-budget-text"></div>
        <h3 class="sec-head">${esc(t("genome.legend"))}</h3>
        <div class="legend" style="flex-direction:column;gap:5px">${[["", "unprobed"], ["background:var(--a);opacity:.25", "known"], ["sw-g", "priming"], ["sw-a", "alive"], ["", "absent"], ["sw-a\" style=\"border-top:2px solid var(--g)", "hot"], ["\" style=\"border-bottom:2px solid var(--g)", "suspect"], ["\" style=\"border-left:3px double var(--ink-40);background:var(--plate2)", "split"], ["sw-ink", "exhausted"], ["sw-c", "finalist"], ["sw-c", "winner"]].map(([cls, k]) => `<span><i class="sw ${cls}"></i>${esc(t("lg." + k))}</span>`).join("")}
        </div>
        <h3 class="sec-head">${esc(t("genome.liveNotes"))}</h3>
        <div class="ticker" id="g-ticker"></div>
        <h3 class="sec-head">${esc(t("console.journal"))}</h3>
        <div class="ticker journal" id="g-journal"></div>
      </div>
      <div class="console-main">
        <div class="readout dim" id="g-counters"></div>
        <h3 class="sec-head"><span id="g-ideo-head"></span><span class="right mono" id="g-ideo-cap"></span></h3>
        <div class="ideo-wrap"><canvas class="ideo" id="g-ideo" height="26"></canvas></div>
        <div class="plate-frame"><div id="g-plate"></div></div>
        <p class="plain-note">${esc(t("genome.tapHint"))} <span class="mono" id="g-hover"></span></p>
        <div id="g-lane"></div>
        <p id="g-done"></p>
        <h3 class="sec-head">${esc(t("genome.trace"))}</h3>
        <canvas class="trace" id="g-trace"></canvas>
        <h3 class="sec-head">${esc(t("genome.liveTop"))}</h3>
        <div id="g-top"></div>
      </div>
    </div>`;
  const plate = new Plate($("#g-plate"), { onTap: (i, e) => openInspector(i, e) });
  window.__plate = plate;
  plate.onHover = (i) => { $("#g-hover").textContent = i >= 0 ? plateBlockCidr(i) : ""; };
  const trace = new Trace($("#g-trace"));
  const loop = makeLoop(() => { trace.draw(); });
  loop.start($("#g-trace")); plate.loop.start($("#g-plate"));
  const ideo = $("#g-ideo");
  const drawIdeo = () => {
    if (!app.catalog) return;
    const P = PAL[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];
    const W = ideo.clientWidth || 300, dpr = Math.min(window.devicePixelRatio || 1, 2);
    ideo.width = Math.round(W * dpr); ideo.height = Math.round(26 * dpr); ideo.style.height = "26px";
    const cx = ideo.getContext("2d"); cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.fillStyle = P.plate2; cx.fillRect(0, 4, W, 12);
    let x = 0; cx.fillStyle = P.ink40; cx.font = "9px " + getComputedStyle(document.body).getPropertyValue("--mono");
    app.catalog.ranges.forEach((r, ri) => {
      const w = (r.blocks / (app.catalog.blocksTotal || 7697)) * W;
      cx.fillRect(x + w - 0.5, 4, 1, 12);
      if (app.genome) { let split = false; const start = app.catalog.ranges.slice(0, ri).reduce((a, y) => a + y.blocks, 0); for (let k = 0; k < r.blocks && !split; k++) if (app.genome.state[start + k] === 7) split = true; if (split) cx.fillRect(x, 18, Math.max(2, w), 2); }
      if (w > 52) cx.fillText(r.cidr, x + 2, 13);
      x += w;
    });
    $("#g-ideo-cap").textContent = plate.inspect != null && app.catalog ? app.catalog.ranges[plate.inspect].cidr + " — ✕" : "";
  };
  ideo.addEventListener("click", (e) => {
    if (!app.catalog) return;
    const r = ideo.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width;
    let acc = 0, idx = 0; for (let ri = 0; ri < app.catalog.ranges.length; ri++) { acc += app.catalog.ranges[ri].blocks / (app.catalog.blocksTotal || 7697); if (fx <= acc) { idx = ri; break; } }
    plate.inspect = plate.inspect === idx ? null : idx; plate.resize(); drawIdeo();
  });
  const railTo = (phase) => {
    const idx = HARD_PHASES.indexOf(phase);
    $$("#g-rail .station").forEach((s, k) => { s.className = "station" + (idx >= 0 && k < idx ? " done" : idx >= 0 && k === idx ? " now" : ""); });
    $("#g-phase").textContent = phase ? t("phase." + phase) : "";
  };
  // Every count on this page is derived from what the server serves:
  // the catalog totals from the catalog payload, the probe budget
  // from the served settings (the budget cap is the server's
  // platform call, never a literal copied into the client).
  let budgetTotal = null;
  const subTo = () => {
    const c = app.catalog;
    $("#g-sub").textContent = t("genome.sub", { ranges: fmt(c?.rangesTotal), blocks: fmt(c?.blocksTotal), addrs: fmt(c?.addressesTotal) });
    $("#g-ideo-head").textContent = t("genome.ideo", { ranges: fmt(c?.rangesTotal) });
  };
  const countersTo = () => {
    const c = app.counters;
    $("#g-counters").textContent = t("genome.counters", { elapsed: mmss(app.elapsedMs()), alive: fmt(c.eligible || 0), primed: fmt(c.blocksPrimed || 0), expanded: fmt(c.blocksExpanded || 0), split: fmt(c.blocksSplit || 0) });
    const spent = c.probesSpent || 0;
    $("#g-budget-fill").style.width = budgetTotal ? Math.min(100, (spent / budgetTotal) * 100) + "%" : "0%";
    $("#g-budget-text").textContent = budgetTotal ? t("genome.spent", { spent: fmt(spent), total: fmt(budgetTotal) }) : t("genome.spentOnly", { spent: fmt(spent) });
    $("#g-ticker").innerHTML = app.ticker.slice(0, 8).map((x) => `<div>${esc(x)}</div>`).join("");
    subTo();
  };
  const journalEl = $("#g-journal"), journalLines = [];
  const pushJournal = (text) => {
    if (!text || journalLines[journalLines.length - 1] === text) return;
    journalLines.push(text); if (journalLines.length > 40) journalLines.shift();
    journalEl.innerHTML = journalLines.map((x) => `<div>${esc(x)}</div>`).join("");
    journalEl.scrollTop = journalEl.scrollHeight;
  };
  const controlsTo = () => {
    const running = app.runStatus === "running" && app.runMode === "hard";
    const done = $("#g-done");
    if (app.runMode === "hard" && app.runStatus === "complete") done.innerHTML = `${esc(t("console.finished"))} <a href="#/results">${esc(t("console.viewResults"))}</a>`;
    else if (app.runMode === "hard" && app.runStatus === "paused-done") done.innerHTML = `${esc(t("console.stopped"))} <a href="#/results">${esc(t("console.viewResults"))}</a>`;
    else if (app.runMode === "hard" && app.runStatus === "failed") done.innerHTML = `${esc(t("console.failed", { reason: app.runError || t("err.unknown") }))} <a href="#/diagnostics">${esc(t("nav.diagnostics"))}</a>`;
    else done.innerHTML = "";
    $("#g-begin").hidden = running || app.runStatus === "paused-done";
    const canResume = app.runStatus === "paused-done" && ((app.state || {}).status || {}).resumeAvailable;
    $("#g-resume").hidden = !canResume;
    const rl = $("#g-resume-line");
    rl.hidden = !canResume;
    if (canResume) rl.textContent = t("dash.resumeLine", { phase: t("phase." + (app.phase || "hard-primer")), probes: fmt(app.counters.probesSpent || 0) });
    const stop = $("#g-stop");
    stop.hidden = !running;
    if (app.stopping) { stop.disabled = true; stop.textContent = t("ui.stopping"); }
    else { stop.disabled = false; if (!stop.dataset.armed) stop.textContent = t("ui.stopRun"); }
    railTo(app.phase); countersTo();
  };
  const topTo = (rows) => {
    $("#g-top").innerHTML = rows && rows.length ? `<table class="data"><thead><tr><th>${t("col.ip")}</th><th>${t("col.elig")}</th><th class="num">↓95</th><th>${t("col.pop")}</th><th>${t("col.ip")} /24</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${D(r.ip)}</td><td>${D(r.eligibility.successes + "/" + r.eligibility.attempts)}</td><td class="num">${pct1(r.eligibility.confidence95.lower)}</td><td>${esc(r.eligibility.pops.dominant || "–")}</td><td>${D(r.block || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">${esc(t("console.noCandidates"))}</p>`;
  };
  const laneTo = () => {
    $("#g-lane").innerHTML = app.lane.length ? `<div class="lane"><h3 class="sec-head">${esc(t("lane.title"))}</h3>${app.lane.map((r) => `<div class="lane-row"><span>${D(r.ip)}</span><span class="ev">${esc(t("det.overall"))} <b>${f1(r.scores?.overall)}</b></span><span class="ev">${esc(t("comp.streaming"))} <b>${fTrim(r.streaming?.sustainableMbps)} Mbps</b></span><span class="ev">${esc(t("comp.load"))} <b>${f2(r.load?.sustainedMbps)} Mbps · ${f1(r.load?.rpm)} rpm</b></span><span class="ev">${esc(verdictWord(r))}</span></div>`).join("")}</div>` : "";
  };
  $("#g-begin").addEventListener("click", () => startRun("hard"));
  $("#g-resume").addEventListener("click", () => startRun("hard", true));
  $("#g-stop").addEventListener("click", (e) => armButton(e.currentTarget, "ui.stopRunArm", stopRun));
  let lastCounters = 0;
  app.src.getSettings().then(({ settings }) => { const b = settings?.hard?.budgetProbes; if (Number.isFinite(b)) { budgetTotal = b; countersTo(); } }).catch(() => {});
  app.src.setTail(true); // the journal is fed by the run's log stream
  const clock = setInterval(() => { if (app.runStatus === "running") countersTo(); }, 1000);
  drawIdeo(); controlsTo(); topTo(((app.state || {}).run || {}).top); laneTo();
  if (app.genome) { plate.drawStatic(); plate.allDirty(); }
  return {
    destroy() { plate.destroy(); loop.stop(); clearInterval(clock); app.src.setTail(false); closeInspector(); },
    onSnapshot(s) { plate.drawStatic(); plate.allDirty(); drawIdeo(); controlsTo(); topTo((s.run || {}).top); },
    onEvent(type, d) {
      if (type === "phase") { railTo(d.phase); pushJournal(journalText("phase", d)); }
      if (type === "ticker") pushJournal(journalText("ticker", d));
      if (type === "log") pushJournal(journalText("log", d));
      if (type === "counters" || type === "ticker") { const now = performance.now(); if (now - lastCounters > 500) { lastCounters = now; countersTo(); } }
      if (type === "candidate" && d.lane) laneTo();
      if (type === "run-state") { controlsTo(); if (d.status === "complete") drawIdeo(); }
      if (type === "stopping") controlsTo();
    },
  };
};
function plateBlockCidr(i) { // catalog-order block label from the live catalog
  if (!app.catalog) return "";
  // CONTRACT catalog shape: `cidr` carries the range's CIDR string;
  // `firstBlock` is the block INDEX (a number), not an address —
  // reading it as a string threw on every plate hover under Live.
  let acc = 0; for (const r of app.catalog.ranges) { if (i < acc + r.blocks) { const base = ipToInt(r.cidr.split("/")[0]); return intToIp(base + (i - acc) * 256) + "/24"; } acc += r.blocks; }
  return "";
}
async function openInspector(i, e) {
  const box = $("#inspector");
  let d = null;
  try { d = await app.src.getBlock(i); } catch { d = null; }
  if (!d && app.genome && app.catalog) {
    const st = app.genome.state[i], ht = app.genome.heat[i];
    d = { index: i, cidr: plateBlockCidr(i), range: "", lane: 0, run: null, primer: { attempts: 0, tier: "full" }, halves: { lower: { s: 0, n: 0 }, upper: { s: 0, n: 0 }, splitP: 0, split: st === 7 }, reputation: app.genome.known[i] ? { attempts: 0, runs: 0, rate: app.genome.known[i] / 255, lastSeen: "", best: "", colo: "" } : null, candidates: [] };
  }
  if (!d) return;
  const rep = d.reputation;
  box.innerHTML = `<button class="btn btn-quiet x" id="insp-x" aria-label="${esc(t("ui.close"))}">✕</button>
    <h4>${D(d.cidr)}</h4>
    <div class="dim">${esc(t("insp.range", { range: d.range, lane: d.lane }))}</div>
    <div class="rule"></div>
    <dl><dt>${esc(t("insp.thisRun"))}</dt><dd>${d.run ? esc(t("insp.probes", { ok: d.run.successes, n: d.run.attempts, rate: pct1(d.run.rate), lower: pct1(d.run.lower) })) : "–"}</dd>
    <dt>${esc(t("insp.primer"))}</dt><dd>${D(d.primer.attempts)} · ${esc(t("insp.tier", { tier: d.primer.tier }))}</dd>
    <dt>${esc(t("insp.halves"))}</dt><dd>${D(d.halves.lower.s + "/" + d.halves.lower.n)} · ${D(d.halves.upper.s + "/" + d.halves.upper.n)}</dd>
    <dd></dd><dd>${esc(d.halves.split ? t("insp.splitYes") : t("insp.splitNo", { p: fmt2(d.halves.splitP) }))}</dd>
    <dt>${esc(t("insp.reputation"))}</dt><dd>${rep ? esc(t("insp.repLine", { n: rep.attempts, runs: rep.runs, rate: pct1(rep.rate), date: rep.lastSeen, ip: rep.best, colo: rep.colo })) : esc(t("insp.unknown"))}</dd>
    <dt>${esc(t("insp.candidates"))}</dt><dd>${d.candidates && d.candidates.length ? d.candidates.map((c) => D(c.ip)).join(" · ") : esc(t("insp.noCand"))}</dd></dl>
    <div class="rule"></div>
    <a href="#/results?block=${encodeURIComponent(d.cidr)}">${esc(t("insp.openResults"))}</a>`;
  box.hidden = false;
  const x = Math.min(innerWidth - 364, Math.max(12, (e ? e.clientX : 80) - 40)), y = Math.min(innerHeight - 320, Math.max(64, (e ? e.clientY : 120) + 14));
  box.style.left = x + "px"; box.style.top = y + "px";
  $("#insp-x").addEventListener("click", closeInspector);
}
function closeInspector() { const b = $("#inspector"); if (b) b.hidden = true; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInspector(); });

const SCAN_PHASES = ["calibrating", "screening", "delayed-retry", "verification", "tunnel"];
const PROFILES = { quick: { n: 16, rounds: 2, fin: 6, tun: "3 × 1" }, full: { n: 120, rounds: 3, fin: 20, tun: "5 × 1" }, research: { n: 240, rounds: 6, fin: 24, tun: "8 × 3" } };
Views.scan = (el, parts) => {
  const mode = parts[1] || "full", P = PROFILES[mode] || PROFILES.full;
  el.innerHTML = `
    <h2 class="view-title">${esc(t("mode." + mode))}</h2>
    <p class="view-sub">${esc(t("mode." + mode + ".d"))}</p>
    <h3 class="sec-head">${esc(t("console.preflight"))}</h3>
    <div class="kv"><span>${esc(t("console.candidates"))} <b>${fmt(P.n)}</b></span> · <span>${esc(t("console.rounds"))} <b>${P.rounds}</b></span> · <span>${esc(t("console.finalists"))} <b>${P.fin}</b></span> · <span>${esc(t("console.tunnel"))} <b>${P.tun}</b></span> · <span>${esc(t("console.estTraffic"))} <b id="sc-est">…</b></span></div>
    <div class="form-actions"><button class="btn btn-primary" id="sc-start">${esc(t("ui.start"))}</button>
    <button class="btn danger" id="sc-stop" hidden>${esc(t("ui.stopRun"))}</button><span class="readout" id="sc-phase"></span></div>
    <p class="plain-note" id="sc-hint" hidden>${esc(t("console.idleHint"))}</p>
    <div class="console-grid" style="margin-top:18px">
      <div class="console-side"><div class="rail" id="sc-rail">${SCAN_PHASES.map((p) => `<div class="station" data-ph="${p}">${esc(t("phase." + p))}<span class="st-note">${esc(t("phn." + p))}</span></div>`).join("")}</div></div>
      <div class="console-main">
        <div class="readout dim" id="sc-counters"></div>
        <p class="nowline"><span class="pulse" id="sc-pulse" hidden></span><span id="sc-now"></span></p>
        <h3 class="sec-head">${esc(t("console.journal"))}</h3>
        <div class="ticker journal" id="sc-journal"></div>
        <h3 class="sec-head">${esc(t("console.ledger"))}</h3>
        <div id="sc-ledger"><p class="empty">${esc(t("console.noCandidates"))}</p></div>
        <p class="plain-note">${esc(t("console.ledgerNote"))}</p>
        <p id="sc-done"></p>
      </div>
    </div>`;
  app.src.getSettings().then(({ settings }) => app.src.estimate(settings)).then((r) => { const n = $("#sc-est"); if (n && r) n.textContent = fmtBytes(r.perCandidateBytes * P.n); }).catch(() => {});
  const seg = (f) => `<span class="segbar">${[0.25, 0.5, 0.75, 1].map((x) => `<i class="${f >= x ? "full" : f > x - 0.25 ? "part" : ""}"></i>`).join("")}</span>`;
  const renderLedger = () => {
    const rows = [...app.ledger.values()].filter((r) => r.stage);
    if (!rows.length) return;
    $("#sc-ledger").innerHTML = `<table class="data"><thead><tr><th>${t("col.ip")}</th><th>${t("col.elig")}</th><th>SPRT</th><th>${t("col.verdict")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${D(r.ip)}</td><td>${seg(r.stage?.elig || 0)} ${D(r.eligibility.successes + "/" + r.eligibility.attempts)}</td><td>${seg(r.stage?.sprt || 0)} <span class="dim">${esc(r.sprt || "")}</span></td><td>${esc(r.verdict ? verdictWord(r) : "")}</td></tr>`).join("")}</tbody></table>`;
  };
  const railTo = (phase) => { const idx = SCAN_PHASES.indexOf(phase); $$("#sc-rail .station").forEach((s, k) => { s.className = "station" + (idx >= 0 && k < idx ? " done" : idx >= 0 && k === idx ? " now" : ""); }); $("#sc-phase").textContent = phase && t("phase." + phase) ? t("phase." + phase) : ""; };
  // The journal: the run narrated in plain words, newest last,
  // auto-scrolled — fed only by the run's real events (phase,
  // ticker, log), never by a timer inventing motion.
  const journalEl = $("#sc-journal"), journalLines = [];
  const pushJournal = (text) => {
    if (!text || journalLines[journalLines.length - 1] === text) return;
    journalLines.push(text); if (journalLines.length > 40) journalLines.shift();
    journalEl.innerHTML = journalLines.map((x) => `<div>${esc(x)}</div>`).join("");
    journalEl.scrollTop = journalEl.scrollHeight;
  };
  const withIp = (line, ip) => (ip ? line.replace("\u0001", D(ip)) : line);
  // The current-operation line: what is happening right now, in one
  // sentence a first-time user can follow.
  const nowLine = () => {
    if (app.runMode !== mode) return "";
    if (app.stopping) return t("ui.stopping");
    if (app.runStatus !== "running") return "";
    const c = app.counters, ph = app.phase, done = fmt(c.completed || 0), total = fmt(c.total || 0);
    if (ph === "calibrating") return (c.total || 0) > 1 ? t("op.calibratingLevel", { done, total }) : t("op.calibrating");
    if (ph === "screening") return withIp(t(c.currentIp ? "op.screening" : "op.screeningNoIp", { round: c.round || 1, rounds: P.rounds, ip: "\u0001", done, total }), c.currentIp);
    if (ph === "delayed-retry") return t("op.delayed-retry", { done, total });
    if (ph === "verification") return t("op.verification", { done, total });
    if (ph === "tunnel") return withIp(t(c.currentIp ? "op.tunnel" : "op.tunnelNoIp", { ip: "\u0001", done, total }), c.currentIp);
    if (ph) return t("op.phase", { phase: t("phase." + ph), done, total });
    return t("op.starting");
  };
  const renderNow = () => {
    $("#sc-now").innerHTML = nowLine();
    $("#sc-pulse").hidden = !(app.runStatus === "running" && app.runMode === mode);
    $("#sc-counters").textContent = app.runMode === mode && app.runStatus === "running" ? `${fmt(app.counters.completed || 0)} / ${fmt(app.counters.total || 0)} · ${mmss(app.elapsedMs())} · ${fmt(app.counters.eligible || 0)} ${esc(t("col.elig"))}` : "";
  };
  const controlsTo = () => {
    const running = app.runStatus === "running" && app.runMode === mode;
    $("#sc-start").hidden = running;
    const stop = $("#sc-stop");
    stop.hidden = !running;
    if (app.stopping) { stop.disabled = true; stop.textContent = t("ui.stopping"); }
    else { stop.disabled = false; if (!stop.dataset.armed) stop.textContent = t("ui.stopRun"); }
    const ended = app.runMode === mode && (app.runStatus === "complete" || app.runStatus === "canceled" || app.runStatus === "failed");
    $("#sc-hint").hidden = running || ended;
    if (app.runMode === mode && app.runStatus === "complete") $("#sc-done").innerHTML = `${esc(t("console.finished"))} <a href="#/results">${esc(t("console.viewResults"))}</a>`;
    else if (app.runMode === mode && app.runStatus === "canceled") $("#sc-done").innerHTML = `${esc(t("console.stopped"))} <a href="#/results">${esc(t("console.viewResults"))}</a>`;
    else if (app.runMode === mode && app.runStatus === "failed") $("#sc-done").innerHTML = `${esc(t("console.failed", { reason: app.runError || t("err.unknown") }))} <a href="#/diagnostics">${esc(t("nav.diagnostics"))}</a>`;
  };
  $("#sc-start").addEventListener("click", () => startRun(mode));
  $("#sc-stop").addEventListener("click", (e) => armButton(e.currentTarget, "ui.stopRunArm", stopRun));
  app.src.setTail(true);
  const clock = setInterval(() => { if (app.runStatus === "running") renderNow(); }, 1000);
  railTo(app.phase); controlsTo(); renderLedger(); renderNow();
  if (app.runStatus === "running" && app.runMode === mode && app.phase) pushJournal(journalText("phase", { phase: app.phase }));
  return { destroy() { clearInterval(clock); app.src.setTail(false); }, onSnapshot: controlsTo, onEvent(type, d) {
    if (type === "phase") { railTo(app.phase); pushJournal(journalText("phase", d)); renderNow(); }
    if (type === "ticker") pushJournal(journalText("ticker", d));
    if (type === "log") pushJournal(journalText("log", d));
    if (type === "candidate") renderLedger();
    if (type === "counters") { controlsTo(); renderNow(); }
    if (type === "run-state" || type === "stopping") { controlsTo(); renderNow(); }
  } };
};
function fmtBytes(b) { if (b == null || !Number.isFinite(b)) return "–"; if (b < 1024) return b + " B"; if (b < 1048576) return (b / 1024).toFixed(1) + " KiB"; return (b / 1048576).toFixed(1) + " MiB"; }

/* ---------------- results & reports ---------------- */
Views.results = (el, parts, q) => {
  const runId = q.get("run") || "latest", block = q.get("block");
  el.innerHTML = `<h2 class="view-title">${esc(t("res.title"))}</h2><div id="res-body"><p class="empty">…</p></div>`;
  let report = null;
  const render = () => {
    const box = $("#res-body");
    if (!report || !report.results) { box.innerHTML = `<p class="empty">${esc(t("res.empty"))}</p>`; return; }
    const rows = block ? report.results.filter((r) => r.block === block) : report.results;
    const ranks = rows.map((r) => report.results.indexOf(r) + 1);
    const dl = `<a class="btn btn-quiet" href="/api/reports/${encodeURIComponent(report.runId)}/download">${esc(t("ui.downloadJson"))}</a> <a class="btn btn-quiet" href="/api/reports/${encodeURIComponent(report.runId)}/best-ips">${esc(t("ui.downloadBest"))}</a>`;
    box.innerHTML = `
      <p class="view-sub">${esc(t("res.fromRun", { run: report.runId, mode: t("mode." + (report.mode || "full")), when: report.finishedAt || "" }))}</p>
      <div class="kv"><span>${t("console.candidates")} <b>${fmt(report.totals?.candidates)}</b></span> · <span>${t("col.elig")} <b>${fmt(report.totals?.eligible)}</b></span> · <span>${t("ms.complete")} <b>${fmt(report.totals?.complete)}</b></span> · <span>${t("ms.partial")} <b>${fmt(report.totals?.partial)}</b></span><span style="margin-inline-start:auto">${dl}</span></div>
      ${!block && rows.length ? `<p class="best-line"><span class="tick-a">▸</span> ${esc(t("res.top"))}: ${D(rows[0].ip)} · ${esc(verdictWord(rows[0]))} · ${esc(t("col.cons"))} ${D(f1(rows[0].scores?.conservative))}</p>` : ""}
      <p class="plain-note">${esc(t("res.scope"))} ${esc(t("res.legend"))}</p>
      ${block ? `<p class="plain-note">${esc(t("res.filterBlock", { block }))} · <a href="#/results?run=${encodeURIComponent(report.runId)}">${esc(t("res.clearFilter"))}</a></p>` : ""}
      <div style="margin-top:10px">${resultsTable(rows, false, ranks)}</div>`;
    $$("#res-body tr.clickable").forEach((tr) => tr.addEventListener("click", () => {
      if (tr.nextElementSibling && tr.nextElementSibling.classList.contains("detail-row")) { tr.nextElementSibling.remove(); return; }
      const r = rows[+tr.dataset.i]; if (!r) return;
      const d = document.createElement("tr"); d.className = "detail-row"; d.innerHTML = `<td colspan="${tr.cells.length}">${resultDetail(r)}</td>`;
      tr.after(d);
    }));
  };
  app.src.getResults(runId).then((r) => { report = r; render(); }).catch(() => render());
  return { onSnapshot(s) {
    // Watching this page while a newer run lands must replace what
    // is shown — "latest" means the server's latest, not the one
    // that was latest when the page happened to open.
    if (!report) { app.src.getResults(runId).then((r) => { report = r; render(); }).catch(() => {}); return; }
    if (runId === "latest" && s && s.latest && report.runId !== s.latest.runId) app.src.getResults("latest").then((r) => { report = r; render(); }).catch(() => {});
  } };
};
Views.reports = (el) => {
  el.innerHTML = `<h2 class="view-title">${esc(t("rep.title"))}</h2><p class="view-sub">${esc(t("rep.sub"))}</p><div id="rep-body"><p class="empty">…</p></div>`;
  const render = (list) => {
    $("#rep-body").innerHTML = list && list.length ? `<table class="data"><thead><tr><th>${t("col.run")}</th><th>${t("col.mode")}</th><th>${t("col.when")}</th><th class="num">${t("col.size")}</th><th></th></tr></thead><tbody>
      ${list.map((r) => `<tr><td>${D(r.runId)}</td><td>${esc(t("mode." + (r.mode || "full")))}</td><td>${D(r.finishedAt || "")}</td><td class="num">${fmtBytes(r.size)}</td>
      <td><a href="#/results?run=${encodeURIComponent(r.runId)}">${esc(t("insp.openResults"))}</a></td></tr>`).join("")}</tbody></table>` : `<p class="empty">${esc(t("rep.empty"))}</p>`;
  };
  app.src.getReports().then(render).catch(() => render([]));
  return { onSnapshot() { app.src.getReports().then(render).catch(() => {}); } };
};

/* ---------------- settings ---------------- */
Object.assign(STR.en, { "set.g.scan": "Scan", "set.g.verification": "Verification", "set.g.calibration": "Calibration", "set.g.tunnel": "Tunnel", "set.g.browsing": "Browsing", "set.g.streaming": "Streaming", "set.g.load": "Real load", "set.g.hard": "Hard Deep Scan", "set.g.logging": "Logging", "set.hg.primer": "Primer & budget", "set.hg.splits": "Splits", "set.hg.reputation": "Reputation" });
Object.assign(STR.fa, { "set.g.scan": "اسکن", "set.g.verification": "راستی‌آزمایی", "set.g.calibration": "کالیبراسیون", "set.g.tunnel": "تونل", "set.g.browsing": "مرور", "set.g.streaming": "استریمینگ", "set.g.load": "بار واقعی", "set.g.hard": "اسکن عمیق (Hard)", "set.g.logging": "لاگ", "set.hg.primer": "پرایمر و بودجه", "set.hg.splits": "شکافت‌ها", "set.hg.reputation": "اعتبار" });
const F = (p, ty, extra) => ({ p, ty, ...extra });
const SETTINGS_SCHEMA = [
  { g: "scan", fields: [F("scan.perRange", "int"), F("scan.maxCandidates", "int"), F("scan.rounds", "int"), F("scan.concurrency", "int"), F("scan.timeoutMs", "int"), F("scan.minimumSuccessRate", "float"), F("scan.seed", "int", { pos: false }), F("scan.delayedRetry.enabled", "bool"), F("scan.delayedRetry.maxCandidates", "int")] },
  { g: "verification", fields: [F("verification.enabled", "bool"), F("verification.limit", "int"), F("verification.sprt.p0", "float"), F("verification.sprt.p1", "float"), F("verification.sprt.alpha", "float"), F("verification.sprt.beta", "float"), F("verification.sprt.minRounds", "int"), F("verification.sprt.maxRounds", "int")] },
  { g: "calibration", adv: true, fields: [F("calibration.enabled", "bool"), F("calibration.levels", "list"), F("calibration.latencyInflationLimit", "float"), F("calibration.failureRateIncreaseLimit", "float"), F("calibration.eventLoopLagLimitMs", "int")] },
  { g: "tunnel", fields: [F("tunnel.enabled", "bool"), F("tunnel.xrayPath", "text", { pos: false }), F("tunnel.limit", "int"), F("tunnel.rounds", "int"), F("tunnel.startupTimeoutMs", "int"), F("tunnel.shutdownGraceMs", "int")] },
  { g: "browsing", adv: true, fields: [F("browsing.enabled", "bool"), F("browsing.assetLimit", "int"), F("browsing.timeoutMs", "int"), F("browsing.maxSockets", "int"), F("browsing.maxBytes", "bytes"), F("browsing.estimatedMaxBytes", "bytes")] },
  { g: "streaming", adv: true, fields: [F("streaming.enabled", "bool"), F("streaming.maxSegments", "int"), F("streaming.quickSegments", "int"), F("streaming.researchSegments", "int"), F("streaming.maxBytes", "bytes"), F("streaming.estimatedMaxBytes", "bytes"), F("streaming.startupBufferSec", "float"), F("streaming.safetyFactor", "float"), F("streaming.timeoutMs", "int"), F("streaming.variantMode", "enum", { opts: ["fixed", "adaptive"] }), F("streaming.targetMbps", "float")] },
  { g: "load", fields: [F("load.enabled", "bool"), F("load.durationMs", "int"), F("load.chunkBytes", "bytes"), F("load.maxDownloadBytes", "bytes"), F("load.flows", "int"), F("load.uploadBytes", "bytes"), F("load.uploadFlows", "int"), F("load.fanoutRequests", "int"), F("load.idleSamples", "int"), F("load.timeoutMs", "int"), F("load.gateProfile", "enum", { opts: ["balanced", "strict", "tolerant"] }), F("load.control.enabled", "bool"), F("load.control.bytes", "bytes"), F("load.endpoints.download", "text", { pos: false }), F("load.endpoints.upload", "text", { pos: false }), F("load.endpoints.ping", "text", { pos: false }), F("load.endpoints.control", "text", { pos: false })] },
  { g: "hard", subgroups: [
    { hg: "primer", fields: [F("hard.concurrency", "int"), F("hard.screeningRounds", "int"), F("hard.recheckTop", "int"), F("hard.saveEvery", "int"), F("hard.liveTop", "int"), F("hard.finalTop", "int"), F("hard.delayedRetry", "bool"), F("hard.retryLimit", "int"), F("hard.engine", "enum", { opts: ["blocks", "round-robin"] }), F("hard.primerPerBlock", "int", { sim: 1 }), F("hard.budgetProbes", "int", { sim: 1 }), F("hard.banditExploration", "float", { sim: 1 }), F("hard.maxDepthPerBlock", "int", { sim: 1 }), F("hard.expansionWaveFactor", "int", { sim: 1 }), F("hard.expansionChunk", "int", { sim: 1 }), F("hard.rangeWaveCapFraction", "float", { sim: 1 }), F("hard.poolPerBlock", "int", { sim: 1 }), F("hard.recheckPerBlock", "int", { sim: 1 })] },
    { hg: "splits", fields: [F("hard.splitMaxDepth", "int", { sim: 1 }), F("hard.splitAlpha", "float", { sim: 1 }), F("hard.splitMinEffect", "float", { sim: 1 }), F("hard.splitReserveFraction", "float", { sim: 1 }), F("hard.splitReserveAlpha", "float", { sim: 1 })] },
    { hg: "reputation", fields: [F("hard.reputationSkipAgeDays", "int", { sim: 1 }), F("hard.reputationConfirmAgeDays", "int", { sim: 1 }), F("hard.reputationHalfLifeDays", "int", { sim: 1 }), F("hard.reputationMaxStoredAttempts", "int", { sim: 1 })] },
  ] },
  { g: "logging", adv: true, fields: [F("logging.level", "enum", { opts: ["debug", "info", "warn", "error"] })] },
];
const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => { const ks = p.split("."); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]] ?? (a[ks[i]] = {}); a[ks[ks.length - 1]] = v; };
Views.settings = (el) => {
  el.innerHTML = `<h2 class="view-title">${esc(t("set.title"))}</h2><p class="view-sub">${esc(t("set.sub"))}</p><div id="set-body"><p class="empty">…</p></div>`;
  let cur = null, catalog = null, estTimer = 0;
  const fieldHtml = (f) => {
    const v = getPath(cur, f.p), key = f.p.split(".").pop();
    const label = `<span class="f-label"><span>${esc(key)}</span><span class="f-key">${esc(f.p)}</span></span>`;
    const warn = f.sim ? `<div class="f-warn">${esc(t("set.simNote"))}</div>` : "";
    if (f.ty === "bool") return `<label class="switch"><input type="checkbox" data-path="${f.p}" ${v ? "checked" : ""}><span class="track"></span><span>${esc(key)} <span class="f-key">${esc(f.p)}</span></span></label>`;
    if (f.ty === "enum") { const opts = [...new Set([...(f.opts || []), String(v)])]; return `<label class="field">${label}<select data-path="${f.p}">${opts.map((o) => `<option ${o === String(v) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>${warn}</label>`; }
    if (f.ty === "list") return `<label class="field">${label}<input type="text" data-path="${f.p}" data-ty="list" value="${esc((v || []).join(", "))}">${warn}</label>`;
    if (f.ty === "text") return `<label class="field">${label}<input type="text" data-path="${f.p}" data-ty="text" value="${esc(v ?? "")}">${warn}</label>`;
    return `<label class="field">${label}<input type="number" data-path="${f.p}" data-ty="${f.ty}" value="${esc(v ?? "")}" step="${f.ty === "float" ? "any" : "1"}">${f.ty === "bytes" ? `<div class="f-note">${fmtBytes(v)}</div>` : ""}${warn}</label>`;
  };
  const groupHtml = (g) => {
    const inner = g.subgroups ? g.subgroups.map((sg) => `<h4 class="sec-head">${esc(t("set.hg." + sg.hg))}</h4><div class="fields">${sg.fields.map(fieldHtml).join("")}</div>`).join("")
      : `<div class="fields">${g.fields.map(fieldHtml).join("")}</div>`;
    return `<fieldset class="group"><legend>${esc(t("set.g." + g.g))}</legend>${inner}</fieldset>`;
  };
  const workloadsHtml = () => {
    if (!catalog) return "";
    const kind = (k) => {
      const sel = getPath(cur, k + ".workloads") || [], custom = (cur.customWorkloads || {})[k] || [];
      return `<h4 class="sec-head">${esc(t("set.g." + k))}</h4><div class="checks">
        ${catalog[k].map((w) => `<label><input type="checkbox" data-wl="${k}" value="${esc(w.name)}" ${sel.includes(w.name) ? "checked" : ""}><span><span class="mono">${esc(w.name)}</span> <span class="desc">${esc(w.description || "")}</span></span></label>`).join("")}
        ${custom.map((w, ix) => `<label><input type="checkbox" checked disabled><span><span class="mono">${esc(w.name)}</span> <span class="desc">${esc(w.pageUrl || w.manifestUrl || "")}</span> <button type="button" class="btn btn-quiet" data-custom-del="${k}:${ix}">${esc(t("ui.remove"))}</button></span></label>`).join("")}
      </div>
      <div class="fields" style="margin-top:8px">
        <label class="field"><span class="f-label"><span>${esc(t("set.name"))}</span></span><input type="text" id="cw-${k}-name"></label>
        <label class="field"><span class="f-label"><span>${esc(k === "browsing" ? t("set.pageUrl") : t("set.manifestUrl"))}</span></span><input type="text" id="cw-${k}-url" dir="ltr"></label>
        <div class="field"><span class="f-label"><span> </span></span><button type="button" class="btn" data-custom-add="${k}">${esc(t("ui.add"))}</button></div>
      </div>`;
    };
    return `<fieldset class="group"><legend>${esc(t("set.workloads"))}</legend>${kind("browsing")}${kind("streaming")}</fieldset>`;
  };
  const build = () => {
    const open = SETTINGS_SCHEMA.filter((g) => !g.adv).map(groupHtml).join("");
    const adv = SETTINGS_SCHEMA.filter((g) => g.adv).map(groupHtml).join("");
    $("#set-body").innerHTML = `<form id="set-form">${open}${workloadsHtml()}
      <details class="advanced"><summary>${esc(t("set.advanced"))}</summary>${adv}</details>
      <div class="form-actions"><button type="button" class="btn btn-primary" id="set-save">${esc(t("ui.save"))}</button>
      <button type="button" class="btn" id="set-defaults">${esc(t("ui.restoreDefaults"))}</button>
      <span class="readout dim" id="set-est"></span></div></form>`;
    wire();
  };
  const collect = (silent) => {
    const out = JSON.parse(JSON.stringify(cur)); let bad = 0;
    $$("#set-form [data-path]").forEach((inp) => {
      const p = inp.dataset.path, ty = inp.dataset.ty;
      inp.classList.remove("invalid");
      if (inp.type === "checkbox") { setPath(out, p, inp.checked); return; }
      if (inp.tagName === "SELECT") { setPath(out, p, inp.value); return; }
      if (ty === "text") { setPath(out, p, inp.value); return; }
      if (ty === "list") { const arr = inp.value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)); if (!arr.length) { bad++; inp.classList.add("invalid"); } else setPath(out, p, arr); return; }
      const v = Number(inp.value), f = SETTINGS_SCHEMA.flatMap((g) => g.fields || (g.subgroups || []).flatMap((s) => s.fields)).find((x) => x.p === p);
      if (!Number.isFinite(v) || (f && f.pos !== false && v <= 0)) { bad++; if (!silent) inp.classList.add("invalid"); else inp.classList.add("invalid"); return; }
      setPath(out, p, ty === "int" || ty === "bytes" ? Math.round(v) : v);
    });
    $$("#set-form [data-wl]").forEach((cb) => {
      const k = cb.dataset.wl, arr = getPath(out, k + ".workloads") || [];
      setPath(out, k + ".workloads", cb.checked ? [...new Set([...arr, cb.value])] : arr.filter((x) => x !== cb.value));
    });
    return bad ? null : out;
  };
  const estimate = () => {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => { const o = collect(true); if (!o) return; try { const r = await app.src.estimate(o); const n = $("#set-est"); if (n && r) n.textContent = t("set.estimate", { bytes: fmtBytes(r.perCandidateBytes) }); } catch { /* estimate is advisory */ } }, 400);
  };
  const wire = () => {
    $("#set-form").addEventListener("input", estimate); estimate();
    $("#set-save").addEventListener("click", async () => {
      const o = collect(false);
      if (!o) { app.showNotice(t("set.invalid")); return; }
      const r = await app.src.action("saveSettings", o);
      if (r && r.error) app.showNotice(r.message || r.error); else { cur = o; app.showNotice(t("set.saved"), "info"); }
    });
    $("#set-defaults").addEventListener("click", (e) => armButton(e.currentTarget, "ui.restoreArm", async () => {
      const r = await app.src.action("defaults");
      if (r && r.error) app.showNotice(r.message || r.error); else { app.showNotice(t("set.restored"), "info"); load(); }
    }));
    $$("#set-form [data-custom-add]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.customAdd, name = $("#cw-" + k + "-name").value.trim(), url = $("#cw-" + k + "-url").value.trim();
      if (!name || !url) return;
      try { new URL(url); } catch { app.showNotice("URL"); return; }
      if (k === "streaming" && !url.includes(".m3u8")) { app.showNotice(".m3u8"); return; }
      cur.customWorkloads = cur.customWorkloads || { browsing: [], streaming: [] };
      cur.customWorkloads[k].push(k === "browsing" ? { name, pageUrl: url } : { name, manifestUrl: url, segmentDurationSec: 6 });
      build();
    }));
    $$("#set-form [data-custom-del]").forEach((b) => b.addEventListener("click", () => {
      const [k, ix] = b.dataset.customDel.split(":"); cur.customWorkloads[k].splice(+ix, 1); build();
    }));
  };
  const load = async () => {
    try { const r = await app.src.getSettings(); cur = r.settings; catalog = r.catalog; build(); }
    catch { $("#set-body").innerHTML = `<p class="empty">${esc(t("res.empty"))}</p>`; }
  };
  load();
  return {};
};

/* ---------------- config ---------------- */
Views.config = (el) => {
  el.innerHTML = `<h2 class="view-title">${esc(t("cfg.title"))}</h2><p class="view-sub">${esc(t("cfg.sub"))}</p><div id="cfg-body"><p class="empty">…</p></div>`;
  const render = (cfg) => {
    const d = cfg && cfg.descriptor;
    $("#cfg-body").innerHTML = `
      <p class="readout">${cfg && cfg.stored ? esc(t("cfg.stored")) : esc(t("cfg.notStored"))} <span class="dim">${esc(t("cfg.protected", { yes: cfg && cfg.protected ? t("cfg.yes") : t("cfg.no") }))}</span></p>
      ${d ? `<table class="data" style="max-width:560px"><tbody>${["address", "port", "host", "sni", "path", "transport", "security", "label", "idPresent"].map((k) => `<tr><td style="width:130px" class="dim">${esc(t("cfg.f." + k))}</td><td>${k === "idPresent" ? esc(d[k] ? t("cfg.yes") : t("cfg.no")) : D(d[k] ?? "–")}</td></tr>`).join("")}</tbody></table>` : ""}
      <h3 class="sec-head">${esc(t("cfg.paste"))}</h3>
      <form id="cfg-form" autocomplete="off"><div class="fields" style="grid-template-columns:1fr auto">
        <label class="field"><input type="password" id="cfg-uri" dir="ltr" placeholder="${esc(t("cfg.pastePh"))}" autocomplete="off"></label>
        <div class="field"><button class="btn btn-primary" type="submit">${esc(t("ui.import"))}</button></div>
      </div></form>
      ${cfg && cfg.stored ? `<h3 class="sec-head">${esc(t("ui.remove"))}</h3><p class="plain-note">${esc(t("cfg.removeNote"))}</p><button class="btn danger" id="cfg-remove">${esc(t("ui.remove"))}</button>` : ""}`;
    $("#cfg-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const inp = $("#cfg-uri"), uri = inp.value; inp.value = ""; // the secret leaves the DOM at once; it is never rendered back
      const r = await app.src.action("importConfig", uri);
      if (r && r.error) app.showNotice(r.message || r.error);
      else { app.showNotice(t("cfg.imported"), "info"); load(); app.resync(); }
    });
    const rm = $("#cfg-remove");
    if (rm) rm.addEventListener("click", (e) => armButton(e.currentTarget, "ui.removeArm", async () => {
      const r = await app.src.action("removeConfig");
      if (r && r.error) app.showNotice(r.message || r.error); else { app.showNotice(t("cfg.removed"), "info"); load(); app.resync(); }
    }));
  };
  const load = async () => { try { render(await app.src.getConfig()); } catch { render(null); } };
  load();
  return { onSnapshot: load };
};

/* ---------------- diagnostics ---------------- */
Views.diagnostics = (el) => {
  el.innerHTML = `<h2 class="view-title">${esc(t("dg.title"))}</h2>
    <h3 class="sec-head">${esc(t("dg.system"))}</h3><div id="dg-system"><p class="empty">…</p></div>
    <h3 class="sec-head">${esc(t("dg.conn"))}</h3>
    <p class="plain-note" id="dg-conn"></p>
    <p class="plain-note">${esc(t("dg.calibTruth"))}</p>
    <div class="form-actions" style="margin-top:0"><button class="btn" id="dg-retry" hidden>${esc(t("off.retry"))}</button></div>
    <h3 class="sec-head">${esc(t("dg.logs"))}</h3><div id="dg-logs"><p class="empty">…</p></div>
    <h3 class="sec-head">${esc(t("dg.tail"))}</h3>
    <div class="form-actions" style="margin:0 0 8px"><div class="chips" id="dg-chips">${["all", "info", "warn", "error"].map((l) => `<button class="chip" data-lv="${l}" aria-pressed="${l === "all"}">${l}</button>`).join("")}</div>
    <button class="btn btn-quiet" id="dg-pause">${esc(t("ui.pause"))}</button></div>
    <div class="logtail" id="dg-tail"><span class="dim">${esc(t("dg.tailEmpty"))}</span></div>`;
  let paused = false, filter = "all";
  const lines = [];
  app.src.getSystem().then((s) => {
    $("#dg-system").innerHTML = `<table class="data" style="max-width:640px"><tbody>${(s.rows || []).map((r) => `<tr><td style="width:150px" class="dim">${esc(r.component)}</td><td>${D(r.value)}</td><td style="width:26px"><span style="display:inline-block;width:9px;height:9px;background:var(--${r.ok ? "a" : "t"})"></span></td></tr>`).join("")}</tbody></table>`;
  }).catch(() => {});
  const loadLogs = () => {
    app.src.getLogs().then(async (logs) => {
      if (!logs.length) { $("#dg-logs").innerHTML = `<p class="empty">${esc(t("dg.noLogs"))}</p>`; return; }
      const sum = await app.src.getLogSummary(logs[0].name).catch(() => null);
      $("#dg-logs").innerHTML = `<table class="data"><thead><tr><th>${t("col.file")}</th><th class="num">${t("col.size")}</th><th>${t("dg.summary")}</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${D(l.name)}</td><td class="num">${fmtBytes(l.size)}</td><td>${sum ? `${fmt(sum.total)} ${t("dg.events")} · ${fmt(sum.errors)} ${t("dg.errors")} · ${fmt(sum.warnings)} ${t("dg.warnings")}` : "–"}</td></tr>`).join("")}</tbody></table>`;
    }).catch(() => {});
  };
  loadLogs();
  const connTo = () => { const off = app.offline || app.conn === "none"; $("#dg-conn").textContent = off ? t("dg.connOff") : t("dg.connLive"); $("#dg-retry").hidden = !off; };
  connTo();
  $("#dg-retry").addEventListener("click", async () => { await retryLive(); connTo(); });
  $$("#dg-chips .chip").forEach((c) => c.addEventListener("click", () => { filter = c.dataset.lv; $$("#dg-chips .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === c))); redrawTail(); }));
  $("#dg-pause").addEventListener("click", (e) => { paused = !paused; e.currentTarget.textContent = t(paused ? "ui.unpause" : "ui.pause"); });
  const redrawTail = () => {
    const box = $("#dg-tail"); if (!box) return;
    const show = lines.filter((l) => filter === "all" || l.level === filter).slice(-200);
    box.innerHTML = show.length ? show.map((l) => `<div><span class="d mono">${esc((l.time || "").slice(11, 19))}</span> <span class="lv-${l.level}">${esc(l.level)}</span> <span class="mono">${esc(l.event || "")}</span> ${esc(l.msg || "")}</div>`).join("") : `<span class="dim">${esc(t("dg.tailEmpty"))}</span>`;
    box.scrollTop = box.scrollHeight;
  };
  app.src.setTail(true);
  return {
    destroy() { app.src.setTail(false); },
    onSnapshot: connTo,
    onEvent(type, d) {
      if (type === "log") { lines.push(d); if (lines.length > 400) lines.splice(0, lines.length - 400); if (!paused) redrawTail(); }
      if (type === "run-state" && d.status !== "running") loadLogs();
    },
  };
};

/* ---------------- the one source, and boot ----------------
   The shipped UI has exactly one data source: the real server.
   There is no fallback feed and nothing simulated ever renders.
   If the server does not answer — at boot, or after the event
   stream dies mid-session — the page says so in plain words and
   offers a retry; it never substitutes other data. */
async function connectLive() {
  app.src = Live; app.lastSeq = 0;
  try { app.catalog = await Live.getCatalog(); } catch { app.catalog = null; }
  Live.connect();
  await app.resync();
}
function renderOffline() {
  if (app.view && app.view.destroy) app.view.destroy();
  app.view = null; app.viewName = "offline"; app.viewParts = [];
  $("#view").innerHTML = `<h2 class="view-title">${esc(t("off.title"))}</h2><p class="view-sub">${esc(t("off.body"))}</p>
  ${app._offStill ? `<p class="plain-note">${esc(t("off.still", { time: app._offStill }))}</p>` : ""}
  <div class="form-actions"><button class="btn btn-primary" id="off-retry">${esc(t("off.retry"))}</button></div>`;
  $("#off-retry").addEventListener("click", retryLive);
}
function enterOffline() {
  if (app.offline) return;
  Live.disconnect();
  app.offline = true;
  app.onConn("none");
  renderOffline();
}
async function retryLive() {
  if (await Live.probe().catch(() => false)) {
    app.offline = false; app._offStill = null;
    await connectLive();
    route();
  } else { app._offStill = new Date().toLocaleTimeString(); renderOffline(); }
}
// When the event stream drops, the pill says "reconnecting" — but
// if the server itself is gone, say that instead of retrying
// forever against a dead port. A deliberate server stop is exempt:
// its plate stays, with its own explanation.
let reachTimer = null;
function scheduleReachCheck() {
  if (reachTimer || app.offline || app.serverStopped) return;
  reachTimer = setTimeout(async () => {
    reachTimer = null;
    if (app.offline || app.serverStopped || app.conn === "live") return;
    if (!(await Live.probe().catch(() => false))) enterOffline();
  }, 4000);
}
(function boot() {
  // Token hygiene: the one-time bootstrap query is consumed by the
  // server's 302; if it ever survives into the address bar, strip it.
  // The token is never read, stored, or sent by this code (R-04).
  const lp = new URLSearchParams(location.search).get("lang");
  if (lp === "fa" || lp === "en") lang = lp; // preview/share override; not persisted
  if (/[?&](t|k)=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
  drawHelix(); applyLang(); refreshStatic();
  $("#lang-toggle").addEventListener("click", () => {
    lang = lang === "fa" ? "en" : "fa"; store.set("lang", lang);
    applyLang(); refreshStatic(); route();
  });
  $("#theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme === "dark";
    prefs.theme = dark ? "light" : "dark"; store.set("theme", prefs.theme);
    applyTheme();
  });
  $("#calm-toggle").addEventListener("click", () => { prefs.calm = !prefs.calm; store.set("calm", prefs.calm ? "1" : null); applyCalm(); });
  $("#stop-server").addEventListener("click", (e) => armButton(e.currentTarget, "ui.stopServerArm", async () => {
    app.serverStopped = true;
    await app.src.action("serverStop"); app.onConn("offline");
  }));
  window.addEventListener("hashchange", route);
  // The banner's clock is local and always ticking while a run is
  // live, so no quiet phase can ever look frozen.
  setInterval(() => { if (app.runStatus === "running") app.refreshChrome(true); }, 1000);
  (async () => {
    app.src = Live;
    if (await Live.probe().catch(() => false)) { await connectLive(); route(); }
    else enterOffline();
  })();
})();
