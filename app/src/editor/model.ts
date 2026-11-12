// Pure timeline operations. Every edit returns a new project (the old one is
// kept for undo). No DOM here, so all of it is unit-tested.

import type { Clip, Media, Project, Track, Zoom } from "../api";

export const MIN_CLIP = 1 / 30;
const uid = () => (globalThis.crypto as any)?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`;

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function clipLength(c: Clip): number {
  if (c.freeze) return Math.max(0, c.out - c.in);
  return Math.max(0, (c.out - c.in) / Math.max(c.speed || 1, 0.01));
}
export const clipEnd = (c: Clip) => c.start + clipLength(c);

export function duration(p: Project): number {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function find(p: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

export function mediaOf(p: Project, c: Clip): Media | undefined {
  return p.media.find((m) => m.id === c.mediaId);
}

const sortClips = (t: Track) => t.clips.sort((a, b) => a.start - b.start);

export function newClip(partial: Partial<Clip> & { start: number; in: number; out: number }): Clip {
  return {
    id: uid(), mediaId: null, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, reverse: false, freeze: false,
    transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0 }, text: null, shape: null, cleanVoice: false,
    ...partial,
  };
}

/** Split a clip at timeline time t. Returns the new project and right half id. */
export function split(p: Project, clipId: string, t: number): { project: Project; rightId: string | null } {
  const next = clone(p);
  const f = find(next, clipId);
  if (!f) return { project: p, rightId: null };
  const { clip, track } = f;
  if (t <= clip.start + MIN_CLIP || t >= clipEnd(clip) - MIN_CLIP) return { project: p, rightId: null };
  const sourceAt = clip.freeze ? clip.in : clip.in + (t - clip.start) * clip.speed;
  const right: Clip = { ...clone(clip), id: uid(), start: t, in: clip.freeze ? clip.in : sourceAt, fadeIn: 0, transitionIn: null };
  // Volume points are relative to the clip start: split them between the halves.
  const cut = t - clip.start;
  if (clip.volumeKeys?.length) {
    right.volumeKeys = clip.volumeKeys.filter((k) => k.t >= cut).map((k) => ({ t: k.t - cut, v: k.v }));
    const at = volumeAt(clip.volumeKeys, cut);
    if (right.volumeKeys.length && right.volumeKeys[0].t > 0) right.volumeKeys.unshift({ t: 0, v: at });
    clip.volumeKeys = clip.volumeKeys.filter((k) => k.t < cut);
    if (clip.volumeKeys.length) clip.volumeKeys.push({ t: cut, v: at });
  }
  if (clip.freeze) {
    right.out = right.in + (clipEnd(clip) - t);
    clip.out = clip.in + (t - clip.start);
  } else {
    clip.out = sourceAt;
  }
  clip.fadeOut = 0;
  track.clips.push(right);
  sortClips(track);
  return { project: next, rightId: right.id };
}

/** Split every clip under the playhead (the "S" key with nothing selected). */
export function splitAll(p: Project, t: number): Project {
  let cur = p;
  for (const track of p.tracks) for (const c of track.clips) if (t > c.start && t < clipEnd(c)) cur = split(cur, c.id, t).project;
  return cur;
}

export function remove(p: Project, clipId: string, ripple = false): Project {
  const next = clone(p);
  const f = find(next, clipId);
  if (!f) return p;
  const len = clipLength(f.clip);
  const end = clipEnd(f.clip);
  f.track.clips.splice(f.index, 1);
  if (ripple) for (const c of f.track.clips) if (c.start >= end - 1e-9) c.start = Math.max(0, c.start - len);
  return next;
}

/** Snap a time to nearby edges (other clips, playhead, markers). */
export function snap(p: Project, t: number, threshold: number, ignoreId?: string, extra: number[] = []): number {
  let best = t;
  let bestD = threshold;
  const pts = [0, ...extra, ...p.markers.map((m) => m.t)];
  for (const tr of p.tracks) for (const c of tr.clips) if (c.id !== ignoreId) pts.push(c.start, clipEnd(c));
  for (const x of pts) {
    const d = Math.abs(x - t);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best;
}

export function move(p: Project, clipId: string, start: number, trackId?: string, snapThreshold = 0, playhead?: number): Project {
  const next = clone(p);
  const f = find(next, clipId);
  if (!f) return p;
  let s = Math.max(0, start);
  if (snapThreshold > 0) {
    const len = clipLength(f.clip);
    const extra = playhead != null ? [playhead] : [];
    const a = snap(next, s, snapThreshold, clipId, extra);
    const b = snap(next, s + len, snapThreshold, clipId, extra) - len;
    const da = Math.abs(a - s) > 1e-9 ? Math.abs(a - s) : Infinity;
    const db = Math.abs(b - s) > 1e-9 ? Math.abs(b - s) : Infinity;
    if (da !== Infinity || db !== Infinity) s = da <= db ? a : b;
  }
  f.clip.start = Math.max(0, s);
  if (trackId && trackId !== f.track.id) {
    const target = next.tracks.find((t) => t.id === trackId);
    if (target && compatible(f.track.kind, target.kind)) {
      f.track.clips.splice(f.index, 1);
      target.clips.push(f.clip);
      sortClips(target);
    }
  }
  sortClips(f.track);
  return next;
}

function compatible(a: Track["kind"], b: Track["kind"]): boolean {
  const vis = (k: string) => k === "video" || k === "overlay";
  return a === b || (vis(a) && vis(b));
}

/** Trim the start or end edge to timeline time t, within the source media. */
export function trim(p: Project, clipId: string, edge: "start" | "end", t: number): Project {
  const next = clone(p);
  const f = find(next, clipId);
  if (!f) return p;
  const c = f.clip;
  const m = mediaOf(next, c);
  const maxOut = m && m.kind !== "image" ? m.duration : Infinity;
  if (edge === "start") {
    const end = clipEnd(c);
    const newStart = Math.min(Math.max(t, 0), end - MIN_CLIP);
    const delta = newStart - c.start;
    const newIn = c.in + delta * (c.freeze ? 1 : c.speed);
    if (newIn < 0) {
      c.start -= c.in / (c.freeze ? 1 : c.speed);
      c.in = 0;
    } else {
      c.in = newIn;
      c.start = newStart;
    }
  } else {
    const newEnd = Math.max(t, c.start + MIN_CLIP);
    const out = c.in + (newEnd - c.start) * (c.freeze ? 1 : c.speed);
    c.out = Math.min(out, c.freeze ? out : maxOut);
  }
  return next;
}

export function duplicate(p: Project, clipId: string): { project: Project; id: string | null } {
  const next = clone(p);
  const f = find(next, clipId);
  if (!f) return { project: p, id: null };
  const copy: Clip = { ...clone(f.clip), id: uid(), start: clipEnd(f.clip) };
  // Push later clips on the track to make room.
  const len = clipLength(copy);
  for (const c of f.track.clips) if (c.start >= copy.start - 1e-9) c.start += len;
  f.track.clips.push(copy);
  sortClips(f.track);
  return { project: next, id: copy.id };
}

export function update(p: Project, clipId: string, fn: (c: Clip) => void): Project {
  const next = clone(p);
  const f = find(next, clipId);
  if (!f) return p;
  fn(f.clip);
  sortClips(f.track);
  return next;
}

export function setSpeed(p: Project, clipId: string, speed: number): Project {
  return update(p, clipId, (c) => {
    c.speed = Math.min(16, Math.max(0.1, speed));
  });
}

/** Insert a freeze frame of `len` seconds at t, pushing the rest right. */
export function freezeFrame(p: Project, clipId: string, t: number, len = 2): Project {
  const f = find(p, clipId);
  if (!f || f.clip.freeze) return p;
  const { project, rightId } = split(p, clipId, t);
  const base = rightId ? project : clone(p);
  const g = find(base, rightId || clipId)!;
  const at = rightId ? g.clip.start : t;
  const srcT = g.clip.in;
  for (const c of g.track.clips) if (c.start >= at - 1e-9) c.start += len;
  g.track.clips.push(newClip({ mediaId: g.clip.mediaId, start: at, in: srcT, out: srcT + len, freeze: true, transform: clone(g.clip.transform) }));
  sortClips(g.track);
  return base;
}

/** Cut time ranges out of the whole timeline (e.g. silences). Everything after shifts left. */
export function removeRanges(p: Project, ranges: { start: number; end: number }[]): Project {
  const sorted = [...ranges].filter((r) => r.end - r.start > MIN_CLIP).sort((a, b) => b.start - a.start);
  let cur = p;
  for (const r of sorted) {
    // Split at both edges on every track, then drop pieces inside and shift.
    cur = splitAll(splitAll(cur, r.end), r.start);
    const next = clone(cur);
    const len = r.end - r.start;
    for (const t of next.tracks) {
      t.clips = t.clips.filter((c) => !(c.start >= r.start - 1e-6 && clipEnd(c) <= r.end + 1e-6));
      for (const c of t.clips) if (c.start >= r.end - 1e-6) c.start -= len;
    }
    next.zooms = next.zooms
      .filter((z) => !(z.start >= r.start && z.end <= r.end))
      .map((z) => ({ ...z, start: z.start >= r.end ? z.start - len : z.start, end: z.end >= r.end ? z.end - len : Math.min(z.end, r.start) }));
    next.captions = next.captions.filter((c) => !(c.start >= r.start && c.end <= r.end)).map((c) => (c.start >= r.end ? { ...c, start: c.start - len, end: c.end - len } : c));
    cur = next;
  }
  return cur;
}

/** Add imported media to the timeline at the end of the right track. */
export function addMedia(p: Project, m: Media, at?: number): Project {
  const next = clone(p);
  next.media.push(m);
  const kind = m.kind === "audio" ? "audio" : m.kind === "image" ? "overlay" : "video";
  let track = next.tracks.find((t) => t.kind === kind);
  if (!track) {
    track = { id: uid(), kind, name: kind === "overlay" ? "Images" : kind === "audio" ? "Audio" : "Video", muted: false, volume: 1, clips: [] };
    next.tracks.push(track);
  }
  const start = at ?? track.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
  const c = newClip({ mediaId: m.id, start, in: 0, out: m.kind === "image" ? 5 : m.duration });
  if (m.kind === "image") c.transform.scale = 0.4;
  track.clips.push(c);
  sortClips(track);
  if (p.media.length === 0 && m.kind === "video" && m.width > 0) {
    next.settings.width = m.width - (m.width % 2);
    next.settings.height = m.height - (m.height % 2);
  }
  return next;
}

function textTrack(p: Project): Track {
  let t = p.tracks.find((x) => x.kind === "text");
  if (!t) {
    t = { id: uid(), kind: "text", name: "Text", muted: false, volume: 1, clips: [] };
    p.tracks.push(t);
  }
  return t;
}

export function addText(p: Project, at: number, text = "Your text", style = "callout"): { project: Project; id: string } {
  const next = clone(p);
  const c = newClip({ start: at, in: 0, out: 3, text: { text, style, size: style === "title" ? 72 : 48, position: style === "title" ? "middle" : "bottom", color: "#ffffff", animation: "fade" } });
  textTrack(next).clips.push(c);
  sortClips(textTrack(next));
  return { project: next, id: c.id };
}

export function addShape(p: Project, at: number, shape: "rect" | "highlight" | "blur" | "pixelate" | "arrow"): { project: Project; id: string } {
  const next = clone(p);
  const rect: [number, number, number, number] = shape === "arrow" ? [0.3, 0.3, 0.2, 0.15] : [0.35, 0.35, 0.3, 0.2];
  const c = newClip({ start: at, in: 0, out: 3, shape: { shape, rect, color: shape === "arrow" ? "#ff3b30" : "#5b8cff" } });
  textTrack(next).clips.push(c);
  sortClips(textTrack(next));
  return { project: next, id: c.id };
}

// ---- Zoom maths, identical to export::zoom_expr / focus_expr in Rust.

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const zoomRamp = (smoothness: number) => 0.25 + clamp(smoothness, 0, 1) * 0.75;

export function zoomAt(zooms: Zoom[], ramp: number, t: number): number {
  let z = 1;
  for (const s of zooms) z += (s.scale - 1) * clamp((t - s.start) / ramp, 0, 1) * clamp((s.end - t) / ramp, 0, 1);
  return z;
}

export function focusAt(zooms: Zoom[], ramp: number, t: number): { x: number; y: number } {
  for (const s of zooms) if (t >= s.start - ramp && t <= s.end + ramp) return { x: s.x, y: s.y };
  return { x: 0.5, y: 0.5 };
}

/** CSS transform for the preview, matching zoompan's crop window. */
export function previewTransform(zooms: Zoom[], smoothness: number, t: number): string {
  const r = zoomRamp(smoothness);
  const z = zoomAt(zooms, r, t);
  if (z <= 1.0001) return "none";
  const f = focusAt(zooms, r, t);
  // zoompan: x = clamp(iw*fx - iw/z/2, 0, iw - iw/z); visible window starts at x.
  const winX = clamp(f.x - 1 / z / 2, 0, 1 - 1 / z);
  const winY = clamp(f.y - 1 / z / 2, 0, 1 - 1 / z);
  return `scale(${z}) translate(${(-winX * 100).toFixed(3)}%, ${(-winY * 100).toFixed(3)}%)`;
}

// ---- Undo history (persisted by the core so it survives restarts).

export class History {
  undoStack: string[] = [];
  redoStack: string[] = [];
  constructor(public limit = 200) {}
  push(before: Project) {
    this.undoStack.push(JSON.stringify(before));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(current: Project): Project | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(JSON.stringify(current));
    return JSON.parse(prev);
  }
  redo(current: Project): Project | null {
    const nxt = this.redoStack.pop();
    if (!nxt) return null;
    this.undoStack.push(JSON.stringify(current));
    return JSON.parse(nxt);
  }
  toJSON() {
    return { undo: this.undoStack.slice(-this.limit), redo: this.redoStack.slice(-50) };
  }
  load(v: { undo?: string[]; redo?: string[] } | null | undefined) {
    this.undoStack = Array.isArray(v?.undo) ? v!.undo.filter((x) => typeof x === "string") : [];
    this.redoStack = Array.isArray(v?.redo) ? v!.redo.filter((x) => typeof x === "string") : [];
  }
}

/** Which clip of a track is under time t. */
export function clipAt(track: Track, t: number): Clip | undefined {
  return track.clips.find((c) => t >= c.start && t < clipEnd(c));
}

/** Source time inside a clip for timeline time t. */
export function sourceTime(c: Clip, t: number): number {
  if (c.freeze) return c.in;
  const local = (t - c.start) * c.speed;
  return c.reverse ? c.out - local : c.in + local;
}

/**
 * Parse a typed time: "83", "83.5", "1:23", "1:02:03", "00:01:23:10" (frames),
 * "1m20s", "2h", "45s", "1.5m". Returns seconds or null.
 */
export function parseTime(input: string, fps = 30): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, ".");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const units = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (units && (units[1] || units[2] || units[3])) return +(units[1] || 0) * 3600 + +(units[2] || 0) * 60 + +(units[3] || 0);
  const parts = s.split(/[:;]/);
  if (parts.length < 2 || parts.length > 4 || parts.some((x) => !/^\d+(\.\d+)?$/.test(x))) return null;
  const n = parts.map(Number);
  if (n.length === 2) return n[0] * 60 + n[1];
  if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
  return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / Math.max(1, fps);
}

// ---- Transitions and volume points (same rules as export::with_transitions / volume_expr).

/** Volume multiplier at clip-local time t from the clip's volume points (linear between points). */
export function volumeAt(keys: { t: number; v: number }[] | undefined, t: number): number {
  if (!keys || !keys.length) return 1;
  const k = [...keys].sort((a, b) => a.t - b.t);
  if (t <= k[0].t) return k[0].v;
  for (let i = 1; i < k.length; i++) {
    if (t < k[i].t) return k[i - 1].v + ((k[i].v - k[i - 1].v) * (t - k[i - 1].t)) / Math.max(1e-3, k[i].t - k[i - 1].t);
  }
  return k[k.length - 1].v;
}

/** A track's clips with transitions applied: [clip, seconds started early]. */
export function withTransitions(track: Track): [Clip, number][] {
  const out: [Clip, number][] = [...track.clips].sort((a, b) => a.start - b.start).map((c) => [{ ...c, transform: c.transform }, 0]);
  for (let i = 1; i < out.length; i++) {
    const tr = out[i][0].transitionIn;
    if (!tr || tr.duration <= 0) continue;
    const prev = out[i - 1][0];
    if (Math.abs(clipEnd(prev) - out[i][0].start) > 0.05) continue;
    if (tr.kind === "dip") {
      const half = tr.duration / 2;
      out[i - 1][0] = { ...prev, fadeOut: Math.max(prev.fadeOut, Math.min(half, clipLength(prev) / 2)) };
      out[i][0] = { ...out[i][0], fadeIn: Math.max(out[i][0].fadeIn, Math.min(half, clipLength(out[i][0]) / 2)) };
    } else {
      const c = out[i][0];
      if (c.freeze || c.reverse) continue;
      const d = Math.min(tr.duration, c.in / Math.max(c.speed, 0.01), clipLength(prev) / 2, clipLength(c) / 2);
      if (d < 0.04) continue;
      out[i][0] = { ...c, start: c.start - d, in: c.in - d * c.speed, fadeIn: Math.max(c.fadeIn, d) };
      out[i][1] = d;
      out[i - 1][0] = { ...prev, fadeOut: Math.max(prev.fadeOut, d) };
    }
  }
  return out;
}

/** The clip that comes right before `clipId` on its track, if they touch. */
export function previousTouching(p: Project, clipId: string): Clip | null {
  const f = find(p, clipId);
  if (!f) return null;
  const sorted = [...f.track.clips].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.id === clipId);
  if (i <= 0) return null;
  return Math.abs(clipEnd(sorted[i - 1]) - f.clip.start) <= 0.05 ? sorted[i - 1] : null;
}
