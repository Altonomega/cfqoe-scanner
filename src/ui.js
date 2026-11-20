import readline from "node:readline";
import { VERSION } from "./version.js";
const colorEnabled =
  void 0 === process.env.NO_COLOR && !1 !== process.stdout.isTTY;
function wrapAnsi(code, text) {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : String(text);
}
export const color = {
  bold: (text) => wrapAnsi("1", text),
  dim: (text) => wrapAnsi("2", text),
  red: (text) => wrapAnsi("31", text),
  green: (text) => wrapAnsi("32", text),
  yellow: (text) => wrapAnsi("33", text),
  blue: (text) => wrapAnsi("36", text),
  gray: (text) => wrapAnsi("90", text),
};
export function banner() {
  return [
    color.blue("+--------------------------------------------+"),
    `${color.blue("|")}      ${color.bold("CFQoE Cloudflare IP Scanner")}  v${VERSION}${" ".repeat(Math.max(1, 8 - VERSION.length))}${color.blue("|")}`,
    `${color.blue("|")}  ${color.dim("Cost-aware measurement, capped traffic")}  ${color.blue("|")}`,
    color.blue("+--------------------------------------------+"),
  ].join("\n");
}
export function progressBar({ completed, total, width = 28 }) {
  const ratio = 0 === total ? 0 : Math.min(1, completed / total),
    filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.round(100 * ratio)}%`;
}
export function terminalWidth() {
  const columns = Number(process.stdout.columns);
  return Number.isFinite(columns) && columns > 20 ? columns : 120;
}
export function clearScreen() {
  process.stdout.isTTY &&
    (readline.cursorTo(process.stdout, 0, 0),
    readline.clearScreenDown(process.stdout));
}
// Plain-language phase labels (plan ch. 2.2): the internal phase
// strings are checkpoint vocabulary, not something to make a user
// decode mid-run. Every render site maps through phaseLabel; unknown
// phases fall back to the raw string so a new phase degrades to
// today's behavior instead of breaking the renderer.
export const PHASE_LABELS = {
  calibrating: "Calibrating",
  screening: "Screening",
  "delayed-retry": "Delayed retry",
  verification: "Verifying",
  tunnel: "Tunnel QoE",
  "hard-primer": "Primer (blocks)",
  "hard-coverage": "Split coverage",
  "hard-split-coverage": "Split coverage",
  "hard-expansion": "Expansion",
  "hard-scan": "Screening",
  "hard-retry": "Delayed retry",
  "hard-verify": "Verifying finalists",
  "hard-finalize": "Final QoE",
};

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? phase;
}

// mm:ss under an hour, h:mm:ss above — a Hard run is measured in
// hours and a bare seconds count stops meaning anything.
export function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000)),
    seconds = totalSeconds % 60,
    minutes = Math.floor(totalSeconds / 60) % 60,
    hours = Math.floor(totalSeconds / 3600),
    mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes),
    ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

// The engine's stop-reason vocabulary, in words a summary can print.
export function stoppedReasonText(reason) {
  return (
    {
      budget: "probe budget exhausted",
      "marginal-gain": "marginal gain too low",
      exhausted: "catalog exhausted",
      canceled: "stopped by user",
      "dead-path": "dead path valve",
      "hard-error": "hard error valve",
      completed: "completed",
    }[reason] ?? reason
  );
}

export function writeProgress(label, state) {
  if (!process.stdout.isTTY) return;
  const termWidth = terminalWidth(),
    barWidth = termWidth < 55 ? 8 : termWidth < 85 ? 16 : 28,
    mainText = `  ${termWidth < 55 ? label.slice(0, 10) : label.padEnd(14)} ${progressBar({ ...state, width: barWidth })} ${state.completed}/${state.total}`,
    extras = [];
  var line;
  (Number.isFinite(state.eligible) && extras.push(`ok:${state.eligible}`),
    Number.isFinite(state.failed) && extras.push(`fail:${state.failed}`),
    // Hit rate next to the counters: on a dark path "3/4,000" only
    // becomes information as a percentage.
    Number.isFinite(state.eligible) &&
      Number.isFinite(state.failed) &&
      state.eligible + state.failed > 0 &&
      extras.push(
        `hit:${Math.round((100 * state.eligible) / (state.eligible + state.failed))}%`,
      ),
    Number.isFinite(state.elapsedMs) &&
      extras.push(formatDurationMs(state.elapsedMs)),
    termWidth >= 90 &&
      state.currentRange &&
      extras.push(`range:${state.currentRange}`),
    // The note (sub-stage, stop hint, tier counts) is the most
    // informative extra; it used to require a 120-column terminal.
    termWidth >= 90 && state.note && extras.push(state.note),
    (line = `${mainText}${extras.length ? `  ${extras.join("  ")}` : ""}`),
    process.stdout.isTTY &&
      (readline.cursorTo(process.stdout, 0),
      readline.clearLine(process.stdout, 0),
      process.stdout.write(line.slice(0, Math.max(20, terminalWidth() - 1)))));
}
// The end-of-run Hard summary, shared by the menu and the CLI so the
// two surfaces can never drift apart. Everything reads from the
// report totals and the run's return value — the numbers the report
// itself carries — and block lines appear only on block-adaptive
// runs, whose totals carry them.
export function hardRunSummaryLines(result, { elapsedMs } = {}) {
  const totals = result.report?.totals ?? {},
    lines = [
      `Eligible IPs so far: ${result.eligibleCount}`,
      `QoE evidence: ${totals.complete || 0} complete, ${totals.partial || 0} partial`,
    ];
  if (Number.isFinite(totals.probesSpent))
    lines.push(
      `Probes: ${totals.probesSpent} spent (primer ${totals.primerProbes || 0} · expansion ${totals.expansionProbes || 0} · split coverage ${totals.reserveProbes || 0})`,
    );
  if (Number.isFinite(totals.blocksTotal)) {
    const tiers = totals.blocksByTier ?? {};
    lines.push(
      `Blocks: ${totals.blocksTotal} total · ${totals.blocksPrimed || 0} primed · ${totals.blocksExpanded || 0} expanded · ${totals.blocksExhausted || 0} exhausted · ${totals.blocksSplit || 0} split (tiers: skip ${tiers.skip || 0} · confirm ${tiers.confirm || 0} · full ${tiers.full || 0})`,
    );
  }
  lines.push(
    `Stopped: ${stoppedReasonText(result.stoppedReason ?? (result.canceled ? "canceled" : "completed"))}`,
  );
  if (Number.isFinite(elapsedMs))
    lines.push(`Elapsed: ${formatDurationMs(elapsedMs)}`);
  if (result.reputationSaved != null)
    lines.push(
      result.reputationSaved
        ? `Block reputation: saved (${result.reputationBlocks} blocks)`
        : "Block reputation: not saved (saved only when a run completes)",
    );
  if (result.xray && !result.xray.enabled)
    lines.push(`Tunnel stage skipped: ${result.xray.reason}`);
  return lines;
}

export function clearProgress() {
  process.stdout.isTTY &&
    (readline.cursorTo(process.stdout, 0),
    readline.clearLine(process.stdout, 0));
}
export function table(rows, headers) {
  const allRows = [headers, ...rows].map((row) =>
      row.map((cell) => String(cell ?? "-")),
    ),
    widths = headers.map((header, index) =>
      Math.max(...allRows.map((row) => row[index].length)),
    ),
    formatRow = (row, format = (cell) => cell) =>
      format(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
  return [
    formatRow(allRows[0], color.bold),
    color.gray(widths.map((width) => "-".repeat(width)).join("  ")),
    ...allRows.slice(1).map((row) => formatRow(row)),
  ].join("\n");
}
