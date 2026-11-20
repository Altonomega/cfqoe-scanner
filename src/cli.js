import fs from "node:fs";
import path from "node:path";
import {
  banner,
  color,
  table,
  writeProgress,
  clearProgress,
  phaseLabel,
  hardRunSummaryLines,
  catalogLine,
} from "./ui.js";
import {
  ensureDirectories,
  readSecretFile,
  writeSecretFile,
  fileIsProtected,
} from "./platform/paths.js";
import { loadSettings, saveSettings } from "./config/settings.js";
import { parseVlessUri, describeVless } from "./config/vless.js";
import { locateXray, xrayVersion, xrayInstallHint } from "./platform/xray.js";
import { createLogger, summarizeLogFile } from "./logging/logger.js";
import { emitRunStart, emitRunEnd } from "./logging/lifecycle.js";
import { runScan } from "./scan.js";
import { runHardScan } from "./hard-scan.js";
import { runMenu, quickProfile, researchProfile } from "./menu/index.js";
import { createWebServer, platformNoticeLines } from "./web/server.js";
const HELP_TEXT = `${banner()}\n\n${color.bold("Usage")}\n  cfqoe                     open the web UI in your browser\n  cfqoe web                 same as above\n  cfqoe menu                open the terminal menu instead\n  cfqoe scan [options]      run a full scan\n  cfqoe quick [options]     run a reduced scan\n  cfqoe research [options]  run the slow repeated-evidence scan\n  cfqoe hard [options]      run the resumable hard deep scan\n  cfqoe resume [options]    resume the last hard scan\n  cfqoe import <vless-uri>  store the configuration locally\n  cfqoe check               verify Node, Xray and stored configuration\n  cfqoe results             print the latest ranking\n  cfqoe diagnose [file]     summarize a log file\n  cfqoe help                show this help\n\n${color.bold("Scan options")}\n  --max N               maximum candidate IPs (scan/quick only)\n  --rounds N            eligibility rounds\n  --tunnel-limit N      candidates measured through the real tunnel\n  --tunnel-rounds N     observations per candidate\n  --segments N          streaming segments per observation\n  --verify-limit N      finalists sent to independent verification\n  --no-verify           skip independent verification (faster, weaker evidence)\n  --no-retry            skip the delayed retry of transient failures\n  --lowest-variant      use the lowest HLS rendition (conservative fixed mode)\n  --no-tunnel           skip the VLESS tunnel stage\n  --no-browsing         skip web transfer workloads\n  --no-streaming        skip streaming workloads\n  --no-load             skip the real-load stage (multi-megabyte transfer)\n  --load-duration N     seconds of sustained download per observation\n  --load-chunk-mb N     download chunk size in megabytes\n  --load-flows N        parallel download flows used to saturate the link\n  --load-control        also measure a non-Cloudflare control download\n  --gate-profile NAME   gate thresholds: balanced (default), strict, tolerant\n  --xray-path PATH      explicit Xray executable\n  --debug               verbose structured logging\n\n${color.bold("Principle")}\n  TCP connect time is diagnostic only. Ranking uses real WebSocket eligibility with\n  Wilson confidence bounds, adaptive verification, portable web transfer and\n  sequential video segment streaming. Every result carries a confidence label.\n`;
function parseArgs(args) {
  const parsed = { flags: new Set(), values: new Map(), positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (
      [
        "max",
        "rounds",
        "tunnel-limit",
        "tunnel-rounds",
        "segments",
        "concurrency",
        "verify-limit",
        "load-duration",
        "load-chunk-mb",
        "load-flows",
      ].includes(name) ||
      "xray-path" === name ||
      "log-level" === name ||
      "gate-profile" === name
    ) {
      const value = args[index + 1];
      if (void 0 === value || value.startsWith("--"))
        throw new Error(`Missing value for --${name}`);
      (parsed.values.set(name, value), (index += 1));
    } else parsed.flags.add(name);
  }
  return parsed;
}
function applyOptions(settings, parsed) {
  const updated = JSON.parse(JSON.stringify(settings)),
    numberOption = (name) => {
      const raw = parsed.values.get(name);
      if (void 0 === raw) return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`--${name} must be a positive number`);
      return value;
    },
    max = numberOption("max");
  max && (updated.scan.maxCandidates = max);
  const rounds = numberOption("rounds");
  rounds && (updated.scan.rounds = rounds);
  const concurrency = numberOption("concurrency");
  concurrency && (updated.scan.concurrency = concurrency);
  const tunnelLimit = numberOption("tunnel-limit");
  tunnelLimit && (updated.tunnel.limit = tunnelLimit);
  const tunnelRounds = numberOption("tunnel-rounds");
  tunnelRounds && (updated.tunnel.rounds = tunnelRounds);
  const segments = numberOption("segments");
  segments && (updated.streaming.maxSegments = segments);
  const verifyLimit = numberOption("verify-limit");
  (verifyLimit && (updated.verification.limit = verifyLimit),
    parsed.flags.has("no-verify") && (updated.verification.enabled = !1),
    parsed.flags.has("no-retry") &&
      ((updated.scan.delayedRetry.enabled = !1),
      (updated.hard.delayedRetry = !1)),
    (parsed.flags.has("lowest-variant") || parsed.flags.has("abr")) &&
      (updated.streaming.variantMode = "lowest"),
    parsed.flags.has("no-tunnel") && (updated.tunnel.enabled = !1),
    parsed.flags.has("no-browsing") && (updated.browsing.enabled = !1),
    parsed.flags.has("no-streaming") && (updated.streaming.enabled = !1),
    parsed.flags.has("no-load") && (updated.load.enabled = !1));
  const loadDuration = numberOption("load-duration");
  loadDuration && (updated.load.durationMs = 1e3 * loadDuration);
  const loadChunkMb = numberOption("load-chunk-mb");
  loadChunkMb && (updated.load.chunkBytes = 1024 * loadChunkMb * 1024);
  const loadFlows = numberOption("load-flows");
  if (
    (loadFlows && (updated.load.flows = Math.min(Math.round(loadFlows), 16)),
    parsed.flags.has("load-control") &&
      (updated.load.control = { ...updated.load.control, enabled: !0 }),
    parsed.values.has("gate-profile"))
  ) {
    const gateProfile = parsed.values.get("gate-profile");
    if (!["balanced", "strict", "tolerant"].includes(gateProfile))
      throw new Error("--gate-profile must be balanced, strict or tolerant");
    updated.load.gateProfile = gateProfile;
  }
  return (
    parsed.values.has("xray-path") &&
      (updated.tunnel.xrayPath = parsed.values.get("xray-path")),
    parsed.flags.has("debug") && (updated.logging.level = "debug"),
    parsed.values.has("log-level") &&
      (updated.logging.level = parsed.values.get("log-level")),
    updated
  );
}
function printResults(results, limit = 15) {
  const rows = results
    .slice(0, limit)
    .map((result) => [
      result.ip,
      result.scores.overall ?? "-",
      result.scores.conservative ?? "-",
      result.scores.overallUncapped ?? "-",
      result.scores.conservativeUncapped ?? "-",
      result.scores.browsing ?? "-",
      result.scores.streaming ?? "-",
      `${Math.round(100 * (result.eligibility.successRate || 0))}%`,
      result.scores.reliabilityLower95 ?? "-",
      result.eligibility.confidence || "-",
      result.measurement?.qoeConfidence || "-",
      result.eligibility.pops?.dominant || "-",
      result.streaming?.quality || "-",
      result.verdict?.label || "-",
      result.load?.sustainedMbps ?? "-",
      result.load?.rpm ?? "-",
      result.load?.shapingRatio ?? "-",
      result.gates?.limiting || result.selection?.tunnelReason || "-",
      result.measurement?.bytesMeasured
        ? `${Math.round(result.measurement.bytesMeasured / 1048576)}MB`
        : "-",
    ]);
  0 !== rows.length
    ? (console.log(
        table(rows, [
          "IP",
          "Final",
          "Conserv",
          "Raw",
          "RawCons",
          "Transfer",
          "Stream",
          "Success",
          "Lower95",
          "EligConf",
          "QoEConf",
          "POP",
          "Quality",
          "Verdict",
          "Mbps",
          "RPM",
          "Shaping",
          "Why",
          "Traffic",
        ]),
      ),
      console.log(
        color.dim(
          "\nMbps is aggregate parallel goodput; RPM is an RPM-style responsiveness estimate from loaded RTT, not the full IETF convergence procedure.",
        ),
      ),
      console.log(
        color.dim(
          "Gate policy: warn caps final scores at 75 and fail caps them at 45. Raw scores remain visible.",
        ),
      ),
      console.log(
        color.dim(
          "Ranks are run-relative. EligConf is Wilson/sample evidence; QoEConf reflects tunnel evidence coverage and repeated rounds.",
        ),
      ))
    : console.log(color.yellow("No candidates were measured."));
}
async function runScanCommand(parsed, { profile }) {
  const layout = ensureDirectories();
  if (!fs.existsSync(layout.secretFile))
    throw new Error('No configuration stored. Run: cfqoe import "vless://..."');
  // Bootstrap order: the logger exists before settings load (so a
  // migration or a corrupt settings file is recorded in this run's
  // log), then it is re-leveled from the loaded settings and the CLI
  // overrides applied on top of them.
  const logger = createLogger({ level: "info", directory: layout.logs }),
    baseSettings = loadSettings(layout.settingsFile, { logger }),
    settings = applyOptions(
      "quick" === profile
        ? quickProfile(baseSettings)
        : "research" === profile
          ? researchProfile(baseSettings)
          : baseSettings,
      parsed,
    );
  logger.setLevel(settings.logging.level);
  (console.log(`${banner()}\n`),
    console.log(`Run id: ${logger.runId}   profile: ${profile}\n`));
  const startedAt = Date.now();
  emitRunStart(logger, { mode: profile });
  try {
    const result = await runScan({
      vlessUri: readSecretFile(layout.secretFile),
      settings,
      layout,
      logger,
      runId: logger.runId,
      onProgress: (progress) =>
        writeProgress(phaseLabel(progress.phase), {
          ...progress,
          elapsedMs: Date.now() - startedAt,
        }),
    });
    emitRunEnd(logger, {
      status: "completed",
      startedAt,
      totals: {
        eligible: result.eligibleCount,
        candidates: result.candidateCount,
      },
    });
    return (
      clearProgress(),
      result.xray.enabled ||
        (console.log(
          color.yellow(`Tunnel stage skipped: ${result.xray.reason}`),
        ),
        "xray_not_found" === result.xray.reason &&
          console.log(color.dim(xrayInstallHint()))),
      console.log(
        color.green(`Scan complete. Eligible IPs: ${result.eligibleCount}`),
      ),
      console.log(`Report:  ${result.jsonPath}`),
      console.log(`Ranking: ${result.topPath}\n`),
      printResults(result.report.results),
      0
    );
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
async function runHardCommand(parsed, { resume }) {
  const layout = ensureDirectories();
  if (!fs.existsSync(layout.secretFile))
    throw new Error('No configuration stored. Run: cfqoe import "vless://..."');
  // Bootstrap logger before settings load — see runScanCommand.
  const logger = createLogger({ level: "info", directory: layout.logs }),
    settings = applyOptions(
      loadSettings(layout.settingsFile, { logger }),
      parsed,
    );
  logger.setLevel(settings.logging.level);
  (console.log(`${banner()}\n`),
    console.log(
      `${resume ? "Resuming" : "Starting"} hard scan. Run id: ${logger.runId}`,
    ),
    console.log(
      color.dim("Checkpointed mode: press Q or Ctrl+C to stop safely.\n"),
    ));
  const startedAt = Date.now();
  emitRunStart(logger, { mode: "hard", resume });
  try {
    const result = await runHardScan({
      vlessUri: readSecretFile(layout.secretFile),
      settings,
      layout,
      logger,
      runId: logger.runId,
      resume,
      onStart: (info) => console.log(color.dim(catalogLine(info))),
      onProgress: (progress) =>
        writeProgress(phaseLabel(progress.phase), {
          ...progress,
          elapsedMs: Date.now() - startedAt,
        }),
    });
    emitRunEnd(logger, {
      status: result.canceled ? "canceled" : "completed",
      startedAt,
      totals: {
        eligible: result.eligibleCount,
        stoppedReason: result.stoppedReason ?? null,
      },
    });
    return (
      clearProgress(),
      console.log(
        result.canceled
          ? color.yellow("Hard scan paused safely.")
          : color.green("Hard scan completed."),
      ),
      hardRunSummaryLines(result, {
        elapsedMs: Date.now() - startedAt,
      }).forEach((line) => console.log(line)),
      result.xray &&
        !result.xray.enabled &&
        "xray_not_found" === result.xray.reason &&
        console.log(color.dim(xrayInstallHint())),
      console.log(`Report:  ${result.jsonPath}`),
      console.log(`Ranking: ${result.topPath}\n`),
      printResults(result.report.results),
      0
    );
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
// The web surface: `cfqoe web`, and — since 0.9.0 — the default for
// a bare `cfqoe` (see resolveCommand). Starts the loopback server,
// hands the one-time bootstrap link to the browser (and prints it —
// the printed link is the fallback and the only place the session
// key ever appears), then waits: the surface lives until Ctrl+C or
// the browser's own stop button ends it. If no browser can be
// opened the URL simply stays printed and the server keeps serving;
// nothing falls back into the menu silently.
async function runWebCommand() {
  const layout = ensureDirectories();
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const api = createWebServer({ layout, onStopRequest: () => finish() });
  const { url, bootstrapUrl } = await api.start({ openBrowser: true });
  console.log(`\n  ${color.bold("Web UI")} running at ${url}`);
  console.log(
    `  ${color.dim("If your browser didn't open, paste this address — it contains your session key, keep it private:")}`,
  );
  console.log(`  ${bootstrapUrl}`);
  for (const line of platformNoticeLines()) console.log(`  ${color.dim(line)}`);
  console.log(`  ${color.dim("Press Ctrl+C to stop the web UI.")}`);
  const onSigint = () => {
    void api.stop("signal").then(() => finish());
  };
  process.once("SIGINT", onSigint);
  await done;
  process.removeListener("SIGINT", onSigint);
  return 0;
}
// Which surface a command line asks for. The web UI is the primary
// surface: a bare `cfqoe` (no words at all) launches it. The
// terminal menu is explicit (`cfqoe menu`), `cfqoe web` is the same
// launch spelled out, and every other word passes through untouched
// — the scan subcommands are the scripting/field-test path. Pure, so
// the default is pinned by a unit test instead of by habit.
export function resolveCommand(argv = []) {
  return argv.length > 0 ? argv[0] : "web";
}
export async function main(argv = process.argv.slice(2)) {
  const command = resolveCommand(argv);
  const rest = argv.slice(1);
  try {
    switch (command) {
      case "menu":
        return (await runMenu(), 0);
      case "web":
        return await runWebCommand();
      case "scan":
        return await runScanCommand(parseArgs(rest), { profile: "full" });
      case "quick":
        return await runScanCommand(parseArgs(rest), { profile: "quick" });
      case "research":
        return await runScanCommand(parseArgs(rest), { profile: "research" });
      case "hard":
        return await runHardCommand(parseArgs(rest), { resume: !1 });
      case "resume":
        return await runHardCommand(parseArgs(rest), { resume: !0 });
      case "import":
        return (function (uri) {
          if (!uri) throw new Error('Usage: cfqoe import "vless://..."');
          const layout = ensureDirectories(),
            config = parseVlessUri(uri);
          return (
            writeSecretFile(layout.secretFile, uri),
            console.log(color.green("Configuration stored locally.")),
            console.log(JSON.stringify(describeVless(config), null, 2)),
            0
          );
        })(rest[0]);
      case "check":
        return await (async function () {
          const layout = ensureDirectories(),
            settings = loadSettings(layout.settingsFile),
            xray = locateXray({
              configuredPath: settings.tunnel.xrayPath,
              root: layout.root,
            }),
            rows = [
              [
                "Node.js",
                process.version,
                Number(process.versions.node.split(".")[0]) >= 20
                  ? "ok"
                  : "upgrade to 20+",
              ],
              ["Platform", `${process.platform}-${process.arch}`, "ok"],
              [
                "Config",
                fs.existsSync(layout.secretFile) ? "present" : "missing",
                fileIsProtected(layout.secretFile)
                  ? "protected"
                  : "unprotected",
              ],
              [
                "Verification",
                settings.verification.enabled ? "SPRT enabled" : "disabled",
                `limit ${settings.verification.limit}`,
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
          return (
            console.log(table(rows, ["Component", "Value", "Status"])),
            xray.found || console.log(`\n${color.dim(xrayInstallHint())}`),
            0
          );
        })();
      case "results":
        return (function () {
          const layout = ensureDirectories(),
            latestFile = path.join(layout.results, "latest.json");
          if (!fs.existsSync(latestFile))
            throw new Error("No results yet. Run: cfqoe scan");
          const report = JSON.parse(fs.readFileSync(latestFile, "utf8"));
          return (
            console.log(`Run ${report.runId} finished ${report.finishedAt}\n`),
            printResults(report.results),
            0
          );
        })();
      case "diagnose":
        return (function (file) {
          const layout = ensureDirectories();
          let target = file;
          if (!target) {
            const files = fs
              .readdirSync(layout.logs)
              .filter((name) => name.endsWith(".ndjson"))
              .map((name) => ({
                name,
                time: fs.statSync(path.join(layout.logs, name)).mtimeMs,
              }))
              .sort((left, right) => right.time - left.time);
            if (0 === files.length) throw new Error("No log files found");
            target = path.join(layout.logs, files[0].name);
          }
          const summary = summarizeLogFile(target);
          return (
            console.log(`Log: ${target}`),
            console.log(
              `Events: ${summary.total}  errors: ${summary.byLevel.error}  warnings: ${summary.byLevel.warn}\n`,
            ),
            summary.errors.length > 0
              ? console.log(
                  table(
                    summary.errors.map((entry) => [
                      entry.event,
                      entry.reason || "-",
                    ]),
                    ["Event", "Reason"],
                  ),
                )
              : console.log(color.green("No warnings or errors recorded.")),
            0
          );
        })(rest[0]);
      case "help":
      case "--help":
      case "-h":
        return (console.log(HELP_TEXT), 0);
      default:
        return (
          console.log(HELP_TEXT),
          console.log(color.yellow(`\nUnknown command: ${command}`)),
          1
        );
    }
  } catch (error) {
    return (console.error(`${color.red("Error:")} ${error.message}`), 1);
  }
}
export { parseArgs, applyOptions, saveSettings };
