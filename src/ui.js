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
export function writeProgress(label, state) {
  if (!process.stdout.isTTY) return;
  const termWidth = terminalWidth(),
    barWidth = termWidth < 55 ? 8 : termWidth < 85 ? 16 : 28,
    mainText = `  ${termWidth < 55 ? label.slice(0, 10) : label.padEnd(14)} ${progressBar({ ...state, width: barWidth })} ${state.completed}/${state.total}`,
    extras = [];
  var line;
  (Number.isFinite(state.eligible) && extras.push(`ok:${state.eligible}`),
    Number.isFinite(state.failed) && extras.push(`fail:${state.failed}`),
    termWidth >= 90 &&
      state.currentRange &&
      extras.push(`range:${state.currentRange}`),
    termWidth >= 120 && state.note && extras.push(state.note),
    (line = `${mainText}${extras.length ? `  ${extras.join("  ")}` : ""}`),
    process.stdout.isTTY &&
      (readline.cursorTo(process.stdout, 0),
      readline.clearLine(process.stdout, 0),
      process.stdout.write(line.slice(0, Math.max(20, terminalWidth() - 1)))));
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
