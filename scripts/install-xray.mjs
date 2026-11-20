#!/usr/bin/env node
// Installs the official Xray binary for the tunnel / streaming / load
// stages: resolves the platform asset from the latest XTLS/Xray-core
// release, downloads it (several methods, in order, until one produces
// a plausible archive), verifies the release's published SHA-256
// before anything is extracted, and smoke-tests the installed binary.
// An existing binary that still runs is kept; one that does not is
// replaced. Every failure path ends in the manual-fallback message —
// this script is the "just make it work" door for users who should
// never have to know what a release asset is.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { xrayAssetName } from "../src/platform/xray-release.js";

const execFileAsync = promisify(execFile);

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");
const isWindows = process.platform === "win32";
const isAndroid = process.platform === "android";
const binaryName = isWindows ? "xray.exe" : "xray";
const xrayDir = path.join(projectRoot, "xray");
const xrayPath = path.join(xrayDir, binaryName);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The one-line reason an error carries, preferring the deepest cause
// code (a spawn failure's ENOENT says more than its wrapper message).
function errorText(error) {
  return error?.cause?.code || error?.code || error?.message || String(error);
}

// Escapes a value for a single-quoted PowerShell string literal.
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

// Runs a command to completion; quiet discards its output (used for
// probes and for helpers whose chatter would bury the install log).
async function run(command, args, { quiet = false, env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: quiet ? "ignore" : "inherit",
      windowsHide: true,
      env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

// fetch with bounded retries and a per-attempt timeout; a non-2xx is
// just a failure here. The user-agent string is frozen as shipped —
// changing it would be a behavior change, not a cleanup.
async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30_000),
        headers: { "user-agent": "CFQoE-Scanner/0.8.3", ...(options.headers || {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(700 * attempt);
    }
  }
  throw lastError;
}

// Cheap sanity gate before the checksum: a truncated or error-page
// download is neither this large nor a ZIP, and finding out here keeps
// the checksum error meaningful when it does fire.
async function assertPlausibleArchive(file) {
  const stat = await fsp.stat(file);
  if (stat.size < 1_048_576) {
    throw new Error(`downloaded file is unexpectedly small (${stat.size} bytes)`);
  }
  const handle = await fsp.open(file, "r");
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    if (head.toString("ascii") !== "PK") {
      throw new Error("downloaded file is not a ZIP archive");
    }
  } finally {
    await handle.close();
  }
}

// Depth-first search for a file by name (case-insensitive): release
// archives do not promise a flat layout.
async function findFileRecursive(dir, name) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, name);
      if (found) return found;
    }
  }
  return null;
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

