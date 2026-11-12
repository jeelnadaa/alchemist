// Keyboard shortcuts: one table, customisable, with presets familiar to
// people coming from other editors.

export interface ShortcutDef {
  id: string;
  label: string;
  scope: "global" | "editor";
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "search", label: "Search", scope: "global" },
  { id: "home", label: "Go home", scope: "global" },
  { id: "record", label: "Record screen", scope: "global" },
  { id: "replaySave", label: "Save instant replay", scope: "global" },
  { id: "newEdit", label: "New edit", scope: "global" },
  { id: "convert", label: "Convert or shrink", scope: "global" },
  { id: "settings", label: "Settings", scope: "global" },
  { id: "playPause", label: "Play or pause", scope: "editor" },
  { id: "split", label: "Split at playhead", scope: "editor" },
  { id: "delete", label: "Delete selection", scope: "editor" },
  { id: "rippleDelete", label: "Ripple delete", scope: "editor" },
  { id: "duplicate", label: "Duplicate", scope: "editor" },
  { id: "undo", label: "Undo", scope: "editor" },
  { id: "redo", label: "Redo", scope: "editor" },
  { id: "markIn", label: "Mark in", scope: "editor" },
  { id: "markOut", label: "Mark out", scope: "editor" },
  { id: "addMarker", label: "Add marker", scope: "editor" },
  { id: "export", label: "Export", scope: "editor" },
  { id: "frameBack", label: "Previous frame", scope: "editor" },
  { id: "frameForward", label: "Next frame", scope: "editor" },
];

export const PRESETS: Record<string, Record<string, string>> = {
  alchemist: {
    search: "Mod+K", home: "Mod+1", record: "Mod+Shift+R", replaySave: "Mod+Shift+S", newEdit: "Mod+N", convert: "Mod+Shift+C", settings: "Mod+,",
    playPause: "Space", split: "S", delete: "Delete", rippleDelete: "Shift+Delete", duplicate: "Mod+D", undo: "Mod+Z", redo: "Mod+Shift+Z",
    markIn: "I", markOut: "O", addMarker: "M", export: "Mod+E", frameBack: "ArrowLeft", frameForward: "ArrowRight",
  },
  premiere: {
    search: "Mod+Shift+F", home: "Mod+1", record: "Mod+Shift+R", replaySave: "Mod+Shift+S", newEdit: "Mod+N", convert: "Mod+Shift+C", settings: "Mod+,",
    playPause: "Space", split: "Mod+K", delete: "Delete", rippleDelete: "Shift+Delete", duplicate: "Mod+D", undo: "Mod+Z", redo: "Mod+Shift+Z",
    markIn: "I", markOut: "O", addMarker: "M", export: "Mod+M", frameBack: "ArrowLeft", frameForward: "ArrowRight",
  },
  finalcut: {
    search: "Mod+F", home: "Mod+1", record: "Mod+Shift+R", replaySave: "Mod+Shift+S", newEdit: "Mod+N", convert: "Mod+Shift+C", settings: "Mod+,",
    playPause: "Space", split: "Mod+B", delete: "Delete", rippleDelete: "Shift+Delete", duplicate: "Mod+D", undo: "Mod+Z", redo: "Mod+Shift+Z",
    markIn: "I", markOut: "O", addMarker: "M", export: "Mod+E", frameBack: "ArrowLeft", frameForward: "ArrowRight",
  },
  davinci: {
    search: "Mod+K", home: "Mod+1", record: "Mod+Shift+R", replaySave: "Mod+Shift+S", newEdit: "Mod+N", convert: "Mod+Shift+C", settings: "Mod+,",
    playPause: "Space", split: "Mod+B", delete: "Backspace", rippleDelete: "Delete", duplicate: "Mod+D", undo: "Mod+Z", redo: "Mod+Shift+Z",
    markIn: "I", markOut: "O", addMarker: "M", export: "Mod+Shift+E", frameBack: "ArrowLeft", frameForward: "ArrowRight",
  },
};

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** "Mod+Shift+K" for a keyboard event. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  if (!["Control", "Meta", "Shift", "Alt"].includes(key)) parts.push(key);
  return parts.join("+");
}

export function bindings(preset: string, overrides: Record<string, string>): Record<string, string> {
  return { ...(PRESETS[preset] || PRESETS.alchemist), ...overrides };
}

/** Which action a keypress triggers. */
export function actionFor(e: KeyboardEvent, map: Record<string, string>, scope: "global" | "editor"): string | null {
  const combo = comboFromEvent(e);
  for (const def of SHORTCUTS) {
    if (def.scope !== "global" && def.scope !== scope) continue;
    if (map[def.id] === combo) return def.id;
  }
  return null;
}

export function pretty(combo: string): string {
  return combo.replace("Mod", isMac ? "⌘" : "Ctrl").replace(/\+/g, " ").replace("ArrowLeft", "←").replace("ArrowRight", "→");
}

/** Combos assigned to more than one action in the same scope. */
export function conflicts(map: Record<string, string>): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const def of SHORTCUTS) {
    const c = map[def.id];
    if (!c) continue;
    const key = `${def.scope === "global" ? "*" : def.scope}:${c}`;
    const globalKey = `*:${c}`;
    const clash = seen.get(key) || seen.get(globalKey) || (def.scope === "global" ? [...seen.keys()].find((k) => k.endsWith(`:${c}`)) : undefined);
    if (clash) out.push(c);
    seen.set(key, def.id);
  }
  return [...new Set(out)];
}
