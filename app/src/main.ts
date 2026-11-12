// Entry point. Decides which window this is (main, recording bar or area
// picker), builds the shell and swaps screens on route changes. Screens are
// loaded on demand, so opening the converter never loads the editor.

import { call, on, type Manifest } from "./api";
import { current, go, onRoute, request, type Route } from "./router";
import { actionFor, bindings } from "./shortcuts";
import { buildShell, type Shell } from "./shell";
import { store } from "./store";
import { errorText, toast } from "./ui/common";
import { openPalette } from "./ui/palette";
import { listenForReplays, saveReplay } from "./ui/replay";

type Cleanup = (() => void) | void;
type Screen = { mount: (shell: Shell, route: Route) => Cleanup | Promise<Cleanup> };

const SCREENS: Record<string, () => Promise<Screen>> = {
  "": () => import("./screens/home"),
  record: () => import("./screens/recorder"),
  edit: () => import("./editor/editor"),
  convert: () => import("./screens/convert"),
  projects: () => import("./screens/projects"),
  settings: () => import("./screens/settings"),
};

async function boot() {
  const app = document.getElementById("app")!;
  const route = current();
  await store.init();

  if (route.name === "bar") {
    document.body.classList.add("bar-window");
    (await import("./screens/bar")).mount(app);
    return;
  }
  if (route.name === "picker") {
    document.body.classList.add("picker-window");
    (await import("./screens/picker")).mount(app);
    return;
  }
  if (route.name === "welcome" || !store.settings.firstRunDone) {
    const startStep = Number(route.params.get("step") || 1);
    (await import("./screens/welcome")).mount(app, startStep, () => {
      location.hash = "#/";
      location.reload();
    });
    return;
  }

  const shell = buildShell();
  app.appendChild(shell.root);
  let cleanup: Cleanup;
  let token = 0;

  const show = async (r: Route) => {
    if (r.name === "welcome") {
      location.reload();
      return;
    }
    const my = ++token;
    if (typeof cleanup === "function") cleanup();
    cleanup = undefined;
    const loader = SCREENS[r.name] ?? SCREENS[""];
    shell.setActive(r.name in SCREENS ? r.name : "");
    shell.setCrumbs(null);
    shell.setTitleRight(null);
    shell.main.replaceChildren();
    try {
      const screen = await loader();
      if (my !== token) return;
      cleanup = await screen.mount(shell, r);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  onRoute(show);
  await show(current());

  // Global keyboard shortcuts (the editor handles its own on top).
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !(e.ctrlKey || e.metaKey)) return;
    if (document.querySelector(".scrim")) return;
    const map = bindings(store.settings.shortcutPreset, store.settings.shortcuts);
    const act = actionFor(e, map, "global");
    if (!act) return;
    e.preventDefault();
    if (act === "search") openPalette();
    else if (act === "home") go("");
    else if (act === "record") go("record");
    else if (act === "newEdit") { request("new-edit"); go("edit/new"); }
    else if (act === "convert") go("convert");
    else if (act === "settings") go("settings/appearance");
    else if (act === "replaySave") saveReplay();
  });

  // Global hotkey from anywhere in the OS.
  await on<string>("hotkey", (what) => {
    if (what === "record") {
      request("record-now");
      go("record");
    }
  });

  await listenForReplays();
  // A recording just finished (from the bar, the hotkey or auto-stop): open it.
  const openFinished = async () => {
    const m = await call<Manifest | null>("take_finished_recording").catch(() => null);
    if (!m) return;
    const { recordingReport } = await import("./screens/recorder");
    try {
      const p = await call<{ id: string }>("project_from_recording", { id: m.id });
      go(`edit/${p.id}`);
      recordingReport(m);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  await on("recording-finished", openFinished);
  await openFinished();

  // Recordings saved after a crash.
  const recovered = await call<Manifest[]>("recovered_recordings").catch(() => []);
  for (const m of recovered) {
    toast("A recording was recovered after Alchemist closed unexpectedly.", {
      ms: 15000,
      action: { label: "Open it", run: async () => { const p = await call<{ id: string }>("project_from_recording", { id: m.id }); go(`edit/${p.id}`); } },
    });
  }

  const info = await call<{ version: string; portable: boolean; portableNote?: string | null; ffmpeg?: string | null }>("app_info").catch(() => null);
  if (info) shell.setStatus(`Alchemist ${info.version}${info.portable ? " · portable" : ""}`);
  if (info?.portableNote) toast(info.portableNote, { ms: 10000 });
  if (info && !info.ffmpeg) toast("Alchemist's media engine (FFmpeg) is missing. Reinstall Alchemist to fix this.", { error: true, ms: 20000 });

  // Updates: quietly, at most once a day, never during work.
  setTimeout(() => import("./updater").then((u) => u.autoCheck(shell)), 4000);
}

boot().catch((e) => {
  document.body.textContent = `Alchemist couldn't start: ${errorText(e)}`;
});
