#!/usr/bin/env node
// After all platform builds: writes SHA256SUMS.txt and the signed update
// manifest latest.json (the format Tauri's updater reads), checks the asset
// naming contract, and reports installer sizes.
//
// Usage: node scripts/make-manifest.mjs <assetsDir> <version> <repo> [notesFile]

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ASSET_RE = /^alchemist-(\d+\.\d+\.\d+(?:-[0-9a-z.]+)?)-(windows|macos|linux)-(x64|arm64|universal)(?:-(setup|portable))?\.(exe|zip|dmg|AppImage|tar\.gz|deb|rpm|app\.tar\.gz)$/;

// Which asset the in-app updater installs for each Tauri platform key.
export const UPDATER = {
  "windows-x86_64": (v) => `alchemist-${v}-windows-x64-setup.exe`,
  "windows-aarch64": (v) => `alchemist-${v}-windows-arm64-setup.exe`,
  "darwin-x86_64": (v) => `alchemist-${v}-macos-x64.app.tar.gz`,
  "darwin-aarch64": (v) => `alchemist-${v}-macos-arm64.app.tar.gz`,
  "linux-x86_64": (v) => `alchemist-${v}-linux-x64.AppImage`,
  "linux-aarch64": (v) => `alchemist-${v}-linux-arm64.AppImage`,
};

export function buildManifest(files, version, repo, notes, sigOf) {
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  const platforms = {};
  for (const [key, fn] of Object.entries(UPDATER)) {
    const file = fn(version);
    const sig = sigOf(file);
    if (files.includes(file) && sig) platforms[key] = { signature: sig.trim(), url: `${base}/${file}` };
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms };
}

function main() {
  const [dir, version, repo, notesFile] = process.argv.slice(2);
  if (!dir || !version || !repo) {
    console.error("Usage: node scripts/make-manifest.mjs <assetsDir> <version> <owner/repo> [notesFile]");
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => !f.startsWith(".") && statSync(join(dir, f)).isFile());
  const assets = files.filter((f) => !f.endsWith(".sig") && f !== "SHA256SUMS.txt" && f !== "latest.json" && f !== "sizes.json");
  const bad = assets.filter((f) => !ASSET_RE.test(f) || ASSET_RE.exec(f)[1] !== version);
  if (bad.length) {
    console.error(`Asset names break the naming contract: ${bad.join(", ")}`);
    process.exit(1);
  }
  const sums = assets.sort().map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}`).join("\n") + "\n";
  writeFileSync(join(dir, "SHA256SUMS.txt"), sums);

  const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8") : `Alchemist ${version}`;
  const manifest = buildManifest(assets, version, repo, notes, (f) => (existsSync(join(dir, `${f}.sig`)) ? readFileSync(join(dir, `${f}.sig`), "utf8") : null));
  if (!Object.keys(manifest.platforms).length) console.warn("Warning: no updater signatures found; latest.json has no platforms.");
  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2));

  // Installer size report (tracked every release; a sudden jump is a bug).
  const sizes = Object.fromEntries(assets.map((f) => [f.replace(version, "VERSION"), statSync(join(dir, f)).size]));
  writeFileSync(join(dir, "sizes.json"), JSON.stringify(sizes, null, 2));
  console.log("Assets:");
  for (const f of assets) console.log(`  ${(statSync(join(dir, f)).size / 1e6).toFixed(1).padStart(7)} MB  ${f}`);
  console.log(`Updater platforms: ${Object.keys(manifest.platforms).join(", ") || "none"}`);
}

if (process.argv[1] && process.argv[1].endsWith("make-manifest.mjs")) main();
