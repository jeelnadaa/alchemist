#!/usr/bin/env node
// Measures the lightness budgets of a release build and fails when one is
// exceeded (PLAN.md section 1). Limits live in scripts/budgets.json.
//
// Usage: node scripts/measure-budgets.mjs [target-triple]
// Measures: installer/app size, time to first window, idle-in-tray memory.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const budgets = JSON.parse(readFileSync(join(here, "budgets.json"), "utf8"));
const target = process.argv[2] || "";
const rel = [join(root, "app/src-tauri/target", target, "release"), join(root, "app/src-tauri/target/release")].find((d) => existsSync(d));
if (!rel) {
  console.error("Build the release first: make package");
  process.exit(1);
}
const exe = join(rel, process.platform === "win32" ? "alchemist.exe" : "alchemist");
const results = [];
const check = (name, value, limit, unit, enforce = true) => {
  const ok = value <= limit;
  results.push({ name, value, limit, unit, ok, enforce });
  console.log(`${ok ? "ok  " : enforce ? "FAIL" : "warn"}  ${name}: ${value.toFixed(1)} ${unit} (budget ${limit} ${unit})`);
};

check("App binary size", statSync(exe).size / 1e6, budgets.appBinaryMB, "MB");
const assets = join(root, "release-assets");
if (existsSync(assets)) {
  for (const f of readdirSync(assets).filter((f) => /setup\.exe$|\.dmg$|\.AppImage$/.test(f))) {
    check(`Installer ${f}`, statSync(join(assets, f)).size / 1e6, budgets.installerMB, "MB");
  }
}

function rssOf(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" });
      return Number(out.trim()) / 1048576;
    }
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;
  } catch {
    return NaN;
  }
}

if (process.platform === "win32" && !process.env.CI_HEADLESS) {
  // Alchemist is single-instance: stop any running copy so we measure a cold start.
  try { execFileSync("taskkill", ["/IM", "alchemist.exe", "/F"], { stdio: "ignore" }); } catch { /* none running */ }
  await new Promise((r) => setTimeout(r, 1000));
  const t0 = Date.now();
  const child = spawn(exe, [], { detached: false, stdio: "ignore" });
  let shown = 0;
  for (let i = 0; i < 150 && !shown; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const h = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).MainWindowHandle`], { encoding: "utf8" }).trim();
    if (h && h !== "0") shown = Date.now() - t0;
  }
  check("Time to first window", shown / 1000, budgets.coldStartSeconds, "s");
  execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`]);
  await new Promise((r) => setTimeout(r, 6000));
  check("Idle in tray (working set)", rssOf(child.pid), budgets.idleTrayMB, "MB");
  child.kill();
} else {
  console.log("Startup and tray measurements need a desktop session; skipped here.");
}

const failed = results.filter((r) => !r.ok && r.enforce);
process.exit(failed.length ? 1 : 0);
