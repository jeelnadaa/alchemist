// Themes are small sets of design tokens. Switching is instant and loads
// nothing. Every theme is checked for WCAG AA contrast in themes.test.ts.

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  bg: string; // app background
  surf: string; // bars, rail, panels
  raised: string; // cards, inputs
  line: string;
  text: string;
  muted: string;
  accent: string; // accent used as text/icons on bg
  btn: string; // filled button background
  on: string; // text on btn
  rec: string;
  ok: string;
  warn: string;
}

export const THEMES: Theme[] = [
  { id: "obsidian", name: "Obsidian", dark: true, bg: "#0b0c0f", surf: "#0f1115", raised: "#14161b", line: "rgba(255,255,255,0.08)", text: "#eceef2", muted: "#9aa1ad", accent: "#7ea3ff", btn: "#3d6be6", on: "#ffffff", rec: "#f05252", ok: "#5fdca5", warn: "#f5b84a" },
  { id: "mercury", name: "Mercury", dark: true, bg: "#0f1216", surf: "#151a20", raised: "#1c232b", line: "rgba(200,220,255,0.09)", text: "#e6edf6", muted: "#93a0ae", accent: "#9ec3ff", btn: "#3a70bf", on: "#ffffff", rec: "#f26060", ok: "#62d9a6", warn: "#f2bb55" },
  { id: "cinnabar", name: "Cinnabar", dark: true, bg: "#150a09", surf: "#1d0f0d", raised: "#271613", line: "rgba(255,200,180,0.09)", text: "#f6e7e2", muted: "#b5958e", accent: "#ff8a6e", btn: "#b83d26", on: "#ffffff", rec: "#ff5e5e", ok: "#6fd7a2", warn: "#f5bf55" },
  { id: "verdigris", name: "Verdigris", dark: true, bg: "#071211", surf: "#0c1a18", raised: "#12231f", line: "rgba(180,255,230,0.09)", text: "#e0f2ec", muted: "#8aaba1", accent: "#4fd1b0", btn: "#167260", on: "#ffffff", rec: "#f26a6a", ok: "#4fd1b0", warn: "#f2c063" },
  { id: "hcdark", name: "High contrast dark", dark: true, bg: "#000000", surf: "#000000", raised: "#111111", line: "#ffffff", text: "#ffffff", muted: "#e6e6e6", accent: "#ffe500", btn: "#ffe500", on: "#000000", rec: "#ff6b6b", ok: "#00ff7f", warn: "#ffe500" },
  { id: "parchment", name: "Parchment", dark: false, bg: "#f4eee2", surf: "#ece4d4", raised: "#fffaf0", line: "rgba(60,40,10,0.14)", text: "#20180c", muted: "#62553f", accent: "#8a520c", btn: "#8a520c", on: "#ffffff", rec: "#c42a17", ok: "#1d7a4a", warn: "#8a5a00" },
  { id: "salt", name: "Salt", dark: false, bg: "#fbfbfa", surf: "#f1f2f4", raised: "#ffffff", line: "rgba(10,20,40,0.1)", text: "#0f1520", muted: "#555d6a", accent: "#2b5be0", btn: "#2b5be0", on: "#ffffff", rec: "#d0281c", ok: "#17794f", warn: "#8a5a00" },
  { id: "quartz", name: "Quartz", dark: false, bg: "#f3eef1", surf: "#eae2e7", raised: "#fdf9fb", line: "rgba(50,20,40,0.1)", text: "#22141e", muted: "#64515d", accent: "#6236c8", btn: "#6236c8", on: "#ffffff", rec: "#c4253f", ok: "#17794f", warn: "#8a5a00" },
  { id: "goldleaf", name: "Gold Leaf", dark: false, bg: "#fbf3dd", surf: "#f3e8c8", raised: "#fffaeb", line: "rgba(80,60,0,0.12)", text: "#241a02", muted: "#625429", accent: "#7a5900", btn: "#7a5900", on: "#ffffff", rec: "#c2361b", ok: "#1d6e3f", warn: "#7a5900" },
  { id: "hclight", name: "High contrast light", dark: false, bg: "#ffffff", surf: "#ffffff", raised: "#ffffff", line: "#000000", text: "#000000", muted: "#1a1a1a", accent: "#0038d1", btn: "#0038d1", on: "#ffffff", rec: "#b00000", ok: "#005a1e", warn: "#6b4a00" },
];

