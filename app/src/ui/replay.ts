// Instant replay helpers shared by the recorder, title bar, palette and
// keyboard shortcut. Saving reports back through the "replay-saved" and
// "replay-error" events (the same ones the global hotkey uses), so every
// save shows exactly one message, wherever it was started.

import { call, on, reveal } from "../api";
import { store } from "../store";
import { toast } from "./common";

export const DEFAULT_REPLAY_HOTKEY = "CommandOrControl+Alt+R";

/** Hotkeys offered in Settings. All avoid common app shortcuts like Save as. */
export const REPLAY_HOTKEYS: [string, string][] = [
  ["CommandOrControl+Alt+R", "Ctrl Alt R"],
  ["CommandOrControl+Shift+F9", "Ctrl Shift F9"],
  ["Alt+F9", "Alt F9"],
  ["CommandOrControl+Alt+F10", "Ctrl Alt F10"],
];

const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

/** "CommandOrControl+Alt+R" -> "Ctrl Alt R" (⌘ ⌥ R on a Mac). */
export function prettyKeys(keys: string | null | undefined): string {
  return (keys || DEFAULT_REPLAY_HOTKEY)
    .split("+")
    .map((k) => {
      if (k === "CommandOrControl" || k === "CmdOrCtrl") return isMac ? "⌘" : "Ctrl";
      if (k === "Control") return "Ctrl";
      if (k === "Alt") return isMac ? "⌥" : "Alt";
      if (k === "Shift") return isMac ? "⇧" : "Shift";
      return k;
    })
    .join(" ");
}

export function replayKeys(): string {
  return prettyKeys(store.settings.replayHotkey);
}

/** Save the last moments. The result is shown by the event listeners below. */
export async function saveReplay(): Promise<string | null> {
  return call<string>("replay_save").catch(() => null);
}

/** Show one toast per save, however it was started. Call once at startup. */
export async function listenForReplays() {
  await on<string>("replay-saved", (path) => {
    toast(`Replay saved: ${path.split(/[\\/]/).pop()}`, { action: { label: "Show", run: () => reveal(path) }, ms: 6000 });
  });
  await on<string>("replay-error", (message) => toast(message, { error: true }));
}
