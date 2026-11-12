#!/usr/bin/env node
// Collects what `tauri build` produced for one target, renames everything to
// the asset naming contract (PLAN.md 6.1), and builds the portable package.
//
//   alchemist-<version>-<os>-<arch>[-<kind>].<ext>
//
// Usage: node scripts/collect-release.mjs <target-triple> [outDir=release-assets]
// Writes files plus updater signatures (<asset>.sig) into outDir.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const target = process.argv[2];
const outDir = join(root, process.argv[3] || "release-assets");
if (!target) {
  console.error("Usage: node scripts/collect-release.mjs <target-triple> [outDir]");
  process.exit(1);
}

export function platformOf(triple) {
  const os = triple.includes("windows") ? "windows" : triple.includes("apple") ? "macos" : "linux";
  const arch = triple.startsWith("aarch64") ? "arm64" : "x64";
  return { os, arch };
}

const version = JSON.parse(readFileSync(join(root, "app", "package.json"), "utf8")).version;
const { os, arch } = platformOf(target);
const name = (suffix) => `alchemist-${version}-${os}-${arch}${suffix}`;
const tauriTarget = join(root, "app", "src-tauri", "target");
const candidates = [join(tauriTarget, target, "release"), join(tauriTarget, "release")];
const releaseDir = candidates.find((d) => existsSync(join(d, "bundle")));
if (!releaseDir) {
  console.error(`No bundle found for ${target}. Run the build first.`);
  process.exit(1);
}
const bundle = join(releaseDir, "bundle");
mkdirSync(outDir, { recursive: true });

const find = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f)) : []);
const put = (src, dest) => {
  copyFileSync(src, join(outDir, dest));
  console.log(`  ${dest}  (${(statSync(src).size / 1e6).toFixed(1)} MB)`);
  if (existsSync(`${src}.sig`)) copyFileSync(`${src}.sig`, join(outDir, `${dest}.sig`));
};
const zipDir = (dir, dest) => {
  const out = join(outDir, dest);
  rmSync(out, { force: true });
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${dir}\\*' -DestinationPath '${out}' -Force`], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-qry", out, "."], { cwd: dir, stdio: "inherit" });
  }
  console.log(`  ${dest}  (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
};
const portableNote = "This file switches Alchemist to portable mode: settings, projects and caches are kept in the \"data\" folder next to the app, and nothing is written to your user profile.\n";

console.log(`Collecting ${target} (${os} ${arch}) v${version}`);

if (os === "windows") {
  const [setup] = find(join(bundle, "nsis"), /-setup\.exe$/);
  if (!setup) throw new Error("NSIS installer missing");
  put(setup, name("-setup.exe"));
  // Portable: the app, FFmpeg sidecar, resources and the marker, zipped.
  const stage = join(outDir, ".portable");
  rmSync(stage, { recursive: true, force: true });
  const app = join(stage, "Alchemist");
  mkdirSync(app, { recursive: true });
  copyFileSync(join(releaseDir, "alchemist.exe"), join(app, "Alchemist.exe"));
  copyFileSync(join(releaseDir, "ffmpeg.exe"), join(app, "ffmpeg.exe"));
  cpSync(join(releaseDir, "resources"), join(app, "resources"), { recursive: true });
  if (existsSync(join(releaseDir, "THIRD_PARTY_NOTICES.md"))) copyFileSync(join(releaseDir, "THIRD_PARTY_NOTICES.md"), join(app, "THIRD_PARTY_NOTICES.md"));
  writeFileSync(join(app, "portable.txt"), portableNote);
  zipDir(stage, name("-portable.zip"));
  rmSync(stage, { recursive: true, force: true });
} else if (os === "macos") {
  const [dmg] = find(join(bundle, "dmg"), /\.dmg$/);
  if (!dmg) throw new Error("DMG missing");
  put(dmg, name(".dmg"));
  // Updater payload (.app.tar.gz + .sig) produced by createUpdaterArtifacts.
  const [tgz] = find(join(bundle, "macos"), /\.app\.tar\.gz$/);
  if (tgz) put(tgz, name(".app.tar.gz"));
  const [appDir] = find(join(bundle, "macos"), /\.app$/);
  const stage = join(outDir, ".portable");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  execFileSync("cp", ["-R", appDir, stage]);
  writeFileSync(join(stage, "portable.txt"), portableNote);
  zipDir(stage, name("-portable.zip"));
  rmSync(stage, { recursive: true, force: true });
} else {
  const [appimage] = find(join(bundle, "appimage"), /\.AppImage$/);
  if (appimage) put(appimage, name(".AppImage"));
  const [deb] = find(join(bundle, "deb"), /\.deb$/);
  if (deb) put(deb, name(".deb"));
  const [rpm] = find(join(bundle, "rpm"), /\.rpm$/);
  if (rpm) put(rpm, name(".rpm"));
  const stage = join(outDir, ".portable");
  rmSync(stage, { recursive: true, force: true });
  const app = join(stage, "alchemist");
  mkdirSync(app, { recursive: true });
  copyFileSync(join(releaseDir, "alchemist"), join(app, "alchemist"));
  copyFileSync(join(releaseDir, "ffmpeg"), join(app, "ffmpeg"));
  cpSync(join(releaseDir, "resources"), join(app, "resources"), { recursive: true });
  writeFileSync(join(app, "portable.txt"), portableNote);
  const out = join(outDir, name(".tar.gz"));
  execFileSync("tar", ["-czf", out, "-C", stage, "alchemist"]);
  console.log(`  ${basename(out)}  (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  rmSync(stage, { recursive: true, force: true });
}