export interface Accent {
  id: string;
  name: string;
  darkText: string;
  lightText: string;
  btn: string;
}

export const ACCENTS: Accent[] = [
  { id: "blue", name: "Blue", darkText: "#7ea3ff", lightText: "#2752d2", btn: "#3d6be6" },
  { id: "violet", name: "Violet", darkText: "#b49cff", lightText: "#6236c8", btn: "#6236c8" },
  { id: "green", name: "Green", darkText: "#5fdca5", lightText: "#136b45", btn: "#136b45" },
  { id: "orange", name: "Orange", darkText: "#ffae5c", lightText: "#9a4a00", btn: "#a54f00" },
  { id: "pink", name: "Pink", darkText: "#ff8ac4", lightText: "#a8215f", btn: "#a8215f" },
];

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/** Resolve the theme to use, honouring "follow system" and accent override. */
export function resolveTheme(opts: { theme: string; followSystem: boolean; darkTheme: string; lightTheme: string; accent: string | null; customTheme?: Theme | null }, systemDark: boolean): Theme {
  const pick = (id: string) => (id === "custom" && opts.customTheme ? opts.customTheme : themeById(id));
  const base = opts.followSystem ? pick(systemDark ? opts.darkTheme : opts.lightTheme) : pick(opts.theme);
  const acc = ACCENTS.find((a) => a.id === opts.accent);
  if (!acc || base.id.startsWith("hc")) return base;
  return { ...base, accent: base.dark ? acc.darkText : acc.lightText, btn: acc.btn, on: "#ffffff" };
}

export function applyTheme(t: Theme, root: HTMLElement = document.documentElement) {
  const map: Record<string, string> = {
    "--bg": t.bg, "--surf": t.surf, "--raised": t.raised, "--line": t.line, "--text": t.text, "--muted": t.muted,
    "--accent": t.accent, "--btn": t.btn, "--on": t.on, "--rec": t.rec, "--ok": t.ok, "--warn": t.warn,
  };
  for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  root.dataset.dark = String(t.dark);
  root.style.colorScheme = t.dark ? "dark" : "light";
}

// ---- WCAG contrast, used by tests and by custom-theme import validation.

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function parseColor(c: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`Not a #rrggbb colour: ${c}`);
}

export function luminance(c: string): number {
  const [r, g, b] = parseColor(c);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Problems with a theme, empty when it passes AA. */
export function auditTheme(t: Theme): string[] {
  const issues: string[] = [];
  const check = (fg: string, bg: string, min: number, what: string) => {
    const r = contrast(fg, bg);
    if (r < min) issues.push(`${t.name}: ${what} contrast ${r.toFixed(2)} < ${min}`);
  };
  for (const [bgName, bg] of [["background", t.bg], ["panels", t.surf], ["cards", t.raised]] as const) {
    check(t.text, bg, 4.5, `text on ${bgName}`);
    check(t.muted, bg, 4.5, `secondary text on ${bgName}`);
    check(t.accent, bg, 4.5, `accent on ${bgName}`);
  }
  check(t.on, t.btn, 4.5, "button text");
  return issues;
}

/** Validate an imported custom theme JSON. */
export function parseCustomTheme(json: string): { theme?: Theme; error?: string } {
  try {
    const raw = JSON.parse(json);
    const keys: (keyof Theme)[] = ["bg", "surf", "raised", "text", "muted", "accent", "btn", "on"];
    for (const k of keys) {
      if (typeof raw[k] !== "string") return { error: `The theme file is missing "${k}".` };
      parseColor(raw[k]);
    }
    const t: Theme = { id: "custom", name: String(raw.name || "Custom"), dark: luminance(raw.bg) < 0.2, line: raw.line || "rgba(128,128,128,0.2)", rec: raw.rec || "#e5372a", ok: raw.ok || "#17794f", warn: raw.warn || "#8a5a00", ...raw };
    const issues = auditTheme(t);
    if (issues.length) return { error: `This theme is hard to read: ${issues[0]}.` };
    return { theme: t };
  } catch (e) {
    return { error: `That isn't a valid theme file. ${(e as Error).message}` };
  }
}
