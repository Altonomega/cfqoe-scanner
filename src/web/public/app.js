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
  "ui.calm": "Calm", "ui.night": "Night plate", "ui.day": "Day plate", "ui.stopServer": "Stop server",
  "ui.stopServerArm": "Really stop?", "ui.stopRun": "Stop safely", "ui.stopRunArm": "Really stop?",
  "ui.start": "Start", "ui.resume": "Resume", "ui.beginReplication": "Begin replication",
  "ui.save": "Save settings", "ui.restoreDefaults": "Restore defaults", "ui.restoreArm": "Really restore?",
  "ui.remove": "Remove", "ui.removeArm": "Really remove?", "ui.import": "Import configuration",
  "ui.openResults": "Open full results", "ui.downloadJson": "Download JSON", "ui.downloadBest": "Download best IPs",
  "ui.close": "Close", "ui.pause": "Pause", "ui.unpause": "Resume tail", "ui.add": "Add",
  "ui.useLive": "Use live server", "ui.useSim": "Use simulated feed",
  "conn.connecting": "connecting…", "conn.live": "● LIVE", "conn.reconnecting": "reconnecting…", "conn.offline": "server stopped", "conn.sim": "SIMULATED",
  "sim.badge": "SIMULATED FEED", "sim.note": "Preview data source — a local simulation speaking the live contract. No scanner is running; nothing here is measured.",
  "sim.speed": "speed", "sim.useLive": "Use live server",
  "run.running": "RUNNING", "run.openConsole": "open console →", "run.idle": "No run yet this session.",
  "nav.head": "Notebook", "nav.notes": "Run notes",
  "nav.dashboard": "Plate", "nav.genome": "Genome", "nav.results": "Results", "nav.reports": "Reports",
  "nav.settings": "Settings", "nav.config": "Config", "nav.diagnostics": "Diagnostics",
  "dash.status": "Status", "dash.runScan": "Run a scan", "dash.plateRest": "The plate, at rest",
  "dash.latest": "Latest result", "dash.noRuns": "No runs yet. The plate is blank.",
  "dash.fromRuns": "From your recorded runs: {alive} blocks known alive · {absent} known absent · {known} known in all.",
  "dash.resumeLine": "Resume the paused Hard run — {phase}, {probes} probes spent.",
  "status.config": "config", "status.xray": "xray", "status.verify": "verify", "status.resume": "resume", "status.platform": "platform",
  "status.ready": "ready", "status.missing": "missing", "status.found": "found", "status.notFound": "not found",
  "status.sprt": "SPRT", "status.off": "off", "status.available": "available", "status.none": "none",
  "mode.quick": "Quick", "mode.full": "Full", "mode.research": "Research", "mode.hard": "Hard Deep Scan",
  "mode.quick.d": "A screening pass: 16 IPs, 2 rounds. Fast, shallow — a first look at the path.",
  "mode.full.d": "The everyday run: 120 IPs, 3 rounds, SPRT verification of 20 finalists, full QoE on the best 5.",
  "mode.research.d": "Deep evidence: 240 candidates, 6 rounds, 24 finalists, triple tunnel passes. Slow and thorough.",
  "mode.hard.d": "The whole catalog, block by block: 23,091 primer probes, adaptive expansion, resumable.",
  "console.preflight": "Pre-flight", "console.candidates": "candidates", "console.rounds": "screening rounds",
  "console.finalists": "finalists", "console.tunnel": "tunnel passes", "console.estTraffic": "estimated traffic",
  "console.ledger": "Candidate ledger", "console.noCandidates": "No candidates have completed a stage yet.",
  "console.finished": "Run finished.", "console.viewResults": "See the results",
  "phase.screening": "Screening", "phase.delayed-retry": "Delayed retry", "phase.verification": "Verification (SPRT)",
  "phase.tunnel": "Tunnel QoE", "phase.calibrating": "Calibrating",
  "phase.hard-primer": "Primers — origins of replication", "phase.hard-coverage": "Proofreading — checking uneven blocks",
  "phase.hard-expansion": "Replication forks — expanding the living blocks", "phase.hard-retry": "Delayed retries",
  "phase.hard-verify": "Verifying finalists (SPRT)", "phase.hard-finalize": "Final QoE — the sequencing lane",
  "genome.title": "Hard Deep Scan", "genome.sub": "The whole Cloudflare catalog as one plate: {ranges} ranges · {blocks} blocks · {addrs} addresses. One cell = one /24 block.",
  "genome.ideo": "Ideogram — {ranges} ranges (width ∝ blocks)", "genome.plate": "The plate — {blocks} blocks",
  "genome.trace": "Trace — last probes (height = speed)", "genome.liveTop": "Live top", "genome.liveNotes": "Live notes",
  "genome.budget": "Budget", "genome.spent": "{spent} / {total} probes",
  "genome.counters": "elapsed {elapsed} · alive {alive} · primed {primed} · expanded {expanded} · split {split}",
  "genome.legend": "Legend", "genome.tapHint": "Tap a cell for the block inspector.",
  "lg.unprobed": "unprobed", "lg.known": "known (reputation)", "lg.priming": "priming", "lg.alive": "alive (depth = rate)",
  "lg.absent": "absent (tick)", "lg.hot": "expanding (gold edge)", "lg.suspect": "suspect (underline)", "lg.split": "split",
  "lg.exhausted": "exhausted", "lg.finalist": "finalist (ring)", "lg.winner": "winner (dot)",
  "lane.title": "Sequencing lane — finalists under measurement",
  "insp.thisRun": "This run", "insp.primer": "Primer", "insp.halves": "Halves", "insp.reputation": "Reputation",
  "insp.candidates": "Candidates", "insp.openResults": "Open in Results", "insp.range": "range {range} · lane {lane}",
  "insp.probes": "{ok} ok of {n} probes · rate {rate} · lower95 {lower}", "insp.splitNo": "split: no (p {p})",
  "insp.splitYes": "split: yes — children live in the quadrants", "insp.tier": "tier: {tier}",
  "insp.repLine": "{n} probes over {runs} runs · decayed rate {rate} · last seen {date} · best {ip} ({colo})",
  "insp.unknown": "Not probed in a previous run.", "insp.noCand": "No candidate from this block yet.",
  "res.title": "Results", "res.fromRun": "Run {run} · {mode} · finished {when}",
  "res.filterBlock": "Showing only block {block}", "res.clearFilter": "clear filter",
  "res.empty": "No results yet. Run a scan and the rankings will appear here.",
  "col.rank": "#", "col.ip": "IP", "col.verdict": "Verdict", "col.cons": "Cons.", "col.raw": "Raw", "col.overall": "Overall",
  "col.elig": "Eligibility", "col.mbps": "Mbps", "col.rpm": "RPM", "col.pop": "POP", "col.gate": "Gate", "col.why": "Why",
  "rep.title": "Reports archive", "rep.sub": "Every saved run. Opening one reads it into the results view.",
  "rep.empty": "No saved reports yet.", "col.run": "Run", "col.mode": "Mode", "col.when": "Finished", "col.size": "Size", "col.open": "",
  "set.title": "Scan settings", "set.sub": "The full settings tree. The web form writes through the same merge-and-migrate path as the terminal editor; the server is the authority, this form only presents.",
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
  "dg.title": "Diagnostics", "dg.system": "System check", "dg.source": "Data source",
  "dg.sourceNote": "The simulation speaks the same contract as the live server; it exists for preview and testing. A real server, when it answers, always wins.",
  "dg.logs": "Log files", "dg.summary": "Summary", "dg.tail": "Live tail",
  "dg.events": "events", "dg.errors": "errors", "dg.warnings": "warnings",
  "dg.noLogs": "No log files yet.", "dg.tailEmpty": "The tail is quiet. Log lines of the active run will appear here.",
  "note.runActive": "A run is already active ({run}).", "note.configMissing": "No VLESS configuration is stored — import one first.",
  "note.serverStopped": "Server stopped. The plate above is the last known state — relaunch from the terminal to continue.",
  "note.stopped": "Run stopped safely; progress is checkpointed.", "note.resumed": "Resumed from the checkpoint.",
  "tick.calibrated": "Calibration: your path sustains {n} parallel probes; the scan will use {n}.",
  "tick.primerDone": "Primer complete: {alive} of {blocks} blocks answered at least once.",
  "tick.coverage": "Split-coverage: {suspects} suspects examined · {split} blocks split.",
  "tick.wave": "Wave {wave} complete · +{probes} probes · budget {spent}/{total}.",
  "tick.retries": "Delayed retries recovered {n} blocks.",
  "tick.pool": "Finalist pool crystallized: {n} blocks.",
  "tick.repSaved": "Reputation saved — the next run's plate starts from this one.",
  "tick.valve": "Stopped early: {pct} of the first probes failed the same way — this usually means the configuration or the path is down, not that the catalog is dead.",
  "tick.complete": "Run complete. {eligible} eligible IPs · report saved.",
  "tick.started": "Run {run} started ({mode}).",
},
fa: {
  "app.tagline": "· اسکنر آی‌پی‌های کلودفلر", "app.subtitle": "دفتر یادداشت سکوئنسر — نشست محلی",
  "app.colophon": "اسکنر CFQoE — اندازه‌گیری‌ها نسبیِ هر اجرا هستند؛ امتیازها کاندیدها را درون همان اجرا مقایسه می‌کنند.",
  "ui.calm": "آرام", "ui.night": "پلیت شب", "ui.day": "پلیت روز", "ui.stopServer": "توقف سرور",
  "ui.stopServerArm": "واقعاً متوقف شود؟", "ui.stopRun": "توقف امن", "ui.stopRunArm": "واقعاً متوقف شود؟",
  "ui.start": "شروع", "ui.resume": "ادامه", "ui.beginReplication": "آغاز همانندسازی",
  "ui.save": "ذخیره تنظیمات", "ui.restoreDefaults": "بازگردانی پیش‌فرض‌ها", "ui.restoreArm": "واقعاً بازگردانده شود؟",
  "ui.remove": "حذف", "ui.removeArm": "واقعاً حذف شود؟", "ui.import": "وارد کردن پیکربندی",
  "ui.openResults": "مشاهده نتایج کامل", "ui.downloadJson": "دانلود JSON", "ui.downloadBest": "دانلود بهترین آی‌پی‌ها",
  "ui.close": "بستن", "ui.pause": "مکث", "ui.unpause": "ادامه پخش", "ui.add": "افزودن",
  "ui.useLive": "استفاده از سرور زنده", "ui.useSim": "استفاده از فید شبیه‌سازی",
  "conn.connecting": "در حال اتصال…", "conn.live": "● زنده", "conn.reconnecting": "در حال اتصال مجدد…", "conn.offline": "سرور متوقف شد", "conn.sim": "شبیه‌سازی",
  "sim.badge": "فید شبیه‌سازی‌شده", "sim.note": "منبع دادهٔ پیش‌نمایش است — یک شبیه‌سازی محلی که با همان قرارداد سرور زنده صحبت می‌کند. هیچ اسکنی در حال اجرا نیست و هیچ‌چیز در اینجا اندازه‌گیری واقعی نیست.",
  "sim.speed": "سرعت", "sim.useLive": "استفاده از سرور زنده",
  "run.running": "در حال اجرا", "run.openConsole": "باز کردن کنسول ←", "run.idle": "هنوز در این نشست اجرایی شروع نشده است.",
  "nav.head": "دفتر", "nav.notes": "یادداشت‌های اجرا",
  "nav.dashboard": "داشبورد", "nav.genome": "ژنوم", "nav.results": "نتایج", "nav.reports": "گزارش‌ها",
  "nav.settings": "تنظیمات", "nav.config": "پیکربندی", "nav.diagnostics": "عیب‌یابی",
  "dash.status": "وضعیت", "dash.runScan": "شروع یک اسکن", "dash.plateRest": "پلیت، در حالت سکون",
  "dash.latest": "آخرین نتیجه", "dash.noRuns": "هنوز اجرایی انجام نشده است؛ پلیت خالی است.",
  "dash.fromRuns": "از اجراهای ثبت‌شدهٔ شما: {alive} بلاک زنده شناخته شده‌اند · {absent} بلاک غایب · در مجموع {known} بلاک شناخته‌شده.",
  "dash.resumeLine": "ادامهٔ اجرای متوقف‌شدهٔ Hard — مرحلهٔ {phase}، {probes} پروب مصرف شده است.",
  "status.config": "پیکربندی", "status.xray": "xray", "status.verify": "راستی‌آزمایی", "status.resume": "ادامه", "status.platform": "پلتفرم",
  "status.ready": "آماده", "status.missing": "موجود نیست", "status.found": "پیدا شد", "status.notFound": "پیدا نشد",
  "status.sprt": "SPRT", "status.off": "خاموش", "status.available": "موجود است", "status.none": "ندارد",
  "mode.quick": "سریع (Quick)", "mode.full": "کامل (Full)", "mode.research": "پژوهشی (Research)", "mode.hard": "اسکن عمیق (Hard Deep Scan)",
  "mode.quick.d": "یک غربال سریع: ۱۶ آی‌پی در ۲ دور. سریع و سطحی — نگاهی اول به مسیر.",
  "mode.full.d": "اجرای روزمره: ۱۲۰ آی‌پی در ۳ دور، راستی‌آزمایی SPRT روی ۲۰ فینالیست و سنجش کامل کیفیت روی ۵ تای برتر.",
  "mode.research.d": "شواهد عمیق: ۲۴۰ کاندیدا، ۶ دور، ۲۴ فینالیست و سه پاس تونل. کند و موشکافانه.",
  "mode.hard.d": "کل کاتالوگ، بلاک به بلاک: ۲۳٬۰۹۱ پروب پرایمر، گسترش تطبیقی و قابلیت ادامه دادن.",
  "console.preflight": "پیش‌پرواز", "console.candidates": "کاندیدا", "console.rounds": "دور غربال",
  "console.finalists": "فینالیست", "console.tunnel": "پاس تونل", "console.estTraffic": "ترافیک تخمینی",
  "console.ledger": "دفتر کاندیداها", "console.noCandidates": "هنوز هیچ کاندیدی مرحله‌ای را کامل نکرده است.",
  "console.finished": "اجرا تمام شد.", "console.viewResults": "مشاهده نتایج",
  "phase.screening": "غربال", "phase.delayed-retry": "تلاش مجدد با تأخیر", "phase.verification": "راستی‌آزمایی (SPRT)",
  "phase.tunnel": "سنجش کیفیت تونل", "phase.calibrating": "کالیبراسیون",
  "phase.hard-primer": "پرایمرها — نقاط آغاز همانندسازی", "phase.hard-coverage": "بازخوانی — بررسی بلاک‌های ناهموار",
  "phase.hard-expansion": "چنگال‌های همانندسازی — گسترش بلاک‌های زنده", "phase.hard-retry": "تلاش‌های مجدد با تأخیر",
  "phase.hard-verify": "راستی‌آزمایی فینالیست‌ها (SPRT)", "phase.hard-finalize": "سنجش نهایی کیفیت — خط سکوئنسینگ",
  "genome.title": "اسکن عمیق (Hard Deep Scan)", "genome.sub": "کل کاتالوگ کلودفلر به‌صورت یک پلیت: {ranges} رینج · {blocks} بلاک · {addrs} آدرس. هر خانه = یک بلاک /24.",
  "genome.ideo": "ایدیوگرام — {ranges} رینج (عرض متناسب با تعداد بلاک)", "genome.plate": "پلیت — {blocks} بلاک",
  "genome.trace": "ردّ پروب‌ها — آخرین پروب‌ها (ارتفاع = سرعت)", "genome.liveTop": "برترهای زنده", "genome.liveNotes": "یادداشت‌های زنده",
  "genome.budget": "بودجه", "genome.spent": "{spent} / {total} پروب",
  "genome.counters": "گذشته {elapsed} · زنده {alive} · پرایمرشده {primed} · گسترش‌یافته {expanded} · شکافته {split}",
  "genome.legend": "راهنما", "genome.tapHint": "برای بازرس بلاک، روی یک خانه بزنید.",
  "lg.unprobed": "پروب‌نشده", "lg.known": "شناخته‌شده (اعتبار)", "lg.priming": "در حال پرایمر", "lg.alive": "زنده (عمق = نرخ)",
  "lg.absent": "غایب (تیک)", "lg.hot": "در حال گسترش (لبه طلایی)", "lg.suspect": "مظنون (خط زیرین)", "lg.split": "شکافته",
  "lg.exhausted": "تمام‌شده", "lg.finalist": "فینالیست (حلقه)", "lg.winner": "برنده (نقطه)",
  "lane.title": "خط سکوئنسینگ — فینالیست‌ها زیر اندازه‌گیری",
  "insp.thisRun": "این اجرا", "insp.primer": "پرایمر", "insp.halves": "نیمه‌ها", "insp.reputation": "اعتبار",
  "insp.candidates": "کاندیداها", "insp.openResults": "باز کردن در نتایج", "insp.range": "رینج {range} · لاین {lane}",
  "insp.probes": "{ok} موفق از {n} پروب · نرخ {rate} · کران پایین ۹۵٪ {lower}", "insp.splitNo": "شکافت: نه (p {p})",
  "insp.splitYes": "شکافت: بله — فرزندان در ربع‌ها زندگی می‌کنند", "insp.tier": "رده: {tier}",
  "insp.repLine": "{n} پروب در {runs} اجرا · نرخ فرسوده {rate} · آخرین مشاهده {date} · بهترین {ip} ({colo})",
  "insp.unknown": "در اجرای قبلی پروب نشده است.", "insp.noCand": "هنوز کاندیدی از این بلاک نیست.",
  "res.title": "نتایج", "res.fromRun": "اجرای {run} · {mode} · پایان‌یافته در {when}",
  "res.filterBlock": "فقط بلاک {block} نمایش داده می‌شود", "res.clearFilter": "حذف فیلتر",
  "res.empty": "هنوز نتیجه‌ای نیست. یک اسکن اجرا کنید تا رتبه‌بندی اینجا ظاهر شود.",
  "col.rank": "#", "col.ip": "آی‌پی", "col.verdict": "حکم", "col.cons": "محافظه‌کار", "col.raw": "خام", "col.overall": "کلی",
  "col.elig": "صلاحیت", "col.mbps": "Mbps", "col.rpm": "RPM", "col.pop": "POP", "col.gate": "گیت", "col.why": "چرا",
  "rep.title": "بایگانی گزارش‌ها", "rep.sub": "همهٔ اجراهای ذخیره‌شده. باز کردن هرکدام، آن را در نمای نتایج می‌خواند.",
  "rep.empty": "هنوز گزارش ذخیره‌شده‌ای نیست.", "col.run": "اجرا", "col.mode": "حالت", "col.when": "پایان", "col.size": "حجم", "col.open": "",
  "set.title": "تنظیمات اسکن", "set.sub": "کل درخت تنظیمات. فرم وب از همان مسیر ادغام و مهاجرت ویرایشگر ترمینال می‌نویسد؛ مرجع نهایی سرور است و این فرم فقط ارائه می‌کند.",
  "set.workloads": "بارهای کاری", "set.customBrowsing": "صفحهٔ مرور سفارشی", "set.customStreaming": "استریم HLS سفارشی",
  "set.name": "نام", "set.pageUrl": "نشانی صفحه", "set.manifestUrl": "نشانی مانیفست (.m3u8)",
  "set.advanced": "پیشرفته", "set.estimate": "ترافیک تخمینی به‌ازای هر کاندیدا: {bytes}",
  "set.saved": "تنظیمات ذخیره شد.", "set.restored": "تنظیمات پیش‌فرض بازگردانده شد.", "set.invalid": "برخی فیلدها عدد معتبر نیستند — علامت خوردند؛ چیزی ذخیره نشد.",
  "set.simNote": "با شبیه‌سازی اعتبارسنجی شده — با احتیاط تغییر دهید.",
  "cfg.title": "پیکربندی VLESS", "cfg.sub": "پیکربندی ذخیره‌شده با ارجاع مدیریت می‌شود. خود URI هیچ‌وقت نمایش داده نمی‌شود، برگردانده نمی‌شود و لاگ نمی‌شود — فقط همین توصیف امن.",
  "cfg.stored": "یک پیکربندی ذخیره شده است.", "cfg.notStored": "هنوز پیکربندی‌ای ذخیره نشده است.",
  "cfg.protected": "فایل محرمانه محافظت‌شده است: {yes}", "cfg.yes": "بله", "cfg.no": "نه",
  "cfg.paste": "یک لینک vless:// بچسبانید", "cfg.pastePh": "vless://… (فیلد همان لحظهٔ ذخیره پاک می‌شود)",
  "cfg.imported": "پیکربندی وارد و ذخیره شد.", "cfg.removed": "پیکربندی حذف شد.",
  "cfg.removeNote": "حذف هنگام اجرای فعال رد می‌شود — اسکن در حال اجرا پیکربندی شروع خودش را نگه می‌دارد.",
  "cfg.f.address": "آدرس", "cfg.f.port": "پورت", "cfg.f.host": "هاست", "cfg.f.sni": "SNI", "cfg.f.path": "مسیر",
  "cfg.f.transport": "ترابری", "cfg.f.security": "امنیت", "cfg.f.label": "برچسب", "cfg.f.idPresent": "شناسه موجود است",
  "dg.title": "عیب‌یابی", "dg.system": "بررسی سیستم", "dg.source": "منبع داده",
  "dg.sourceNote": "شبیه‌سازی با همان قرارداد سرور زنده صحبت می‌کند؛ برای پیش‌نمایش و تست است. سرور واقعی، هر وقت پاسخ بدهد، همیشه برنده است.",
  "dg.logs": "فایل‌های لاگ", "dg.summary": "خلاصه", "dg.tail": "پخش زندهٔ لاگ",
  "dg.events": "رویداد", "dg.errors": "خطا", "dg.warnings": "هشدار",
  "dg.noLogs": "هنوز فایل لاگی نیست.", "dg.tailEmpty": "پخش زنده ساکت است. خطوط لاگ اجرای فعال اینجا ظاهر می‌شوند.",
  "note.runActive": "اجرایی هم‌اکنون فعال است ({run}).", "note.configMissing": "پیکربندی VLESS ذخیره نشده است — اول یکی وارد کنید.",
  "note.serverStopped": "سرور متوقف شد. پلیت بالا آخرین وضعیت شناخته‌شده است — برای ادامه از ترمینال دوباره اجرا کنید.",
  "note.stopped": "اجرا با امنیت متوقف شد؛ پیشرفت چک‌پوینت شده است.", "note.resumed": "از چک‌پوینت ادامه یافت.",
  "tick.calibrated": "کالیبراسیون: مسیر شما {n} پروب موازی را تاب می‌آورد؛ اسکن از {n} استفاده می‌کند.",
  "tick.primerDone": "پرایمر کامل شد: {alive} از {blocks} بلاک دست‌کم یک‌بار پاسخ دادند.",
  "tick.coverage": "پوشش شکافت: {suspects} مظنون بررسی شد · {split} بلاک شکافت.",
  "tick.wave": "موج {wave} کامل شد · +{probes} پروب · بودجه {spent}/{total}.",
  "tick.retries": "تلاش‌های مجدد {n} بلاک را برگرداندند.",
  "tick.pool": "استخر فینالیست‌ها متبلور شد: {n} بلاک.",
  "tick.repSaved": "اعتبار ذخیره شد — پلیت اجرای بعدی از همین یکی شروع می‌شود.",
  "tick.valve": "توقف زودهنگام: {pct} از پروب‌های اول به یک شکل شکست خوردند — معمولاً یعنی پیکربندی یا مسیر پایین است، نه اینکه کاتالوگ مرده باشد.",
  "tick.complete": "اجرا کامل شد. {eligible} آی‌پی واجد شرایط · گزارش ذخیره شد.",
  "tick.started": "اجرای {run} شروع شد ({mode}).",
}};
let lang = prefs.lang === "fa" ? "fa" : "en";
function t(key, params) {
  let s = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll("{" + k + "}", v);
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
  post(path, body) {
    return this.api(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CFQoE-Request": "1" }, body: JSON.stringify(body || {}) })
      .catch((e) => ({ error: "unreachable", message: String(e.message || e) }));
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
    es.onerror = () => app.onConn("reconnecting");
  },
  disconnect() { if (this.es) { this.es.close(); this.es = null; } },
  setTail(on) { if (this.tail !== on) { this.tail = on; if (this.es) this.connect(); } },
};

/* ---------------- simulation source ----------------
   A deterministic (seeded) local engine that speaks the §5 contract:
   same snapshot shape, same event taxonomy, same cadence discipline.
   It exists so the UI can be previewed and Proof-tested before W3.
   It measures nothing; the SIMULATED FEED bar says so, always. */
const Sim = {
  kind: "sim", seq: 0, timer: null, tail: false, speed: 16,
  cat: null, latent: null, half: null, known: null, bestHost: null, colo: null,
  state: null, heat: null, quads: null, quadHeat: null,
  run: null, paused: null, reports: [], latestReport: null, cfgDesc: null,
  settingsObj: null, logCount: { total: 0, errors: 0, warnings: 0 },
  emit(type, data) { data.seq = ++this.seq; app.onEvent(type, data); },
  log(level, event, msg) { this.logCount.total++; if (level === "error") this.logCount.errors++; if (level === "warn") this.logCount.warnings++; if (this.tail) this.emit("log", { time: new Date().toISOString(), level, event, msg }); },
  buildCatalog() {
    const rng = mulberry32(20261), counts = new Array(753).fill(1);
    [1023, 1023, 511, 511, 511, 511, 255, 255, 255, 255, 255, 255, 255, 255, 127, 127, 127, 127, 127, 127, 31, 15, 3, 3]
      .forEach((g, i) => { counts[i] += g; }); // 753 ranges, exactly 7,697 blocks
    const anchors = [["104.16.0.0", 2048], ["104.24.0.0", 1024], ["172.64.0.0", 2048], ["172.68.0.0", 1024], ["162.158.0.0", 512], ["188.114.0.0", 256], ["104.18.0.0", 256], ["198.41.0.0", 128], ["103.21.0.0", 128], ["141.101.0.0", 128], ["108.162.0.0", 64], ["190.93.0.0", 64], ["197.234.0.0", 32], ["173.245.0.0", 32], ["159.60.0.0", 32], ["103.31.0.0", 16], ["185.93.0.0", 16]];
    const cursors = anchors.map(([b]) => ipToInt(b));
    const order = counts.map((c, i) => [c, i]).sort((a, b) => b[0] - a[0]);
    const ranges = new Array(753);
    for (const [size, i] of order) {
      const ai = anchors.findIndex(([, cap], k) => cursors[k] + size * 256 <= ipToInt(anchors[k][0]) + cap * 256);
      const base = cursors[ai]; cursors[ai] += size * 256;
      ranges[i] = { cidr: intToIp(base) + "/" + (24 - Math.log2(size)), firstBlock: intToIp(base) + "/24", base, blocks: size };
    }
    // deterministic shuffle into "catalog order"
    for (let i = ranges.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ranges[i], ranges[j]] = [ranges[j], ranges[i]]; }
    const blocks = []; ranges.forEach((r, ri) => { r.start = blocks.length; for (let k = 0; k < r.blocks; k++) blocks.push({ range: ri, base: r.base + k * 256 }); });
    this.cat = { ranges, blocks, blocksTotal: 7697, rangesTotal: 753, addressesTotal: 1970432 };
    // latent path quality: most of the catalog is filtered on this path,
    // some ranges bloom — the shape Mahan's real runs show.
    this.latent = new Float32Array(7697); this.half = new Float32Array(7697);
    this.known = new Uint8Array(7697); this.bestHost = new Uint8Array(7697); this.colo = new Uint8Array(7697);
    const colos = 8;
    ranges.forEach((r) => {
      const q = rng(); const rq = q < 0.5 ? 0.01 + rng() * 0.03 : q < 0.78 ? 0.08 + rng() * 0.22 : 0.45 + rng() * 0.45;
      for (let k = 0; k < r.blocks; k++) {
        const i = r.start + k; let p = Math.min(0.97, Math.max(0.002, rq * (0.55 + rng() * 0.9)));
        this.latent[i] = p;
        if (rng() < 0.06) this.half[i] = (rng() < 0.5 ? -1 : 1) * (0.45 + rng() * 0.4); // hetero block: halves disagree
        if (rng() < 0.85) this.known[i] = Math.round(Math.min(1, Math.max(0, p + (rng() - 0.5) * 0.35)) * 255);
        this.bestHost[i] = 1 + Math.floor(rng() * 254);
        this.colo[i] = Math.floor(rng() * colos);
      }
    });
    this.state = new Uint8Array(7697); this.heat = new Uint8Array(7697);
    this.quads = new Uint32Array(7697); this.quadHeat = new Uint32Array(7697);
    for (let i = 0; i < 7697; i++) if (this.known[i]) this.state[i] = 1;
  },
  pHalf(i, h) { const d = this.half[i] / 2; return Math.min(0.99, Math.max(0.001, this.latent[i] + (h ? d : -d))); },
  blockCidr(i) { const b = this.cat.blocks[i]; return intToIp(b.base) + "/24"; },
  blockIp(i) { const b = this.cat.blocks[i]; return intToIp(b.base + this.bestHost[i]); },
  async probe() { return false; },
  async getCatalog() { if (!this.cat) this.buildCatalog(); const { ranges, blocksTotal, rangesTotal, addressesTotal } = this.cat; return { ranges: ranges.map(({ cidr, firstBlock, blocks }) => ({ cidr, firstBlock, blocks })), blocksTotal, rangesTotal, addressesTotal }; },
  genomeVecs() { return { blocksTotal: 7697, state: u8ToB64(this.state), heat: u8ToB64(this.heat), quads: u32ToB64(this.quads), quadHeat: u32ToB64(this.quadHeat), known: u8ToB64(this.known) }; },
  snapshot() {
    const R = this.run || this.paused;
    return {
      server: { version: "0.9.0", platform: (navigator.platform || "local") + " · simulated" },
      status: { configReady: !!this.cfgDesc, xrayFound: true, verifyEnabled: true, resumeAvailable: !!this.paused },
      genome: this.genomeVecs(),
      run: R ? { mode: R.mode, runId: R.runId, status: this.run ? "running" : "paused-done", phase: R.phase, startedAt: R.startedAt, counters: R.counters, genome: R.mode === "hard" ? this.genomeVecs() : undefined, top: this.liveTop() } : null,
      latest: this.latestReport ? { runId: this.latestReport.runId, finishedAt: this.latestReport.finishedAt, best: this.latestReport.results.slice(0, 5) } : null,
    };
  },
  async getState() { if (!this.cat) this.buildCatalog(); return this.snapshot(); },
  liveTop() {
    const R = this.run || this.paused; if (!R || R.mode !== "hard" || !R.att) return [];
    const rows = [];
    for (let i = 0; i < 7697; i++) if (R.suc[i] > 0) rows.push(i);
    rows.sort((a, b) => wilson(R.suc[b], R.att[b]).lower - wilson(R.suc[a], R.att[a]).lower);
    return rows.slice(0, 30).map((i) => this.eligRow(i, R.att[i], R.suc[i]));
  },
  eligRow(i, att, suc) {
    const w = wilson(suc, att);
    return { ip: this.blockIp(i), range: this.cat.ranges[this.cat.blocks[i].range].cidr, block: this.blockCidr(i), eligibility: { attempts: att, successes: suc, successRate: att ? +(suc / att).toFixed(3) : 0, confidence95: { lower: +w.lower.toFixed(3), upper: +w.upper.toFixed(3) }, confidence: att >= 8 ? "high" : att >= 3 ? "medium" : "low", handshakeMedianMs: Math.round(60 + (1 - this.latent[i]) * 700), pops: { dominant: ["FRA", "AMS", "LHR", "CDG", "WAW", "IST", "DXB", "SIN"][this.colo[i]] } } };
  },
  async getSettings() {
    if (!this.settingsObj) this.settingsObj = simDefaultSettings();
    return { settings: JSON.parse(JSON.stringify(this.settingsObj)), catalog: { browsing: [
      { name: "cloudflare-docs", description: "Cloudflare developer docs — many small same-origin assets" },
      { name: "cloudflare-blog", description: "Cloudflare blog home — image-heavy page" },
      { name: "cloudflare-speed", description: "Cloudflare speed landing page" },
      { name: "cdnjs", description: "cdnjs library index — pure static asset delivery" }],
      streaming: [
      { name: "apple-advanced-hevc", description: "Apple advanced HEVC ladder (up to 1080p)" },
      { name: "apple-bipbop", description: "Apple bipbop HLS ladder — the classic test stream" }] } };
  },
  async estimate(s) { const b = (s.browsing.maxBytes || 0) * Math.max(1, (s.browsing.workloads || []).length) + (s.streaming.maxBytes || 0) + (s.load.maxDownloadBytes || 0) + (s.load.uploadBytes || 0); return { perCandidateBytes: b }; },
  async getReports() { return this.reports.map((r) => ({ runId: r.runId, mode: r.mode, finishedAt: r.finishedAt, size: r.size })); },
  async getResults(id) { if (!id || id === "latest") return this.latestReport; return this.reports.find((r) => r.runId === id) || null; },
  async getConfig() { return { stored: !!this.cfgDesc, protected: true, descriptor: this.cfgDesc }; },
  async getSystem() { return { rows: [
    { component: t("status.config"), value: this.cfgDesc ? t("status.ready") : t("status.missing"), ok: !!this.cfgDesc },
    { component: "Node", value: "v22 · simulated", ok: true },
    { component: t("status.platform"), value: navigator.platform || "—", ok: true },
    { component: "Xray", value: t("status.found") + " · simulated", ok: true },
    { component: "Catalog", value: "753 ranges · 7,697 blocks", ok: true },
    { component: t("status.verify"), value: "SPRT", ok: true }] }; },
  async getLogs() { return [{ name: "run-sim-latest.ndjson", size: 4096 + this.logCount.total * 118, modified: new Date().toISOString() }]; },
  async getLogSummary() { return { total: this.logCount.total, errors: this.logCount.errors, warnings: this.logCount.warnings }; },
  async getBlock(i) {
    const R = this.run || this.paused, b = this.cat.blocks[i], r = this.cat.ranges[b.range];
    const att = R && R.att ? R.att[i] : 0, suc = R && R.suc ? R.suc[i] : 0;
    const hA = R && R.hAtt ? [R.hAtt[0][i], R.hAtt[1][i]] : [0, 0], hS = R && R.hSuc ? [R.hSuc[0][i], R.hSuc[1][i]] : [0, 0];
    const known = this.known[i] / 255;
    return { index: i, cidr: this.blockCidr(i), range: r.cidr, lane: b.range + 1,
      run: att ? { attempts: att, successes: suc, rate: +(suc / att).toFixed(2), lower: +wilson(suc, att).lower.toFixed(2) } : null,
      primer: { attempts: Math.min(3, att), tier: known > 0.5 ? "skip" : known > 0 ? "confirm" : "full" },
      halves: { lower: { s: hS[0], n: hA[0] }, upper: { s: hS[1], n: hA[1] }, splitP: att >= 4 && Math.abs((hA[0] ? hS[0] / hA[0] : 0) - (hA[1] ? hS[1] / hA[1] : 0)) >= 0.5 ? 0.03 : 0.31, split: this.state[i] === 7 },
      reputation: known ? { attempts: 12 + (i % 40), runs: 1 + (i % 3), rate: +known.toFixed(2), lastSeen: "2026-11-18", best: this.blockIp(i), colo: ["FRA", "AMS", "LHR", "CDG", "WAW", "IST", "DXB", "SIN"][this.colo[i]] } : null,
      candidates: suc ? [this.eligRow(i, att, suc)] : [] };
  },
  action(name, body) {
    return (async () => {
      if (name === "run") {
        if (this.run) return { error: "run_active", message: t("note.runActive", { run: this.run.runId }) };
        if (!this.cfgDesc) return { error: "config_missing", message: t("note.configMissing") };
        if (body.resume && this.paused) { const R = this.paused; this.paused = null; this.startRun(R); this.emit("run-state", { status: "running", mode: R.mode, runId: R.runId }); return { ok: true, runId: R.runId }; }
        const R = this.newRun(body.mode); this.startRun(R); return { ok: true, runId: R.runId };
      }
      if (name === "stop") { this.stopRun(); return { ok: true }; }
      if (name === "serverStop") { app.onConn("offline"); return { ok: true }; }
      if (name === "saveSettings") { this.settingsObj = body; return { ok: true }; }
      if (name === "defaults") { this.settingsObj = simDefaultSettings(); return { ok: true }; }
      if (name === "workloads") { return { ok: true }; }
      if (name === "importConfig") {
        const uri = String(body || "").trim();
        if (!/^vless:\/\//i.test(uri) || !uri.includes("@")) return { error: "invalid_uri", message: "Only WebSocket transport is supported for scanning, found: —" };
        const m = uri.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)([^#]*)(?:#(.*))?$/i);
        if (!m) return { error: "invalid_uri", message: "Could not parse the VLESS link." };
        const q = new URLSearchParams((m[4] || "").split("?")[1] || "");
        this.cfgDesc = { address: m[2], port: +m[3], host: q.get("host") || m[2], sni: q.get("sni") || q.get("host") || "", path: decodeURIComponent(q.get("path") || "/"), transport: q.get("type") || "ws", security: q.get("security") || "tls", label: m[5] ? decodeURIComponent(m[5]) : null, idPresent: Boolean(m[1]) };
        if (this.cfgDesc.transport !== "ws") return { error: "transport", message: "Only WebSocket transport is supported for scanning, found: " + this.cfgDesc.transport };
        return { ok: true, descriptor: this.cfgDesc };
      }
      if (name === "removeConfig") { if (this.run) return { error: "run_active", message: t("cfg.removeNote") }; this.cfgDesc = null; return { ok: true }; }
      return { error: "unknown", message: name };
    })();
  },
  connect() { /* the sim emits only while a run or the tail is live */ },
  disconnect() { },
  setTail(on) { this.tail = on; if (on) this.log("info", "web.tail", "live tail subscribed (simulated)"); },
  newRun(mode) {
    const runId = Math.random().toString(16).slice(2, 10) + "-sim";
    const R = { mode, runId, startedAt: new Date().toISOString(), phase: "calibrating", tick: 0,
      counters: { completed: 0, total: 0, eligible: 0, failed: 0, probesSpent: 0, primerProbes: 0, expansionProbes: 0, reserveProbes: 0, blocksPrimed: 0, blocksExpanded: 0, blocksSplit: 0, elapsedMs: 0 },
      rng: mulberry32(404 + Date.now() % 100000) };
    if (mode === "hard") {
      R.att = new Uint16Array(7697); R.suc = new Uint16Array(7697);
      R.hAtt = [new Uint16Array(7697), new Uint16Array(7697)]; R.hSuc = [new Uint16Array(7697), new Uint16Array(7697)];
      R.pending = []; R.po = this.primerOrder(); R.poIdx = 0; R.suspects = []; R.covIdx = 0; R.wave = 0; R.finIdx = 0; R.laneIdx = 0;
      for (let i = 0; i < 7697; i++) { this.state[i] = this.known[i] ? 1 : 0; this.heat[i] = 0; this.quads[i] = 0; this.quadHeat[i] = 0; }
    } else {
      const P = { quick: { n: 16, rounds: 2, fin: 6, tun: 3, tunRounds: 1 }, full: { n: 120, rounds: 3, fin: 20, tun: 5, tunRounds: 1 }, research: { n: 240, rounds: 6, fin: 24, tun: 8, tunRounds: 3 } }[mode];
      R.prof = P; R.cands = []; R.ci = 0; R.sprtIdx = 0; R.tunIdx = 0;
      const used = new Set();
      for (let k = 0; k < P.n; k++) {
        let i; do { i = Math.floor(R.rng() * 7697); } while (used.has(i) || (R.rng() < 0.7 && this.latent[i] < 0.05));
        used.add(i);
        R.cands.push({ block: i, ip: intToIp(this.cat.blocks[i].base + 1 + Math.floor(R.rng() * 254)), att: 0, suc: 0, stage: { elig: 0, sprt: 0, tun: 0 }, ms: 60 + R.rng() * 700 });
      }
    }
    return R;
  },
  primerOrder() { // stratified: range round-robin, 3 passes — origins ignite everywhere at once
    const order = [], maxSize = Math.max(...this.cat.ranges.map((r) => r.blocks));
    const strat = [];
    for (let k = 0; k < maxSize; k++) for (const r of this.cat.ranges) if (k < r.blocks) strat.push(r.start + k);
    for (let p = 0; p < 3; p++) order.push(...strat);
    return order;
  },
  startRun(R) {
    this.run = R;
    this.emit("run-state", { status: "running", mode: R.mode, runId: R.runId });
    this.emit("phase", { phase: R.phase, startedAt: Date.now() });
    this.log("info", "run.start", R.mode + " " + R.runId);
    app.showNotice(t("tick.started", { run: R.runId, mode: t("mode." + R.mode) }), "info");
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
  },
  stopRun() {
    if (!this.run) return;
    clearInterval(this.timer); this.timer = null;
    const R = this.run; this.run = null; this.paused = R.phase === "complete" ? null : R;
    this.emit("run-state", { status: R.phase === "complete" ? "complete" : "paused-done", mode: R.mode, runId: R.runId });
    this.log("warn", "run.stop", R.runId);
  },
  finishRun(R, rows) {
    const rep = { schema: 10, runId: R.runId, mode: R.mode, startedAt: R.startedAt, finishedAt: new Date().toISOString(),
      totals: { candidates: rows.length, eligible: rows.filter((r) => r.eligibility.successRate > 0).length, complete: rows.filter((r) => r.measurement.status === "complete").length, partial: rows.filter((r) => r.measurement.status === "partial").length },
      results: rows, size: 0 };
    rep.size = JSON.stringify(rep).length;
    this.latestReport = rep; this.reports.unshift(rep);
    if (R.mode === "hard") for (let i = 0; i < 7697; i++) if (R.att[i]) this.known[i] = Math.round(255 * R.suc[i] / R.att[i]);
    this.emit("ticker", { text: t("tick.repSaved") });
    this.emit("ticker", { text: t("tick.complete", { eligible: rep.totals.eligible }) });
    this.log("info", "run.complete", R.runId);
    this.stopRun();
  },
  probeOnce(R, i, half) {
    const ok = R.rng() < this.pHalf(i, half);
    R.att[i]++; R.hAtt[half][i]++; if (ok) { R.suc[i]++; R.hSuc[half][i]++; }
    R.counters.probesSpent++;
    return ok;
  },
  tracePush(R, ok, ms, recovered) { this.emit("trace", { points: [[recovered ? "recovered" : ok ? "ok" : R.rng() < 0.003 ? "error" : "timeout", Math.round(ms)]] }); },
  tick() {
    const R = this.run; if (!R) return;
    R.tick++; R.counters.elapsedMs = R.tick * 250;
    if (R.mode === "hard") this.tickHard(R); else this.tickScan(R);
    this.emit("counters", { ...R.counters });
  },
};
function simDefaultSettings() {
  const MIB = 1048576;
  return { version: 7, mode: "full",
    scan: { perRange: 3, maxCandidates: 120, rounds: 3, screeningRounds: 1, concurrency: 12, timeoutMs: 6000, minimumSuccessRate: 0.6, seed: 404, delayedRetry: { enabled: true, maxCandidates: 60 } },
    verification: { enabled: true, limit: 20, sprt: { p0: 0.6, p1: 0.9, alpha: 0.05, beta: 0.1, minRounds: 2, maxRounds: 16 } },
    calibration: { enabled: true, levels: [1, 2, 4, 8, 12, 16], latencyInflationLimit: 0.1, failureRateIncreaseLimit: 0.02, eventLoopLagLimitMs: 50 },
    tunnel: { enabled: true, xrayPath: "auto", limit: 5, rounds: 1, concurrency: 1, startupTimeoutMs: 8000, shutdownGraceMs: 1500 },
    browsing: { enabled: true, metricName: "Web Transfer Score", workloads: ["cloudflare-docs", "cdnjs"], assetLimit: 10, timeoutMs: 20000, maxSockets: 1, maxBytes: 5 * MIB, estimatedMaxBytes: 5 * MIB },
    streaming: { enabled: true, workloads: ["apple-advanced-hevc"], maxSegments: 4, quickSegments: 2, researchSegments: 6, maxBytes: 12 * MIB, estimatedMaxBytes: 12 * MIB, startupBufferSec: 4, safetyFactor: 1.25, timeoutMs: 30000, variantMode: "fixed", targetMbps: 6 },
    load: { enabled: true, durationMs: 8000, chunkBytes: MIB, maxDownloadBytes: 12 * MIB, flows: 4, uploadBytes: MIB, uploadFlows: 1, fanoutRequests: 4, idleSamples: 2, timeoutMs: 7000, minBytes: 8 * MIB, gateProfile: "balanced", endpoints: { download: "https://speed.cloudflare.com/__down", upload: "https://speed.cloudflare.com/__up", ping: "https://speed.cloudflare.com/__down?bytes=1000", control: "https://ash-speed.hetzner.com/100MB.bin" }, control: { enabled: false, bytes: 6 * MIB }, gates: {} },
    traffic: { targetBytesPerCandidate: 30 * MIB, hardWarningBytesPerCandidate: 40 * MIB },
    hard: { concurrency: 12, screeningRounds: 1, recheckTop: 20, saveEvery: 25, liveTop: 30, finalTop: 200, delayedRetry: true, retryLimit: 5000, engine: "blocks", primerPerBlock: 3, budgetProbes: 72000, banditExploration: 1, maxDepthPerBlock: 32, expansionWaveFactor: 10, expansionChunk: 4, rangeWaveCapFraction: 0.25, poolPerBlock: 8, recheckPerBlock: 4, splitMaxDepth: 2, splitAlpha: 0.05, splitMinEffect: 0.5, splitReserveFraction: 0.85, splitReserveAlpha: 0.25, reputationSkipAgeDays: 3, reputationConfirmAgeDays: 21, reputationHalfLifeDays: 14, reputationMaxStoredAttempts: 64 },
    customWorkloads: { browsing: [], streaming: [] }, logging: { level: "info" } };
}

/* ---------------- sim run machines ---------------- */
Object.assign(Sim, {
  setPhase(R, p) { R.phase = p; this.emit("phase", { phase: p, startedAt: Date.now() }); this.log("info", "phase", p); },
  mark(R, i) { (R.dirty || (R.dirty = new Map())).set(i, 1); },
  flush(R) {
    if (!R.dirty || !R.dirty.size) return;
    const deltas = [];
    for (const i of R.dirty.keys()) deltas.push(this.state[i] === 7 ? [i, 7, this.heat[i], this.quads[i], this.quadHeat[i]] : [i, this.state[i], this.heat[i]]);
    R.dirty.clear();
    this.emit("blocks", { deltas });
  },
  resolvePending(R) {
    for (const { i, half } of R.pending) {
      const ok = this.probeOnce(R, i, half);
      R.counters.primerProbes++; R.resolved++;
      this.tracePush(R, ok, ok ? 50 + R.rng() * 800 : 6000, false);
      this.state[i] = R.suc[i] > 0 ? 3 : 4; this.heat[i] = Math.round(255 * R.suc[i] / R.att[i]); this.mark(R, i);
    }
    R.pending = [];
    R.counters.completed = R.resolved; R.counters.total = R.po.length;
    R.counters.eligible = 0; for (let i = 0; i < 7697; i++) if (R.suc[i] > 0) R.counters.eligible++;
  },
  tickHard(R) {
    const K = 90 * this.speed;
    if (R.phase === "calibrating") { this.emit("ticker", { text: t("tick.calibrated", { n: 12 }) }); this.setPhase(R, "hard-primer"); R.resolved = 0; return; }
    if (R.phase === "hard-primer") {
      if (R.pending.length) this.resolvePending(R);
      if (R.poIdx < R.po.length) {
        const batch = R.po.slice(R.poIdx, R.poIdx + K); R.poIdx += batch.length;
        R.pending = batch.map((i) => { if (!R.att[i] && !R.suc[i]) { this.state[i] = 2; this.mark(R, i); } return { i, half: R.rng() < 0.5 ? 0 : 1 }; });
      } else if (!R.pending.length) {
        let alive = 0; for (let i = 0; i < 7697; i++) if (R.suc[i] > 0) alive++;
        R.counters.blocksPrimed = 7697;
        this.emit("ticker", { text: t("tick.primerDone", { alive: fmt(alive), blocks: fmt(7697) }) });
        R.suspects = [];
        for (let i = 0; i < 7697; i++) {
          const a0 = R.hAtt[0][i], a1 = R.hAtt[1][i];
          if (a0 >= 1 && a1 >= 1 && Math.abs((a0 ? R.hSuc[0][i] / a0 : 0) - (a1 ? R.hSuc[1][i] / a1 : 0)) >= 0.5) R.suspects.push(i);
        }
        R.suspects.sort((a, b) => R.att[b] - R.att[a]); R.suspects = R.suspects.slice(0, 400);
        this.setPhase(R, "hard-coverage");
      }
      this.flush(R); return;
    }
    if (R.phase === "hard-coverage") {
      const batch = R.suspects.slice(R.covIdx, R.covIdx + Math.max(4, Math.floor(K / 24)));
      for (const i of batch) {
        if (this.state[i] !== 7) { this.state[i] = 6; this.mark(R, i); }
        const less = R.hAtt[0][i] <= R.hAtt[1][i] ? 0 : 1;
        this.probeOnce(R, i, less); this.probeOnce(R, i, 1 - less); R.counters.reserveProbes += 2;
        const a0 = R.hAtt[0][i], a1 = R.hAtt[1][i], r0 = a0 ? R.hSuc[0][i] / a0 : 0, r1 = a1 ? R.hSuc[1][i] / a1 : 0;
        if (Math.min(a0, a1) >= 2 && Math.abs(r0 - r1) >= 0.5) {
          const cs = (s, a) => (a ? (s ? 3 : 4) : 0), ch = (s, a) => (a ? Math.round(255 * s / a) : 0);
          let q = [cs(R.hSuc[0][i], a0), cs(R.hSuc[0][i], a0), cs(R.hSuc[1][i], a1), cs(R.hSuc[1][i], a1)];
          let qh = [ch(R.hSuc[0][i], a0), ch(R.hSuc[0][i], a0), ch(R.hSuc[1][i], a1), ch(R.hSuc[1][i], a1)];
          if (R.rng() < 0.25) { const col = r0 < r1 ? 0 : 2; q[col] = this.pHalf(i, col ? 1 : 0) > 0.3 ? 3 : 4; qh[col] = Math.round(255 * Math.min(1, this.pHalf(i, col ? 1 : 0) + 0.15)); }
          this.quads[i] = (q[0] | (q[1] << 8) | (q[2] << 16) | (q[3] << 24)) >>> 0;
          this.quadHeat[i] = (qh[0] | (qh[1] << 8) | (qh[2] << 16) | (qh[3] << 24)) >>> 0;
          this.state[i] = 7; R.counters.blocksSplit++;
        } else { this.state[i] = R.suc[i] > 0 ? 3 : 4; this.heat[i] = Math.round(255 * R.suc[i] / R.att[i]); }
        this.mark(R, i);
      }
      R.covIdx += batch.length;
      if (R.covIdx >= R.suspects.length) {
        this.emit("ticker", { text: t("tick.coverage", { suspects: fmt(R.suspects.length), split: fmt(R.counters.blocksSplit) }) });
        R.aliveList = []; for (let i = 0; i < 7697; i++) if (R.suc[i] > 0) R.aliveList.push(i);
        this.setPhase(R, "hard-expansion");
      }
      this.flush(R); return;
    }
    if (R.phase === "hard-expansion") {
      const waves = this.speed >= 16 ? 2 : 1;
      for (let w = 0; w < waves; w++) {
        R.wave++;
        const cand = R.aliveList.filter((i) => R.att[i] < 32);
        cand.sort((a, b) => (R.suc[b] / R.att[b] + Math.sqrt(2 * Math.log(R.counters.probesSpent + 2) / R.att[b])) - (R.suc[a] / R.att[a] + Math.sqrt(2 * Math.log(R.counters.probesSpent + 2) / R.att[a])));
        for (const i of cand.slice(0, 30)) {
          this.state[i] = 5; this.mark(R, i);
          for (let k = 0; k < 4; k++) { const ok = this.probeOnce(R, i, R.rng() < 0.5 ? 0 : 1); R.counters.expansionProbes++; this.tracePush(R, ok, ok ? 50 + R.rng() * 800 : 6000, false); }
          this.state[i] = R.att[i] >= 32 ? 8 : 3; this.heat[i] = Math.round(255 * R.suc[i] / R.att[i]); this.mark(R, i);
          if (R.att[i] >= 32) R.counters.blocksExpanded++;
        }
        if (R.wave % 2 === 1 || this.speed < 16) this.emit("ticker", { text: t("tick.wave", { wave: R.wave, probes: 120, spent: fmt(R.counters.probesSpent), total: fmt(72000) }) });
        this.log("info", "hard.engine.wave", "wave " + R.wave);
      }
      if (R.counters.probesSpent >= 72000 || R.wave >= 30) this.setPhase(R, "hard-retry");
      this.flush(R); return;
    }
    if (R.phase === "hard-retry") {
      if (!R.retried) {
        R.retried = true; let recovered = 0, tried = 0;
        for (let i = 0; i < 7697 && tried < 240; i++) if (this.state[i] === 4) { tried++; const ok = this.probeOnce(R, i, R.rng() < 0.5 ? 0 : 1); this.tracePush(R, ok, ok ? 120 + R.rng() * 600 : 6000, ok); if (ok) { recovered++; this.state[i] = 3; this.heat[i] = Math.round(255 * R.suc[i] / R.att[i]); this.mark(R, i); } }
        R.recovered = recovered;
      } else {
        this.emit("ticker", { text: t("tick.retries", { n: fmt(R.recovered || 0) }) });
        const alive = []; for (let i = 0; i < 7697; i++) if (R.suc[i] > 0) alive.push(i);
        alive.sort((a, b) => wilson(R.suc[b], R.att[b]).lower - wilson(R.suc[a], R.att[a]).lower);
        R.finalists = alive.slice(0, 200); R.finIdx = 0;
        this.setPhase(R, "hard-verify");
      }
      this.flush(R); return;
    }
    if (R.phase === "hard-verify") {
      const batch = R.finalists.slice(R.finIdx, R.finIdx + 40);
      for (const i of batch) { this.state[i] = 9; this.mark(R, i); }
      R.finIdx += batch.length;
      if (R.finIdx >= R.finalists.length) { this.emit("ticker", { text: t("tick.pool", { n: fmt(R.finalists.length) }) }); R.laneIdx = 0; this.setPhase(R, "hard-finalize"); }
      this.flush(R); return;
    }
    if (R.phase === "hard-finalize") {
      const top = R.finalists.slice(0, 5);
      if (R.laneIdx < top.length) {
        const i = top[R.laneIdx];
        const ev = this.simEvidence(R, i);
        this.emit("candidate", { row: this.makeRow(this.blockIp(i), i, R.att[i], R.suc[i], ev), lane: true });
        if (R.laneIdx < 3) { this.state[i] = 10; this.mark(R, i); }
        R.laneIdx++;
      } else {
        const rows = R.finalists.slice(0, 40).map((i, k) => this.makeRow(this.blockIp(i), i, R.att[i], R.suc[i], k < 5 ? this.simEvidence(R, i) : null));
        this.flush(R);
        this.finishRun(R, this.sortRows(rows));
        return;
      }
      this.flush(R); return;
    }
  },
  simEvidence(R, i) {
    const p = this.latent[i];
    return { transfer: Math.round(40 + p * 55), streamingMbps: +(1 + p * 9).toFixed(1), loadMbps: +(0.8 + p * 11).toFixed(1), rpm: Math.round(60 + p * 700), shaping: +(0.5 + p * 0.45).toFixed(2), rttInc: Math.round(30 + (1 - p) * 260) };
  },
  makeRow(ip, blockIdx, att, suc, ev) {
    const w = wilson(suc, att), rate = att ? suc / att : 0;
    const base = { ip, range: this.cat.ranges[this.cat.blocks[blockIdx].range].cidr, block: this.blockCidr(blockIdx),
      eligibility: { attempts: att, successes: suc, successRate: +rate.toFixed(3), confidence95: { lower: +w.lower.toFixed(3), upper: +w.upper.toFixed(3) }, confidence: att >= 8 ? "high" : att >= 3 ? "medium" : "low", handshakeMedianMs: Math.round(60 + (1 - this.latent[blockIdx]) * 700), pops: { dominant: ["FRA", "AMS", "LHR", "CDG", "WAW", "IST", "DXB", "SIN"][this.colo[blockIdx]] } } };
    if (ev) {
      const overall = Math.max(0, Math.min(99, Math.round(28 + 58 * w.lower + Math.min(14, ev.loadMbps))));
      return { ...base, verdict: { label: overall >= 80 ? "recommended" : overall >= 60 ? "good" : "usable" },
        scores: { conservative: Math.round(overall * (0.82 + 0.18 * rate)), conservativeUncapped: Math.round(overall * (0.82 + 0.18 * rate)), overall, overallUncapped: overall },
        load: { sustainedMbps: ev.loadMbps, rpm: ev.rpm, shapingRatio: ev.shaping, rttIncreaseMs: ev.rttInc },
        streaming: { sustainableMbps: ev.streamingMbps }, gates: { status: ev.loadMbps >= 2 ? "pass" : ev.loadMbps >= 1 ? "warn" : "fail", limiting: ev.loadMbps < 2 ? "sustainedMbps" : null },
        measurement: { status: "complete", bytesMeasured: 30 * 1048576 + blockIdx * 977, qoeConfidence: "measured" } };
    }
    const overall = Math.min(70, Math.round(75 * rate));
    return { ...base, verdict: { label: suc ? "partial" : "unmeasured" },
      scores: { conservative: Math.round(overall * (0.8 + 0.2 * rate)), conservativeUncapped: Math.round(overall * (0.8 + 0.2 * rate)), overall, overallUncapped: overall },
      load: null, streaming: null, gates: { status: "unknown", limiting: suc ? "load" : "eligibility" },
      measurement: { status: suc ? "partial" : "unmeasured", bytesMeasured: 0, qoeConfidence: "provisional" } };
  },
  sortRows(rows) { const rank = { complete: 0, partial: 1, unmeasured: 2 }; return rows.sort((a, b) => (rank[a.measurement.status] - rank[b.measurement.status]) || (b.scores.conservative - a.scores.conservative)); },
  tickScan(R) {
    const K = 4 + this.speed, P = R.prof;
    if (R.phase === "calibrating") { this.emit("ticker", { text: t("tick.calibrated", { n: 12 }) }); R.counters.total = P.n * P.rounds; this.setPhase(R, "screening"); return; }
    if (R.phase === "screening") {
      for (let k = 0; k < K && R.ci < P.n * P.rounds; k++, R.ci++) {
        const c = R.cands[R.ci % P.n];
        c.p ??= Math.min(0.97, Math.max(0.01, this.latent[c.block] * (0.7 + R.rng() * 0.6)));
        const ok = R.rng() < c.p; c.att++; if (ok) c.suc++;
        this.tracePush(R, ok, ok ? c.ms : 6000, false);
        if (c.att === P.rounds) { c.stage.elig = 1; this.emit("candidate", { row: this.scanRow(R, c) }); }
      }
      R.counters.completed = R.ci; R.counters.eligible = R.cands.filter((c) => c.suc > 0).length;
      if (R.ci >= P.n * P.rounds) { R.retryList = R.cands.filter((c) => c.suc === 0); R.ri = 0; R.counters.total = R.retryList.length; R.counters.completed = 0; this.setPhase(R, "delayed-retry"); }
      return;
    }
    if (R.phase === "delayed-retry") {
      for (let k = 0; k < K && R.ri < R.retryList.length; k++, R.ri++) { const c = R.retryList[R.ri]; const ok = R.rng() < c.p; c.att++; if (ok) { c.suc++; this.tracePush(R, ok, c.ms, true); this.emit("candidate", { row: this.scanRow(R, c) }); } }
      R.counters.completed = R.ri;
      if (R.ri >= R.retryList.length) {
        R.fin = R.cands.filter((c) => c.suc > 0).sort((a, b) => wilson(b.suc, b.att).lower - wilson(a.suc, a.att).lower).slice(0, P.fin);
        R.fin.forEach((c) => { c.llr = 0; c.rounds = 0; c.decided = null; });
        R.counters.total = R.fin.length; R.counters.completed = 0; this.setPhase(R, "verification");
      }
      return;
    }
    if (R.phase === "verification") {
      let open = 0;
      for (const c of R.fin) {
        if (c.decided) continue; open++;
        const ok = R.rng() < c.p; c.rounds++; c.llr += ok ? 0.405 : -1.386;
        c.stage.sprt = c.rounds / 16;
        if (c.llr >= 2.89) c.decided = "accept"; else if (c.llr <= -2.251) c.decided = "reject"; else if (c.rounds >= 16) c.decided = "inconclusive";
        if (c.decided) this.emit("candidate", { row: this.scanRow(R, c) });
      }
      R.counters.completed = R.fin.filter((c) => c.decided).length;
      if (!open || R.fin.every((c) => c.decided)) { R.tun = R.fin.filter((c) => c.decided !== "reject").slice(0, P.tun); R.tunIdx = 0; R.counters.total = R.tun.length * P.tunRounds; R.counters.completed = 0; this.setPhase(R, "tunnel"); }
      return;
    }
    if (R.phase === "tunnel") {
      const c = R.tun[Math.floor(R.tunIdx / P.tunRounds)];
      if (c) { c.tunRoundsDone = (c.tunRoundsDone || 0) + 1; c.stage.tun = c.tunRoundsDone / P.tunRounds; R.tunIdx++; R.counters.completed = R.tunIdx;
        if (c.tunRoundsDone >= P.tunRounds) this.emit("candidate", { row: this.scanRow(R, c, true) }); }
      if (R.tunIdx >= R.tun.length * P.tunRounds) {
        const rows = R.cands.filter((c) => c.suc > 0).map((c) => this.scanRow(R, c, R.tun.includes(c)));
        this.finishRun(R, this.sortRows(rows));
      }
      return;
    }
  },
  scanRow(R, c, full) {
    const ev = full ? { transfer: 0, streamingMbps: +(1 + c.p * 9).toFixed(1), loadMbps: +(0.8 + c.p * 11).toFixed(1), rpm: Math.round(60 + c.p * 700), shaping: +(0.5 + c.p * 0.45).toFixed(2), rttInc: Math.round(30 + (1 - c.p) * 260) } : null;
    const row = this.makeRow(c.ip, c.block, c.att, c.suc, ev);
    row.stage = { ...c.stage }; row.sprt = c.decided || (c.rounds ? "rounds " + c.rounds : null);
    return row;
  },
});

/* ---------------- app store & event plumbing ---------------- */
const app = {
  src: null, state: null, catalog: null, conn: "connecting",
  runStatus: "idle", runMode: null, runId: null, phase: null, counters: {}, startedAt: 0,
  genome: null, // {state, heat, quads, quadHeat, known} Uint arrays, 7,697 cells
  tracePts: [], ticker: [], ledger: new Map(), lane: [], logs: [],
  lastSeq: 0, view: null, viewName: "",
  onConn(s) {
    this.conn = s;
    const pill = $("#conn-pill");
    if (this.src && this.src.kind === "sim") { pill.textContent = t("conn.sim"); pill.className = "pill"; }
    else if (s === "live") { pill.textContent = t("conn.live"); pill.className = "pill pill-live"; }
    else if (s === "offline") { pill.textContent = t("conn.offline"); pill.className = "pill pill-off"; this.showNotice(t("note.serverStopped"), "info"); }
    else { pill.textContent = t("conn.reconnecting"); pill.className = "pill pill-off"; }
    if (s === "live") this.resync();
  },
  showNotice(msg, kind) {
    const n = $("#notice"); n.textContent = msg; n.className = "notice" + (kind === "info" ? " info" : ""); n.hidden = false;
    clearTimeout(this._noticeT); this._noticeT = setTimeout(() => { n.hidden = true; }, 9000);
  },
  async resync() {
    try { const s = await this.src.getState(); this.applySnapshot(s); } catch { /* server gone; pill already says so */ }
  },
  applySnapshot(s) {
    this.state = s;
    if (s.server && s.server.version) $("#version").textContent = "v" + s.server.version;
    const g = (s.run && s.run.genome) || s.genome;
    if (g) this.genome = { state: b64ToU8(g.state), heat: b64ToU8(g.heat), quads: b64ToU32(g.quads), quadHeat: g.quadHeat ? b64ToU32(g.quadHeat) : new Uint32Array(7697), known: b64ToU8(g.known) };
    if (s.run) { this.runStatus = s.run.status; this.runMode = s.run.mode; this.runId = s.run.runId; this.phase = s.run.phase; this.counters = s.run.counters || {}; }
    else this.runStatus = s.status && s.status.resumeAvailable ? "paused-done" : this.runStatus === "complete" ? "complete" : "idle";
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
    if (type === "run-state") {
      if (d.status === "running" && d.runId !== this._lastRunId) { this.ledger.clear(); this.lane = []; this.tracePts = []; }
      this._lastRunId = d.runId;
      this.runStatus = d.status; this.runMode = d.mode; this.runId = d.runId;
      if (d.status === "complete" || d.status === "paused-done") setTimeout(() => this.resync(), 350);
      if (d.status === "paused-done") this.showNotice(t("note.stopped"), "info");
    }
    this.refreshChrome();
    if (this.view && this.view.onEvent) this.view.onEvent(type, d);
  },
  refreshNotes() {
    const el = $("#margin-notes"); if (!el) return;
    el.innerHTML = this.ticker.length ? this.ticker.slice(0, 3).map((x) => `<div>${esc(x)}</div>`).join("") : esc(t("run.idle"));
  },
  refreshChrome() {
    const b = $("#run-banner");
    if (this.runStatus === "running") {
      b.hidden = false;
      $("#rb-jump").href = this.runMode === "hard" ? "#/genome" : "#/scan/" + this.runMode;
      $("#rb-text").textContent = `${t("mode." + this.runMode)} · ${this.phase ? t("phase." + this.phase) : ""} · ${mmss(this.counters.elapsedMs)} · ${fmt(this.counters.probesSpent || this.counters.completed || 0)}`;
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
  let p1 = "", p2 = "", rungs = "";
  for (let x = 0; x <= 72; x += 2) { const y1 = 9 + 6 * Math.sin(x / 72 * Math.PI * 2), y2 = 9 - 6 * Math.sin(x / 72 * Math.PI * 2); p1 += `${x},${y1.toFixed(1)} `; p2 += `${x},${y2.toFixed(1)} `; }
  for (let x = 6; x < 72; x += 12) { const y1 = 9 + 6 * Math.sin(x / 72 * Math.PI * 2), y2 = 9 - 6 * Math.sin(x / 72 * Math.PI * 2); rungs += `<line x1="${x}" y1="${y1.toFixed(1)}" x2="${x}" y2="${y2.toFixed(1)}"/>`; }
  svg.innerHTML = `<g style="stroke:var(--ink-40)" stroke-width="1">${rungs}</g><polyline points="${p1}" fill="none" style="stroke:var(--a)" stroke-width="1.4"/><polyline points="${p2}" fill="none" style="stroke:var(--c)" stroke-width="1.4"/>`;
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
  const { parts, q } = parseHash();
  const name = parts[0] || "dashboard";
  if (app.view && app.view.destroy) app.view.destroy();
  window.__plate = null;
  $$("#margin a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name || (name === "scan" && a.dataset.nav === "dashboard")));
  const el = $("#view"); el.innerHTML = "";
  const fn = name === "scan" ? Views.scan : Views[name] || Views.dashboard;
  app.viewName = name;
  app.view = fn(el, parts, q) || {};
  el.focus({ preventScroll: true });
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
    else app.showNotice(r.message || r.error);
    return;
  }
  location.hash = mode === "hard" ? "#/genome" : "#/scan/" + mode;
}
function resultsTable(rows, compact) {
  const head = `<tr><th class="num">${t("col.rank")}</th><th>${t("col.ip")}</th><th>${t("col.verdict")}</th><th class="num">${t("col.cons")}</th>${compact ? "" : `<th class="num">${t("col.raw")}</th><th class="num">${t("col.overall")}</th>`}<th>${t("col.elig")}</th><th class="num">${t("col.mbps")}</th><th class="num">${t("col.rpm")}</th><th>${t("col.pop")}</th><th>${t("col.gate")}</th>${compact ? "" : `<th>${t("col.why")}</th>`}</tr>`;
  const body = rows.map((r, i) => `<tr class="${i === 0 ? "best" : ""} clickable" data-i="${i}">
    <td class="num">${i + 1}</td><td>${i === 0 ? '<span class="tick-a">▸</span> ' : ""}${D(r.ip)}</td><td>${esc(r.verdict?.label || r.measurement?.status || "")}</td>
    <td class="num">${r.scores?.conservative ?? "–"}</td>${compact ? "" : `<td class="num">${r.scores?.conservativeUncapped ?? "–"}</td><td class="num">${r.scores?.overall ?? "–"}</td>`}
    <td>${D((r.eligibility?.successes ?? "–") + "/" + (r.eligibility?.attempts ?? "–"))} <span class="dim">↓${fmt2(r.eligibility?.confidence95?.lower)}</span></td>
    <td class="num">${r.load?.sustainedMbps ?? "–"}</td><td class="num">${r.load?.rpm ?? "–"}</td><td>${esc(r.eligibility?.pops?.dominant || "–")}</td>
    <td>${esc(r.gates?.status || "–")}</td>${compact ? "" : `<td>${esc(r.gates?.limiting || r.measurement?.status || "")}</td>`}</tr>`).join("");
  return `<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`;
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
    <p class="view-sub">${esc(t("genome.sub", { ranges: fmt(753), blocks: fmt(7697), addrs: fmt(1970432) }))}</p>
    <div class="form-actions" style="margin:0 0 14px">
      <button class="btn btn-primary" id="g-begin">${esc(t("ui.beginReplication"))}</button>
      <button class="btn" id="g-resume" hidden>${esc(t("ui.resume"))}</button>
      <button class="btn danger" id="g-stop" hidden>${esc(t("ui.stopRun"))}</button>
      <span class="readout" id="g-phase"></span>
    </div>
    <div class="console-grid">
      <div class="console-side">
        <div class="rail" id="g-rail">${HARD_PHASES.map((p) => `<div class="station" data-ph="${p}">${esc(t("phase." + p))}<span class="st-note"></span></div>`).join("")}</div>
        <h3 class="sec-head">${esc(t("genome.budget"))}</h3>
        <div class="budget-meter"><div id="g-budget-fill"></div></div>
        <div class="readout" id="g-budget-text"></div>
        <h3 class="sec-head">${esc(t("genome.legend"))}</h3>
        <div class="legend" style="flex-direction:column;gap:5px">${[["", "unprobed"], ["background:var(--a);opacity:.25", "known"], ["sw-g", "priming"], ["sw-a", "alive"], ["", "absent"], ["sw-a\" style=\"border-top:2px solid var(--g)", "hot"], ["\" style=\"border-bottom:2px solid var(--g)", "suspect"], ["sw-ink", "exhausted"], ["sw-c", "finalist"], ["sw-c", "winner"]].map(([cls, k]) => `<span><i class="sw ${cls}"></i>${esc(t("lg." + k))}</span>`).join("")}
        </div>
        <h3 class="sec-head">${esc(t("genome.liveNotes"))}</h3>
        <div class="ticker" id="g-ticker"></div>
      </div>
      <div class="console-main">
        <div class="readout dim" id="g-counters"></div>
        <h3 class="sec-head">${esc(t("genome.ideo", { ranges: fmt(753) }))}<span class="right mono" id="g-ideo-cap"></span></h3>
        <div class="ideo-wrap"><canvas class="ideo" id="g-ideo" height="26"></canvas></div>
        <div class="plate-frame"><div id="g-plate"></div></div>
        <p class="plain-note">${esc(t("genome.tapHint"))} <span class="mono" id="g-hover"></span></p>
        <div id="g-lane"></div>
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
      const w = (r.blocks / 7697) * W;
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
    let acc = 0, idx = 0; for (let ri = 0; ri < app.catalog.ranges.length; ri++) { acc += app.catalog.ranges[ri].blocks / 7697; if (fx <= acc) { idx = ri; break; } }
    plate.inspect = plate.inspect === idx ? null : idx; plate.resize(); drawIdeo();
  });
  const railTo = (phase) => {
    const idx = HARD_PHASES.indexOf(phase);
    $$("#g-rail .station").forEach((s, k) => { s.className = "station" + (idx >= 0 && k < idx ? " done" : idx >= 0 && k === idx ? " now" : ""); });
    $("#g-phase").textContent = phase ? t("phase." + phase) : "";
  };
  const countersTo = () => {
    const c = app.counters;
    $("#g-counters").textContent = t("genome.counters", { elapsed: mmss(c.elapsedMs), alive: fmt(c.eligible || 0), primed: fmt(c.blocksPrimed || 0), expanded: fmt(c.blocksExpanded || 0), split: fmt(c.blocksSplit || 0) });
    const total = 72000, spent = c.probesSpent || 0;
    $("#g-budget-fill").style.width = Math.min(100, (spent / total) * 100) + "%";
    $("#g-budget-text").textContent = t("genome.spent", { spent: fmt(spent), total: fmt(total) });
    $("#g-ticker").innerHTML = app.ticker.slice(0, 8).map((x) => `<div>${esc(x)}</div>`).join("");
  };
  const controlsTo = () => {
    const running = app.runStatus === "running" && app.runMode === "hard";
    $("#g-begin").hidden = running || app.runStatus === "paused-done";
    $("#g-resume").hidden = !(app.runStatus === "paused-done" && ((app.state || {}).status || {}).resumeAvailable);
    $("#g-stop").hidden = !running;
    railTo(app.phase); countersTo();
  };
  const topTo = (rows) => {
    $("#g-top").innerHTML = rows && rows.length ? `<table class="data"><thead><tr><th>${t("col.ip")}</th><th>${t("col.elig")}</th><th class="num">↓95</th><th>${t("col.pop")}</th><th>${t("col.ip")} /24</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${D(r.ip)}</td><td>${D(r.eligibility.successes + "/" + r.eligibility.attempts)}</td><td class="num">${fmt2(r.eligibility.confidence95.lower)}</td><td>${esc(r.eligibility.pops.dominant)}</td><td>${D(r.block || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">${esc(t("console.noCandidates"))}</p>`;
  };
  const laneTo = () => {
    $("#g-lane").innerHTML = app.lane.length ? `<div class="lane"><h3 class="sec-head">${esc(t("lane.title"))}</h3>${app.lane.map((r) => `<div class="lane-row"><span>${D(r.ip)}</span><span class="ev">transfer <b>${r.scores?.overall ?? "–"}</b></span><span class="ev">streaming <b>${r.streaming?.sustainableMbps ?? "–"} Mbps</b></span><span class="ev">load <b>${r.load?.sustainedMbps ?? "–"} Mbps · ${r.load?.rpm ?? "–"} rpm</b></span><span class="ev">${esc(r.verdict?.label || "")}</span></div>`).join("")}</div>` : "";
  };
  $("#g-begin").addEventListener("click", () => startRun("hard"));
  $("#g-resume").addEventListener("click", () => startRun("hard", true));
  $("#g-stop").addEventListener("click", (e) => armButton(e.currentTarget, "ui.stopRunArm", async () => { await app.src.action("stop"); }));
  let lastCounters = 0;
  drawIdeo(); controlsTo(); topTo(((app.state || {}).run || {}).top); laneTo();
  if (app.genome) { plate.drawStatic(); plate.allDirty(); }
  return {
    destroy() { plate.destroy(); loop.stop(); closeInspector(); },
    onSnapshot(s) { plate.drawStatic(); plate.allDirty(); drawIdeo(); controlsTo(); topTo((s.run || {}).top); },
    onEvent(type, d) {
      if (type === "phase") { railTo(d.phase); }
      if (type === "counters") { const now = performance.now(); if (now - lastCounters > 500) { lastCounters = now; countersTo(); } }
      if (type === "candidate" && d.lane) laneTo();
      if (type === "run-state") { controlsTo(); if (d.status === "complete") drawIdeo(); }
      if (type === "ticker") countersTo();
    },
  };
};
function plateBlockCidr(i) { // catalog-order block label without the sim's help (live path)
  if (!app.catalog) return "";
  let acc = 0; for (const r of app.catalog.ranges) { if (i < acc + r.blocks) { const base = ipToInt(r.firstBlock.split("/")[0]); return intToIp(base + (i - acc) * 256) + "/24"; } acc += r.blocks; }
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
    <dl><dt>${esc(t("insp.thisRun"))}</dt><dd>${d.run ? esc(t("insp.probes", { ok: d.run.successes, n: d.run.attempts, rate: fmt2(d.run.rate), lower: fmt2(d.run.lower) })) : "–"}</dd>
    <dt>${esc(t("insp.primer"))}</dt><dd>${D(d.primer.attempts)} · ${esc(t("insp.tier", { tier: d.primer.tier }))}</dd>
    <dt>${esc(t("insp.halves"))}</dt><dd>${D(d.halves.lower.s + "/" + d.halves.lower.n)} · ${D(d.halves.upper.s + "/" + d.halves.upper.n)}</dd>
    <dd></dd><dd>${esc(d.halves.split ? t("insp.splitYes") : t("insp.splitNo", { p: fmt2(d.halves.splitP) }))}</dd>
    <dt>${esc(t("insp.reputation"))}</dt><dd>${rep ? esc(t("insp.repLine", { n: rep.attempts, runs: rep.runs, rate: fmt2(rep.rate), date: rep.lastSeen, ip: rep.best, colo: rep.colo })) : esc(t("insp.unknown"))}</dd>
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

const SCAN_PHASES = ["screening", "delayed-retry", "verification", "tunnel"];
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
    <div class="console-grid" style="margin-top:18px">
      <div class="console-side"><div class="rail" id="sc-rail">${SCAN_PHASES.map((p) => `<div class="station" data-ph="${p}">${esc(t("phase." + p))}<span class="st-note"></span></div>`).join("")}</div>
      <h3 class="sec-head">${esc(t("genome.liveNotes"))}</h3><div class="ticker" id="sc-ticker"></div></div>
      <div class="console-main">
        <div class="readout dim" id="sc-counters"></div>
        <canvas class="trace" id="sc-trace"></canvas>
        <h3 class="sec-head">${esc(t("console.ledger"))}</h3>
        <div id="sc-ledger"><p class="empty">${esc(t("console.noCandidates"))}</p></div>
        <p id="sc-done"></p>
      </div>
    </div>`;
  const trace = new Trace($("#sc-trace"));
  const loop = makeLoop(() => trace.draw()); loop.start($("#sc-trace"));
  app.src.getSettings().then(({ settings }) => app.src.estimate(settings)).then((r) => { const n = $("#sc-est"); if (n && r) n.textContent = fmtBytes(r.perCandidateBytes * P.n); }).catch(() => {});
  const seg = (f) => `<span class="segbar">${[0.25, 0.5, 0.75, 1].map((x) => `<i class="${f >= x ? "full" : f > x - 0.25 ? "part" : ""}"></i>`).join("")}</span>`;
  const renderLedger = () => {
    const rows = [...app.ledger.values()].filter((r) => r.stage);
    if (!rows.length) return;
    $("#sc-ledger").innerHTML = `<table class="data"><thead><tr><th>${t("col.ip")}</th><th>${t("col.elig")}</th><th>SPRT</th><th>${t("col.verdict")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${D(r.ip)}</td><td>${seg(r.stage?.elig || 0)} ${D(r.eligibility.successes + "/" + r.eligibility.attempts)}</td><td>${seg(r.stage?.sprt || 0)} <span class="dim">${esc(r.sprt || "")}</span></td><td>${esc(r.verdict?.label || "")}</td></tr>`).join("")}</tbody></table>`;
  };
  const railTo = (phase) => { const idx = SCAN_PHASES.indexOf(phase); $$("#sc-rail .station").forEach((s, k) => { s.className = "station" + (idx >= 0 && k < idx ? " done" : idx >= 0 && k === idx ? " now" : ""); }); $("#sc-phase").textContent = phase && t("phase." + phase) ? t("phase." + phase) : ""; };
  const controlsTo = () => {
    const running = app.runStatus === "running" && app.runMode === mode;
    $("#sc-start").hidden = running; $("#sc-stop").hidden = !running;
    $("#sc-counters").textContent = app.runMode === mode ? `${fmt(app.counters.completed || 0)} / ${fmt(app.counters.total || 0)} · ${mmss(app.counters.elapsedMs)}` : "";
    $("#sc-ticker").innerHTML = app.ticker.slice(0, 8).map((x) => `<div>${esc(x)}</div>`).join("");
    if (app.runStatus === "complete" && app.runMode === mode) $("#sc-done").innerHTML = `${esc(t("console.finished"))} <a href="#/results">${esc(t("console.viewResults"))}</a>`;
  };
  $("#sc-start").addEventListener("click", () => startRun(mode));
  $("#sc-stop").addEventListener("click", (e) => armButton(e.currentTarget, "ui.stopRunArm", async () => { await app.src.action("stop"); }));
  railTo(app.phase); controlsTo(); renderLedger();
  return { destroy() { loop.stop(); }, onSnapshot: controlsTo, onEvent(type) { if (type === "phase") railTo(app.phase); if (type === "candidate") renderLedger(); if (type === "run-state" || type === "counters" || type === "ticker") controlsTo(); } };
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
    const dl = app.src.kind === "live"
      ? `<a class="btn btn-quiet" href="/api/reports/${encodeURIComponent(report.runId)}/download">${esc(t("ui.downloadJson"))}</a> <a class="btn btn-quiet" href="/api/reports/${encodeURIComponent(report.runId)}/best-ips">${esc(t("ui.downloadBest"))}</a>`
      : `<button class="btn btn-quiet" id="res-dl">${esc(t("ui.downloadJson"))}</button>`;
    box.innerHTML = `
      <p class="view-sub">${esc(t("res.fromRun", { run: report.runId, mode: t("mode." + (report.mode || "full")), when: report.finishedAt || "" }))}</p>
      <div class="kv"><span>${t("console.candidates")} <b>${fmt(report.totals?.candidates)}</b></span> · <span>${t("col.elig")} <b>${fmt(report.totals?.eligible)}</b></span> · <span>complete <b>${fmt(report.totals?.complete)}</b></span> · <span>partial <b>${fmt(report.totals?.partial)}</b></span><span style="margin-inline-start:auto">${dl}</span></div>
      ${block ? `<p class="plain-note">${esc(t("res.filterBlock", { block }))} · <a href="#/results?run=${encodeURIComponent(report.runId)}">${esc(t("res.clearFilter"))}</a></p>` : ""}
      <div style="margin-top:10px">${resultsTable(rows, false)}</div>`;
    const dlb = $("#res-dl");
    if (dlb) dlb.addEventListener("click", () => download(report.runId + ".json", JSON.stringify(report, null, 2), "application/json"));
    $$("#res-body tr.clickable").forEach((tr) => tr.addEventListener("click", () => {
      if (tr.nextElementSibling && tr.nextElementSibling.classList.contains("detail-row")) { tr.nextElementSibling.remove(); return; }
      const r = rows[+tr.dataset.i]; if (!r) return;
      const lines = [
        `eligibility  ${r.eligibility?.successes}/${r.eligibility?.attempts} · rate ${r.eligibility?.successRate} · lower95 ${r.eligibility?.confidence95?.lower} · median ${r.eligibility?.handshakeMedianMs} ms · ${r.eligibility?.confidence} confidence`,
        `scores       overall ${r.scores?.overall} (raw ${r.scores?.overallUncapped}) · conservative ${r.scores?.conservative} (raw ${r.scores?.conservativeUncapped})`,
        `load         ${r.load ? r.load.sustainedMbps + " Mbps · " + r.load.rpm + " rpm · shaping " + r.load.shapingRatio + " · +RTT " + r.load.rttIncreaseMs + " ms" : "not measured"}`,
        `streaming    ${r.streaming ? (r.streaming.sustainableMbps + " Mbps sustainable") : "not measured"}`,
        `gates        ${r.gates?.status || "–"}${r.gates?.limiting ? " · limiting: " + r.gates.limiting : ""}`,
        `measurement  ${r.measurement?.status} · ${fmtBytes(r.measurement?.bytesMeasured)} · ${r.measurement?.qoeConfidence || ""}`,
      ].join("\n");
      const d = document.createElement("tr"); d.className = "detail-row"; d.innerHTML = `<td colspan="12">${esc(lines)}</td>`;
      tr.after(d);
    }));
  };
  app.src.getResults(runId).then((r) => { report = r; render(); }).catch(() => render());
  return { onSnapshot() { if (!report) app.src.getResults(runId).then((r) => { report = r; render(); }).catch(() => {}); } };
};
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
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
Object.assign(STR.en, { "set.g.scan": "Scan", "set.g.verification": "Verification", "set.g.calibration": "Calibration", "set.g.tunnel": "Tunnel", "set.g.browsing": "Browsing", "set.g.streaming": "Streaming", "set.g.load": "Real load", "set.g.traffic": "Traffic budget", "set.g.hard": "Hard Deep Scan", "set.g.logging": "Logging", "set.hg.primer": "Primer & budget", "set.hg.splits": "Splits", "set.hg.reputation": "Reputation" });
Object.assign(STR.fa, { "set.g.scan": "اسکن", "set.g.verification": "راستی‌آزمایی", "set.g.calibration": "کالیبراسیون", "set.g.tunnel": "تونل", "set.g.browsing": "مرور", "set.g.streaming": "استریمینگ", "set.g.load": "بار واقعی", "set.g.traffic": "بودجهٔ ترافیک", "set.g.hard": "اسکن عمیق (Hard)", "set.g.logging": "لاگ", "set.hg.primer": "پرایمر و بودجه", "set.hg.splits": "شکافت‌ها", "set.hg.reputation": "اعتبار" });
const F = (p, ty, extra) => ({ p, ty, ...extra });
const SETTINGS_SCHEMA = [
  { g: "scan", fields: [F("scan.perRange", "int"), F("scan.maxCandidates", "int"), F("scan.rounds", "int"), F("scan.screeningRounds", "int"), F("scan.concurrency", "int"), F("scan.timeoutMs", "int"), F("scan.minimumSuccessRate", "float"), F("scan.seed", "int", { pos: false }), F("scan.delayedRetry.enabled", "bool"), F("scan.delayedRetry.maxCandidates", "int")] },
  { g: "verification", fields: [F("verification.enabled", "bool"), F("verification.limit", "int"), F("verification.sprt.p0", "float"), F("verification.sprt.p1", "float"), F("verification.sprt.alpha", "float"), F("verification.sprt.beta", "float"), F("verification.sprt.minRounds", "int"), F("verification.sprt.maxRounds", "int")] },
  { g: "calibration", adv: true, fields: [F("calibration.enabled", "bool"), F("calibration.levels", "list"), F("calibration.latencyInflationLimit", "float"), F("calibration.failureRateIncreaseLimit", "float"), F("calibration.eventLoopLagLimitMs", "int")] },
  { g: "tunnel", fields: [F("tunnel.enabled", "bool"), F("tunnel.xrayPath", "text", { pos: false }), F("tunnel.limit", "int"), F("tunnel.rounds", "int"), F("tunnel.concurrency", "int"), F("tunnel.startupTimeoutMs", "int"), F("tunnel.shutdownGraceMs", "int")] },
  { g: "browsing", adv: true, fields: [F("browsing.enabled", "bool"), F("browsing.metricName", "text", { pos: false }), F("browsing.assetLimit", "int"), F("browsing.timeoutMs", "int"), F("browsing.maxSockets", "int"), F("browsing.maxBytes", "bytes"), F("browsing.estimatedMaxBytes", "bytes")] },
  { g: "streaming", adv: true, fields: [F("streaming.enabled", "bool"), F("streaming.maxSegments", "int"), F("streaming.quickSegments", "int"), F("streaming.researchSegments", "int"), F("streaming.maxBytes", "bytes"), F("streaming.estimatedMaxBytes", "bytes"), F("streaming.startupBufferSec", "float"), F("streaming.safetyFactor", "float"), F("streaming.timeoutMs", "int"), F("streaming.variantMode", "enum", { opts: ["fixed", "adaptive"] }), F("streaming.targetMbps", "float")] },
  { g: "load", fields: [F("load.enabled", "bool"), F("load.durationMs", "int"), F("load.chunkBytes", "bytes"), F("load.maxDownloadBytes", "bytes"), F("load.flows", "int"), F("load.uploadBytes", "bytes"), F("load.uploadFlows", "int"), F("load.fanoutRequests", "int"), F("load.idleSamples", "int"), F("load.timeoutMs", "int"), F("load.minBytes", "bytes"), F("load.gateProfile", "enum", { opts: ["balanced", "strict", "tolerant"] }), F("load.control.enabled", "bool"), F("load.control.bytes", "bytes"), F("load.endpoints.download", "text", { pos: false }), F("load.endpoints.upload", "text", { pos: false }), F("load.endpoints.ping", "text", { pos: false }), F("load.endpoints.control", "text", { pos: false })] },
  { g: "traffic", adv: true, fields: [F("traffic.targetBytesPerCandidate", "bytes"), F("traffic.hardWarningBytesPerCandidate", "bytes")] },
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
    <h3 class="sec-head">${esc(t("dg.source"))}</h3>
    <p class="plain-note">${esc(t("dg.sourceNote"))}</p>
    <div class="form-actions" style="margin-top:0"><button class="btn" id="dg-live">${esc(t("ui.useLive"))}</button><button class="btn" id="dg-sim">${esc(t("ui.useSim"))}</button></div>
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
  app.src.getLogs().then(async (logs) => {
    if (!logs.length) { $("#dg-logs").innerHTML = `<p class="empty">${esc(t("dg.noLogs"))}</p>`; return; }
    const sum = await app.src.getLogSummary(logs[0].name).catch(() => null);
    $("#dg-logs").innerHTML = `<table class="data"><thead><tr><th>file</th><th class="num">${t("col.size")}</th><th>${t("dg.summary")}</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${D(l.name)}</td><td class="num">${fmtBytes(l.size)}</td><td>${sum ? `${fmt(sum.total)} ${t("dg.events")} · ${fmt(sum.errors)} ${t("dg.errors")} · ${fmt(sum.warnings)} ${t("dg.warnings")}` : "–"}</td></tr>`).join("")}</tbody></table>`;
  }).catch(() => {});
  const srcBtns = () => { $("#dg-live").setAttribute("aria-pressed", String(app.src.kind === "live")); $("#dg-sim").setAttribute("aria-pressed", String(app.src.kind === "sim")); };
  srcBtns();
  $("#dg-live").addEventListener("click", async () => { if (await Live.probe()) { await window.__setSource("live"); srcBtns(); } else app.showNotice(t("conn.reconnecting")); });
  $("#dg-sim").addEventListener("click", async () => { await window.__setSource("sim"); srcBtns(); });
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
    onEvent(type, d) { if (type === "log") { lines.push(d); if (lines.length > 400) lines.splice(0, lines.length - 400); if (!paused) redrawTail(); } },
  };
};

/* ---------------- source selection & boot ---------------- */
async function setSource(src, initial) {
  if (app.src && app.src !== src) app.src.disconnect();
  app.src = src; app.lastSeq = 0;
  $("#sim-bar").hidden = src.kind !== "sim";
  try { app.catalog = await src.getCatalog(); } catch { app.catalog = null; }
  src.connect();
  await app.resync();
  app.onConn(src.kind === "sim" ? "sim" : app.conn);
  if (!initial) route();
}
window.__setSource = (kind) => setSource(kind === "sim" ? Sim : Live);
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
    await app.src.action("serverStop"); app.onConn("offline");
  }));
  $("#sim-speed").addEventListener("change", (e) => { Sim.speed = +e.target.value; });
  $("#to-live").addEventListener("click", async () => { if (await Live.probe()) setSource(Live); else app.showNotice(t("conn.reconnecting")); });
  window.addEventListener("hashchange", route);
  (async () => {
    const liveOk = await Live.probe().catch(() => false);
    await setSource(liveOk ? Live : Sim, true);
    route();
  })();
})();
