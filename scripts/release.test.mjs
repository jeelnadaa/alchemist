// node --test scripts/release.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_RE, buildManifest } from "./make-manifest.mjs";

test("asset names follow the contract", () => {
  for (const ok of ["alchemist-1.4.2-windows-x64-setup.exe", "alchemist-1.4.2-windows-x64-portable.zip", "alchemist-1.4.2-macos-arm64.dmg", "alchemist-1.4.2-macos-arm64-portable.zip", "alchemist-1.4.2-linux-x64.AppImage", "alchemist-1.4.2-linux-arm64.tar.gz", "alchemist-1.4.2-linux-x64.deb", "alchemist-1.4.2-linux-x64.rpm", "alchemist-2.0.0-beta.1-macos-x64.app.tar.gz"]) {
    assert.ok(ASSET_RE.test(ok), ok);
  }
  for (const bad of ["Alchemist_1.4.2_x64-setup.exe", "alchemist-1.4-windows-x64-setup.exe", "alchemist-1.4.2-win-x64.exe"]) assert.ok(!ASSET_RE.test(bad), bad);
});

test("manifest lists only signed updater assets with release URLs", () => {
  const files = ["alchemist-1.0.0-windows-x64-setup.exe", "alchemist-1.0.0-linux-x64.AppImage", "alchemist-1.0.0-macos-arm64.app.tar.gz"];
  const m = buildManifest(files, "1.0.0", "o/r", "notes", (f) => (f.endsWith(".AppImage") ? null : `sig-${f}`));
  assert.deepEqual(Object.keys(m.platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);
  assert.equal(m.platforms["windows-x86_64"].url, "https://github.com/o/r/releases/download/v1.0.0/alchemist-1.0.0-windows-x64-setup.exe");
  assert.equal(m.platforms["windows-x86_64"].signature, "sig-alchemist-1.0.0-windows-x64-setup.exe");
});
