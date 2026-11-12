// Search: one index of actions, settings and help, plus live projects and
// files. Matching is word-based and forgiving ("smaller", "shrink", "25mb").

export type Group = "Actions" | "Files" | "Settings" | "Help";

export interface Entry {
  id: string;
  group: Group;
  title: string;
  sub: string;
  keywords: string;
  hint?: string;
  run: () => void;
}

export function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/(\d)\s*mb\b/g, "$1mb");
}

const SYNONYMS: Record<string, string[]> = {
  smaller: ["compress", "shrink", "reduce", "size", "small"],
  compress: ["smaller", "shrink", "size"],
  shrink: ["smaller", "compress"],
  gif: ["animation", "loop"],
  subtitles: ["captions"],
  captions: ["subtitles", "transcript"],
  record: ["capture", "screen"],
  capture: ["record"],
  theme: ["dark", "light", "color", "appearance"],
  dark: ["theme"],
  light: ["theme"],
  mp3: ["audio"],
  audio: ["sound", "mp3"],
  cut: ["trim", "split"],
  trim: ["cut"],
  upscale: ["enhance", "sharpen", "4k"],
  sharpen: ["enhance"],
  permissions: ["privacy", "allow", "screen recording", "microphone"],
};

/** Score an entry for a query; 0 means no match. */
export function score(e: Entry, query: string): number {
  const q = normalize(query).trim();
  if (!q) return 1;
  const title = normalize(e.title);
  const hay = `${title} ${normalize(e.sub)} ${normalize(e.keywords)}`;
  let total = 0;
  for (const w of q.split(/\s+/)) {
    const alts = [w, ...(SYNONYMS[w] || [])];
    let best = 0;
    for (const a of alts) {
      const weight = a === w ? 1 : 0.6;
      if (title.startsWith(a)) best = Math.max(best, 6 * weight);
      else if (new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title)) best = Math.max(best, 4 * weight);
      else if (hay.includes(a)) best = Math.max(best, 2 * weight);
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export function rank(entries: Entry[], query: string, perGroup = { Actions: 6, Files: 4, Settings: 4, Help: 3 }): { group: Group; items: Entry[] }[] {
  const scored = entries.map((e) => ({ e, s: score(e, query) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  const groups: Group[] = ["Actions", "Files", "Settings", "Help"];
  return groups
    .map((g) => ({ group: g, items: scored.filter((x) => x.e.group === g).slice(0, perGroup[g]).map((x) => x.e) }))
    .filter((g) => g.items.length > 0);
}
