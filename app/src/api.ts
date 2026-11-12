// Typed bridge to the Rust core. In a plain browser (UI development and
// tests) a small in-memory mock stands in, so every screen can be exercised
// without the desktop shell.

export interface MediaInfo { duration: number; width: number; height: number; fps: number; videoCodec?: string | null; audioCodec?: string | null; audioStreams: number; subtitleStreams: number; bitrateKbps?: number | null; sizeBytes: number; container: string; hasVideo: boolean; hasAudio: boolean }
export interface QualityScore { metric: string; value: number; verdict: string }
export interface Report { inputBytes: number; outputBytes: number; seconds: number; quality?: QualityScore | null; note?: string | null }
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export interface Job { id: string; title: string; kind: string; input?: string | null; output: string; status: JobStatus; progress: number; etaSeconds?: number | null; stage: string; error?: string | null; report?: Report | null }
export interface SizePlan { videoKbps: number; audioKbps: number; width: number; height: number; fps: number; label: string; tooSmall: boolean }
export interface Clamped { value: { width: number; height: number; fps: number }; notes: string[] }
export interface Capabilities { version: string; encoders: string[]; hwH264?: string | null; hwHevc?: string | null; devices: string[]; filters: string[] }
export interface AppInfo { version: string; os: string; portable: boolean; portableNote?: string | null; dataDir: string; recordingsDir: string; ffmpeg?: string | null }
export interface Monitor { index: number; name: string; x: number; y: number; width: number; height: number; scale: number; primary: boolean }

export type Container = "mp4" | "webm" | "mov" | "mkv" | "gif" | "mp3" | "m4a" | "wav";
export type Quality = "smaller" | "same" | "best";
export interface EnhanceOptions { sharpen: boolean; denoise: boolean; stabilize: boolean; upscale: boolean; deinterlace: boolean; hdrToSdr: boolean }
export type Goal = { goal: "targetSize"; targetMb: number } | { goal: "format"; container: Container; quality: Quality } | { goal: "enhance"; options: EnhanceOptions };
export interface ConvertRequest { input: string; output?: string | null; goal: Goal; video?: { width: number; height: number; fps: number } | null; fit?: "fit" | "fill" | "stretch"; start?: number | null; length?: number | null; useHardware?: boolean; keepMetadata?: boolean }

export type Source =
  | { kind: "screen"; index: number; x: number; y: number; width: number; height: number }
  | { kind: "window"; title: string }
  | { kind: "area"; x: number; y: number; width: number; height: number; screenIndex: number };
export interface RecordOptions { source: Source; mic: boolean; systemAudio: boolean; camera: boolean; preset: "tutorial" | "high" | "tiny"; video?: { width: number; height: number; fps: number } | null; recordKeys: boolean; autoStopSeconds?: number | null; autoStopMb?: number | null; separateCursor?: boolean }
export interface ReplayOptions { source: Source; seconds: number; mic: boolean; systemAudio: boolean; preset: "tutorial" | "high" | "tiny"; video?: { width: number; height: number; fps: number } | null }
export interface ReplayStatus { running: boolean; seconds: number; buffered: number; notes: string[] }
export interface Manifest { id: string; startedUnix: number; state: string; fps: number; segments: string[]; video?: string | null; mic?: string | null; systemAudio?: string | null; camera?: string | null; events?: string | null; duration: number; droppedFrames: number; bytes: number; encoder: string; notes: string[] }
export interface RecordStatus { recording: boolean; paused: boolean; seconds: number; bytes: number; droppedFrames: number; freeBytes?: number | null; warning?: string | null; micLevel: number }

