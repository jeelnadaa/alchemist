#!/usr/bin/env node
// Fails the release if an installer grew more than the allowed amount since
// the previous release (PLAN.md: "a sudden jump is a bug").
//
// Usage: node scripts/check-sizes.mjs <new sizes.json> <previous sizes.json> [maxGrowthPercent=15]

import { existsSync, readFileSync } from "node:fs";

const [now, prev, pct = "15"] = process.argv.slice(2);
if (!now || !prev || !existsSync(prev)) {
  console.log("No previous size report; skipping the size check.");
  process.exit(0);
}
const a = JSON.parse(readFileSync(now, "utf8"));
const b = JSON.parse(readFileSync(prev, "utf8"));
const limit = 1 + Number(pct) / 100;
let failed = false;
for (const [k, size] of Object.entries(a)) {
  const before = b[k];
  if (!before) continue;
  const change = ((size / before - 1) * 100).toFixed(1);
  const line = `${k}: ${(before / 1e6).toFixed(1)} MB → ${(size / 1e6).toFixed(1)} MB (${change}%)`;
  if (size > before * limit) {
    console.error(`TOO BIG  ${line}`);
    failed = true;
  } else console.log(`ok       ${line}`);
}
process.exit(failed ? 1 : 0);
