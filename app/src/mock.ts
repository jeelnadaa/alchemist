// In-browser stand-in for the Rust core. Used only outside the desktop app
// (UI development, screenshots, tests). Behaves like the real commands with
// simulated progress, so every screen and state can be exercised.

import type { Job, Manifest, Media, Project, ProjectSummary, Settings } from "./api";
import { DEFAULT_SETTINGS } from "./api";

type Emit = (event: string, payload: unknown) => void;

const store = {
  settings: loadLocal<Settings>("alc-mock-settings", { ...DEFAULT_SETTINGS }),
  projects: loadLocal<Record<string, Project>>("alc-mock-projects", {}),
  history: {} as Record<string, unknown>,
  jobs: [] as Job[],
  recording: null as null | { started: number; paused: boolean; pausedAt: number; pausedTotal: number },
  replay: null as null | { started: number; seconds: number },
};

function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
function saveLocal(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

const uuid = () => (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2);

function sampleMedia(path: string): Media {
  const audio = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(path);
  const image = /\.(png|jpe?g|webp)$/i.test(path);
  return { id: uuid(), path, kind: audio ? "audio" : image ? "image" : "video", duration: image ? 5 : audio ? 95 : 180, width: audio ? 0 : 1920, height: audio ? 0 : 1080, hasAudio: !image, missing: false };
}

function newProject(name: string, width = 1920, height = 1080, fps = 30): Project {
  const t = Math.floor(Date.now() / 1000);
  return {
    version: 1, id: uuid(), name, created: t, modified: t,
    settings: { width, height, fps, background: "#000000", padding: 0, radius: 0 },
    media: [],
    tracks: [
      { id: "v1", kind: "video", name: "Video", muted: false, volume: 1, clips: [] },
      { id: "t1", kind: "text", name: "Text", muted: false, volume: 1, clips: [] },
      { id: "a1", kind: "audio", name: "Voice", muted: false, volume: 1, clips: [] },
    ],
    zooms: [], zoomSmoothness: 0.5, captions: [], markers: [], inPoint: null, outPoint: null, events: null,
  };
}

function plan(duration: number, mb: number, w = 1920, h = 1080, fps = 59.94) {
  const total = (mb * 8 * 1024 * 0.95) / Math.max(duration, 0.1);
  const audio = total < 400 ? 64 : 128;
  const video = Math.max(total - audio, 0);
  const [maxH, maxF] = video >= 4500 ? [1080, 60] : video >= 2200 ? [1080, 30] : video >= 900 ? [720, 30] : video >= 400 ? [480, 30] : [360, 24];
  const short = Math.min(w, h);
  const s = Math.min(short, maxH) / short;
  const W = Math.round((w * s) / 2) * 2;
  const H = Math.round((h * s) / 2) * 2;
  const F = Math.min(fps, maxF);
  return { videoKbps: video, audioKbps: audio, width: W, height: H, fps: F, label: `${Math.min(W, H)}p, ${Math.round(F)} fps`, tooSmall: video < 80 };
}

function runJob(job: Job, emit: Emit, outBytes: number, inBytes: number) {
  store.jobs.push(job);
  emit("job", job);
  const startedAt = Date.now();
  const tick = () => {
    if (job.status === "cancelled") return emit("job", job);
    if (store.jobs.some((j) => j.status === "running" && j.id !== job.id)) return setTimeout(tick, 300);
    job.status = "running";
    job.stage = "Working";
    job.progress = Math.min(1, job.progress + 0.08);
    job.etaSeconds = ((Date.now() - startedAt) / 1000 / job.progress) * (1 - job.progress);
    if (job.progress >= 1) {
      job.status = "done";
      job.stage = "Done";
      job.etaSeconds = null;
      job.report = { inputBytes: inBytes, outputBytes: outBytes, seconds: (Date.now() - startedAt) / 1000, quality: job.kind === "export" || job.kind === "preview" ? null : { metric: "VMAF", value: 94.6, verdict: "Looks identical to the original" }, note: null };
    }
    emit("job", { ...job });
    if (job.status === "running") setTimeout(tick, 250);
  };
  setTimeout(tick, 200);
  return job;
}

function mkJob(title: string, kind: string, output: string, input?: string): Job {
  return { id: uuid(), title, kind, input, output, status: "queued", progress: 0, etaSeconds: null, stage: "Waiting", error: null, report: null };
}

export async function mockInvoke(cmd: string, a: Record<string, any>, emit: Emit): Promise<unknown> {
  switch (cmd) {
    case "app_info":
      return { version: "0.1.0", os: "windows", portable: false, portableNote: null, dataDir: "C:/Users/you/AppData/Roaming/Alchemist", recordingsDir: "C:/Users/you/AppData/Roaming/Alchemist/recordings", ffmpeg: "ffmpeg.exe" };
    case "capabilities":
      return { version: "ffmpeg version 6.1.1", encoders: ["libx264", "libvpx-vp9"], hwH264: "h264_nvenc", hwHevc: null, devices: ["gdigrab", "dshow"], filters: ["libvmaf", "zoompan"] };
    case "check_limits": {
      const notes: string[] = [];
      let { width, height, fps } = a as { width: number; height: number; fps: number };
      const clampDim = (v: number, mn: number, mx: number, n: string) => {
        if (v < mn) { notes.push(`${n} raised to the minimum of ${mn} px.`); v = mn; }
        if (v > mx) { notes.push(`${n} lowered to the maximum of ${mx} px.`); v = mx; }
        if (v % 2) { const e = v + 1 <= mx ? v + 1 : v - 1; notes.push(`${n} must be an even number, so ${v} became ${e}.`); v = e; }
        return v;
      };
      width = clampDim(Math.round(width), 128, 7680, "Width");
      height = clampDim(Math.round(height), 72, 4320, "Height");
      if (!(fps >= 1)) { notes.push("Frame rate raised to the minimum of 1 fps."); fps = 1; }
      if (fps > 240) { notes.push("Frame rate lowered to the maximum of 240 fps."); fps = 240; }
      return { value: { width, height, fps: Math.round(fps * 1000) / 1000 }, notes };
    }
    case "probe":
      return { duration: 180, width: 1920, height: 1080, fps: 59.94, videoCodec: "h264", audioCodec: "aac", audioStreams: 1, subtitleStreams: 0, bitrateKbps: 55000, sizeBytes: 1.24 * 1024 ** 3, container: "mov", hasVideo: true, hasAudio: true };
    case "size_plan":
      return plan(180, a.targetMb);
    case "settings_get":
      return { ...store.settings };
    case "settings_set":
      store.settings = a.value;
      saveLocal("alc-mock-settings", store.settings);
      return null;
    case "convert_start": {
      const r = a.req;
      const name = String(r.input).split(/[\\/]/).pop();
      const g = r.goal;
      const title = g.goal === "targetSize" ? `${name} → under ${g.targetMb} MB` : g.goal === "format" ? `${name} → ${g.container.toUpperCase()}` : `${name} → enhanced`;
      const out = g.goal === "targetSize" ? g.targetMb * 1024 * 1024 * 0.93 : 300 * 1024 * 1024;
      return runJob(mkJob(title, g.goal === "targetSize" ? "compress" : g.goal === "format" ? "convert" : "enhance", String(r.input).replace(/\.\w+$/, ".out.mp4"), r.input), emit, out, 1.24 * 1024 ** 3);
    }
    case "convert_preview":
      return runJob(mkJob("Preview", "preview", "preview.mp4", a.req.input), emit, 2e6, 3e7);
    case "jobs_list":
      return store.jobs;
    case "job_cancel": {
      const j = store.jobs.find((x) => x.id === a.id);
      if (j) { j.status = "cancelled"; j.stage = "Cancelled"; emit("job", { ...j }); }
      return null;
    }
    case "jobs_clear":
      store.jobs = store.jobs.filter((j) => j.status === "queued" || j.status === "running");
      return null;
    case "is_busy":
      return store.jobs.some((j) => j.status === "running" || j.status === "queued") || !!store.recording;
    case "monitors":
      return [{ index: 0, name: "Built-in display", x: 0, y: 0, width: 2560, height: 1440, scale: 1.5, primary: true }, { index: 1, name: "Monitor 2", x: 2560, y: 0, width: 1920, height: 1080, scale: 1, primary: false }];
    case "windows_list":
      return ["Browser", "Code editor", "Terminal"];
    case "record_start":
      store.recording = { started: Date.now(), paused: false, pausedAt: 0, pausedTotal: 0 };
      emit("recorder", "started");
      return { id: "recording-1", startedUnix: Date.now() / 1000, state: "recording", fps: 30, segments: ["screen-001.mkv"], duration: 0, droppedFrames: 0, bytes: 0, encoder: "h264_nvenc", notes: [] } as Manifest;
    case "record_status": {
      const r = store.recording;
      if (!r) return null;
      const now = r.paused ? r.pausedAt : Date.now();
      const seconds = (now - r.started - r.pausedTotal) / 1000;
      return { recording: true, paused: r.paused, seconds, bytes: seconds * 1.1e6, droppedFrames: 0, freeBytes: 120e9, warning: null, micLevel: 0.3 + Math.random() * 0.4 };
    }
    case "record_pause":
      if (store.recording) { store.recording.paused = true; store.recording.pausedAt = Date.now(); }
      return null;
    case "record_resume":
      if (store.recording) { store.recording.pausedTotal += Date.now() - store.recording.pausedAt; store.recording.paused = false; }
      return null;
    case "record_stop": {
      const r = store.recording;
      store.recording = null;
      emit("recorder", "stopped");
      const d = r ? (Date.now() - r.started - r.pausedTotal) / 1000 : 0;
      return { id: "recording-1", startedUnix: Date.now() / 1000, state: "done", fps: 30, segments: [], video: "screen-001.mkv", mic: "mic.wav", systemAudio: "system.wav", duration: d, droppedFrames: 0, bytes: d * 1.1e6, encoder: "h264_nvenc", notes: [] } as Manifest;
    }
    case "take_finished_recording":
      return null;
    case "replay_start":
      store.replay = { started: Date.now(), seconds: a.opts?.seconds || 30 };
      emit("replay", "started");
      return { running: true, seconds: store.replay.seconds, buffered: 0, notes: [] };
    case "replay_stop":
      store.replay = null;
      emit("replay", "stopped");
      return null;
    case "replay_save": {
      if (!store.replay) {
        const msg = "Instant replay is off. Turn it on in Record first.";
        emit("replay-error", msg);
        throw new Error(msg);
      }
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const savePath = `C:/Users/you/Videos/Alchemist/Replays/Replay ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.mp4`;
      emit("replay-saved", savePath);
      return savePath;
    }
    case "replays_dir":
      return "C:/Users/you/Videos/Alchemist/Replays";
    case "replay_status":
      if (!store.replay) return { running: false, seconds: 30, buffered: 0, notes: [] };
      return {
        running: true,
        seconds: store.replay.seconds,
        buffered: Math.min(store.replay.seconds, (Date.now() - store.replay.started) / 1000),
        notes: [],
      };
    case "recording_ui_done":
      return null;
    case "record_cancel":
      store.recording = null;
      return null;
    case "recovered_recordings":
      return [];
    case "open_area_picker":
      setTimeout(() => emit("area-picked", { x: 320, y: 180, width: 1280, height: 720 }), 300);
      return null;
    case "area_picked":
      emit("area-picked", a.area);
      return null;
    case "project_new":
      return newProject(a.name, a.width, a.height, a.fps);
    case "project_save":
      store.projects[a.project.id] = { ...a.project, modified: Math.floor(Date.now() / 1000) };
      saveLocal("alc-mock-projects", store.projects);
      return null;
    case "project_load": {
      const p = store.projects[a.id];
      if (!p) throw "This project couldn't be found.";
      return p;
    }
    case "project_list":
      return Object.values(store.projects).map((p): ProjectSummary => ({ id: p.id, name: p.name, modified: p.modified, duration: Math.max(0, ...p.tracks.flatMap((t) => t.clips.map((c) => c.start + (c.out - c.in) / c.speed))), thumb: null })).sort((x, y) => y.modified - x.modified);
    case "project_delete":
      delete store.projects[a.id];
      saveLocal("alc-mock-projects", store.projects);
      return null;
    case "history_save":
      store.history[a.id] = a.history;
      return null;
    case "history_load":
      return store.history[a.id] ?? { undo: [], redo: [] };
    case "media_import":
      return (a.paths as string[]).map(sampleMedia);
    case "project_from_recording": {
      const p = newProject("Screen recording");
      const v = sampleMedia("C:/recordings/screen-001.mkv");
      v.duration = 42; v.hasAudio = false;
      const m = sampleMedia("C:/recordings/mic.wav");
      m.duration = 42;
      p.media.push(v, m);
      const clip = (mid: string) => ({ id: uuid(), mediaId: mid, start: 0, in: 0, out: 42, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, reverse: false, freeze: false, transform: { rotate: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0 }, text: null, shape: null, cleanVoice: false });
      p.tracks[0].clips.push(clip(v.id));
      p.tracks[2].clips.push({ ...clip(m.id), cleanVoice: true });
      p.zooms = [{ start: 6, end: 11, scale: 2, x: 0.75, y: 0.7 }, { start: 22, end: 27, scale: 1.8, x: 0.3, y: 0.4 }];
      p.events = "C:/recordings/events.jsonl";
      p.eventsMedia = v.id;
      p.sourceRect = [0, 0, 1920, 1080];
      p.cursorHidden = true;
      p.cursor = { show: true, size: 1, smoothing: 0.5, ripple: true, highlight: false, keys: true, color: "#5b8cff" };
      store.projects[p.id] = p;
      return p;
    }
    case "export_start":
      return runJob(mkJob(`Export "${a.project.name}"`, "export", a.req.output), emit, 96 * 1024 * 1024, 0);
    case "detect_silence":
      return [{ start: 12.2, end: 15.6 }, { start: 30.1, end: 33.0 }, { start: 38.5, end: 45.2 }];
    case "auto_zoom":
      return [{ start: 6, end: 11, scale: 2, x: 0.75, y: 0.7 }];
    case "cursor_data": {
      // A lazy figure-of-eight across the screen with a click every 4 s.
      const rate = 30;
      const path: [number, number, number][] = [];
      for (let i = 0; i <= 42 * rate; i++) {
        const t = i / rate;
        path.push([t, 960 + Math.sin(t * 0.5) * 700, 540 + Math.sin(t) * 350]);
      }
      const clicks = path.filter((_, i) => i % (4 * rate) === 2 * rate);
      return { path, rate, clicks, keys: [[3, 4.2, "Ctrl + S"], [9, 11, "hello world"]] };
    }
    case "waveform":
      return Array.from({ length: a.buckets }, (_, i) => Math.abs(Math.sin(i / 7)) * 0.6 + Math.random() * 0.25);
    case "thumbnail":
      return "";
    case "make_proxy":
      return runJob(mkJob("Preparing smooth preview", "proxy", "proxy.mp4"), emit, 1e7, 0);
    case "captions_export":
    case "project_package":
      return "C:/Videos/package/project.alc";
    case "captions_import":
      return [{ start: 1, end: 3, text: "Imported caption" }];
    case "project_relink":
      return { ...a.project, media: a.project.media.map((m: Media) => (m.id === a.mediaId ? { ...m, path: a.path, missing: false } : m)) };
    case "project_open_file":
      return newProject("Opened project");
    case "read_text_file":
      return JSON.stringify({ name: "Midnight", bg: "#0a0f1e", surf: "#0f1528", raised: "#151c33", text: "#e8ecf8", muted: "#9aa6c4", accent: "#8fb0ff", btn: "#3a5fd0", on: "#ffffff" });
    case "file_exists":
      return true;
    case "file_size":
      return 25 * 1024 * 1024;
    case "crash_reports":
      return [];
    case "quit":
      return null;
    default:
      throw `Unknown command ${cmd}`;
  }
}

export async function mockPick(opts: { multiple?: boolean; project?: boolean; subtitles?: boolean; theme?: boolean }): Promise<string[]> {
  if (opts.theme) return ["C:/themes/midnight.json"];
  if (opts.project) return ["C:/Videos/demo.alc"];
  if (opts.subtitles) return ["C:/Videos/captions.srt"];
  return opts.multiple ? ["C:/Videos/team-standup.mov", "C:/Videos/conference-talk.mkv"] : ["C:/Videos/team-standup.mov"];
}
