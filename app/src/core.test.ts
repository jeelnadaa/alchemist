import { describe, expect, it } from "vitest";
import type { Media, Project } from "./api";
import * as M from "./editor/model";
import { ago, bytes, clock, eta, ratio, timecode } from "./format";
import { rank, score, type Entry } from "./search";
import { actionFor, bindings, conflicts, PRESETS } from "./shortcuts";
import { auditTheme, contrast, parseCustomTheme, resolveTheme, THEMES } from "./themes";

function project(): Project {
  return {
    version: 1, id: "p", name: "Demo", created: 0, modified: 0,
    settings: { width: 1920, height: 1080, fps: 30, background: "#000000", padding: 0, radius: 0 },
    media: [{ id: "m", path: "a.mp4", kind: "video", duration: 60, width: 1920, height: 1080, hasAudio: true, missing: false }],
    tracks: [
      { id: "v", kind: "video", name: "Video", muted: false, volume: 1, clips: [M.newClip({ id: "c1", mediaId: "m", start: 0, in: 0, out: 10 }), M.newClip({ id: "c2", mediaId: "m", start: 10, in: 20, out: 30 })] },
      { id: "t", kind: "text", name: "Text", muted: false, volume: 1, clips: [] },
      { id: "a", kind: "audio", name: "Voice", muted: false, volume: 1, clips: [M.newClip({ id: "a1", mediaId: "m", start: 0, in: 0, out: 20 })] },
    ],
    zooms: [{ start: 12, end: 16, scale: 2, x: 0.8, y: 0.7 }], zoomSmoothness: 0.5, captions: [{ start: 13, end: 14, text: "hi" }], markers: [{ t: 7, label: "" }], inPoint: null, outPoint: null, events: null,
  };
}

