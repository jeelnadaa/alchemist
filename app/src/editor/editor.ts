// The editor: preview, a side panel that only shows what the selection
// needs, and a multi-track timeline. All edits go through editor/model.ts.

import { call, defaultCursor, fileUrl, type CursorData, type CursorSettings, pickFiles, pickFolder, pickSave, reveal, type Caption, type Clip, type Job, type Media, type Project, type Track, type Zoom } from "../api";
import { clear, debounce, h, icon } from "../dom";
import { clock, fileName, timecode } from "../format";
import { go, take, type Route } from "../router";
import { actionFor, bindings } from "../shortcuts";
import type { Shell } from "../shell";
import { store } from "../store";
import { chipGroup, errorText, modal, rangeControl, toast, toggleRow } from "../ui/common";
import { openPalette, rememberFile } from "../ui/palette";
import { openExport } from "./exportDialog";
import * as M from "./model";

type Sel = { kind: "clip"; id: string } | { kind: "zoom"; index: number } | null;

const PLAYABLE = /\.(mp4|m4v|webm|mov|mp3|wav|m4a|aac|ogg|opus|flac|png|jpe?g|webp|gif)$/i;

export async function mount(shell: Shell, route: Route) {
  let project: Project;
  try {
    project = await openProject(route.arg);
  } catch (e) {
    toast(errorText(e), { error: true });
    go("");
    return;
  }
  localStorage.setItem("alc-last-project", project.id);
  const ed = new Editor(shell, project);
  await ed.init();
  const want = take<string>("editor-open");
  if (want) ed.openRequest(want);
  return () => ed.destroy();
}

async function openProject(arg: string | null): Promise<Project> {
  if (arg && arg !== "new") return call<Project>("project_load", { id: arg });
  let files = take<string[]>("new-edit-files");
  take("new-edit");
  if (!files) files = await pickFiles({ multiple: true });
  if (!files.length) throw "No video chosen.";
  files.forEach(rememberFile);
  const media = await call<Media[]>("media_import", { paths: files });
  const first = media.find((m) => m.kind === "video");
  let p = await call<Project>("project_new", { name: fileName(files[0]).replace(/\.[^.]+$/, ""), width: first?.width || 1920, height: first?.height || 1080, fps: 30 });
  for (const m of media) p = M.addMedia(p, m);
  await call("project_save", { project: p });
  history.replaceState(null, "", `#/edit/${p.id}`);
  return p;
}

class Editor {
  p: Project;
  hist = new M.History();
  sel: Sel = null;
  t = 0;
  playing = false;
  pxPerSec = 40;
  openSection = "";
  showAll = false;
  saved = true;
  private raf = 0;
  private lastFrame = 0;
  private videos = new Map<string, HTMLVideoElement | HTMLAudioElement | HTMLImageElement>();
  private cursorCache: { key: string; data: CursorData | null } | null = null;
  private urls = new Map<string, string>();
  private waves = new Map<string, number[]>();
  private proxies = new Map<string, string>();
  private unsubs: (() => void)[] = [];
  // DOM
  root!: HTMLElement;
  stage!: HTMLElement;
  canvas!: HTMLElement;
  overlayLayer!: HTMLElement;
  inspector!: HTMLElement;
  tl!: HTMLElement;
  tlGrid!: HTMLElement;
  playhead!: HTMLElement;
  timeEl!: HTMLInputElement;
  durEl!: HTMLElement;
  zoomInput!: HTMLInputElement;
  timelineEl!: HTMLElement;
  hoverLine!: HTMLElement;
  private seekRaf = 0;
  playBtn!: HTMLButtonElement;
  banner!: HTMLElement;
  savedEl!: HTMLElement;
  nameEl!: HTMLElement;

  constructor(private shell: Shell, p: Project) {
    this.p = p;
  }

  async init() {
    this.hist.load(await call<{ undo: string[]; redo: string[] }>("history_load", { id: this.p.id }).catch(() => null));
    this.buildDom();
    this.unsubs.push(store.sub("jobs", () => this.onJobs()));
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    document.addEventListener("keydown", onKey);
    this.unsubs.push(() => document.removeEventListener("keydown", onKey));
    const onResize = () => {
      // A smaller window shrinks a tall timeline so the preview stays usable.
      if (!this.timelineEl.classList.contains("collapsed") && this.timelineHeight() > window.innerHeight * 0.45) {
        this.setTimelineHeight(this.timelineHeight(), false);
      } else this.layoutStage();
    };
    window.addEventListener("resize", onResize);
    this.unsubs.push(() => window.removeEventListener("resize", onResize));
    await this.loadMedia();
    this.renderAll();
    this.checkMissing();
    this.suggestSilence();
  }

  destroy() {
    this.pause();
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    for (const el of this.videos.values()) if (el instanceof HTMLMediaElement) { el.pause(); el.removeAttribute("src"); el.load(); }
    this.saveNow();
  }

  // ------------------------------------------------------------ editing

  commit(next: Project, keepSel = true) {
    if (next === this.p) return;
    this.hist.push(this.p);
    this.p = next;
    if (!keepSel && this.sel?.kind === "clip" && !M.find(this.p, this.sel.id)) this.sel = null;
    if (this.sel?.kind === "clip" && !M.find(this.p, this.sel.id)) this.sel = null;
    this.markDirty();
    this.renderAll();
  }

  markDirty() {
    this.saved = false;
    this.savedEl.textContent = "Saving…";
    this.save();
  }

  save = debounce(() => this.saveNow(), 700);

  async saveNow() {
    try {
      await call("project_save", { project: this.p });
      await call("history_save", { id: this.p.id, history: this.hist.toJSON() });
      this.saved = true;
      if (this.savedEl) this.savedEl.replaceChildren(icon("check", 13), "Saved");
    } catch (e) {
      if (this.savedEl) this.savedEl.textContent = "Not saved";
      toast(`Couldn't save: ${errorText(e)}`, { error: true });
    }
  }

  undo() {
    const prev = this.hist.undo(this.p);
    if (prev) { this.p = prev; this.markDirty(); this.renderAll(); }
  }
  redo() {
    const next = this.hist.redo(this.p);
    if (next) { this.p = next; this.markDirty(); this.renderAll(); }
  }

  selectedClip(): { track: Track; clip: Clip } | null {
    return this.sel?.kind === "clip" ? M.find(this.p, this.sel.id) : null;
  }

  // ------------------------------------------------------------ DOM

