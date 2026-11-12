#!/usr/bin/env node
// Downloads the pinned FFmpeg build for a target and places it where Tauri
// expects a sidecar: app/src-tauri/binaries/ffmpeg-<target-triple>[.exe].
//
// Usage: node scripts/fetch-ffmpeg.mjs [target-triple]
// Env:   ALCHEMIST_FFMPEG_LOCAL=/path/to/ffmpeg  -> copy that binary instead (offline builds)

import { createWriteStream, existsSync, mkdirSync, copyFileSync, chmodSync, statSync, renameSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned release of https://github.com/eugeneware/ffmpeg-static (FFmpeg 6.1.1, GPL builds).
const RELEASE = "b6.1.1";
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;

const ASSETS = {
  "x86_64-pc-windows-msvc": "ffmpeg-win32-x64.gz",
  // No native Windows-on-ARM build: the x64 binary runs under emulation.
  "aarch64-pc-windows-msvc": "ffmpeg-win32-x64.gz",
  "x86_64-apple-darwin": "ffmpeg-darwin-x64.gz",
  "aarch64-apple-darwin": "ffmpeg-darwin-arm64.gz",
  "x86_64-unknown-linux-gnu": "ffmpeg-linux-x64.gz",
  "aarch64-unknown-linux-gnu": "ffmpeg-linux-arm64.gz",
};

function hostTriple() {
  try {
    const out = execSync("rustc -vV", { encoding: "utf8" });
    return /host: (\S+)/.exec(out)[1];
  } catch {
    throw new Error("Rust isn't installed. Install it from https://rustup.rs, then run this again.");
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || hostTriple();
const asset = ASSETS[target];
if (!asset) {
  console.error(`No FFmpeg build is configured for ${target}. Supported: ${Object.keys(ASSETS).join(", ")}`);
  process.exit(1);
}
const outDir = join(here, "..", "app", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const exe = target.includes("windows") ? ".exe" : "";
const dest = join(outDir, `ffmpeg-${target}${exe}`);

if (existsSync(dest) && statSync(dest).size > 1_000_000) {
  console.log(`FFmpeg already present: ${dest}`);
  process.exit(0);
}

if (process.env.ALCHEMIST_FFMPEG_LOCAL) {
  copyFileSync(process.env.ALCHEMIST_FFMPEG_LOCAL, dest);
  console.log(`Copied local FFmpeg to ${dest}`);
  process.exit(0);
}

const url = `${BASE}/${asset}`;
console.log(`Downloading ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}. Check your connection, or set ALCHEMIST_FFMPEG_LOCAL to an ffmpeg binary.`);
  process.exit(1);
}
const tmp = `${dest}.part`;
await pipeline(Readable.fromWeb(res.body), createGunzip(), createWriteStream(tmp));
renameSync(tmp, dest);
if (!exe) chmodSync(dest, 0o755);
console.log(`FFmpeg ready: ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);

// Licence text for the bundled build.
try {
  const lic = await fetch(`${BASE}/${asset.replace(".gz", ".LICENSE")}`);
  if (lic.ok) {
    const text = await lic.text();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(outDir, "FFMPEG_LICENSE.txt"), text);
  }
} catch {
  /* optional */
}