describe("timeline model", () => {
  it("measures clips and project", () => {
    const p = project();
    expect(M.duration(p)).toBe(20);
    const c = M.newClip({ start: 2, in: 0, out: 10, speed: 2 });
    expect(M.clipLength(c)).toBe(5);
    expect(M.clipEnd(c)).toBe(7);
  });

  it("splits at the playhead with correct source points", () => {
    const { project: p, rightId } = M.split(project(), "c2", 14);
    const left = M.find(p, "c2")!.clip;
    const right = M.find(p, rightId!)!.clip;
    expect(left.out).toBe(24);
    expect(right.in).toBe(24);
    expect(right.start).toBe(14);
    expect(M.duration(p)).toBe(20);
  });

  it("ignores splits at the very edge", () => {
    expect(M.split(project(), "c1", 0).rightId).toBeNull();
    expect(M.split(project(), "c1", 10).rightId).toBeNull();
  });

  it("delete and ripple delete", () => {
    expect(M.find(M.remove(project(), "c1"), "c2")!.clip.start).toBe(10);
    expect(M.find(M.remove(project(), "c1", true), "c2")!.clip.start).toBe(0);
  });

  it("moves with snapping to edges, markers and playhead", () => {
    let p = M.move(project(), "a1", 6.9, undefined, 0.2);
    expect(M.find(p, "a1")!.clip.start).toBe(7);
    p = M.move(project(), "a1", 4.1, undefined, 0.2, 4);
    expect(M.find(p, "a1")!.clip.start).toBe(4);
    p = M.move(project(), "a1", -5);
    expect(M.find(p, "a1")!.clip.start).toBe(0);
  });

  it("refuses to move video onto an audio track", () => {
    const p = M.move(project(), "c1", 0, "a");
    expect(M.find(p, "c1")!.track.id).toBe("v");
  });

  it("trims within the source media", () => {
    let p = M.trim(project(), "c2", "start", 12);
    expect(M.find(p, "c2")!.clip.in).toBe(22);
    p = M.trim(project(), "c2", "end", 100);
    expect(M.find(p, "c2")!.clip.out).toBe(60);
    p = M.trim(project(), "c1", "start", -3);
    expect(M.find(p, "c1")!.clip.in).toBe(0);
  });

  it("duplicates after the clip and makes room", () => {
    const { project: p, id } = M.duplicate(project(), "c1");
    expect(M.find(p, id!)!.clip.start).toBe(10);
    expect(M.find(p, "c2")!.clip.start).toBe(20);
  });

  it("freeze frame inserts a still and pushes the rest", () => {
    const p = M.freezeFrame(project(), "c1", 5, 2);
    const v = p.tracks[0].clips;
    expect(v.some((c) => c.freeze && c.start === 5 && M.clipLength(c) === 2)).toBe(true);
    expect(M.duration({ ...p, tracks: [p.tracks[0]] })).toBe(22);
  });

  it("speed is clamped", () => {
    expect(M.find(M.setSpeed(project(), "c1", 100), "c1")!.clip.speed).toBe(16);
  });

  it("removing silences shifts everything after", () => {
    const p = M.removeRanges(project(), [{ start: 2, end: 4 }, { start: 15, end: 16 }]);
    expect(M.duration(p)).toBeCloseTo(17, 6);
    expect(p.captions[0].start).toBeCloseTo(11, 6);
    expect(p.zooms[0].start).toBeCloseTo(10, 6);
    expect(p.zooms[0].end).toBeCloseTo(13, 6);
  });

  it("adds media to the right track and adopts the first video's size", () => {
    const base = { ...project(), media: [], tracks: project().tracks.map((t) => ({ ...t, clips: [] })) };
    const m: Media = { id: "n", path: "b.mov", kind: "video", duration: 8, width: 1281, height: 721, hasAudio: true, missing: false };
    const p = M.addMedia(base, m);
    expect(p.settings.width).toBe(1280);
    expect(p.tracks[0].clips.length).toBe(1);
    const img = M.addMedia(p, { ...m, id: "i", kind: "image" });
    expect(img.tracks.find((t) => t.kind === "overlay")!.clips[0].transform.scale).toBe(0.4);
  });

  it("text and shapes", () => {
    const { project: p, id } = M.addText(project(), 3, "Hello");
    expect(M.find(p, id)!.clip.text!.text).toBe("Hello");
    const s = M.addShape(p, 1, "blur");
    expect(M.find(s.project, s.id)!.clip.shape!.shape).toBe("blur");
  });

  it("zoom maths matches the export expression", () => {
    const z = [{ start: 2, end: 5, scale: 2, x: 0.8, y: 0.7 }];
    expect(M.zoomAt(z, 0.5, 1)).toBe(1);
    expect(M.zoomAt(z, 0.5, 2.25)).toBeCloseTo(1.5);
    expect(M.zoomAt(z, 0.5, 3.5)).toBe(2);
    expect(M.focusAt(z, 0.5, 3).x).toBe(0.8);
    expect(M.previewTransform(z, 0.33, 3.5)).toContain("scale(2)");
    expect(M.previewTransform(z, 0.5, 0)).toBe("none");
  });

  it("history undo/redo and persistence", () => {
    const h = new M.History(3);
    const a = project();
    const b = M.remove(a, "c1");
    h.push(a);
    const back = h.undo(b)!;
    expect(M.find(back, "c1")).not.toBeNull();
    expect(M.find(h.redo(back)!, "c1")).toBeNull();
    for (let i = 0; i < 10; i++) h.push(a);
    expect(h.toJSON().undo.length).toBe(3);
    const h2 = new M.History();
    h2.load(h.toJSON());
    expect(h2.undoStack.length).toBe(3);
    h2.load(null);
    expect(h2.undoStack.length).toBe(0);
  });

  it("transitions match the export rules", () => {
    const p = project();
    p.tracks[0].clips[1].transitionIn = { kind: "crossfade", duration: 1 };
    const v = M.withTransitions(p.tracks[0]);
    expect(v[1][0].start).toBe(9);
    expect(v[1][0].in).toBe(19);
    expect(v[1][1]).toBe(1);
    expect(M.clipEnd(v[1][0])).toBe(20);
    expect(v[0][0].fadeOut).toBe(1);
    p.tracks[0].clips[1].transitionIn = { kind: "dip", duration: 1 };
    const d = M.withTransitions(p.tracks[0]);
    expect([d[0][0].fadeOut, d[1][0].fadeIn, d[1][0].start]).toEqual([0.5, 0.5, 10]);
    expect(M.previousTouching(p, "c2")?.id).toBe("c1");
    expect(M.previousTouching(p, "c1")).toBeNull();
  });

  it("volume points interpolate and survive a split", () => {
    const keys = [{ t: 1, v: 1 }, { t: 3, v: 0.2 }];
    expect(M.volumeAt(keys, 0)).toBe(1);
    expect(M.volumeAt(keys, 2)).toBeCloseTo(0.6);
    expect(M.volumeAt(keys, 9)).toBe(0.2);
    expect(M.volumeAt(undefined, 2)).toBe(1);
    const p = project();
    p.tracks[2].clips[0].volumeKeys = keys;
    const { project: q, rightId } = M.split(p, "a1", 2);
    const left = M.find(q, "a1")!.clip.volumeKeys!;
    const right = M.find(q, rightId!)!.clip.volumeKeys!;
    expect(left[left.length - 1]).toEqual({ t: 2, v: expect.closeTo(0.6) });
    expect(right[0]).toEqual({ t: 0, v: expect.closeTo(0.6) });
    expect(right[1]).toEqual({ t: 1, v: 0.2 });
  });

  it("parses typed times", () => {
    expect(M.parseTime("83")).toBe(83);
    expect(M.parseTime("1:23")).toBe(83);
    expect(M.parseTime("1:02:03")).toBe(3723);
    expect(M.parseTime("00:01:23:15", 30)).toBe(83.5);
    expect(M.parseTime("1m20s")).toBe(80);
    expect(M.parseTime("2h")).toBe(7200);
    expect(M.parseTime("1.5m")).toBe(90);
    expect(M.parseTime("12,5")).toBe(12.5);
    expect(M.parseTime("abc")).toBeNull();
    expect(M.parseTime("")).toBeNull();
    expect(M.parseTime("1:2:3:4:5")).toBeNull();
  });

  it("source time honours speed, reverse and freeze", () => {
    expect(M.sourceTime(M.newClip({ start: 10, in: 5, out: 25, speed: 2 }), 12)).toBe(9);
    expect(M.sourceTime(M.newClip({ start: 0, in: 0, out: 10, reverse: true }), 2)).toBe(8);
    expect(M.sourceTime(M.newClip({ start: 0, in: 4, out: 6, freeze: true }), 1)).toBe(4);
  });
});

