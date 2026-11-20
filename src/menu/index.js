import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  banner,
  color,
  table,
  writeProgress,
  clearProgress,
  clearScreen,
  terminalWidth,
} from "../ui.js";
import {
  ensureDirectories,
  paths,
  writeSecretFile,
  readSecretFile,
  removeSecretFile,
  fileIsProtected,
  isWindows,
} from "../platform/paths.js";
import {
  loadSettings,
  saveSettings,
  loadCatalog,
  DEFAULT_SETTINGS,
} from "../config/settings.js";
import {
  parseVlessUri,
  describeVless,
  assertWebsocketCapable,
  normalizeVlessInput,
} from "../config/vless.js";
import {
  locateXray,
  xrayVersion,
  xrayInstallHint,
} from "../platform/xray.js";
import { createLogger, summarizeLogFile } from "../logging/logger.js";
import { emitRunStart, emitRunEnd } from "../logging/lifecycle.js";
import { runScan } from "../scan.js";
import { runHardScan, hasHardScanState } from "../hard-scan.js";
const MENU_TEXT = `\n  ${color.bold("1")}. Quick Scan            ${color.dim("fast screening, low confidence labels")}\n  ${color.bold("2")}. Full Scan             ${color.dim("wider sample with independent verification")}\n  ${color.bold("3")}. Research Scan         ${color.dim("slow, deeper repeated-evidence profile")}\n  ${color.bold("4")}. Hard Deep Scan        ${color.dim("block-adaptive catalog sweep, resumable")}\n  ${color.bold("5")}. Resume Hard Scan      ${color.dim("continue the last deep sweep")}\n  ${color.bold("6")}. VLESS Configuration   ${color.dim("import, inspect or remove your config")}\n  ${color.bold("7")}. Workload Settings     ${color.dim("choose or add transfer and streaming targets")}\n  ${color.bold("8")}. System Check          ${color.dim("verify Node, Xray and file protection")}\n  ${color.bold("9")}. Best IPs              ${color.dim("show the latest ranking with confidence")}\n  ${color.bold("10")}. Previous Results     ${color.dim("list saved reports")}\n  ${color.bold("11")}. Diagnostics          ${color.dim("summarize the newest log file")}\n  ${color.bold("12")}. Scan Settings        ${color.dim("edit measurement and verification numbers")}\n  ${color.bold("0")}. Exit\n`;
async function pauseBeforeMenu(rl) {
  if (stdin.isTTY)
    await rl.question(
      `\n  ${color.dim("Press Enter to return to the menu...")}`,
    );
}
export async function runMenu() {
  const layout = ensureDirectories(),
    rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: Boolean(stdin.isTTY),
      crlfDelay: Infinity,
      historySize: 0,
      removeHistoryDuplicates: true,
    });
  try {
    for (;;) {
      const settings = loadSettings(layout.settingsFile);
      clearScreen();
      console.log(`${banner()}`);
      console.log(statusLine(layout, settings));
      console.log(MENU_TEXT);
      const choice = (await rl.question("  Select an option: ")).trim();
      if ("0" === choice || "q" === choice.toLowerCase()) break;
      try {
        await dispatchChoice(choice, { rl, layout, settings });
      } catch (error) {
        clearProgress();
        console.log(`\n  ${color.red("Error:")} ${error.message}`);
      }
      await pauseBeforeMenu(rl);
    }
  } finally {
    rl.close();
  }
  console.log(`\n  ${color.dim("Goodbye.")}\n`);
}
function statusLine(layout, settings) {
  const hasConfig = fs.existsSync(layout.secretFile),
    xray = locateXray({
      configuredPath: settings.tunnel.xrayPath,
      root: layout.root,
    });
  return `  ${[
    hasConfig ? color.green("config: ready") : color.yellow("config: missing"),
    xray.found ? color.green("xray: found") : color.yellow("xray: missing"),
    settings.verification.enabled
      ? color.green("verify: sprt")
      : color.yellow("verify: off"),
    hasHardScanState(layout)
      ? color.yellow("resume: available")
      : color.dim("resume: none"),
    color.dim(`platform: ${process.platform}-${process.arch}`),
  ].join("   ")}`;
}
async function dispatchChoice(choice, ctx) {
  switch (choice) {
    case "1":
      return runScanFlow(ctx, "quick");
    case "2":
      return runScanFlow(ctx, "full");
    case "3":
      return runScanFlow(ctx, "research");
    case "4":
      return runHardScanFlow(ctx, false);
    case "5":
      return runHardScanFlow(ctx, true);
    case "6":
      return manageConfig(ctx);
    case "7":
      return manageWorkloads(ctx);
    case "8":
      return showSystemCheck(ctx);
    case "9":
      return showBestIps(ctx);
    case "10":
      return listPreviousResults(ctx);
    case "11":
      return showDiagnostics(ctx);
    case "12":
      return editSettings(ctx);
    default:
      return void console.log(`\n  ${color.yellow("Unknown option.")}`);
  }
}
async function manageWorkloads({ rl, layout, settings }) {
  const catalog = loadCatalog(layout.workloadsFile);
  console.log(`\n  ${color.bold("Built-in web transfer workloads")}`);
  catalog.browsing.forEach((workload, index) => {
    const mark = settings.browsing.workloads.includes(workload.name)
      ? color.green("[x]")
      : "[ ]";
    console.log(
      `   ${mark} ${index + 1}. ${workload.name} - ${workload.description}`,
    );
  });
  console.log(`\n  ${color.bold("Built-in streaming workloads")}`);
  catalog.streaming.forEach((workload, index) => {
    const mark = settings.streaming.workloads.includes(workload.name)
      ? color.green("[x]")
      : "[ ]";
    console.log(
      `   ${mark} ${index + 1}. ${workload.name} - ${workload.description}`,
    );
  });
  console.log(
    "\n  1) Toggle transfer   2) Toggle streaming   3) Add custom page   4) Add custom stream   0) Back",
  );
  const choice = (await rl.question("  Choose: ")).trim().toLowerCase(),
    updated = { ...settings };
  if ("1" === choice || "2" === choice) {
    const kind = "1" === choice ? "browsing" : "streaming",
      name = (await rl.question("  Workload name to toggle: ")).trim();
    if (!catalog[kind].some((workload) => workload.name === name))
      throw new Error(`Unknown workload: ${name}`);
    const selected = new Set(updated[kind].workloads);
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    updated[kind] = { ...updated[kind], workloads: Array.from(selected) };
  } else if ("3" === choice) {
    const name = (await rl.question("  Name: ")).trim(),
      pageUrl = (await rl.question("  Page URL: ")).trim();
    new URL(pageUrl);
    updated.customWorkloads = {
      ...updated.customWorkloads,
      browsing: [...updated.customWorkloads.browsing, { name, pageUrl }],
    };
  } else {
    if ("4" !== choice) return;
    const name = (await rl.question("  Name: ")).trim(),
      manifestUrl = (await rl.question("  HLS manifest URL (.m3u8): ")).trim();
    new URL(manifestUrl);
    updated.customWorkloads = {
      ...updated.customWorkloads,
      streaming: [
        ...updated.customWorkloads.streaming,
        { name, manifestUrl, segmentDurationSec: 6 },
      ],
    };
  }
  saveSettings(layout.settingsFile, updated);
  console.log(`  ${color.green("Settings saved.")}`);
}
async function showSystemCheck({ layout, settings }) {
  const xray = locateXray({
      configuredPath: settings.tunnel.xrayPath,
      root: layout.root,
    }),
    platformLabel =
      "android" === process.platform
        ? "Termux/Android"
        : isWindows
          ? "windows native"
          : "posix",
    rows = [
      [
        "Node.js",
        process.version,
        Number(process.versions.node.split(".")[0]) >= 20
          ? "ok"
          : "upgrade to 20+",
      ],
      ["Platform", `${process.platform}-${process.arch}`, platformLabel],
      [
        "Config file",
        fs.existsSync(layout.secretFile) ? "present" : "missing",
        fileIsProtected(layout.secretFile) ? "protected" : "unprotected",
      ],
      [
        "Results dir",
        layout.results,
        fs.existsSync(layout.results) ? "ok" : "missing",
      ],
      [
        "Verification",
        settings.verification.enabled ? "SPRT enabled" : "disabled",
        `p0 ${settings.verification.sprt.p0} / p1 ${settings.verification.sprt.p1}`,
      ],
      [
        "Delayed retry",
        settings.hard.delayedRetry ? "enabled" : "disabled",
        `limit ${settings.hard.retryLimit}`,
      ],
      [
        "Hard resume",
        hasHardScanState(layout) ? "available" : "none",
        layout.hardStateFile,
      ],
    ];
  if (xray.found) {
    const version = await xrayVersion(xray.path);
    rows.push([
      "Xray",
      xray.path,
      version.ok ? version.version : "not runnable",
    ]);
  } else rows.push(["Xray", "not found", "tunnel stage disabled"]);
  console.log(`\n${table(rows, ["Component", "Value", "Status"])}`);
  if (!xray.found) console.log(`\n  ${color.dim(xrayInstallHint())}`);
}
async function showBestIps({ layout }) {
  const latestPath = path.join(layout.results, "latest.json");
  if (!fs.existsSync(latestPath))
    throw new Error("No results yet. Run a scan first.");
  const report = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  console.log(`\n  Run ${report.runId} from ${report.finishedAt}`);
  printRankings(report.results, 15);
  console.log(
    `  ${color.dim("Plain list saved at")} ${path.join(layout.results, "best-ips.txt")}`,
  );
}
async function listPreviousResults({ layout }) {
  const names = fs
    .readdirSync(layout.results, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("run-") &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, 15);
  if (0 === names.length)
    return void console.log(`\n  ${color.yellow("No saved reports yet.")}`);
  const rows = names.map((name) => {
    const stat = fs.statSync(path.join(layout.results, name));
    return [
      name,
      `${(stat.size / 1024).toFixed(1)} KB`,
      stat.mtime.toISOString(),
    ];
  });
  console.log(`\n  ${color.bold(`Previous Results (${names.length})`)}`);
  if (terminalWidth() < 75)
    rows.forEach((row, index) =>
      console.log(`\n  ${index + 1}. ${row[0]}\n     ${row[1]} | ${row[2]}`),
    );
  else console.log(`\n${table(rows, ["Report", "Size", "Modified"])}`);
}
async function showDiagnostics({ layout }) {
  const entries = fs
    .readdirSync(layout.logs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
    .map((entry) => ({
      name: entry.name,
      time: fs.statSync(path.join(layout.logs, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);
  if (0 === entries.length)
    return void console.log(`\n  ${color.yellow("No log files yet.")}`);
  const summary = summarizeLogFile(path.join(layout.logs, entries[0].name));
  console.log(`\n  ${color.bold("Diagnostics")}`);
  console.log(`  Log: ${entries[0].name}`);
  console.log(
    `  Events: ${summary.total}  errors: ${summary.byLevel.error}  warnings: ${summary.byLevel.warn}`,
  );
  if (summary.errors.length > 0) {
    if (terminalWidth() < 75)
      summary.errors.forEach((error, index) =>
        console.log(`  ${index + 1}. ${error.event}: ${error.reason || "-"}`),
      );
    else
      console.log(
        `\n${table(
          summary.errors.map((error) => [error.event, error.reason || "-"]),
          ["Event", "Reason"],
        )}`,
      );
  } else console.log(`  ${color.green("No warnings or errors recorded.")}`);
}
async function editSettings({ rl, layout, settings }) {
  const fields = [
    {
      label: "Max candidates (full scan)",
      group: "scan",
      field: "maxCandidates",
    },
    { label: "Eligibility rounds", group: "scan", field: "rounds" },
    {
      label: "Eligibility concurrency",
      group: "scan",
      field: "concurrency",
    },
    {
      label: "Successful threshold",
      group: "scan",
      field: "minimumSuccessRate",
    },
    {
      label: "Verification finalists",
      group: "verification",
      field: "limit",
    },
    { label: "Tunnel finalists", group: "tunnel", field: "limit" },
    { label: "Tunnel rounds", group: "tunnel", field: "rounds" },
    {
      label: "Streaming segments",
      group: "streaming",
      field: "maxSegments",
    },
    {
      label: "Streaming research segments",
      group: "streaming",
      field: "researchSegments",
    },
    {
      label: "Streaming variant mode",
      group: "streaming",
      field: "variantMode",
      values: ["fixed", "lowest"],
    },
    {
      label: "Transfer asset limit",
      group: "browsing",
      field: "assetLimit",
    },
    {
      label: "Real-load stage enabled",
      group: "load",
      field: "enabled",
      values: ["true", "false"],
      boolean: true,
    },
    {
      label: "Real-load duration (ms)",
      group: "load",
      field: "durationMs",
    },
    {
      label: "Real-load chunk size (bytes)",
      group: "load",
      field: "chunkBytes",
    },
    {
      label: "Real-load upload size (bytes)",
      group: "load",
      field: "uploadBytes",
    },
    {
      label: "Real-load parallel requests",
      group: "load",
      field: "fanoutRequests",
    },
    {
      label: "Real-load parallel download flows",
      group: "load",
      field: "flows",
    },
    {
      label: "Real-load parallel upload flows",
      group: "load",
      field: "uploadFlows",
    },
    {
      label: "Real-load minimum bytes",
      group: "load",
      field: "minBytes",
    },
    { label: "Hard concurrent IPs", group: "hard", field: "concurrency" },
    {
      label: "Hard screening rounds",
      group: "hard",
      field: "screeningRounds",
    },
    {
      label: "Hard finalist verification count",
      group: "hard",
      field: "recheckTop",
    },
    { label: "Hard retry limit", group: "hard", field: "retryLimit" },
    { label: "Hard-save every N IPs", group: "hard", field: "saveEvery" },
    { label: "Hard live top count", group: "hard", field: "liveTop" },
    { label: "Hard final top count", group: "hard", field: "finalTop" },
    {
      label: "Log level",
      group: "logging",
      field: "level",
      values: ["debug", "info", "warn", "error"],
    },
  ];
  for (;;) {
    const rows = fields.map((field, index) => [
      String(index + 1),
      field.label,
      String(settings[field.group][field.field]),
    ]);
    console.log(`\n${table(rows, ["#", "Setting", "Value"])}`);
    console.log("\n  0) Back   d) Restore defaults");
    const choice = (await rl.question("  Choose a setting: "))
      .trim()
      .toLowerCase();
    if ("0" === choice || 0 === choice.length) return;
    if ("d" === choice) {
      saveSettings(layout.settingsFile, DEFAULT_SETTINGS);
      Object.assign(settings, loadSettings(layout.settingsFile));
      console.log(`  ${color.green("Defaults restored.")}`);
      continue;
    }
    const field = fields[Number(choice) - 1];
    if (!field) {
      console.log(`  ${color.yellow("Unknown selection.")}`);
      continue;
    }
    const current = settings[field.group][field.field],
      prompt = field.values
        ? `  New value (${field.values.join("/")}), current ${current}: `
        : `  New value, current ${current}: `,
      input = (await rl.question(prompt)).trim();
    if (0 === input.length) continue;
    const updated = {
      ...settings,
      [field.group]: { ...settings[field.group] },
    };
    if (field.values) {
      if (!field.values.includes(input))
        throw new Error(`Allowed values: ${field.values.join(", ")}`);
      updated[field.group][field.field] = field.boolean
        ? "true" === input
        : input;
    } else {
      const parsed = Number(input);
      if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error("Value must be a positive number");
      updated[field.group][field.field] = parsed;
    }
    saveSettings(layout.settingsFile, updated);
    Object.assign(settings, updated);
    console.log(`  ${color.green("Saved.")}`);
  }
}
export function quickProfile(base) {
  return {
    ...base,
    scan: {
      ...base.scan,
      perRange: 2,
      maxCandidates: 16,
      rounds: 2,
      concurrency: Math.min(10, base.scan.concurrency),
    },
    verification: {
      ...base.verification,
      limit: Math.min(6, base.verification.limit),
    },
    tunnel: { ...base.tunnel, limit: 3, rounds: 1 },
    streaming: {
      ...base.streaming,
      maxSegments: base.streaming.quickSegments ?? 3,
    },
    browsing: { ...base.browsing, assetLimit: 4 },
  };
}
export function researchProfile(base) {
  return {
    ...base,
    scan: {
      ...base.scan,
      perRange: 4,
      maxCandidates: Math.max(240, base.scan.maxCandidates),
      rounds: Math.max(6, base.scan.rounds),
    },
    verification: {
      ...base.verification,
      enabled: true,
      limit: Math.max(24, base.verification.limit),
      sprt: { ...base.verification.sprt, minRounds: 4, maxRounds: 24 },
    },
    tunnel: {
      ...base.tunnel,
      limit: Math.max(8, base.tunnel.limit),
      rounds: Math.max(3, base.tunnel.rounds),
    },
    streaming: {
      ...base.streaming,
      maxSegments: base.streaming.researchSegments ?? 29,
    },
    browsing: {
      ...base.browsing,
      assetLimit: Math.max(8, base.browsing.assetLimit),
    },
    load: {
      ...base.load,
      durationMs: Math.max(12e3, base.load?.durationMs || 0),
      maxDownloadBytes: Math.max(25165824, base.load?.maxDownloadBytes || 0),
      flows: Math.max(6, base.load?.flows || 0),
      uploadBytes: Math.max(2097152, base.load?.uploadBytes || 0),
      uploadFlows: Math.max(2, base.load?.uploadFlows || 0),
      fanoutRequests: Math.max(6, base.load?.fanoutRequests || 0),
      idleSamples: Math.max(4, base.load?.idleSamples || 0),
      timeoutMs: Math.max(12e3, base.load?.timeoutMs || 0),
      minBytes: Math.max(12582912, base.load?.minBytes || 0),
    },
  };
}
async function runScanFlow({ layout }, mode) {
  if (!fs.existsSync(layout.secretFile))
    return void console.log(
      `\n  ${color.yellow("Import your VLESS configuration first (option 6).")}`,
    );
  // Bootstrap order: the logger exists before settings load (so a
  // migration or a corrupt settings file is recorded in this run's
  // log), then it is re-leveled from the loaded settings.
  const logger = createLogger({ level: "info", directory: layout.logs }),
    settings = loadSettings(layout.settingsFile, { logger });
  logger.setLevel(settings.logging.level);
  const profile =
      "quick" === mode
        ? quickProfile(settings)
        : "research" === mode
          ? researchProfile(settings)
          : settings,
    vlessUri = readSecretFile(layout.secretFile),
    title =
      "quick" === mode
        ? "Quick scan"
        : "research" === mode
          ? "Research scan"
          : "Full scan";
  console.log(`\n  ${color.bold(title)} started. Run id: ${logger.runId}\n`);
  const startedAt = Date.now();
  emitRunStart(logger, { mode });
  try {
    const result = await runScan({
      vlessUri,
      settings: profile,
      layout,
      logger,
      runId: logger.runId,
      onProgress: (event) => writeProgress(event.phase, event),
    });
    emitRunEnd(logger, {
      status: "completed",
      startedAt,
      totals: {
        eligible: result.eligibleCount,
        candidates: result.candidateCount,
      },
    });
    clearProgress();
    if (!result.xray.enabled) {
      console.log(
        `  ${color.yellow("Tunnel stage skipped:")} ${result.xray.reason}`,
      );
      if ("xray_not_found" === result.xray.reason)
        console.log(`  ${color.dim(xrayInstallHint())}`);
    }
    console.log(
      `  ${color.green("Scan complete.")} Eligible IPs: ${result.eligibleCount}`,
    );
    console.log(
      `  QoE evidence: ${result.report.totals.complete} complete, ${result.report.totals.partial || 0} partial, ${result.report.totals.unmeasured || 0} eligibility-only`,
    );
    console.log(
      `  Random sample: ${result.candidateCount} IPs across a ${result.rangeCount}-range catalog`,
    );
    console.log(`  Sampling seed: ${result.samplingSeed}`);
    console.log(`  Report: ${result.jsonPath}`);
    printRankings(result.report.results);
  } catch (error) {
    emitRunEnd(logger, {
      status: "failed",
      startedAt,
      error: { class: "internal", message: error.message },
    });
    throw error;
  } finally {
    await logger.close();
  }
}
async function runHardScanFlow({ rl, layout }, resume) {
  if (!fs.existsSync(layout.secretFile))
    return void console.log(
      `\n  ${color.yellow("Import your VLESS configuration first (option 6).")}`,
    );
  if (resume && !hasHardScanState(layout))
    return void console.log(
      `\n  ${color.yellow("No paused hard scan was found.")}`,
    );
  // Bootstrap logger before settings load — see runScanFlow.
  const logger = createLogger({ level: "info", directory: layout.logs }),
    settings = loadSettings(layout.settingsFile, { logger });
  logger.setLevel(settings.logging.level);
  const vlessUri = readSecretFile(layout.secretFile);
  rl.pause();
  console.log(
    `\n  ${color.bold(resume ? "Resuming hard scan" : "Hard deep scan")} started. Run id: ${logger.runId}`,
  );
  console.log(
    `  ${color.dim(`Parallel sweep: ${settings.hard.concurrency} IPs at once, ${settings.hard.screeningRounds} fast screening round(s).`)}`,
  );
  console.log(
    `  ${color.dim("Transient failures are retried later; finalists are verified adaptively. Press Q or Ctrl+C to stop safely.")}\n`,
  );
  const startedAt = Date.now();
  emitRunStart(logger, { mode: "hard", resume });
  try {
    const result = await runHardScan({
      vlessUri,
      settings,
      layout,
      logger,
      runId: logger.runId,
      resume,
      onProgress: (event) => writeProgress(event.phase, event),
    });
    emitRunEnd(logger, {
      status: result.canceled ? "canceled" : "completed",
      startedAt,
      totals: {
        eligible: result.eligibleCount,
        stoppedReason: result.stoppedReason ?? null,
      },
    });
    clearProgress();
    console.log(
      result.canceled
        ? `  ${color.yellow("Hard scan paused safely.")}`
        : `  ${color.green("Hard scan completed.")}`,
    );
    console.log(`  Eligible IPs so far: ${result.eligibleCount}`);
    console.log(
      `  QoE evidence: ${result.report.totals.complete || 0} complete, ${result.report.totals.partial || 0} partial`,
    );
    console.log(`  Report: ${result.jsonPath}`);
    printRankings(result.report.results);
  } catch (error) {
    emitRunEnd(logger, {
      status: "failed",
      startedAt,
      error: { class: "internal", message: error.message },
    });
    throw error;
  } finally {
    await logger.close();
    rl.resume();
  }
}
function formatNumber(value, suffix = "") {
  return Number.isFinite(value) ? `${value}${suffix}` : "-";
}
function formatPercent(value) {
  return Number.isFinite(value) ? Math.round(1e3 * value) / 10 + "%" : "-";
}
function tunnelSkipReason(candidate) {
  const reason = candidate.selection?.tunnelReason,
    reasons = {
      "outside-tunnel-limit": "Not tunnel-tested (outside tunnel.limit)",
      "not-eligible": "Not tunnel-tested (eligibility threshold not met)",
      "xray-not-found": "Not tunnel-tested (Xray not found)",
      "tunnel-disabled": "Not tunnel-tested (tunnel stage disabled)",
      "eligibility-only": "Eligibility-only; tunnel QoE not measured",
    };
  return (
    reasons[reason] ||
    ("unmeasured" === candidate.measurement?.status
      ? reasons["eligibility-only"]
      : null)
  );
}
function gateCheckLine(check) {
  const valueText =
    null === check.value
      ? "not measured"
      : `${check.value}${"ratio" === check.unit || "x" === check.unit ? "" : ` ${check.unit}`}`;
  if ("unknown" === check.status)
    return `UNKNOWN ${check.label}: ${valueText}`;
  const comparator = "higher" === check.direction ? "<" : ">",
    threshold = "fail" === check.status ? check.fail : check.warn;
  return `${check.status.toUpperCase()} ${check.label}: ${valueText} (${comparator}${threshold})`;
}
export function candidateDetailLines(candidate, rank = 1) {
  const traffic = candidate.measurement?.bytesMeasured
      ? `${Math.round(candidate.measurement.bytesMeasured / 1048576)} MB`
      : "-",
    why =
      tunnelSkipReason(candidate) ||
      candidate.limitingFactor ||
      candidate.gates?.limiting ||
      candidate.measurement?.missingComponents?.join(", ") ||
      "none",
    attempts = candidate.eligibility?.attempts ?? 0,
    successes = candidate.eligibility?.successes ?? 0,
    issues =
      candidate.gateIssues ||
      (candidate.gates?.checks || []).filter(
        (check) => "pass" !== check.status,
      ),
    lines = [
      `${rank}. ${candidate.ip} | Final ${formatNumber(candidate.scores?.overall)} / ${formatNumber(candidate.scores?.conservative)} conservative | ${candidate.verdict?.label || candidate.measurement?.status || "-"}`,
      `   Raw (before gate cap): ${formatNumber(candidate.scores?.overallUncapped)} / ${formatNumber(candidate.scores?.conservativeUncapped)} conservative`,
      `   Scores: Transfer ${formatNumber(candidate.scores?.browsing)} | Streaming ${formatNumber(candidate.scores?.streaming)} | Load ${formatNumber(candidate.scores?.load)} | Reliability ${formatNumber(candidate.scores?.reliability)}`,
      `   Evidence: Eligibility ${successes}/${attempts} (${formatPercent(candidate.eligibility?.successRate)}) | Lower95 ${formatNumber(candidate.scores?.reliabilityLower95, "%")} | EligConf ${candidate.eligibility?.confidence || "-"} | QoEConf ${candidate.measurement?.qoeConfidence || "-"} | Gate coverage ${formatPercent(candidate.measurement?.gateCoverage)}`,
      `   Load: Down ${formatNumber(candidate.load?.sustainedMbps, " Mbps")} | Up ${formatNumber(candidate.load?.uplinkMbps, " Mbps")} | RPM ${formatNumber(candidate.load?.rpm)} | Added RTT ${formatNumber(candidate.load?.rttIncreaseMs, " ms")}`,
      `   Stability: Shaping ${formatNumber(candidate.load?.shapingRatio)} | Jitter ${formatNumber(candidate.load?.jitterMs, " ms")} | Loss ${Number.isFinite(candidate.load?.lossRate) ? Math.round(1e4 * candidate.load.lossRate) / 100 + "%" : "-"} | Loaded samples ${candidate.load?.latencySamples?.loaded ?? "-"}`,
      `   Stream: ${candidate.streaming?.quality || "-"} | ${formatNumber(candidate.streaming?.sustainableMbps, " Mbps")} | POP ${candidate.eligibility?.pops?.dominant || "-"} | Traffic ${traffic}`,
      `   Gate: ${candidate.gates?.status || "-"}${candidate.gates?.scoreCap ? ` | Cap ${candidate.gates.scoreCap}` : ""} | Why: ${why}`,
    ];
  if (issues.length)
    lines.push(`   Gate evidence: ${issues.map(gateCheckLine).join(" | ")}`);
  return lines;
}
function printRankings(candidates, limit = 10) {
  const rows = candidates.slice(0, limit);
  const wide = terminalWidth() >= 132;
  const lines = rows.map((c) => {
    const base = [
      c.ip,
      c.scores.overall ?? "-",
      c.scores.conservative ?? "-",
      c.scores.overallUncapped ?? "-",
      c.scores.conservativeUncapped ?? "-",
      `${c.eligibility.successes ?? 0}/${c.eligibility.attempts ?? 0}`,
      c.eligibility.confidence || "-",
      c.measurement?.qoeConfidence || "-",
      c.verdict?.label || c.measurement?.status || "-",
    ];
    if (!wide) return base;
    return [
      ...base,
      c.scores.browsing ?? "-",
      c.scores.streaming ?? "-",
      c.load?.sustainedMbps ?? "-",
      c.load?.rpm ?? "-",
      c.eligibility.pops?.dominant || "-",
      c.streaming?.quality || "-",
      tunnelSkipReason(c) ||
        c.limitingFactor ||
        c.gates?.limiting ||
        c.measurement?.missingComponents?.join(",") ||
        "-",
      c.measurement?.bytesMeasured
        ? `${Math.round(c.measurement.bytesMeasured / 1048576)}MB`
        : "-",
    ];
  });
  if (0 === lines.length)
    return void console.log(
      `\n  ${color.yellow("No candidates were measured.")}`,
    );
  const columns = wide
    ? [
        "IP",
        "Final",
        "Conserv",
        "Raw",
        "RawCons",
        "Success",
        "EligConf",
        "QoEConf",
        "Verdict",
        "Transfer",
        "Stream",
        "Mbps",
        "RPM",
        "POP",
        "Quality",
        "Why",
        "Traffic",
      ]
    : [
        "IP",
        "Final",
        "Conserv",
        "Raw",
        "RawCons",
        "Success",
        "EligConf",
        "QoEConf",
        "Verdict",
      ];
  console.log(`\n${table(lines, columns)}\n`);
  const measured = candidates.filter(
    (c) =>
      "complete" === c.measurement?.status ||
      "partial" === c.measurement?.status,
  ).length;
  const eligibilityOnly = candidates.filter(
    (c) => "unmeasured" === c.measurement?.status,
  ).length;
  console.log(
    `  ${color.dim(`${measured} candidates have tunnel QoE evidence; ${eligibilityOnly} are eligibility-only. Full Scan measures only the top tunnel finalists (tunnel.limit).`)}`,
  );
  console.log(
    `  ${color.dim("Gate policy: warn caps the final score at 75; fail caps it at 45. Raw scores remain visible for transparent within-verdict ranking.")}\n`,
  );
}
export async function manageConfig({ rl, layout, print = console.log }) {
  const hasConfig = fs.existsSync(layout.secretFile);
  print(
    `\n  Current state: ${hasConfig ? color.green("configuration stored") : color.yellow("no configuration")}`,
  );
  print("  1) Import or replace   2) Inspect   3) Remove   0) Back");
  const choice = (await rl.question("  Choose: ")).trim().toLowerCase();
  if ("1" === choice)
    for (;;) {
      const raw = await rl.question(
          "  Paste your vless:// link (0 to cancel): ",
        ),
        normalized = normalizeVlessInput(raw);
      if ("0" === normalized || "" === normalized) {
        print(
          `  ${color.yellow("Import cancelled.")} Existing configuration was not changed.`,
        );
        return { status: "cancelled" };
      }
      try {
        const parsed = parseVlessUri(normalized);
        assertWebsocketCapable(parsed);
        writeSecretFile(layout.secretFile, normalized);
        const stored = parseVlessUri(readSecretFile(layout.secretFile));
        assertWebsocketCapable(stored);
        print(
          `  ${color.green("Saved and verified.")} The link is stored locally and never printed again.`,
        );
        print(`  ${JSON.stringify(describeVless(stored))}`);
        return { status: "saved", config: describeVless(stored) };
      } catch (error) {
        print(`  ${color.red("Invalid configuration:")} ${error.message}`);
        print(
          `  ${color.dim("Paste a one-line VLESS WebSocket link, or enter 0 to cancel.")}`,
        );
      }
    }
  else {
    if ("2" === choice) {
      if (!hasConfig) throw new Error("No configuration is stored");
      const parsed = parseVlessUri(readSecretFile(layout.secretFile));
      print(`  ${JSON.stringify(describeVless(parsed), null, 2)}`);
      print(
        `  File protected: ${fileIsProtected(layout.secretFile) ? color.green("yes") : color.yellow("check permissions")}`,
      );
      return { status: "inspected" };
    }
    if ("3" === choice) {
      removeSecretFile(layout.secretFile);
      print(`  ${color.green("Configuration removed.")}`);
      return { status: "removed" };
    }
  }
  return { status: "back" };
}
export { paths };