// The installed binary counts as ready only if it still executes —
// a file left by another platform or a half-finished copy does not.
async function existingBinaryRuns() {
  if (!(await exists(xrayPath))) return false;
  try {
    if (!isWindows) await fsp.chmod(xrayPath, 0o755);
    await run(xrayPath, ["version"], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

// Resolves the release asset and refuses anything the metadata does
// not checksum: an unverifiable executable is never installed.
async function resolveRelease(assetName) {
  const response = await fetchWithRetry(
    "https://api.github.com/repos/XTLS/Xray-core/releases/latest",
    { headers: { accept: "application/vnd.github+json" } },
    2,
  );
  const latest = await response.json();
  const asset = Array.isArray(latest.assets)
    ? latest.assets.find((candidate) => candidate.name === assetName)
    : null;
  if (!asset?.browser_download_url) {
    throw new Error(`GitHub release metadata did not list ${assetName}`);
  }
  if (!String(asset.digest || "").startsWith("sha256:")) {
    throw new Error(
      `GitHub release metadata did not provide a SHA-256 digest for ${assetName}; refusing an unverified executable`,
    );
  }
  return {
    name: asset.name,
    url: asset.browser_download_url,
    digest: asset.digest,
    release: latest.tag_name || "unknown",
  };
}

// The proxy git would use, when one is configured — download tools
// honor it explicitly because Node's fetch does not read git config.
async function detectGitProxy() {
  for (const key of ["https.proxy", "http.proxy"]) {
    try {
      const { stdout } = await execFileAsync("git", ["config", "--get", key], {
        timeout: 5_000,
        windowsHide: true,
      });
      const value = String(stdout).trim();
      if (value) return value;
    } catch {
      // No git, or the key is unset: try the next source.
    }
  }
  return null;
}

async function downloadWithNode(url, dest) {
  const response = await fetchWithRetry(url, {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.body) throw new Error("download response had no body");
  await pipeline(response.body, fs.createWriteStream(dest, { mode: 0o600 }));
}

async function downloadWithPowerShell(url, dest, proxy) {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12",
    `$params=@{UseBasicParsing=$true;Uri='${psQuote(url)}';OutFile='${psQuote(dest)}'}`,
    "if ($env:CFQOE_GIT_PROXY) {$params.Proxy=$env:CFQOE_GIT_PROXY}",
    "Invoke-WebRequest @params",
  ].join(";");
  await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { quiet: true, env: { ...process.env, CFQOE_GIT_PROXY: proxy || "" } },
  );
}

async function downloadWithCurl(url, dest, proxy) {
  const args = [
    "--location", "--fail", "--silent", "--show-error",
    "--retry", "3", "--connect-timeout", "20",
  ];
  if (proxy) args.push("--proxy", proxy);
  args.push("--output", dest, url);
  await run(isWindows ? "curl.exe" : "curl", args, { quiet: true });
}

// Tries each download method in order and returns the name of the one
// that produced a plausible archive; every failure is collected so the
// final error can say what was tried and why each attempt failed.
async function downloadArchive(url, dest) {
  const proxy = await detectGitProxy();
  const methods = [
    ["Node.js", () => downloadWithNode(url, dest)],
    ...(isWindows
      ? [["PowerShell", () => downloadWithPowerShell(url, dest, proxy)]]
      : []),
    ["curl", () => downloadWithCurl(url, dest, proxy)],
  ];
  const failures = [];
  for (const [name, attempt] of methods) {
    try {
      await fsp.rm(dest, { force: true });
      console.log(`Downloading with ${name} ...`);
      await attempt();
      await assertPlausibleArchive(dest);
      return name;
    } catch (error) {
      failures.push(`${name}: ${errorText(error)}`);
    }
  }
  throw new Error(`all official download methods failed (${failures.join(" | ")})`);
}

async function sha256OfFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyChecksum(file, digest) {
  if (!String(digest || "").startsWith("sha256:")) {
    throw new Error("Xray archive SHA-256 digest is required");
  }
  const expected = digest.slice("sha256:".length).toLowerCase();
  const actual = await sha256OfFile(file);
  if (actual !== expected) {
    throw new Error(`Xray archive checksum mismatch (expected ${expected}, got ${actual})`);
  }
  console.log("Verified Xray archive SHA-256 checksum.");
  return true;
}

// Extraction uses whatever the platform already has: Expand-Archive on
// Windows, python3's zipfile elsewhere, unzip as the last resort —
// with the Termux-specific remedy spelled out where it applies.
async function extractArchive(archive, destDir) {
  if (isWindows) {
    await run("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${psQuote(archive)}' -DestinationPath '${psQuote(destDir)}'`,
    ]);
    return;
  }
  try {
    await run("python3", [
      "-c",
      "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      archive,
      destDir,
    ]);
    return;
  } catch {
    try {
      await run("unzip", ["-o", archive, "-d", destDir]);
      return;
    } catch {
      throw new Error(
        "Could not extract the Xray archive. " +
          (isAndroid
            ? "In Termux run: pkg install python unzip"
            : "Install python3 or unzip and retry."),
      );
    }
  }
}

// The geo data files ride along when the archive carries them; the
// binary works without them, so absence is not an error.
async function copyDataFiles(fromDir) {
  for (const name of ["geoip.dat", "geosite.dat"]) {
    const found = await findFileRecursive(fromDir, name);
    if (found) await fsp.copyFile(found, path.join(xrayDir, name));
  }
}

async function main() {
  if (await existingBinaryRuns()) {
    console.log(`Xray is ready at ${xrayPath}`);
    return;
  }
  if (await exists(xrayPath)) {
    console.log("Existing Xray binary is incompatible or broken; replacing it.");
    await fsp.rm(xrayPath, { force: true });
  }

  const assetName = xrayAssetName();
  const release = await resolveRelease(assetName);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cfqoe-xray-"));
  const archivePath = path.join(tempDir, assetName);
  const extractDir = path.join(tempDir, "extract");
  try {
    console.log(`Installing official ${release.name} from XTLS/Xray-core ${release.release} ...`);
    await fsp.mkdir(extractDir, { recursive: true });
    const method = await downloadArchive(release.url, archivePath);
    await verifyChecksum(archivePath, release.digest);
    await extractArchive(archivePath, extractDir);

    const foundBinary = await findFileRecursive(extractDir, binaryName);
    if (!foundBinary) {
      throw new Error(`Archive ${release.name} did not contain ${binaryName}`);
    }
    await fsp.mkdir(xrayDir, { recursive: true });
    await fsp.copyFile(foundBinary, xrayPath);
    if (!isWindows) await fsp.chmod(xrayPath, 0o755);
    await copyDataFiles(extractDir);

    try {
      await run(xrayPath, ["version"], { quiet: true });
    } catch (error) {
      // Never leave a binary in place that this platform cannot run.
      await fsp.rm(xrayPath, { force: true });
      throw new Error(
        `Downloaded Xray cannot run on ${process.platform}/${process.arch}: ${errorText(error)}`,
      );
    }
    console.log(`Installed and verified Xray with ${method} at ${xrayPath}`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Xray install failed: ${errorText(error)}`);
  console.error(
    "Manual fallback: download the matching official Xray ZIP from https://github.com/XTLS/Xray-core/releases/latest and extract xray.exe into the project xray folder.",
  );
  process.exit(1);
});