describe("themes", () => {
  it("every built-in theme passes WCAG AA", () => {
    const issues = THEMES.flatMap(auditTheme);
    expect(issues).toEqual([]);
  });
  it("there are five dark and five light themes", () => {
    expect(THEMES.filter((t) => t.dark).length).toBe(5);
    expect(THEMES.filter((t) => !t.dark).length).toBe(5);
  });
  it("follow system picks the right theme and accents stay readable", () => {
    const o = { theme: "obsidian", followSystem: true, darkTheme: "mercury", lightTheme: "quartz", accent: null };
    expect(resolveTheme(o, true).id).toBe("mercury");
    expect(resolveTheme(o, false).id).toBe("quartz");
    for (const t of THEMES) for (const acc of ["blue", "violet", "green", "orange", "pink"]) {
      const r = resolveTheme({ ...o, followSystem: false, theme: t.id, accent: acc }, true);
      expect(auditTheme(r), `${t.id}+${acc}`).toEqual([]);
    }
  });
  it("contrast maths", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });
  it("custom themes are validated", () => {
    expect(parseCustomTheme("nope").error).toBeTruthy();
    expect(parseCustomTheme(JSON.stringify({ bg: "#ffffff", surf: "#ffffff", raised: "#ffffff", text: "#eeeeee", muted: "#000000", accent: "#000000", btn: "#000000", on: "#ffffff" })).error).toContain("hard to read");
    const ok = parseCustomTheme(JSON.stringify({ name: "Mine", bg: "#101010", surf: "#151515", raised: "#1a1a1a", text: "#f0f0f0", muted: "#b0b0b0", accent: "#8ab4ff", btn: "#2b5be0", on: "#ffffff" }));
    expect(ok.theme?.dark).toBe(true);
  });
});

