// Human-friendly numbers. Shared by every screen so wording stays consistent.

export function bytes(n: number): string {
  if (!isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i >= 3 ? v.toFixed(2) : i === 2 ? (v >= 100 ? Math.round(v) : v.toFixed(1)) : Math.round(v)} ${units[i]}`;
}

/** 0:00, 3:07, 1:02:03 */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 00:01:02.50 style for the timecode display. */
export function timecode(sec: number, fps = 30): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const f = Math.floor((s - Math.floor(s)) * fps);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

export function eta(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return "";
  if (sec < 60) return "under a minute left";
  const m = Math.round(sec / 60);
  return m === 1 ? "about 1 min left" : `about ${m} min left`;
}

export function ratio(before: number, after: number): string {
  if (!before || !after) return "";
  const r = before / after;
  if (r >= 1.05) return `${r >= 10 ? Math.round(r) : r.toFixed(1)}× smaller`;
  if (r <= 0.95) return `${(1 / r).toFixed(1)}× larger`;
  return "about the same size";
}

export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - unixSeconds);
  if (d < 60) return "Just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 172800) return "Yesterday";
  return `${Math.floor(d / 86400)} days ago`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