export interface Transform { crop?: [number, number, number, number] | null; rotate: number; flipH: boolean; flipV: boolean; scale: number; x: number; y: number }
export interface TextProps { text: string; style: string; size: number; position: string; color: string; animation: string }
export interface ShapeProps { shape: string; rect: [number, number, number, number]; color: string }
export interface VolumeKey { t: number; v: number }
export interface Transition { kind: "crossfade" | "dip"; duration: number }
export interface Clip { id: string; mediaId?: string | null; start: number; in: number; out: number; speed: number; volume: number; fadeIn: number; fadeOut: number; reverse: boolean; freeze: boolean; transform: Transform; text?: TextProps | null; shape?: ShapeProps | null; cleanVoice: boolean; volumeKeys?: VolumeKey[]; transitionIn?: Transition | null }
export interface Track { id: string; kind: "video" | "overlay" | "text" | "audio"; name: string; muted: boolean; volume: number; clips: Clip[] }
export interface Media { id: string; path: string; kind: "video" | "audio" | "image"; duration: number; width: number; height: number; hasAudio: boolean; missing: boolean }
export interface Zoom { start: number; end: number; scale: number; x: number; y: number }
export interface Caption { start: number; end: number; text: string }
export interface Project { version: number; id: string; name: string; created: number; modified: number; settings: { width: number; height: number; fps: number; background: string; padding: number; radius: number; shadow?: boolean }; media: Media[]; tracks: Track[]; zooms: Zoom[]; zoomSmoothness: number; captions: Caption[]; markers: { t: number; label: string }[]; inPoint?: number | null; outPoint?: number | null; events?: string | null; eventsMedia?: string | null; sourceRect?: [number, number, number, number] | null; cursorHidden?: boolean; cursor?: CursorSettings }
export interface CursorSettings { show: boolean; size: number; smoothing: number; ripple: boolean; highlight: boolean; keys: boolean; color: string }
export const defaultCursor: CursorSettings = { show: true, size: 1, smoothing: 0.5, ripple: true, highlight: false, keys: true, color: "#5b8cff" };
/** Smoothed cursor path (t, x, y) at `rate` Hz, clicks (t, x, y) and keystroke labels (start, end, text), in source time and screen pixels. */
export interface CursorData { path: [number, number, number][]; rate: number; clicks: [number, number, number][]; keys: [number, number, string][] }
export interface ProjectSummary { id: string; name: string; modified: number; duration: number; thumb?: string | null }
export interface ExportRequest { preset: "share" | "vertical" | "small" | "gif" | "audio" | "custom"; output: string; range?: [number, number] | null; width?: number | null; height?: number | null; fps?: number | null; burnCaptions: boolean; sidecarCaptions: boolean; loudness: boolean; useHardware: boolean; targetMb?: number | null }

export interface Settings {
  theme: string; darkTheme: string; lightTheme: string; followSystem: boolean; accent: string | null; textSize: string; reduceMotion: boolean;
  updateMode: "auto" | "notify" | "off"; betaChannel: boolean; lastUpdateCheck: number; useHardware: boolean;
  recordPreset: "tutorial" | "high" | "tiny"; recordMic: boolean; recordSystemAudio: boolean; recordCamera: boolean; recordKeys: boolean; recordSmoothCursor: boolean; countdown: number;
  replaySeconds: number; replayHotkey: string; replaysFolder: string | null;
  defaultTargetMb: number; saveNextToOriginal: boolean; exportFolder: string | null; shortcutPreset: string; shortcuts: Record<string, string>; firstRunDone: boolean;
  [k: string]: unknown;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "obsidian", darkTheme: "obsidian", lightTheme: "salt", followSystem: false, accent: null, textSize: "default", reduceMotion: false,
  updateMode: "auto", betaChannel: false, lastUpdateCheck: 0, useHardware: true, recordPreset: "tutorial", recordMic: true, recordSystemAudio: true,
  recordCamera: false, recordKeys: false, recordSmoothCursor: true, countdown: 3,
  replaySeconds: 30, replayHotkey: "CommandOrControl+Shift+S", replaysFolder: null,
  defaultTargetMb: 25, saveNextToOriginal: true, exportFolder: null, shortcutPreset: "alchemist", shortcuts: {}, firstRunDone: false,
};

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Handler = (payload: any) => void;
const mockListeners = new Map<string, Set<Handler>>();

export async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  const { mockInvoke } = await import("./mock");
  return mockInvoke(cmd, args, mockEmit) as Promise<T>;
}

export function mockEmit(event: string, payload: unknown) {
  mockListeners.get(event)?.forEach((h) => h(payload));
}

export async function on<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (inTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(event, (e) => handler(e.payload));
  }
  if (!mockListeners.has(event)) mockListeners.set(event, new Set());
  mockListeners.get(event)!.add(handler as Handler);
  return () => mockListeners.get(event)?.delete(handler as Handler);
}

/** URL a <video> or <img> can load for a local file. */
export async function fileUrl(path: string): Promise<string> {
  if (inTauri) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(path);
  }
  return path.startsWith("blob:") || path.startsWith("http") ? path : "";
}

export async function pickFiles(opts: { multiple?: boolean; video?: boolean; project?: boolean; subtitles?: boolean; theme?: boolean } = {}): Promise<string[]> {
  if (!inTauri) {
    const { mockPick } = await import("./mock");
    return mockPick(opts);
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const filters = opts.theme
    ? [{ name: "Theme", extensions: ["json"] }]
    : opts.project
    ? [{ name: "Alchemist project", extensions: ["alc"] }]
    : opts.subtitles
      ? [{ name: "Captions", extensions: ["srt", "vtt"] }]
      : [{ name: "Video and audio", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "ts", "mts", "gif", "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "png", "jpg", "jpeg", "webp"] }];
  const r = await open({ multiple: !!opts.multiple, filters });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

export async function pickSave(defaultPath: string, ext: string): Promise<string | null> {
  if (!inTauri) return defaultPath;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
}

export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return "C:/Videos";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true });
  return typeof r === "string" ? r : null;
}

export async function reveal(path: string) {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function openUrl(url: string) {
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
