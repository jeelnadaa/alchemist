// Recorder setup: what to record, sound and camera, quality, then Record.
// Advanced settings (custom size and frame rate, auto-stop, keystrokes) sit
// behind "More options".

import { call, inTauri, on, type Clamped, type Manifest, type Monitor, type RecordOptions, type RecordStatus, type Source } from "../api";
import { clear, h, icon } from "../dom";
import { bytes, clock } from "../format";
import { go, take } from "../router";
import type { Shell } from "../shell";
import { store } from "../store";
import { errorText, modal, segmented, toast, toggleRow } from "../ui/common";

type Kind = "screen" | "window" | "area";

const PRESET_LABEL: Record<RecordOptions["preset"], string> = { tutorial: "Tutorial · 1080p 30", high: "High quality · 60 fps", tiny: "Tiny file · 24 fps" };
// Rough size per minute for the honest live estimate (hardware H.264).
const MB_PER_MIN: Record<RecordOptions["preset"], number> = { tutorial: 45, high: 110, tiny: 18 };

export async function mount(shell: Shell) {
  const s = store.settings;
  const info = await call<{ os: string }>("app_info");
  const monitors = await call<Monitor[]>("monitors").catch(() => [] as Monitor[]);
  let kind: Kind = (take<Kind>("record-source") as Kind) || "screen";
  if (kind === "window" && info.os !== "windows") kind = "area";
  let monitor = monitors.find((m) => m.primary) || monitors[0];
  let windowTitle = "";
  let area: { x: number; y: number; width: number; height: number } | null = null;
  const opts = { mic: s.recordMic, systemAudio: s.recordSystemAudio, camera: s.recordCamera, preset: s.recordPreset, keys: s.recordKeys, smoothCursor: s.recordSmoothCursor ?? true };
  let custom: { width: number; height: number; fps: number } | null = null;
  let autoStopMin = 0;
  let autoStopMb = 0;

  const sourceArea = h("div", { class: "col", style: { alignItems: "center", gap: "14px" } });
  const estimate = h("p", { class: "muted small" });
  const errorBox = h("div", { class: "hidden" });

  const renderSource = async () => {
    clear(sourceArea);
    if (kind === "screen") {
      const tiles = h("div", { class: "screens", role: "radiogroup", "aria-label": "Screen" });
      for (const m of monitors) {
        tiles.appendChild(
          h("button", { type: "button", role: "radio", class: "screen-tile", "aria-checked": String(m === monitor), onclick: () => { monitor = m; renderSource(); } },
            h("span", { class: "mini" }), h("strong", null, m.name || `Screen ${m.index + 1}`), h("span", { class: "muted small" }, `${m.width} × ${m.height}${m.primary ? " · main" : ""}`)));
      }
      if (!monitors.length) tiles.appendChild(h("p", { class: "muted" }, "No screens found."));
      sourceArea.appendChild(tiles);
    } else if (kind === "window") {
      const list = await call<string[]>("windows_list").catch(() => [] as string[]);
      if (!windowTitle && list.length) windowTitle = list[0];
      const sel = h("select", { class: "input", style: { width: "480px" }, "aria-label": "Window to record", onchange: (e: Event) => (windowTitle = (e.target as HTMLSelectElement).value) },
        ...list.map((t) => h("option", { value: t, selected: t === windowTitle }, t)));
      sourceArea.append(h("label", { class: "field" }, "Window", sel), h("p", { class: "muted small" }, "Tip: keep the window where it is while recording."));
    } else {
      const pick = h("button", { type: "button", class: "btn", onclick: async () => {
        if (!monitor) return;
        await call("open_area_picker", { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height });
      } }, icon("box", 16), area ? "Change area" : "Choose an area");
      sourceArea.append(
        h("div", { class: "screen-tile", style: { width: "320px", cursor: "default" } }, h("span", { class: "mini", style: { display: "grid", placeItems: "center" } }, area ? h("span", { class: "mono small" }, `${area.width} × ${area.height}`) : h("span", { class: "muted small" }, "No area yet"))),
        pick,
        monitors.length > 1 ? h("select", { class: "input", style: { width: "260px" }, "aria-label": "Screen for the area", onchange: (e: Event) => { monitor = monitors[+(e.target as HTMLSelectElement).value]; area = null; renderSource(); } }, ...monitors.map((m, i) => h("option", { value: String(i), selected: m === monitor }, m.name))) : "");
    }
    renderEstimate();
  };

  const renderEstimate = () => {
    const mb = MB_PER_MIN[opts.preset] * (custom ? (custom.width * custom.height) / (1920 * 1080) * (custom.fps / (opts.preset === "high" ? 60 : 30)) : 1);
    estimate.textContent = `About ${Math.max(5, Math.round(mb))} MB per minute${opts.mic || opts.systemAudio ? ", sound on separate tracks" : ""}. Saved continuously, so a crash loses about a second.`;
  };

  const unArea = await on<{ x: number; y: number; width: number; height: number } | null>("area-picked", (a) => {
    if (!a) return;
    area = a;
    kind = "area";
    renderSource();
  });

  const pill = (label: string, ic: Parameters<typeof icon>[0], key: "mic" | "systemAudio" | "camera", offLabel: string) => {
    const b = h("button", { type: "button", class: "pill", "aria-pressed": String(opts[key]), "data-tooltip": `Toggle ${label}`, "data-tooltip-pos": "top" }, icon(ic, 18), h("span", null, opts[key] ? label : offLabel));
    b.addEventListener("click", () => {
      opts[key] = !opts[key];
      b.setAttribute("aria-pressed", String(opts[key]));
      b.querySelector("span")!.textContent = opts[key] ? label : offLabel;
      store.set({ recordMic: opts.mic, recordSystemAudio: opts.systemAudio, recordCamera: opts.camera });
      renderEstimate();
    });
    return b;
  };

  const qualityBtn = h("button", { type: "button", class: "pill", "data-tooltip": "Change recording quality preset", "data-tooltip-pos": "top", style: { flexDirection: "column", alignItems: "flex-start", gap: "0", lineHeight: "1.15" }, onclick: () => openMore() },
    h("span", { class: "tiny muted" }, "Quality"), h("span", { style: { color: "var(--text)" } }, PRESET_LABEL[opts.preset]));

  const sources: [Kind, string][] = info.os === "windows" ? [["screen", "Screen"], ["window", "Window"], ["area", "Area"]] : [["screen", "Screen"], ["area", "Area"]];
  const toolbar = h("div", { class: "rectool", role: "toolbar", "aria-label": "Recording setup" },
    segmented("What to record", sources, kind, (v) => { kind = v; renderSource(); }),
    h("span", { class: "sep" }),
    pill("Mic", "mic", "mic", "Mic off"),
    pill("Computer sound", "speaker", "systemAudio", "Sound off"),
    pill("Camera", "camera", "camera", "Camera off"),
    h("span", { class: "sep" }),
    qualityBtn,
    h("button", { type: "button", class: "recbtn", "data-tooltip": "Start recording (Ctrl Shift R)", "data-tooltip-pos": "top", onclick: () => start() }, "Record"),
    h("button", { type: "button", class: "icon-btn", "aria-label": "More recording options", "data-tooltip": "Recording options", "data-tooltip-pos": "top", onclick: () => openMore() }, icon("more", 18)));

  const page = h("div", { class: "recorder" },
    h("h1", null, "Record"),
    sourceArea,
    errorBox,
    toolbar,
    estimate,
    h("p", { class: "muted small" }, "Press ", h("span", { class: "kbd" }, "Ctrl Shift R"), " anywhere to start or stop, even with this window closed."));
  shell.main.appendChild(page);
  await renderSource();

  function buildSource(): Source | null {
    if (kind === "window") return windowTitle ? { kind: "window", title: windowTitle } : null;
    if (kind === "area") {
      if (!area || !monitor) return null;
      return { kind: "area", x: monitor.x + area.x, y: monitor.y + area.y, width: area.width, height: area.height, screenIndex: monitor.index };
    }
    if (!monitor) return null;
    return { kind: "screen", index: monitor.index, x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
  }

  async function start() {
    const source = buildSource();
    if (!source) {
      toast(kind === "area" ? "Choose an area first." : kind === "window" ? "Choose a window first." : "No screen found.", { error: true });
      return;
    }
    const recordOpts: RecordOptions = {
      source, mic: opts.mic, systemAudio: opts.systemAudio, camera: opts.camera, preset: opts.preset, video: custom, recordKeys: opts.keys, separateCursor: opts.smoothCursor,
      autoStopSeconds: autoStopMin ? autoStopMin * 60 : null, autoStopMb: autoStopMb || null,
    };
    await countdown(store.settings.countdown);
    try {
      const m = await call<Manifest>("record_start", { opts: recordOpts });
      for (const n of m.notes) toast(n);
      if (!inTauri) inlineRecording(shell);
    } catch (e) {
      errorBox.className = "notice error";
      errorBox.replaceChildren(h("span", { class: "grow" }, errorText(e)), h("a", { href: "#/welcome?step=2" }, "How to fix this"));
    }
  }

  function openMore() {
    modal((close) => {
      const presetSeg = segmented("Quality", [["tutorial", "Tutorial · 30 fps"], ["high", "High · 60 fps"], ["tiny", "Tiny file"]], opts.preset, (v) => {
        opts.preset = v;
        store.set({ recordPreset: v });
        qualityBtn.lastElementChild!.textContent = PRESET_LABEL[v];
        renderEstimate();
      });
      const w = h("input", { class: "input", type: "number", value: String(custom?.width ?? ""), placeholder: "Same as screen", "aria-label": "Width" }) as HTMLInputElement;
      const hh = h("input", { class: "input", type: "number", value: String(custom?.height ?? ""), placeholder: "Same as screen", "aria-label": "Height" }) as HTMLInputElement;
      const f = h("input", { class: "input", type: "number", step: "0.01", value: String(custom?.fps ?? ""), placeholder: "From quality", "aria-label": "Frame rate" }) as HTMLInputElement;
      const notes = h("div", { class: "col small" });
      const check = async () => {
        notes.replaceChildren();
        if (!w.value && !hh.value && !f.value) {
          custom = null;
          return;
        }
        const c = await call<Clamped>("check_limits", { width: +w.value || 1920, height: +hh.value || 1080, fps: +f.value || (opts.preset === "high" ? 60 : 30) });
        custom = c.value;
        for (const n of c.notes) notes.appendChild(h("span", { style: { color: "var(--warn)" } }, n));
        if (c.value.fps > 60 || c.value.width * c.value.height > 3840 * 2160) notes.appendChild(h("span", { style: { color: "var(--warn)" } }, "This is heavy for live recording and may drop frames. 1080p at 30 or 60 fps is recommended."));
        renderEstimate();
      };
      [w, hh, f].forEach((el) => el.addEventListener("change", check));
      const minutes = h("input", { class: "input", type: "number", min: "0", value: String(autoStopMin || ""), placeholder: "Off", "aria-label": "Stop after minutes", onchange: (e: Event) => (autoStopMin = +(e.target as HTMLInputElement).value || 0) });
      const mb = h("input", { class: "input", type: "number", min: "0", value: String(autoStopMb || ""), placeholder: "Off", "aria-label": "Stop at size in MB", onchange: (e: Event) => (autoStopMb = +(e.target as HTMLInputElement).value || 0) });
      return h("div", { class: "dialog", style: { width: "620px" } },
        h("header", null, h("h2", null, "Recording options"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16))),
        h("div", { class: "content" },
          h("div", { class: "field" }, "Quality", presetSeg),
          h("div", { class: "field" }, "Custom size and frame rate (optional)", h("div", { class: "grid3" }, w, hh, f), notes),
          h("div", { class: "grid2" }, h("label", { class: "field" }, "Stop after (minutes)", minutes), h("label", { class: "field" }, "Stop at size (MB)", mb)),
          toggleRow("Smooth cursor", "Record the pointer separately so the editor can draw a smooth, resizable cursor with click ripples.", opts.smoothCursor, (v) => { opts.smoothCursor = v; store.set({ recordSmoothCursor: v }); }),
          toggleRow("Record keystrokes", "For keystroke overlays in the editor. Stays on this computer.", opts.keys, (v) => { opts.keys = v; store.set({ recordKeys: v }); }),
          h("label", { class: "field" }, "Countdown before recording", segmented("Countdown", [["0", "Off"], ["3", "3 s"], ["5", "5 s"]], String(store.settings.countdown) as "0" | "3" | "5", (v) => store.set({ countdown: +v })))),
        h("footer", null, h("span", { class: "grow" }), h("button", { type: "button", class: "btn primary", onclick: async () => { await check(); close(); } }, "Done")));
    }, { label: "Recording options" });
  }

  if (take("record-now")) start();
  return () => unArea();
}