  buildDom() {
    this.nameEl = h("strong", { tabindex: "0", title: "Click to rename", style: { cursor: "text" }, onclick: () => this.rename() }, this.p.name);
    this.savedEl = h("span", { class: "tiny muted row", style: { gap: "4px" } }, icon("check", 13), "Saved");
    this.shell.setCrumbs(h("span", { class: "row", style: { gap: "8px" } }, h("a", { href: "#/projects" }, "Projects"), h("span", { class: "muted" }, "/"), this.nameEl, this.savedEl));
    this.shell.setTitleRight(h("div", { class: "row", style: { gap: "4px" } },
      h("button", { type: "button", class: "icon-btn", "aria-label": "Undo", "data-tooltip": "Undo (Ctrl Z)", "data-tooltip-pos": "bottom", onclick: () => this.undo() }, icon("undo", 18)),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Redo", "data-tooltip": "Redo (Ctrl Shift Z)", "data-tooltip-pos": "bottom", onclick: () => this.redo() }, icon("redo", 18)),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Project options", "data-tooltip": "Project options", "data-tooltip-pos": "bottom", onclick: () => this.projectMenu() }, icon("more", 18)),
      h("button", { type: "button", class: "btn primary", "data-tooltip": "Export video (Ctrl E)", "data-tooltip-pos": "bottom", style: { height: "36px", marginLeft: "6px" }, onclick: () => this.export() }, "Export")));

    this.banner = h("div", { class: "col", style: { gap: "8px" } });
    this.canvas = h("div", { class: "canvas" });
    this.overlayLayer = h("div", { class: "canvas", style: { pointerEvents: "none" } });
    this.stage = h("div", { class: "stage", role: "img", "aria-label": "Video preview" }, this.canvas, this.overlayLayer);
    this.timeEl = h("input", { class: "timecode mono small", type: "text", spellcheck: false, "aria-label": "Current time. Type a time and press Enter to jump there", title: "Type a time like 1:23, 83, 1m20s or 00:01:23:10, then press Enter" }) as HTMLInputElement;
    this.timeEl.addEventListener("focus", () => this.timeEl.select());
    this.timeEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const t = M.parseTime(this.timeEl.value, this.p.settings.fps);
        if (t == null) {
          toast("Type a time like 1:23, 83, 1m20s or 00:01:23:10.");
          return;
        }
        this.seek(t);
        this.timeEl.blur();
      } else if (e.key === "Escape") {
        this.timeEl.blur();
      }
      e.stopPropagation();
    });
    this.timeEl.addEventListener("blur", () => this.updateTime());
    this.durEl = h("span", { class: "mono small muted" });
    this.playBtn = h("button", { type: "button", class: "play", "aria-label": "Play", "data-tooltip": "Play / Pause (Space)", "data-tooltip-pos": "top", onclick: () => this.toggle() }, icon("play", 16)) as HTMLButtonElement;
    const preview = h("section", { class: "ed-preview", "aria-label": "Preview" },
      this.banner,
      h("div", { class: "stage-wrap" }, this.stage),
      h("div", { class: "transport" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "Back 5 seconds", "data-tooltip": "Back 5s (← or J)", "data-tooltip-pos": "top", onclick: () => this.seek(this.t - 5) }, icon("back", 18)),
        this.playBtn,
        h("button", { type: "button", class: "icon-btn", "aria-label": "Forward 5 seconds", "data-tooltip": "Forward 5s (→ or L)", "data-tooltip-pos": "top", onclick: () => this.seek(this.t + 5) }, icon("forward", 18)),
        h("span", { class: "row", style: { gap: "4px" } }, this.timeEl, this.durEl)));
    this.inspector = h("aside", { class: "inspector", "aria-label": "Settings for the selection" });
    this.tl = h("div", { class: "tl-scroll" });
    const tools = h("div", { class: "tl-tools", role: "toolbar", "aria-label": "Timeline tools" },
      this.tool("split", "Split", "S", () => this.split()),
      this.tool("trash", "Delete", "", () => this.deleteSel(false)),
      h("span", { style: { width: "1px", height: "22px", background: "var(--line)", margin: "0 6px" } }),
      this.tool("text", "Text", "", () => this.addText()),
      this.tool("box", "Shapes & blur", "", () => this.shapesMenu()),
      this.tool("captions", "Captions", "", () => this.openRequest("captions")),
      this.tool("media", "Add media", "", () => this.addMediaFiles()),
      this.tool("marker", "Marker", "M", () => this.addMarker()),
      h("span", { class: "grow" }),
      h("span", { class: "tiny muted" }, "Zoom"),
      (() => {
        const r = h("input", { type: "range", min: "5", max: "300", value: String(this.pxPerSec), "aria-label": "Timeline zoom (Ctrl + scroll also zooms)", "data-tooltip": "Timeline zoom", "data-tooltip-pos": "top", style: { width: "120px", marginLeft: "8px" } }) as HTMLInputElement;
        r.style.setProperty("--fill", `${((this.pxPerSec - 5) / 295) * 100}%`);
        r.addEventListener("input", () => this.setZoom(+r.value));
        this.zoomInput = r;
        return r;
      })(),
      h("button", { type: "button", class: "icon-btn", "data-tooltip": "Fit video in timeline (Ctrl 0)", "data-tooltip-pos": "top", "aria-label": "Fit the whole video in the timeline", onclick: () => this.zoomToFit() }, icon("box", 15)),
      h("button", { type: "button", class: "icon-btn tl-collapse", "data-tooltip": "Expand / shrink timeline", "data-tooltip-pos": "top", "aria-label": "Shrink or expand the timeline", onclick: () => this.toggleTimeline() }, icon("chevron", 16)));
    const splitter = h("div", { class: "tl-splitter", role: "separator", "aria-orientation": "horizontal", "aria-label": "Drag to resize the timeline", tabindex: "0", title: "Drag to resize. Double-click to shrink or expand." });
    splitter.addEventListener("mousedown", (e) => this.dragSplitter(e));
    splitter.addEventListener("dblclick", () => this.toggleTimeline());
    splitter.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        this.setTimelineHeight(this.timelineHeight() + (e.key === "ArrowUp" ? 30 : -30));
      }
    });
    this.timelineEl = h("section", { class: "timeline", "aria-label": "Timeline" }, tools, this.tl);
    this.root = h("div", { class: "editor" },
      h("div", { class: "ed-top" }, preview, this.inspector),
      splitter,
      this.timelineEl);
    this.setTimelineHeight(Number(localStorage.getItem("alc-tl-height")) || 270, false);
    if (localStorage.getItem("alc-tl-collapsed") === "1") this.timelineEl.classList.add("collapsed");
    this.tl.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.tl.addEventListener("mousemove", (e) => this.onHover(e));
    this.tl.addEventListener("mouseleave", () => this.hoverLine?.classList.add("hidden"));
    this.shell.main.appendChild(this.root);
    new ResizeObserver(() => this.layoutStage()).observe(this.stage.parentElement!);
  }

  tool(ic: Parameters<typeof icon>[0], label: string, key: string, run: () => void) {
    return h("button", { type: "button", class: "tool", onclick: run }, icon(ic, 15), label, key ? h("span", { class: "k" }, key) : null);
  }

  renderAll() {
    this.layoutStage();
    this.renderStage();
    this.renderInspector();
    this.renderTimeline();
  }

  // ------------------------------------------------------------ media

  async loadMedia() {
    for (const m of this.p.media) await this.ensureMedia(m);
  }

  async ensureMedia(m: Media) {
    if (this.urls.has(m.id) || m.missing) return;
    const playable = PLAYABLE.test(m.path) || m.path.startsWith("blob:");
    if (!playable && m.kind !== "audio") {
      const cached = localStorage.getItem(`alc-proxy:${m.path}`);
      if (cached && (await call<boolean>("file_exists", { path: cached }))) {
        this.urls.set(m.id, await fileUrl(cached));
      } else {
        const job = await call<Job>("make_proxy", { path: m.path, duration: m.duration });
        store.jobs.set(job.id, job);
        this.proxies.set(job.id, m.id);
        this.banner.appendChild(h("div", { class: "notice", dataset: { proxy: job.id } }, h("span", { class: "grow" }, `Preparing a smooth preview of ${fileName(m.path)}. Editing works already; exports always use the original.`)));
      }
    } else {
      this.urls.set(m.id, await fileUrl(m.path));
    }
    if (m.hasAudio || m.kind === "audio") {
      call<number[]>("waveform", { path: m.path, buckets: Math.min(4000, Math.max(200, Math.round(m.duration * 20))) })
        .then((w) => { this.waves.set(m.id, w); this.renderTimeline(); })
        .catch(() => {});
    }
  }

  onJobs() {
    for (const [jobId, mediaId] of this.proxies) {
      const j = store.jobs.get(jobId);
      if (!j || (j.status !== "done" && j.status !== "failed")) continue;
      this.proxies.delete(jobId);
      this.banner.querySelector(`[data-proxy="${jobId}"]`)?.remove();
      const m = this.p.media.find((x) => x.id === mediaId);
      if (j.status === "done" && m) {
        localStorage.setItem(`alc-proxy:${m.path}`, j.output);
        fileUrl(j.output).then((u) => { this.urls.set(mediaId, u); for (const k of [...this.videos.keys()]) if (k === mediaId || k.startsWith(`${mediaId}#`)) this.videos.delete(k); this.renderStage(); });
      }
    }
  }

  element(m: Media, slot = 0): HTMLVideoElement | HTMLAudioElement | HTMLImageElement | null {
    const key = slot ? `${m.id}#${slot}` : m.id;
    let el = this.videos.get(key);
    const url = this.urls.get(m.id);
    if (!url) return null;
    if (!el) {
      if (m.kind === "image") el = h("img", { class: "media", src: url, alt: "" }) as HTMLImageElement;
      else if (m.kind === "audio") { el = new Audio(url); el.preload = "auto"; }
      else { el = h("video", { preload: "auto", playsInline: true }) as HTMLVideoElement; el.src = url; }
      this.videos.set(key, el);
    }
    return el;
  }

  // ------------------------------------------------------------ preview

  layoutStage() {
    const wrap = this.stage.parentElement as HTMLElement;
    if (!wrap) return;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const ar = this.p.settings.width / this.p.settings.height;
    let w = W;
    let hgt = W / ar;
    if (hgt > H) { hgt = H; w = H * ar; }
    this.stage.style.width = `${Math.floor(w)}px`;
    this.stage.style.height = `${Math.floor(hgt)}px`;
    this.stage.style.setProperty("--scale", String(w / this.p.settings.width));
  }

  renderStage() {
    const p = this.p;
    const scale = this.stage.clientWidth / p.settings.width || 1;
    const pad = Math.min(p.settings.padding, Math.min(p.settings.width, p.settings.height) / 3) * scale;
    this.canvas.style.background = p.settings.background || "#000";
    clear(this.canvas);
    clear(this.overlayLayer);
    const visual = p.tracks.filter((t) => t.kind === "video" || t.kind === "overlay");
    const audible: { el: HTMLMediaElement; clip: Clip; track: Track }[] = [];
    const overlays = document.createDocumentFragment();
    const anyVisible = visual.some((t) => M.clipAt(t, this.t));
    let recBox: { left: number; top: number; w: number; h: number; clip: Clip } | null = null;
    for (const track of visual) {
      const slots = new Map<string, number>();
      for (const [c] of M.withTransitions(track)) {
      if (this.t < c.start || this.t >= M.clipEnd(c) || !c.mediaId) continue;
      const m = M.mediaOf(p, c);
      if (!m) continue;
      const slot = slots.get(m.id) ?? 0;
      slots.set(m.id, slot + 1);
      const el = this.element(m, slot);
      const box = h("div", { class: "layer" });
      const tr = c.transform;
      const sc = tr.scale || 1;
      // Same maths as the export: fit the picture's shape into the padded box.
      let bw = (this.stage.clientWidth - 2 * pad) * sc;
      let bh = (this.stage.clientHeight - 2 * pad) * sc;
      if (track.kind === "video" && m.width > 0 && m.height > 0) {
        const rotated = ((tr.rotate || 0) % 180 + 180) % 180 === 90;
        const [mw, mh] = rotated ? [m.height, m.width] : [m.width, m.height];
        const f = Math.min(bw / mw, bh / mh);
        bw = mw * f;
        bh = mh * f;
      }
      Object.assign(box.style, {
        left: `${(this.stage.clientWidth - bw) / 2 + tr.x * this.stage.clientWidth}px`,
        top: `${(this.stage.clientHeight - bh) / 2 + tr.y * this.stage.clientHeight}px`,
        width: `${bw}px`,
        height: `${bh}px`,
        borderRadius: track.kind === "video" && p.settings.radius && pad ? `${p.settings.radius * scale}px` : track.kind === "overlay" && m.kind === "video" ? "50%" : "0",
        boxShadow: track.kind === "video" && p.settings.shadow && pad ? `0 ${Math.max(2, this.stage.clientHeight / 90)}px ${Math.max(6, pad)}px rgba(0,0,0,0.55)` : "none",
        overflow: "hidden",
        transform: `${tr.flipH ? "scaleX(-1)" : ""} ${tr.flipV ? "scaleY(-1)" : ""} rotate(${tr.rotate || 0}deg)`,
        opacity: String(this.fadeAt(c)),
      });
      if (track.kind === "video" && m.id === p.eventsMedia && !recBox) {
        recBox = { left: (this.stage.clientWidth - bw) / 2 + tr.x * this.stage.clientWidth, top: (this.stage.clientHeight - bh) / 2 + tr.y * this.stage.clientHeight, w: bw, h: bh, clip: c };
      }
      if (el) {
        box.appendChild(el);
        if (el instanceof HTMLMediaElement) {
          if (track.kind === "overlay") (el as HTMLVideoElement).style.objectFit = "cover";
          const want = M.sourceTime(c, this.t);
          if (Math.abs(el.currentTime - want) > (this.playing ? 0.25 : 0.03)) el.currentTime = want;
          el.playbackRate = Math.min(4, Math.max(0.25, c.speed));
          audible.push({ el, clip: c, track });
        }
      } else {
        box.appendChild(h("span", { class: "muted small" }, m.missing ? `Missing: ${fileName(m.path)}` : "Preparing preview…"));
      }
      // Overlays sit above the zoom, exactly like the export.
      (track.kind === "overlay" ? overlays : this.canvas).appendChild(box);
      }
    }
    if (!anyVisible) this.canvas.appendChild(h("div", { class: "layer", style: { inset: "0" } }, h("span", { class: "muted small" }, this.p.tracks.every((t) => !t.clips.length) ? "Add a video to begin" : "")));

    // Audio-only clips.
    for (const track of p.tracks.filter((t) => t.kind === "audio")) {
      const c = M.clipAt(track, this.t);
      if (!c?.mediaId) continue;
      const m = M.mediaOf(p, c);
      const el = m && this.element(m);
      if (el instanceof HTMLMediaElement) {
        const want = M.sourceTime(c, this.t);
        if (Math.abs(el.currentTime - want) > (this.playing ? 0.25 : 0.03)) el.currentTime = want;
        el.playbackRate = Math.min(4, Math.max(0.25, c.speed));
        audible.push({ el, clip: c, track });
      }
    }
    // Play/pause and volume for whatever is under the playhead; pause the rest.
    const active = new Set(audible.map((a) => a.el));
    for (const el of this.videos.values()) if (el instanceof HTMLMediaElement && !active.has(el) && !el.paused) el.pause();
    for (const a of audible) {
      const media = M.mediaOf(p, a.clip);
      const soundFromVideoTrack = a.track.kind === "video" || a.track.kind === "audio";
      a.el.muted = a.track.muted || !soundFromVideoTrack || (media?.kind === "video" && a.track.kind !== "video");
      a.el.volume = Math.min(1, Math.max(0, a.clip.volume * a.track.volume * this.fadeAt(a.clip) * M.volumeAt(a.clip.volumeKeys, this.t - a.clip.start)));
      if (this.playing && a.el.paused && !a.clip.freeze) a.el.play().catch(() => {});
      if ((!this.playing || a.clip.freeze) && !a.el.paused) a.el.pause();
    }

    if (recBox) this.drawCursor(recBox);

    // Zoom applies to the picture (like export); overlays, text and shapes sit on top.
    this.canvas.style.transform = M.previewTransform(p.zooms, p.zoomSmoothness, this.t);
    this.overlayLayer.appendChild(overlays);

    for (const track of p.tracks.filter((t) => t.kind === "text" || t.kind === "overlay")) {
      for (const c of track.clips) {
        if (this.t < c.start || this.t >= M.clipEnd(c)) continue;
        const selected = this.sel?.kind === "clip" && this.sel.id === c.id;
        if (c.text) {
          const sizePx = (c.text.size || 48) * (this.stage.clientHeight / 1080);
          const el = h("div", { class: `txt${selected ? " selected" : ""}`, style: { fontSize: `${sizePx}px`, color: c.text.color || "#fff", top: c.text.position === "top" ? "8%" : c.text.position === "middle" ? "50%" : "auto", bottom: c.text.position === "bottom" || !c.text.position ? "8%" : "auto", transform: c.text.position === "middle" ? "translate(-50%,-50%)" : "translateX(-50%)", opacity: String(c.text.animation === "fade" && this.playing ? this.fadeText(c) : 1), pointerEvents: "auto" } }, c.text.text);
          el.addEventListener("mousedown", (e) => { e.stopPropagation(); this.select({ kind: "clip", id: c.id }); });
          el.addEventListener("dblclick", () => { this.openSection = "Text"; this.renderInspector(); (this.inspector.querySelector("textarea") as HTMLTextAreaElement | null)?.focus(); });
          this.overlayLayer.appendChild(el);
        }
        if (c.shape) this.overlayLayer.appendChild(c.shape.shape === "arrow" ? this.arrowEl(c, selected) : this.shapeEl(c, selected));
      }
    }
    for (const cap of p.captions) {
      if (this.t >= cap.start && this.t < cap.end) {
        this.overlayLayer.appendChild(h("div", { class: "txt", style: { fontSize: `${44 * (this.stage.clientHeight / 1080)}px`, bottom: "8%" } }, cap.text));
      }
    }
    this.updateTime();
    if (this.playhead) this.playhead.style.transform = `translateX(${this.t * this.pxPerSec}px)`;
  }

  updateTime() {
    if (document.activeElement !== this.timeEl) this.timeEl.value = timecode(this.t, Math.round(this.p.settings.fps));
    this.durEl.textContent = `/ ${clock(M.duration(this.p))}`;
  }

  fadeAt(c: Clip): number {
    const local = this.t - c.start;
    const len = M.clipLength(c);
    let a = 1;
    if (c.fadeIn > 0) a = Math.min(a, local / c.fadeIn);
    if (c.fadeOut > 0) a = Math.min(a, (len - local) / c.fadeOut);
    return Math.max(0, Math.min(1, a));
  }

  fadeText(c: Clip): number {
    return Math.max(0, Math.min(1, (this.t - c.start) / 0.3, (M.clipEnd(c) - this.t) / 0.3));
  }

  arrowEl(c: Clip, selected: boolean): HTMLElement {
    const ns = "http://www.w3.org/2000/svg";
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const [x, y, dx, dy] = c.shape!.rect;
    const color = c.shape!.color || "#ff3b30";
    const wrap = h("div", { class: `arrow-shape${selected ? " selected" : ""}`, style: { position: "absolute", inset: "0", pointerEvents: "none" } });
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.style.position = "absolute";
    svg.style.inset = "0";
    svg.style.overflow = "visible";
    const th = Math.max(3, H * 0.009);
    const x1 = x * W, y1 = y * H, x2 = (x + dx) * W, y2 = (y + dy) * H;
    const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const hl = Math.min(th * 5, len * 0.6), hw = th * 3.2;
    const bx = x2 - ux * hl, by = y2 - uy * hl;
    const line = document.createElementNS(ns, "line");
    Object.entries({ x1, y1, x2: bx, y2: by, stroke: color, "stroke-width": th, "stroke-linecap": "round" }).forEach(([k, v]) => line.setAttribute(k, String(v)));
    const head = document.createElementNS(ns, "polygon");
    head.setAttribute("points", `${x2},${y2} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}`);
    head.setAttribute("fill", color);
    const hit = document.createElementNS(ns, "line");
    Object.entries({ x1, y1, x2, y2, stroke: "transparent", "stroke-width": Math.max(16, th * 4) }).forEach(([k, v]) => hit.setAttribute(k, String(v)));
    hit.style.pointerEvents = "stroke";
    hit.style.cursor = "move";
    svg.append(line, head, hit);
    wrap.appendChild(svg);
    const handle = (hx: number, hy: number) => h("span", { class: "arrow-handle", style: { left: `${hx - 6}px`, top: `${hy - 6}px`, display: selected ? "block" : "none" } });
    const hStart = handle(x1, y1);
    const hEnd = handle(x2, y2);
    wrap.append(hStart, hEnd);
    const drag = (e: MouseEvent, mode: "move" | "start" | "end") => {
      e.preventDefault();
      e.stopPropagation();
      this.selectQuiet({ kind: "clip", id: c.id });
      const r = this.stage.getBoundingClientRect();
      const s0 = { x: e.clientX, y: e.clientY };
      const o = [...c.shape!.rect] as [number, number, number, number];
      const before = this.p;
      let next = before;
      const mv = (ev: MouseEvent) => {
        const mx = (ev.clientX - s0.x) / r.width;
        const my = (ev.clientY - s0.y) / r.height;
        next = M.update(before, c.id, (cl) => {
          if (mode === "move") cl.shape!.rect = [o[0] + mx, o[1] + my, o[2], o[3]];
          else if (mode === "start") cl.shape!.rect = [o[0] + mx, o[1] + my, o[2] - mx, o[3] - my];
          else cl.shape!.rect = [o[0], o[1], o[2] + mx, o[3] + my];
        });
        this.p = next;
        this.renderStage();
      };
      const up = () => {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        this.p = before;
        if (next !== before) this.commit(next);
        else this.renderAll();
      };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    };
    hit.addEventListener("mousedown", (e) => drag(e as MouseEvent, "move"));
    hStart.addEventListener("mousedown", (e) => drag(e, "start"));
    hEnd.addEventListener("mousedown", (e) => drag(e, "end"));
    return wrap;
  }

  shapeEl(c: Clip, selected: boolean): HTMLElement {
    const [x, y, w, hh] = c.shape!.rect;
    const el = h("div", { class: `shape ${c.shape!.shape}${selected ? " selected" : ""}`, style: { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${hh * 100}%`, borderColor: c.shape!.color || "var(--accent)", pointerEvents: "auto" } });
    const grip = h("span", { style: { position: "absolute", right: "-6px", bottom: "-6px", width: "12px", height: "12px", background: "#fff", borderRadius: "3px", cursor: "nwse-resize" } });
    el.appendChild(grip);
    const drag = (e: MouseEvent, mode: "move" | "size") => {
      e.preventDefault();
      e.stopPropagation();
      this.select({ kind: "clip", id: c.id });
      const r = this.stage.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY };
      const orig = [...c.shape!.rect] as [number, number, number, number];
      const before = this.p;
      let next = this.p;
      const move = (ev: MouseEvent) => {
        const dx = (ev.clientX - start.x) / r.width;
        const dy = (ev.clientY - start.y) / r.height;
        next = M.update(before, c.id, (cl) => {
          cl.shape!.rect = mode === "move"
            ? [Math.min(1 - orig[2], Math.max(0, orig[0] + dx)), Math.min(1 - orig[3], Math.max(0, orig[1] + dy)), orig[2], orig[3]]
            : [orig[0], orig[1], Math.max(0.03, Math.min(1 - orig[0], orig[2] + dx)), Math.max(0.03, Math.min(1 - orig[1], orig[3] + dy))];
        });
        this.p = next;
        this.renderStage();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        this.p = before;
        this.commit(next);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    el.addEventListener("mousedown", (e) => drag(e, "move"));
    grip.addEventListener("mousedown", (e) => drag(e, "size"));
    return el;
  }

  // ------------------------------------------------------------ playback

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  play() {
    if (this.t >= M.duration(this.p) - 0.05) this.t = this.p.inPoint ?? 0;
    this.playing = true;
    this.playBtn.replaceChildren(icon("pause", 16));
    this.playBtn.setAttribute("aria-label", "Pause");
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.playing) return;
      this.t += (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      const end = this.p.outPoint ?? M.duration(this.p);
      if (this.t >= end) { this.t = end; this.pause(); }
      this.renderStage();
      this.followPlayhead();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const el of this.videos.values()) if (el instanceof HTMLMediaElement) el.pause();
    if (this.playBtn) { this.playBtn.replaceChildren(icon("play", 16)); this.playBtn.setAttribute("aria-label", "Play"); }
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(M.duration(this.p), t));
    this.renderStage();
    this.followPlayhead();
  }

  followPlayhead() {
    const x = this.t * this.pxPerSec + 122;
    const sc = this.tl;
    if (x < sc.scrollLeft + 130 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - 200);
  }

  // ------------------------------------------------------------ timeline

  timelineHeight(): number {
    return this.timelineEl.getBoundingClientRect().height || 270;
  }

  setTimelineHeight(px: number, save = true) {
    // Keep most of the window for the preview.
    const max = Math.max(160, window.innerHeight * 0.45);
    const hgt = Math.round(Math.min(max, Math.max(130, px)));
    this.timelineEl.style.height = `${hgt}px`;
    this.timelineEl.classList.remove("collapsed");
    if (save) {
      localStorage.setItem("alc-tl-height", String(hgt));
      localStorage.setItem("alc-tl-collapsed", "0");
    }
    this.layoutStage();
  }

  toggleTimeline() {
    const collapsed = this.timelineEl.classList.toggle("collapsed");
    localStorage.setItem("alc-tl-collapsed", collapsed ? "1" : "0");
    setTimeout(() => this.layoutStage(), 200);
  }

  dragSplitter(e: MouseEvent) {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = this.timelineEl.classList.contains("collapsed") ? 46 : this.timelineHeight();
    document.body.style.cursor = "row-resize";
    this.timelineEl.classList.add("resizing");
    let raf = 0;
    const mv = (ev: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.setTimelineHeight(h0 + (y0 - ev.clientY)));
    };
    const up = () => {
      document.body.style.cursor = "";
      this.timelineEl.classList.remove("resizing");
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  }

  /** Zoom keeping the time under `anchorX` (client px) in place. */
  setZoom(px: number, anchorX?: number) {
    const next = Math.min(300, Math.max(5, px));
    const rect = this.tl.getBoundingClientRect();
    const ax = anchorX ?? rect.left + rect.width / 2;
    const tAtAnchor = (this.tl.scrollLeft + ax - rect.left - 122) / this.pxPerSec;
    this.pxPerSec = next;
    if (this.zoomInput) {
      this.zoomInput.value = String(Math.round(next));
      this.zoomInput.style.setProperty("--fill", `${((next - 5) / 295) * 100}%`);
    }
    this.renderTimeline();
    this.tl.scrollLeft = Math.max(0, tAtAnchor * next + 122 - (ax - rect.left));
  }

  zoomToFit() {
    const avail = this.tl.clientWidth - 150;
    this.setZoom(avail / Math.max(M.duration(this.p), 1));
    this.tl.scrollLeft = 0;
  }

  onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.setZoom(this.pxPerSec * Math.exp(-e.deltaY * 0.0015), e.clientX);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.tl.scrollHeight <= this.tl.clientHeight + 2) {
      // Plain scroll pans sideways when there's nothing to scroll vertically.
      e.preventDefault();
      this.tl.scrollLeft += e.deltaY;
    }
  }

  onHover(e: MouseEvent) {
    if (!this.hoverLine || !this.tlGrid) return;
    const r = this.tlGrid.getBoundingClientRect();
    const x = e.clientX - r.left - 122;
    if (x < 0) {
      this.hoverLine.classList.add("hidden");
      return;
    }
    this.hoverLine.classList.remove("hidden");
    this.hoverLine.style.transform = `translateX(${x}px)`;
    this.hoverLine.dataset.time = clock(x / this.pxPerSec);
  }

  /** Seek without rebuilding anything but the preview, at most once per frame. */
  scrubTo(t: number) {
    this.t = Math.max(0, Math.min(M.duration(this.p), t));
    if (this.playhead) this.playhead.style.transform = `translateX(${this.t * this.pxPerSec}px)`;
    cancelAnimationFrame(this.seekRaf);
    this.seekRaf = requestAnimationFrame(() => this.renderStage());
  }

  renderTimeline() {
    const p = this.p;
    const total = Math.max(M.duration(p) + 10, 30);
    const width = total * this.pxPerSec;
    const keepScroll = this.tl.scrollLeft;
    clear(this.tl);
    const grid = h("div", { class: "tl-grid", style: { width: `${width + 140}px` } });
    // Ruler
    const ruler = h("div", { class: "tl-ruler", role: "slider", "aria-label": "Playhead", "aria-valuemin": "0", "aria-valuemax": String(Math.round(M.duration(p))), "aria-valuenow": String(Math.round(this.t)) });
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * this.pxPerSec >= 70) || 600;
    for (let s = 0; s <= total; s += step) ruler.appendChild(h("span", { style: { left: `${s * this.pxPerSec}px` } }, clock(s)));
    for (const mk of p.markers) ruler.appendChild(h("span", { class: "marker", title: mk.label || "Marker", style: { left: `${mk.t * this.pxPerSec}px` } }));
    const seekFrom = (e: MouseEvent) => {
      const r = ruler.getBoundingClientRect();
      this.scrubTo((e.clientX - r.left) / this.pxPerSec);
    };
    ruler.addEventListener("mousedown", (e) => {
      seekFrom(e);
      const mv = (ev: MouseEvent) => seekFrom(ev);
      const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
    grid.append(h("span"), ruler);

    // Zoom lane (only if there are zooms).
    if (p.zooms.length) {
      const lane = h("div", { class: "tl-lane" });
      p.zooms.forEach((z, i) => {
        const el = h("button", { type: "button", class: `tl-zoom${this.sel?.kind === "zoom" && this.sel.index === i ? " sel" : ""}`, style: { left: `${z.start * this.pxPerSec}px`, width: `${Math.max(14, (z.end - z.start) * this.pxPerSec)}px`, border: "0", color: "var(--text)" }, onclick: () => this.select({ kind: "zoom", index: i }) }, `${z.scale.toFixed(1)}×`);
        lane.appendChild(el);
      });
      grid.append(h("div", { class: "tl-label" }, "Zoom"), lane);
    }

    for (const track of p.tracks) {
      const label = h("div", { class: "tl-label" },
        h("span", { class: "grow", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, track.name),
        track.kind !== "text" ? h("button", { type: "button", title: track.muted ? "Unmute" : "Mute", "aria-label": `${track.muted ? "Unmute" : "Mute"} ${track.name}`, onclick: () => this.commit({ ...M.clone(p), tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, muted: !t.muted } : t)) }) }, icon(track.muted ? "close" : "speaker", 14)) : null);
      const lane = h("div", { class: "tl-lane", dataset: { track: track.id } });
      for (const c of track.clips) lane.appendChild(this.clipEl(track, c));
      lane.addEventListener("mousedown", (e) => {
        if (e.target === lane) { this.select(null); }
      });
      grid.append(label, lane);
    }
    // In/out range and playhead.
    if (p.inPoint != null || p.outPoint != null) {
      const a = p.inPoint ?? 0;
      const b = p.outPoint ?? M.duration(p);
      grid.appendChild(h("div", { class: "inout", style: { left: `${122 + a * this.pxPerSec}px`, width: `${(b - a) * this.pxPerSec}px` } }));
    }
    this.playhead = h("div", { class: "playhead", style: { left: "122px", transform: `translateX(${this.t * this.pxPerSec}px)` } });
    this.hoverLine = h("div", { class: "tl-hover hidden", style: { left: "122px" }, "aria-hidden": "true" });
    grid.append(this.hoverLine, this.playhead);
    this.tl.appendChild(grid);
    this.tl.scrollLeft = keepScroll;
    this.tlGrid = grid;
  }

  clipEl(track: Track, c: Clip): HTMLElement {
    const m = M.mediaOf(this.p, c);
    const len = M.clipLength(c);
    const label = c.text ? c.text.text : c.shape ? { rect: "Box", highlight: "Highlight", blur: "Blur", pixelate: "Pixelate" }[c.shape.shape] || "Shape" : m ? fileName(m.path) : "Clip";
    const kind = c.text || c.shape ? "text" : track.kind;
    const selected = this.sel?.kind === "clip" && this.sel.id === c.id;
    const el = h("div", { class: `tl-clip ${kind}${selected ? " sel" : ""}`, dataset: { clip: c.id }, role: "button", tabindex: "0", "aria-label": `${label}, ${clock(c.start)} to ${clock(c.start + len)}`, style: { left: `${c.start * this.pxPerSec}px`, width: `${Math.max(6, len * this.pxPerSec)}px` } });
    const wave = m && this.waves.get(m.id);
    if (wave && (track.kind === "audio" || track.kind === "video")) {
      const box = h("span", { class: "wave" });
      const n = Math.max(4, Math.min(300, Math.round((len * this.pxPerSec) / 3)));
      for (let i = 0; i < n; i++) {
        const srcT = c.in + ((c.out - c.in) * i) / n;
        const v = wave[Math.min(wave.length - 1, Math.floor((srcT / Math.max(m!.duration, 0.01)) * wave.length))] || 0;
        box.appendChild(h("i", { style: { height: `${Math.max(6, v * 100)}%` } }));
      }
      el.appendChild(box);
    }
    el.appendChild(h("span", { style: { position: "relative", textShadow: "0 1px 2px rgba(0,0,0,.5)" } }, c.freeze ? `Freeze · ${label}` : c.speed !== 1 ? `${label} · ${c.speed}×` : label));
    const left = h("span", { class: "edge l" });
    const right = h("span", { class: "edge r" });
    el.append(left, right);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") this.select({ kind: "clip", id: c.id }); });

    const startDrag = (e: MouseEvent, mode: "move" | "l" | "r") => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.selectQuiet({ kind: "clip", id: c.id });
      const x0 = e.clientX;
      const before = this.p;
      let next = before;
      let moved = false;
      let raf = 0;
      const snapPx = 8 / this.pxPerSec;
      el.classList.add("dragging");
      const guide = h("div", { class: "tl-snap hidden", style: { left: "122px" } });
      this.tlGrid.appendChild(guide);
      const mv = (ev: MouseEvent) => {
        if (Math.abs(ev.clientX - x0) > 2) moved = true;
        if (!moved) return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const dt = (ev.clientX - x0) / this.pxPerSec;
          let laneEl: HTMLElement | null = null;
          if (mode === "move") {
            laneEl = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(".tl-lane") ?? null;
            next = M.move(before, c.id, c.start + dt, laneEl?.dataset.track, snapPx, this.t);
          } else if (mode === "l") {
            next = M.trim(before, c.id, "start", M.snap(before, c.start + dt, snapPx, c.id, [this.t]));
          } else {
            next = M.trim(before, c.id, "end", M.snap(before, M.clipEnd(c) + dt, snapPx, c.id, [this.t]));
          }
          const f = M.find(next, c.id);
          if (!f) return;
          el.style.left = `${f.clip.start * this.pxPerSec}px`;
          el.style.width = `${Math.max(6, M.clipLength(f.clip) * this.pxPerSec)}px`;
          if (laneEl && f.track.id === laneEl.dataset.track && el.parentElement !== laneEl) laneEl.appendChild(el);
          // Guide line when an edge snapped to something.
          const raw = mode === "r" ? M.clipEnd(c) + dt : c.start + dt;
          const edge = mode === "r" ? M.clipEnd(f.clip) : f.clip.start;
          const snapped = Math.abs(edge - raw) > 1e-6 && Math.abs(edge - raw) <= snapPx + 1e-9;
          guide.classList.toggle("hidden", !snapped);
          guide.style.transform = `translateX(${edge * this.pxPerSec}px)`;
          this.p = next;
          this.renderStage();
        });
      };
      const up = () => {
        cancelAnimationFrame(raf);
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        el.classList.remove("dragging");
        guide.remove();
        this.p = before;
        if (moved && next !== before) this.commit(next);
        else {
          this.renderInspector();
          this.renderStage();
        }
      };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    };
    el.addEventListener("mousedown", (e) => startDrag(e, "move"));
    left.addEventListener("mousedown", (e) => startDrag(e, "l"));
    right.addEventListener("mousedown", (e) => startDrag(e, "r"));
    return el;
  }

  /** Change the selection without rebuilding the timeline (keeps drags smooth). */
  selectQuiet(s: Sel) {
    this.sel = s;
    this.openSection = "";
    this.tl.querySelectorAll(".tl-clip.sel, .tl-zoom.sel").forEach((x) => x.classList.remove("sel"));
    if (s?.kind === "clip") this.tl.querySelector(`[data-clip="${s.id}"]`)?.classList.add("sel");
    this.renderInspector();
  }

  select(s: Sel) {
    this.sel = s;
    this.openSection = "";
    this.renderInspector();
    this.renderTimeline();
    this.renderStage();
  }

  // ------------------------------------------------------------ inspector

  renderInspector() {
    clear(this.inspector);
    const sections = this.sectionsFor();
    const title = this.selectionTitle();
    this.inspector.appendChild(h("div", { class: "head col", style: { gap: "2px" } }, h("span", { class: "tiny muted" }, this.sel ? "Selected" : "Project"), h("strong", null, title)));
    const list = h("div", { class: "sections" });
    const visible = this.showAll ? sections : sections.slice(0, 4);
    const open = this.openSection && visible.some((s) => s.title === this.openSection) ? this.openSection : visible[0]?.title;
    for (const s of visible) {
      const isOpen = this.showAll || s.title === open;
      const btn = h("button", { type: "button", class: "sec-btn", "aria-expanded": String(isOpen), onclick: () => { this.openSection = s.title === open && !this.showAll ? "-" : s.title; this.renderInspector(); } },
        h("span", null, s.title), h("span", { class: "row tiny muted", style: { gap: "8px", fontWeight: "400" } }, s.summary || "", icon("chevron", 14)));
      list.appendChild(btn);
      if (isOpen) list.appendChild(h("div", { class: "sec-body" }, ...s.build()));
    }
    this.inspector.appendChild(list);
    if (sections.length > 4 || !this.showAll) {
      this.inspector.appendChild(h("button", { type: "button", class: "btn ghost", style: { margin: "8px 12px 14px", justifyContent: "flex-start" }, onclick: () => { this.showAll = !this.showAll; this.renderInspector(); } }, this.showAll ? "Show fewer settings" : this.sel ? "Show all settings for this item" : "Show all project settings"));
    }
  }

  selectionTitle(): string {
    if (this.sel?.kind === "zoom") return `Zoom · ${clock(this.p.zooms[this.sel.index]?.start ?? 0)}`;
    const f = this.selectedClip();
    if (!f) return this.p.name;
    const c = f.clip;
    if (c.text) return `Text · ${clock(c.start)} to ${clock(M.clipEnd(c))}`;
    if (c.shape) return `${c.shape.shape[0].toUpperCase()}${c.shape.shape.slice(1)} · ${clock(c.start)}`;
    const m = M.mediaOf(this.p, c);
    return `${m ? fileName(m.path) : "Clip"} · ${clock(c.start)} to ${clock(M.clipEnd(c))}`;
  }

  sectionsFor(): { title: string; summary?: string; build: () => (Node | null)[] }[] {
    const p = this.p;
    if (this.sel?.kind === "zoom") {
      const i = this.sel.index;
      const z = p.zooms[i];
      if (!z) return [];
      const upd = (patch: Partial<Zoom>, live = false) => {
        const next = M.clone(p);
        Object.assign(next.zooms[i], patch);
        if (live) { this.p = next; this.renderStage(); } else this.commit(next);
      };
      return [{ title: "Zoom", summary: `${z.scale.toFixed(1)}×`, build: () => [
        rangeControl("How close", z.scale, 1.1, 4, 0.1, (v) => `${v.toFixed(1)}×`, (v) => upd({ scale: v }, true), (v) => upd({ scale: v })),
        rangeControl("Focus left to right", z.x, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => upd({ x: v }, true), (v) => upd({ x: v })),
        rangeControl("Focus top to bottom", z.y, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => upd({ y: v }, true), (v) => upd({ y: v })),
        h("button", { type: "button", class: "btn", onclick: () => { const next = M.clone(p); next.zooms.splice(i, 1); this.sel = null; this.commit(next); } }, icon("trash", 15), "Remove this zoom"),
      ] }];
    }
    const f = this.selectedClip();
    if (!f) return this.projectSections();
    const { clip: c, track } = f;
    const id = c.id;
    const live = (fn: (c: Clip) => void) => { this.p = M.update(this.p, id, fn); this.renderStage(); };
    const before = () => this.p;
    let snapshot = before();
    const commitFrom = (fn: (c: Clip) => void) => { const base = snapshot; this.p = base; this.commit(M.update(base, id, fn)); snapshot = this.p; };
    const slider = (label: string, v: number, min: number, max: number, step: number, fmt: (v: number) => string, set: (c: Clip, v: number) => void) =>
      rangeControl(label, v, min, max, step, fmt, (x) => live((cl) => set(cl, x)), (x) => commitFrom((cl) => set(cl, x)));
    const m = M.mediaOf(p, c);

    if (c.text) {
      const t = c.text;
      return [
        { title: "Text", build: () => {
          const ta = h("textarea", { class: "input", "aria-label": "Text", rows: 3 }, t.text) as HTMLTextAreaElement;
          ta.addEventListener("input", () => live((cl) => (cl.text!.text = ta.value)));
          ta.addEventListener("change", () => commitFrom((cl) => (cl.text!.text = ta.value)));
          return [ta, chipGroup("Style", [["caption", "Caption"], ["title", "Title"], ["label", "Label"], ["callout", "Callout"]], (t.style || "callout") as "caption", (v) => commitFrom((cl) => { cl.text!.style = v; cl.text!.size = v === "title" ? 72 : v === "label" ? 32 : 48; }))];
        } },
        { title: "Size and place", summary: t.position || "bottom", build: () => [
          slider("Size", t.size, 16, 160, 1, (v) => `${v} px`, (cl, v) => (cl.text!.size = v)),
          chipGroup("Place", [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]], (t.position || "bottom") as "top", (v) => commitFrom((cl) => (cl.text!.position = v))),
          chipGroup("Colour", [["#ffffff", "White"], ["#ffd84d", "Yellow"], ["#7ea3ff", "Blue"], ["#5fdca5", "Green"]], (t.color || "#ffffff") as "#ffffff", (v) => commitFrom((cl) => (cl.text!.color = v))),
        ] },
        { title: "Animation", summary: t.animation || "none", build: () => [chipGroup("In and out", [["none", "None"], ["fade", "Fade"]], (t.animation || "none") as "none", (v) => commitFrom((cl) => (cl.text!.animation = v)))] },
        this.timingSection(c),
      ];
    }
    if (c.shape) {
      return [
        { title: "Shape", summary: c.shape.shape, build: () => [
          chipGroup("Kind", [["rect", "Box"], ["highlight", "Highlight"], ["arrow", "Arrow"], ["blur", "Blur"], ["pixelate", "Pixelate"]], c.shape!.shape as "rect", (v) => commitFrom((cl) => { if ((v === "arrow") !== (cl.shape!.shape === "arrow")) cl.shape!.rect = v === "arrow" ? [0.3, 0.3, 0.2, 0.15] : [0.35, 0.35, 0.3, 0.2]; cl.shape!.shape = v; })),
          chipGroup("Colour", [["#5b8cff", "Blue"], ["#f05252", "Red"], ["#ffd84d", "Yellow"], ["#ffffff", "White"]], (c.shape!.color || "#5b8cff") as "#5b8cff", (v) => commitFrom((cl) => (cl.shape!.color = v))),
          h("p", { class: "tiny muted" }, c.shape!.shape === "arrow" ? "Drag the arrow to move it; drag either end to point it." : "Drag the box in the preview to move it; drag its corner to resize."),
        ] },
        this.timingSection(c),
      ];
    }
    const out: { title: string; summary?: string; build: () => (Node | null)[] }[] = [];
    if (track.kind === "video" && m?.kind === "video") {
      out.push({ title: "Zoom", summary: p.zooms.length ? "Auto" : "Off", build: () => this.zoomControls() });
    }
    if (track.kind === "overlay" || m?.kind === "image") {
      out.push({ title: "Position and size", summary: `${Math.round(c.transform.scale * 100)}%`, build: () => [
        slider("Size", c.transform.scale, 0.05, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (cl, v) => (cl.transform.scale = v)),
        slider("Left and right", c.transform.x, -0.5, 0.5, 0.01, (v) => `${Math.round(v * 100)}`, (cl, v) => (cl.transform.x = v)),
        slider("Up and down", c.transform.y, -0.5, 0.5, 0.01, (v) => `${Math.round(v * 100)}`, (cl, v) => (cl.transform.y = v)),
      ] });
    }
    if (m && m.kind !== "image") {
      out.push({ title: "Speed", summary: c.freeze ? "Freeze" : `${c.speed}×`, build: () => [
        chipGroup("Speed", [["0.5", "0.5×"], ["1", "1×"], ["1.5", "1.5×"], ["2", "2×"], ["4", "4×"]], String(c.speed) as "1", (v) => this.commit(M.setSpeed(this.p, id, +v))),
        toggleRow("Play backwards", "Shown in the export; the preview plays forwards.", c.reverse, (v) => commitFrom((cl) => (cl.reverse = v))),
        h("button", { type: "button", class: "btn", onclick: () => this.commit(M.freezeFrame(this.p, id, Math.max(c.start + 0.05, Math.min(M.clipEnd(c) - 0.05, this.t)), 2)) }, "Freeze frame here for 2 s"),
      ] });
    }
    if (m && (m.hasAudio || m.kind === "audio")) {
      out.push({ title: "Sound", summary: `${Math.round(c.volume * 100)}%`, build: () => [
        slider("Volume", c.volume, 0, 2, 0.01, (v) => `${Math.round(v * 100)}%`, (cl, v) => (cl.volume = v)),
        toggleRow("Clean up voice", "Removes hum and background noise.", c.cleanVoice, (v) => commitFrom((cl) => (cl.cleanVoice = v))),
        this.volumePoints(c),
        h("button", { type: "button", class: "btn", onclick: () => this.findSilence(m) }, "Find silent parts"),
      ] });
    }
    if (track.kind === "video" && m?.kind === "video") {
      out.push({ title: "Crop, rotate, flip", summary: c.transform.rotate ? `${c.transform.rotate}°` : "", build: () => [
        chipGroup("Rotate", [["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]], String(c.transform.rotate || 0) as "0", (v) => commitFrom((cl) => (cl.transform.rotate = +v))),
        toggleRow("Flip left to right", null, c.transform.flipH, (v) => commitFrom((cl) => (cl.transform.flipH = v))),
        toggleRow("Flip upside down", null, c.transform.flipV, (v) => commitFrom((cl) => (cl.transform.flipV = v))),
        slider("Zoom in (crop)", c.transform.crop ? 1 / c.transform.crop[2] : 1, 1, 3, 0.05, (v) => `${v.toFixed(2)}×`, (cl, v) => { const s = 1 / v; cl.transform.crop = v <= 1.001 ? null : [(1 - s) / 2, (1 - s) / 2, s, s]; }),
      ] });
    }
    if ((track.kind === "video" || track.kind === "overlay" || track.kind === "audio") && M.previousTouching(p, id)) {
      const tr = c.transitionIn;
      out.splice(Math.min(1, out.length), 0, { title: "Transition in", summary: tr ? (tr.kind === "dip" ? "Dip" : "Crossfade") : "None", build: () => [
        chipGroup("From the clip before", [["none", "None"], ["crossfade", "Crossfade"], ["dip", "Dip to background"]], (tr?.kind || "none") as "none", (v) => commitFrom((cl) => { cl.transitionIn = v === "none" ? null : { kind: v as "crossfade" | "dip", duration: cl.transitionIn?.duration || 0.6 }; })),
        tr ? slider("Length", tr.duration, 0.1, 3, 0.05, (v) => `${v.toFixed(2)} s`, (cl, v) => { cl.transitionIn = { kind: cl.transitionIn?.kind || "crossfade", duration: v }; }) : null,
        tr?.kind === "crossfade" && c.in / Math.max(c.speed, 0.01) < tr.duration ? h("p", { class: "tiny muted" }, "This clip starts at the very beginning of its video, so the crossfade is shortened to the footage available.") : null,
      ] });
    }
    out.push({ title: "Fade in and out", summary: c.fadeIn || c.fadeOut ? "On" : "Off", build: () => [
      slider("Fade in", c.fadeIn, 0, 5, 0.1, (v) => `${v.toFixed(1)} s`, (cl, v) => (cl.fadeIn = v)),
      slider("Fade out", c.fadeOut, 0, 5, 0.1, (v) => `${v.toFixed(1)} s`, (cl, v) => (cl.fadeOut = v)),
    ] });
    out.push(this.timingSection(c));
    return out;
  }

  /** Volume points: change loudness over time within one clip. */
  volumePoints(c: Clip): HTMLElement {
    const box = h("div", { class: "col", style: { gap: "8px" } });
    const keys = [...(c.volumeKeys || [])].sort((a, b) => a.t - b.t);
    const local = Math.max(0, Math.min(M.clipLength(c), this.t - c.start));
    box.appendChild(h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("span", { class: "small" }, "Volume points"),
      h("button", { type: "button", class: "btn", style: { height: "30px" }, onclick: () => this.commit(M.update(this.p, c.id, (cl) => {
        const list = (cl.volumeKeys || []).filter((k) => Math.abs(k.t - local) > 0.05);
        list.push({ t: local, v: M.volumeAt(cl.volumeKeys, local) });
        if (list.length === 1 && local > 0.05) list.unshift({ t: 0, v: 1 });
        cl.volumeKeys = list.sort((a, b) => a.t - b.t);
      })) }, icon("plus", 13), `Add at ${clock(local)}`)));
    keys.forEach((k, i) => {
      box.appendChild(h("div", { class: "row small", style: { gap: "8px" } },
        h("button", { type: "button", class: "btn ghost mono", style: { height: "28px", padding: "0 6px" }, onclick: () => this.seek(c.start + k.t) }, clock(k.t)),
        h("div", { class: "grow" }, rangeControl("Level", k.v, 0, 2, 0.01, (v) => `${Math.round(v * 100)}%`, () => {}, (v) => this.commit(M.update(this.p, c.id, (cl) => { const s = [...(cl.volumeKeys || [])].sort((a, b) => a.t - b.t); s[i] = { ...s[i], v }; cl.volumeKeys = s; })))),
        h("button", { type: "button", class: "icon-btn", "aria-label": `Remove volume point at ${clock(k.t)}`, onclick: () => this.commit(M.update(this.p, c.id, (cl) => { const s = [...(cl.volumeKeys || [])].sort((a, b) => a.t - b.t); s.splice(i, 1); cl.volumeKeys = s; })) }, icon("close", 12))));
    });
    if (!keys.length) box.appendChild(h("p", { class: "tiny muted" }, "Add points to make the sound rise or fall, for example to lower music under your voice."));
    return box;
  }

  timingSection(c: Clip) {
    return { title: "Timing", summary: `${M.clipLength(c).toFixed(1)} s`, build: () => {
      const start = h("input", { class: "input", type: "number", step: "0.1", value: c.start.toFixed(2), "aria-label": "Starts at (seconds)" }) as HTMLInputElement;
      const len = h("input", { class: "input", type: "number", step: "0.1", min: "0.1", value: M.clipLength(c).toFixed(2), "aria-label": "Length (seconds)" }) as HTMLInputElement;
      start.addEventListener("change", () => this.commit(M.move(this.p, c.id, +start.value)));
      len.addEventListener("change", () => this.commit(M.trim(this.p, c.id, "end", c.start + Math.max(0.1, +len.value))));
      return [h("div", { class: "grid2" }, h("label", { class: "field" }, "Starts at (s)", start), h("label", { class: "field" }, "Length (s)", len)),
        h("button", { type: "button", class: "btn", onclick: () => { const d = M.duplicate(this.p, c.id); this.commit(d.project); } }, "Duplicate")];
    } };
  }

  zoomControls(): (Node | null)[] {
    const p = this.p;
    const hasEvents = !!p.events;
    return [
      hasEvents
        ? toggleRow("Follow clicks automatically", "Zooms in where you clicked while recording.", p.zooms.length > 0, async (v) => { if (v) await this.autoZoom(0.5); else this.commit({ ...M.clone(p), zooms: [] }); })
        : h("p", { class: "tiny muted" }, "Auto-zoom works on screen recordings made in Alchemist. You can still add zooms by hand."),
      hasEvents && p.zooms.length ? rangeControl("How close", 0.5, 0, 1, 0.05, (v) => (v < 0.34 ? "Subtle" : v < 0.67 ? "Medium" : "Close"), () => {}, (v) => this.autoZoom(v)) : null,
      rangeControl("Smoothness", p.zoomSmoothness, 0, 1, 0.05, (v) => (v < 0.34 ? "Snappy" : v < 0.67 ? "Smooth" : "Gentle"), (v) => { this.p = { ...this.p, zoomSmoothness: v }; this.renderStage(); }, (v) => { const base = { ...this.p }; this.p = p; this.commit({ ...base, zoomSmoothness: v }); }),
      h("button", { type: "button", class: "btn", onclick: () => this.addZoomHere() }, icon("zoom", 15), "Add a zoom at the playhead"),
    ];
  }

  async autoZoom(strength: number) {
    const p = this.p;
    if (!p.events) return;
    const first = p.media.find((m) => m.kind === "video");
    try {
      const zooms = await call<Zoom[]>("auto_zoom", { events: p.events, origin: [0, 0], size: [first?.width || p.settings.width, first?.height || p.settings.height], strength });
      this.commit({ ...M.clone(p), zooms });
      toast(zooms.length ? `${zooms.length} zoom${zooms.length > 1 ? "s" : ""} added from your clicks.` : "No clicks were found in this recording.");
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }

  addZoomHere() {
    const next = M.clone(this.p);
    next.zooms.push({ start: this.t, end: this.t + 3, scale: 2, x: 0.5, y: 0.5 });
    next.zooms.sort((a, b) => a.start - b.start);
    this.commit(next);
    this.select({ kind: "zoom", index: next.zooms.findIndex((z) => z.start === this.t) });
  }

  /** Cursor data for the preview, loaded once per smoothing value. */
  private cursorData(): CursorData | null {
    const p = this.p;
    if (!p.events) return null;
    const cs = p.cursor ?? defaultCursor;
    const key = `${p.events}|${cs.smoothing}`;
    if (this.cursorCache?.key !== key) {
      this.cursorCache = { key, data: this.cursorCache?.data ?? null };
      call<CursorData>("cursor_data", { events: p.events, smoothing: cs.smoothing })
        .then((d) => { if (this.cursorCache?.key === key) { this.cursorCache.data = d; this.renderStage(); } })
        .catch(() => {});
    }
    return this.cursorCache.data;
  }

  /** Same picture the export draws: smooth pointer, highlight, click ripple, keystrokes. */
  private drawCursor(box: { left: number; top: number; w: number; h: number; clip: Clip }) {
    const p = this.p;
    const cs = p.cursor ?? defaultCursor;
    const rect = p.sourceRect;
    const d = this.cursorData();
    if (!d || !rect) return;
    const src = M.sourceTime(box.clip, this.t);
    const map = (x: number, y: number): [number, number] => [box.left + ((x - rect[0]) / Math.max(1, rect[2])) * box.w, box.top + ((y - rect[1]) / Math.max(1, rect[3])) * box.h];
    const unit = Math.max(6, (this.stage.clientHeight / 1080) * 34 * Math.min(4, Math.max(0.3, cs.size)));
    const pos = M.cursorAt(d, src);
    if (pos) {
      const [x, y] = map(pos[0], pos[1]);
      if (cs.highlight) this.canvas.appendChild(h("div", { class: "cursor-hl", style: { left: `${x - unit}px`, top: `${y - unit}px`, width: `${unit * 2}px`, height: `${unit * 2}px`, background: cs.color } }));
      if (p.cursorHidden && cs.show) {
        const svg = h("div", { class: "cursor-pt", style: { left: `${x - unit * 0.08}px`, top: `${y - unit * 0.04}px`, width: `${unit}px`, height: `${unit}px` } });
        svg.innerHTML = `<svg viewBox="0 0 100 100" width="100%" height="100%"><polygon points="8,4 8,78 27,62 42,94 55,88 41,57 66,57" fill="#fff" stroke="#141418" stroke-width="7" stroke-linejoin="round"/></svg>`;
        this.canvas.appendChild(svg);
      }
    }
    if (cs.ripple) {
      const c = M.clickAt(d, src);
      if (c) {
        const [x, y] = map(c.x, c.y);
        const r = unit * (0.6 + c.age * 0.6);
        this.canvas.appendChild(h("div", { class: "cursor-rip", style: { left: `${x - r}px`, top: `${y - r}px`, width: `${r * 2}px`, height: `${r * 2}px`, borderColor: cs.color, opacity: String(1 - c.age) } }));
      }
    }
    if (cs.keys) {
      const k = M.keyAt(d, src);
      if (k) this.overlayLayer.appendChild(h("div", { class: "cursor-keys", style: { fontSize: `${Math.max(10, (this.stage.clientHeight / 1080) * 56)}px` } }, k));
    }
  }

  cursorControls() {
    const p = this.p;
    const cs = { ...defaultCursor, ...(p.cursor ?? {}) };
    const set = (patch: Partial<CursorSettings>, liveOnly = false) => {
      const next = { ...M.clone(this.p), cursor: { ...cs, ...patch } };
      if (liveOnly) { this.p = next; this.renderStage(); } else { this.commit(next); }
    };
    return [
      p.cursorHidden
        ? toggleRow("Show cursor", "A smooth cursor drawn from the recording's mouse log.", cs.show, (v) => set({ show: v }))
        : h("p", { class: "tiny muted" }, "This recording has the cursor in the picture. Turn on Smooth cursor in recording options to restyle it next time."),
      rangeControl("Size", cs.size, 0.5, 3, 0.1, (v) => `${Math.round(v * 100)}%`, (v) => set({ size: v }, true), (v) => set({ size: v })),
      rangeControl("Smoothness", cs.smoothing, 0, 1, 0.05, (v) => (v < 0.1 ? "Raw" : v < 0.6 ? "Smooth" : "Very smooth"), (v) => set({ smoothing: v }, true), (v) => set({ smoothing: v })),
      toggleRow("Click ripples", "A ring where you clicked.", cs.ripple, (v) => set({ ripple: v })),
      toggleRow("Highlight", "A soft spotlight that follows the cursor.", cs.highlight, (v) => set({ highlight: v })),
      toggleRow("Keystrokes", "Show shortcuts and typing on screen.", cs.keys, (v) => set({ keys: v })),
      h("label", { class: "ctl" }, h("span", null, "Colour"), h("input", { type: "color", value: cs.color, "aria-label": "Cursor effect colour", style: { width: "100%", height: "36px", border: "0", background: "none" }, onchange: (e: Event) => set({ color: (e.target as HTMLInputElement).value }) })),
    ];
  }

  projectSections() {
    const p = this.p;
    const s = p.settings;
    const set = (patch: Partial<Project["settings"]>, liveOnly = false) => {
      const next = { ...M.clone(this.p), settings: { ...this.p.settings, ...patch } };
      if (liveOnly) { this.p = next; this.layoutStage(); this.renderStage(); } else { this.commit(next); }
    };
    return [
      { title: "Captions", summary: p.captions.length ? String(p.captions.length) : "None", build: () => this.captionControls() },
      { title: "Look", summary: s.padding ? "Framed" : "Plain", build: () => [
        h("label", { class: "ctl" }, h("span", null, "Background"), h("input", { type: "color", value: s.background || "#000000", "aria-label": "Background colour", style: { width: "100%", height: "36px", border: "0", background: "none" }, onchange: (e: Event) => set({ background: (e.target as HTMLInputElement).value }) })),
        rangeControl("Padding", s.padding, 0, 200, 2, (v) => `${v} px`, (v) => set({ padding: v }, true), (v) => set({ padding: v })),
        rangeControl("Rounded corners", s.radius, 0, 80, 1, (v) => `${v} px`, (v) => set({ radius: v }, true), (v) => set({ radius: v })),
        toggleRow("Shadow", "A soft shadow under the picture. Needs some padding.", !!s.shadow, (v) => set({ shadow: v, padding: v && !s.padding ? 48 : s.padding })),
        h("p", { class: "tiny muted" }, "Padding and rounded corners give recordings a clean app-demo look."),
      ] },
      { title: "Zoom", summary: p.zooms.length ? `${p.zooms.length}` : "Off", build: () => this.zoomControls() },
      ...(p.events ? [{ title: "Cursor", summary: p.cursorHidden && (p.cursor ?? defaultCursor).show ? "Smooth" : "Effects", build: () => this.cursorControls() }] : []),
      { title: "Size and frame rate", summary: `${s.width}×${s.height}`, build: () => {
        const presets = h("div", { class: "chips" }, ...([["16:9", 1920, 1080], ["9:16", 1080, 1920], ["1:1", 1080, 1080], ["4:5", 1080, 1350]] as [string, number, number][]).map(([n, w, hh]) => h("button", { type: "button", "aria-pressed": String(s.width === w && s.height === hh), onclick: () => set({ width: w, height: hh }) }, n)));
        const w = h("input", { class: "input", type: "number", value: String(s.width), "aria-label": "Width" }) as HTMLInputElement;
        const hh = h("input", { class: "input", type: "number", value: String(s.height), "aria-label": "Height" }) as HTMLInputElement;
        const f = h("input", { class: "input", type: "number", step: "0.01", value: String(s.fps), "aria-label": "Frame rate" }) as HTMLInputElement;
        const apply = async () => {
          const c = await call<{ value: { width: number; height: number; fps: number }; notes: string[] }>("check_limits", { width: +w.value, height: +hh.value, fps: +f.value });
          c.notes.forEach((n) => toast(n));
          set(c.value);
        };
        [w, hh, f].forEach((el) => el.addEventListener("change", apply));
        return [presets, h("div", { class: "grid3" }, w, hh, f), h("p", { class: "tiny muted" }, "Changing this never damages your edit; clips are refitted.")];
      } },
      { title: "Markers and range", summary: p.inPoint != null || p.outPoint != null ? "Range set" : "", build: () => [
        h("div", { class: "row wrap" },
          h("button", { type: "button", class: "btn", onclick: () => this.commit({ ...M.clone(this.p), inPoint: this.t }) }, "Mark in here (I)"),
          h("button", { type: "button", class: "btn", onclick: () => this.commit({ ...M.clone(this.p), outPoint: this.t }) }, "Mark out here (O)"),
          p.inPoint != null || p.outPoint != null ? h("button", { type: "button", class: "btn ghost", onclick: () => this.commit({ ...M.clone(this.p), inPoint: null, outPoint: null }) }, "Clear range") : null),
        ...p.markers.map((mk, i) => h("div", { class: "row small" }, h("button", { type: "button", class: "btn ghost", style: { height: "30px" }, onclick: () => this.seek(mk.t) }, clock(mk.t)), h("span", { class: "grow muted" }, mk.label || `Marker ${i + 1}`), h("button", { type: "button", class: "icon-btn", "aria-label": "Remove marker", onclick: () => { const n = M.clone(this.p); n.markers.splice(i, 1); this.commit(n); } }, icon("close", 13)))),
      ] },
    ];
  }

  captionControls(): (Node | null)[] {
    const p = this.p;
    const list = h("div", { class: "col", style: { gap: "6px" } });
    p.captions.forEach((c, i) => {
      const ta = h("input", { class: "input", value: c.text, "aria-label": `Caption at ${clock(c.start)}` }) as HTMLInputElement;
      ta.addEventListener("change", () => { const n = M.clone(this.p); n.captions[i].text = ta.value; this.commit(n); });
      list.appendChild(h("div", { class: "row" }, h("button", { type: "button", class: "btn ghost mono", style: { height: "32px", padding: "0 6px" }, onclick: () => this.seek(c.start) }, clock(c.start)), ta,
        h("button", { type: "button", class: "icon-btn", "aria-label": "Remove caption", onclick: () => { const n = M.clone(this.p); n.captions.splice(i, 1); this.commit(n); } }, icon("close", 13))));
    });
    return [
      list,
      h("div", { class: "row wrap" },
        h("button", { type: "button", class: "btn", onclick: () => { const n = M.clone(this.p); n.captions.push({ start: this.t, end: this.t + 3, text: "New caption" }); n.captions.sort((a, b) => a.start - b.start); this.commit(n); } }, icon("plus", 14), "Add at playhead"),
        h("button", { type: "button", class: "btn", onclick: () => this.importCaptions() }, "Import SRT or VTT"),
        p.captions.length ? h("button", { type: "button", class: "btn", onclick: () => this.exportCaptions() }, "Save as SRT") : null),
      h("p", { class: "tiny muted" }, "Automatic captions that run on this computer are coming in a later version. For now, type them or import a file."),
    ];
  }

  async importCaptions() {
    const [f] = await pickFiles({ subtitles: true });
    if (!f) return;
    try {
      const caps = await call<Caption[]>("captions_import", { path: f });
      this.commit({ ...M.clone(this.p), captions: caps });
      toast(`${caps.length} captions imported.`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }

  async exportCaptions() {
    const path = await pickSave(`${this.p.name}.srt`, "srt");
    if (!path) return;
    await call("captions_export", { captions: this.p.captions, path }).then(() => toast("Captions saved.", { action: { label: "Show", run: () => reveal(path) } })).catch((e) => toast(errorText(e), { error: true }));
  }

  // ------------------------------------------------------------ actions

  split() {
    const f = this.selectedClip();
    if (f && this.t > f.clip.start && this.t < M.clipEnd(f.clip)) this.commit(M.split(this.p, f.clip.id, this.t).project);
    else this.commit(M.splitAll(this.p, this.t));
  }

  deleteSel(ripple: boolean) {
    if (this.sel?.kind === "zoom") {
      const n = M.clone(this.p);
      n.zooms.splice(this.sel.index, 1);
      this.sel = null;
      return this.commit(n);
    }
    const f = this.selectedClip();
    if (!f) return toast("Select a clip first.");
    this.sel = null;
    this.commit(M.remove(this.p, f.clip.id, ripple));
  }

  addText(text = "Your text", style = "callout") {
    const r = M.addText(this.p, this.t, text, style);
    this.commit(r.project);
    this.select({ kind: "clip", id: r.id });
    this.openSection = "Text";
    this.renderInspector();
    (this.inspector.querySelector("textarea") as HTMLTextAreaElement | null)?.select();
  }

  addShape(kind: "rect" | "highlight" | "blur" | "pixelate" | "arrow") {
    const r = M.addShape(this.p, this.t, kind);
    this.commit(r.project);
    this.select({ kind: "clip", id: r.id });
  }

  shapesMenu() {
    modal((close) => {
      const opt = (k: "rect" | "highlight" | "blur" | "pixelate" | "arrow", title: string, sub: string, ic: Parameters<typeof icon>[0]) =>
        h("button", { type: "button", class: "opt", style: { flexDirection: "row", alignItems: "center", gap: "14px" }, onclick: () => { close(); this.addShape(k); } }, h("span", { style: { color: "var(--accent)" } }, icon(ic, 20)), h("span", { class: "col", style: { gap: "2px" } }, h("strong", null, title), h("small", null, sub)));
      return h("div", { class: "dialog", style: { width: "480px" } },
        h("header", null, h("h2", null, "Add a shape"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16))),
        h("div", { class: "content" },
          opt("highlight", "Highlight", "Draw attention to a button or area", "box"),
          opt("arrow", "Arrow", "Point at something", "forward"),
          opt("rect", "Box", "An outline around something", "box"),
          opt("blur", "Blur", "Hide passwords, emails or faces", "blur"),
          opt("pixelate", "Pixelate", "A stronger way to hide something", "blur")));
    }, { label: "Add a shape" });
  }

  addMarker() {
    const n = M.clone(this.p);
    n.markers.push({ t: this.t, label: "" });
    n.markers.sort((a, b) => a.t - b.t);
    this.commit(n);
  }

  async addMediaFiles() {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    try {
      const media = await call<Media[]>("media_import", { paths: files });
      let p = this.p;
      for (const m of media) { p = M.addMedia(p, m); await this.ensureMedia(m); }
      this.commit(p);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }

  async findSilence(m: Media, quiet = false) {
    try {
      const ranges = await call<{ start: number; end: number }[]>("detect_silence", { path: m.path });
      // Map source time to timeline time through the clips that use this media.
      const timeline: { start: number; end: number }[] = [];
      for (const t of this.p.tracks) for (const c of t.clips) {
        if (c.mediaId !== m.id || c.freeze || c.reverse) continue;
        for (const r of ranges) {
          const a = Math.max(r.start, c.in);
          const b = Math.min(r.end, c.out);
          if (b - a > 0.3) timeline.push({ start: c.start + (a - c.in) / c.speed, end: c.start + (b - c.in) / c.speed });
        }
      }
      const total = timeline.reduce((s, r) => s + r.end - r.start, 0);
      if (!timeline.length) {
        if (!quiet) toast("No long pauses found.");
        return;
      }
      const notice = h("div", { class: "notice", role: "status" },
        icon("sparkle", 18),
        h("span", { class: "grow" }, `Found ${timeline.length} silent pause${timeline.length > 1 ? "s" : ""}, ${Math.round(total)} seconds in total.`),
        h("button", { type: "button", class: "btn primary", style: { height: "32px" }, onclick: () => { notice.remove(); this.commit(M.removeRanges(this.p, timeline)); toast("Pauses removed. Press Undo to bring them back."); } }, "Remove them"),
        h("button", { type: "button", class: "btn ghost", style: { height: "32px" }, onclick: () => { notice.remove(); localStorage.setItem(`alc-silence-dismissed:${this.p.id}`, "1"); } }, "Not now"));
      this.banner.appendChild(notice);
    } catch (e) {
      if (!quiet) toast(errorText(e), { error: true });
    }
  }

  suggestSilence() {
    if (localStorage.getItem(`alc-silence-dismissed:${this.p.id}`)) return;
    const voice = this.p.media.find((m) => m.kind === "audio") || this.p.media.find((m) => m.hasAudio);
    if (voice && !voice.missing && voice.duration > 20) this.findSilence(voice, true);
  }

  checkMissing() {
    for (const m of this.p.media.filter((x) => x.missing)) {
      const n = h("div", { class: "notice warn" }, h("span", { class: "grow" }, `"${fileName(m.path)}" has moved or been deleted.`),
        h("button", { type: "button", class: "btn", style: { height: "32px" }, onclick: async () => {
          const [f] = await pickFiles({});
          if (!f) return;
          try {
            const p = await call<Project>("project_relink", { project: this.p, mediaId: m.id, path: f });
            this.urls.delete(m.id);
            this.videos.delete(m.id);
            this.commit(p);
            await this.ensureMedia(p.media.find((x) => x.id === m.id)!);
            n.remove();
            this.renderStage();
          } catch (e) {
            toast(errorText(e), { error: true });
          }
        } }, "Find it"));
      this.banner.appendChild(n);
    }
  }

  export() {
    this.pause();
    if (!M.duration(this.p)) return toast("Add a video first.");
    openExport(this.p, () => toast(`Exporting "${this.p.name}". You can keep editing.`, { action: { label: "Show progress", run: () => document.querySelector<HTMLButtonElement>(".jobchip")?.click() } }));
  }

  rename() {
    const input = h("input", { class: "input", value: this.p.name, style: { height: "30px", width: "220px" }, "aria-label": "Project name" }) as HTMLInputElement;
    this.nameEl.replaceWith(input);
    input.focus();
    input.select();
    const done = () => {
      const name = input.value.trim() || this.p.name;
      input.replaceWith(this.nameEl);
      if (name !== this.p.name) {
        this.commit({ ...M.clone(this.p), name });
        this.nameEl.textContent = name;
      }
    };
    input.addEventListener("blur", done);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.value = this.p.name; input.blur(); } });
  }

  projectMenu() {
    modal((close) => {
      const item = (title: string, sub: string, run: () => void, danger = false) => h("button", { type: "button", class: "opt", style: danger ? { borderColor: "color-mix(in srgb, var(--rec) 40%, transparent)" } : undefined, onclick: () => { close(); run(); } }, h("strong", null, title), h("small", null, sub));
      return h("div", { class: "dialog", style: { width: "480px" } },
        h("header", null, h("h2", null, "Project"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16))),
        h("div", { class: "content" },
          item("Add media", "Videos, sound or images", () => this.addMediaFiles()),
          item("Package for another computer", "Copies the project and all its media into one folder", () => this.packageProject()),
          item("Search everything", "Ctrl K", () => openPalette()),
          item("Delete project", "The project is removed. Your original videos are kept.", async () => {
            const { confirmDialog } = await import("../ui/common");
            if (await confirmDialog("Delete this project?", "The project is removed. Your original videos are not touched.", "Delete", true)) {
              await call("project_delete", { id: this.p.id });
              localStorage.removeItem("alc-last-project");
              go("projects");
            }
          }, true)));
    }, { label: "Project options" });
  }

  async packageProject() {
    const folder = await pickFolder();
    if (!folder) return;
    try {
      const file = await call<string>("project_package", { project: this.p, dest: folder });
      toast("Project packaged.", { action: { label: "Show", run: () => reveal(file) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }

  openRequest(what: string) {
    if (what === "captions") { this.sel = null; this.openSection = "Captions"; this.renderInspector(); }
    else if (what === "silence") { const m = this.p.media.find((x) => x.kind === "audio") || this.p.media.find((x) => x.hasAudio); if (m) this.findSilence(m); else toast("This project has no sound to check."); }
    else if (what === "text") this.addText();
    else if (what === "blur") this.addShape("blur");
    else if (what === "export") this.export();
    else if (what === "package") this.packageProject();
  }

  onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (document.querySelector(".scrim")) return;
    const map = bindings(store.settings.shortcutPreset, store.settings.shortcuts);
    const act = actionFor(e, map, "editor");
    if (!act) return;
    const editorActs: Record<string, () => void> = {
      playPause: () => this.toggle(),
      split: () => this.split(),
      delete: () => this.deleteSel(false),
      rippleDelete: () => this.deleteSel(true),
      duplicate: () => { const f = this.selectedClip(); if (f) this.commit(M.duplicate(this.p, f.clip.id).project); },
      undo: () => this.undo(),
      redo: () => this.redo(),
      markIn: () => this.commit({ ...M.clone(this.p), inPoint: this.t }),
      markOut: () => this.commit({ ...M.clone(this.p), outPoint: this.t }),
      addMarker: () => this.addMarker(),
      export: () => this.export(),
      frameBack: () => this.seek(this.t - 1 / this.p.settings.fps),
      frameForward: () => this.seek(this.t + 1 / this.p.settings.fps),
    };
    if (editorActs[act]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      editorActs[act]();
    }
  }
}