describe("search", () => {
  const e = (title: string, group: Entry["group"], keywords = ""): Entry => ({ id: title, title, group, sub: "", keywords, run: () => {} });
  const all = [e("Shrink a video to a target size", "Actions", "compress mb"), e("Record screen", "Actions"), e("Make a GIF", "Actions"), e("Theme and colors", "Settings"), e("Add captions", "Actions", "subtitles")];
  it("matches synonyms and ranks titles first", () => {
    expect(score(all[0], "smaller")).toBeGreaterThan(0);
    expect(rank(all, "subtitles")[0].items[0].title).toBe("Add captions");
    expect(rank(all, "dark")[0].group).toBe("Settings");
    expect(rank(all, "zzz")).toEqual([]);
    expect(rank(all, "").flatMap((g) => g.items).length).toBe(5);
  });
  it("handles '25 MB' style queries", () => {
    expect(score(all[0], "25 mb")).toBe(0);
    expect(score(all[0], "shrink")).toBeGreaterThan(score(all[0], "compress"));
  });
});

describe("shortcuts", () => {
  it("no preset has conflicts", () => {
    for (const [name, map] of Object.entries(PRESETS)) expect(conflicts(map), name).toEqual([]);
  });
  it("maps key events to actions", () => {
    const map = bindings("alchemist", {});
    const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true });
    expect(actionFor(ev, map, "editor")).toBe("search");
    expect(actionFor(new KeyboardEvent("keydown", { key: "s" }), map, "editor")).toBe("split");
    expect(actionFor(new KeyboardEvent("keydown", { key: "s" }), map, "global")).toBeNull();
    expect(bindings("alchemist", { split: "B" }).split).toBe("B");
  });
});

describe("format", () => {
  it("formats numbers for people", () => {
    expect(bytes(1.24 * 1024 ** 3)).toBe("1.24 GB");
    expect(bytes(24.8 * 1024 ** 2)).toBe("24.8 MB");
    expect(clock(187)).toBe("3:07");
    expect(clock(3723)).toBe("1:02:03");
    expect(timecode(62.5, 30)).toBe("00:01:02:15");
    expect(timecode(1.5, 60)).toBe("00:00:01:30");
    expect(timecode(1.5, 120)).toBe("00:00:01:60");
    expect(timecode(1.5, 144)).toBe("00:00:01:72");
    expect(timecode(1.5, 240)).toBe("00:00:01:120");
    expect(M.parseTime("00:00:01:60", 120)).toBe(1.5);
    expect(M.parseTime("00:00:01:72", 144)).toBe(1.5);
    expect(M.parseTime("00:00:01:120", 240)).toBe(1.5);
    expect(eta(30)).toBe("under a minute left");
    expect(ratio(1240, 24.8)).toBe("50× smaller");
    expect(ratio(10, 10)).toBe("about the same size");
    expect(ago(1000, 1000 + 7200)).toBe("2 h ago");
  });
});

describe("cursor effects", () => {
  const d = { path: [[0, 0, 0], [0.5, 50, 10], [1, 100, 20]] as [number, number, number][], rate: 2, clicks: [[0.6, 50, 10]] as [number, number, number][], keys: [[1, 2.2, "Ctrl + S"]] as [number, number, string][] };
  it("follows the path and hides outside the log", () => {
    expect(M.cursorAt(d, 0.25)).toEqual([25, 5]);
    expect(M.cursorAt(d, 5)).toBeNull();
    expect(M.cursorAt(null, 1)).toBeNull();
  });
  it("shows ripples briefly and keystrokes while held", () => {
    expect(M.clickAt(d, 0.7)?.x).toBe(50);
    expect(M.clickAt(d, 1.2)).toBeNull();
    expect(M.keyAt(d, 1.5)).toBe("Ctrl + S");
    expect(M.keyAt(d, 3)).toBeNull();
  });
});