function countdown(n: number): Promise<void> {
  if (!n) return Promise.resolve();
  return new Promise((resolve) => {
    const el = h("div", { class: "countdown", role: "status", "aria-live": "assertive" }, String(n));
    document.body.appendChild(el);
    let left = n;
    const t = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(t);
        el.remove();
        resolve();
      } else el.textContent = String(left);
    }, 1000);
  });
}

/** In the browser preview there is no separate bar window, so show it inline. */
function inlineRecording(shell: Shell) {
  shell.main.replaceChildren();
  const host = h("div", { class: "recorder" });
  shell.main.appendChild(host);
  import("./bar").then((b) => b.mount(host, async (m) => {
    const p = await call<{ id: string }>("project_from_recording", { id: m.id });
    go(`edit/${p.id}`);
    recordingReport(m);
  }));
}

/** Honest post-recording report. */
export function recordingReport(m: Manifest) {
  const parts = [`Recorded ${clock(m.duration)}`, bytes(m.bytes)];
  if (m.droppedFrames > 0) parts.push(`${m.droppedFrames} frames dropped`);
  else parts.push("no dropped frames");
  toast(`${parts.join(" · ")}.`, { ms: 8000 });
  for (const n of m.notes) toast(n, { ms: 10000 });
}

export type { RecordStatus };
