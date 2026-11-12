// Self-update from GitHub Releases.
// - Checks at most once a day (with jitter), only GitHub, no identifiers.
// - Signature is verified by the updater plugin before anything is applied.
// - Never installs during a recording, export or conversion: waits for idle.
// - Portable builds and system packages get a download link instead, since
//   those files belong to the user or the package manager.

import { call, inTauri, openUrl } from "./api";
import { h } from "./dom";
import type { Shell } from "./shell";
import { store } from "./store";
import { confirmDialog, errorText, modal, toast } from "./ui/common";

export const RELEASES = "https://github.com/jeelnadaa/alchemist/releases";

let pending: { version: string; notes: string; install: () => Promise<void> } | null = null;

export function isNewer(candidate: string, current: string): boolean {
  const p = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((x) => (isNaN(+x) ? -1 : +x));
  const a = p(candidate);
  const b = p(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function due(lastCheck: number, now: number, jitter: number): boolean {
  return now >= lastCheck + 86400 + Math.min(jitter, 3600);
}

async function betaCheck(currentVersion: string): Promise<{ version: string; url: string } | null> {
  const res = await fetch("https://api.github.com/repos/jeelnadaa/alchemist/releases?per_page=10", { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const list = (await res.json()) as { tag_name: string; prerelease: boolean; draft: boolean; html_url: string }[];
  const newest = list.find((r) => !r.draft && isNewer(r.tag_name, currentVersion));
  return newest ? { version: newest.tag_name.replace(/^v/, ""), url: newest.html_url } : null;
}

export async function checkNow(shell: Shell | null, manual: boolean): Promise<string> {
  if (!inTauri) return "Updates are checked in the desktop app.";
  const info = await call<{ version: string; portable: boolean; os: string }>("app_info");
  await store.set({ lastUpdateCheck: Math.floor(Date.now() / 1000) });
  try {
    if (store.settings.betaChannel) {
      const b = await betaCheck(info.version);
      if (b) {
        offerLink(b.version, b.url);
        return `Alchemist ${b.version} is available.`;
      }
    }
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 20000 });
    if (!update) return `You're up to date (${info.version}).`;
    if (info.portable) {
      offerLink(update.version, `${RELEASES}/latest`);
      return `Alchemist ${update.version} is available.`;
    }
    const mode = manual ? "notify" : store.settings.updateMode;
    pending = {
      version: update.version,
      notes: update.body || "",
      install: async () => {
        if (await call<boolean>("is_busy")) {
          toast("The update will install when the current recording or export finishes.");
          const wait = setInterval(async () => {
            if (!(await call<boolean>("is_busy"))) {
              clearInterval(wait);
              await update.install();
              const { relaunch } = await import("@tauri-apps/plugin-process");
              await relaunch();
            }
          }, 5000);
          return;
        }
        await update.install();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
    if (mode === "auto") {
      // Download quietly now; install on the next restart or when asked.
      await update.download();
      shell?.setStatus(`Alchemist ${update.version} is ready.`);
      showRestartButton(shell);
    } else {
      toast(`Alchemist ${update.version} is available.`, { ms: 12000, action: { label: "See what's new", run: () => showUpdateDialog(true) } });
    }
    return `Alchemist ${update.version} is available.`;
  } catch (e) {
    // Offline or GitHub unavailable: stay quiet unless asked.
    if (manual) return `Couldn't check for updates: ${errorText(e)}`;
    return "";
  }
}

function offerLink(version: string, url: string) {
  toast(`Alchemist ${version} is available.`, { ms: 15000, action: { label: "Download", run: () => openUrl(url) } });
}

function showRestartButton(shell: Shell | null) {
  if (!shell) return;
  shell.setTitleRight(h("button", { type: "button", class: "btn primary", style: { height: "32px" }, onclick: () => showUpdateDialog(false) }, "Restart to update"));
}

export function showUpdateDialog(needsDownload: boolean) {
  if (!pending) return;
  const p = pending;
  modal((close) =>
    h("div", { class: "dialog", style: { width: "560px" } },
      h("header", null, h("h2", null, `Alchemist ${p.version}`)),
      h("div", { class: "content" },
        h("p", { class: "muted" }, needsDownload ? "Here's what changed. Updating takes a few seconds; your projects are kept." : "The update is downloaded and verified. Restarting takes a few seconds."),
        p.notes ? h("pre", { class: "small", style: { whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0, maxHeight: "300px", overflow: "auto" } }, p.notes) : null),
      h("footer", null, h("span", { class: "grow" }),
        h("button", { class: "btn", type: "button", onclick: close }, "Later"),
        h("button", { class: "btn primary", type: "button", onclick: async () => { close(); try { await p.install(); } catch (e) { toast(errorText(e), { error: true }); } } }, needsDownload ? "Update and restart" : "Restart now"))),
    { label: "Update" });
}

export async function autoCheck(shell: Shell) {
  const s = store.settings;
  if (s.updateMode === "off") return;
  const jitter = Math.floor(Math.random() * 3600);
  if (!due(s.lastUpdateCheck, Math.floor(Date.now() / 1000), jitter)) return;
  await checkNow(shell, false);
}

export async function confirmBeta(): Promise<boolean> {
  return confirmDialog("Get early versions?", "Early versions arrive sooner and may have rough edges. You'll get a link to each one; your stable install keeps working.", "Turn on");
}
