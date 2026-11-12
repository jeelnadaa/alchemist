// Convert & compress: add files, choose what you want, press start.
// Works without opening the editor; jobs keep running in the background.

import { call, fileUrl, pickFiles, pickFolder, type Clamped, type ConvertRequest, type Container, type EnhanceOptions, type Goal, type Job, type MediaInfo, type Quality, type SizePlan } from "../api";
import { clear, h, icon } from "../dom";
import { bytes, clock, fileName } from "../format";
import { take } from "../router";
import type { Shell } from "../shell";
import { jobRow } from "../shell";
import { store } from "../store";
import { errorText, modal, segmented, toast, toggleRow } from "../ui/common";
import { rememberFile } from "../ui/palette";

type GoalKind = "smaller" | "format" | "enhance";

interface FileItem { path: string; info?: MediaInfo; error?: string }

export async function mount(shell: Shell) {
  const s = store.settings;
  let goal: GoalKind = (take<GoalKind>("convert-goal") as GoalKind) || "smaller";
  let target = s.defaultTargetMb;
  let customTarget = "";
  let fmt: Container = (take<Container>("convert-format") as Container) || "mp4";
  let quality: Quality = "same";
  const fixes: EnhanceOptions = { sharpen: true, denoise: true, stabilize: false, upscale: false, deinterlace: false, hdrToSdr: false };
  let video: { width: number; height: number; fps: number } | null = null;
  let fit: "fit" | "fill" | "stretch" = "fit";
  let useHardware = s.useHardware;
  let keepMetadata = true;
  let outFolder: string | null = s.saveNextToOriginal ? null : s.exportFolder;
  const files: FileItem[] = [];
  let selected = 0;
  const myJobs = new Set<string>();

  const list = h("ul", { "aria-label": "Files", style: { listStyle: "none", margin: "0", padding: "0", display: "flex", flexDirection: "column", gap: "10px" } });
  const jobsBox = h("div", { class: "col" });
  const panel = h("div", { class: "scroll" });
  const ctaBtn = h("button", { type: "button", class: "btn primary big grow", onclick: () => start() }, "Start");
  const previewBtn = h("button", { type: "button", class: "btn big", onclick: () => preview() }, "Preview 5 s");

  const addFiles = async (paths: string[]) => {
    for (const p of paths) {
      if (files.some((f) => f.path === p)) continue;
      rememberFile(p);
      const item: FileItem = { path: p };
      files.push(item);
      call<MediaInfo>("probe", { path: p }).then((i) => (item.info = i)).catch((e) => (item.error = errorText(e))).finally(() => { renderFiles(); renderPanel(); });
    }
    renderFiles();
    renderPanel();
  };

  const renderFiles = () => {
    clear(list);
    files.forEach((f, i) => {
      const info = f.info;
      list.appendChild(h("li", null,
        h("div", { class: "filerow", role: "button", tabindex: "0", "aria-selected": String(i === selected), onclick: () => { selected = i; renderFiles(); renderPanel(); } },
          h("span", { class: "tb" }),
          h("span", { class: "grow col", style: { gap: "2px" } },
            h("strong", null, fileName(f.path)),
            f.error ? h("span", { class: "small", style: { color: "var(--rec)" } }, f.error)
              : info ? h("span", { class: "mono tiny muted" }, `${info.hasVideo ? `${info.width}×${info.height} · ${Math.round(info.fps * 100) / 100} fps · ` : "audio · "}${clock(info.duration)} · ${bytes(info.sizeBytes)}`)
              : h("span", { class: "tiny muted" }, "Reading…")),
          h("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${fileName(f.path)}`, onclick: (e: Event) => { e.stopPropagation(); files.splice(i, 1); selected = Math.max(0, Math.min(selected, files.length - 1)); renderFiles(); renderPanel(); } }, icon("close", 14)))));
    });
  };

  const renderJobs = () => {
    clear(jobsBox);
    const jobs = [...myJobs].map((id) => store.jobs.get(id)).filter(Boolean) as Job[];
    if (jobs.length) jobsBox.append(h("h2", null, "Progress"), ...jobs.reverse().map((j) => jobRow(j)));
  };
  const unsub = store.sub("jobs", renderJobs);

  const opt = (title: string, sub: string, on: boolean, click: () => void) =>
    h("button", { type: "button", class: "opt", "aria-pressed": String(on), onclick: click }, h("strong", null, title), h("small", null, sub));

  const estimateBox = h("div", { class: "estimate", "aria-live": "polite" });

  let estimateToken = 0;
  async function renderEstimate() {
    const f = files[selected];
    const my = ++estimateToken;
    const plan = goal === "smaller" && f?.info ? await call<SizePlan>("size_plan", { path: f.path, targetMb: target }).catch(() => null) : null;
    if (my !== estimateToken) return;
    clear(estimateBox);
    estimateBox.appendChild(h("span", { class: "tiny muted" }, "You'll get about"));
    if (goal === "smaller") {
      estimateBox.appendChild(h("strong", null, `Under ${target} MB`));
      if (f?.info) {
        const p = plan;
        if (p) {
          estimateBox.appendChild(h("span", { class: "small" }, `${p.label} · ${Math.round(p.videoKbps)} kbps video · ${Math.max(1, Math.round(f.info.sizeBytes / (target * 1024 * 1024)))}× smaller`));
          if (p.tooSmall) estimateBox.appendChild(h("span", { class: "small", style: { color: "var(--warn)" } }, "This video is too long for that size to look good. Try a bigger target or trim it first."));
        }
      } else estimateBox.appendChild(h("span", { class: "small muted" }, "Add a video to see the details."));
    } else if (goal === "format") {
      estimateBox.appendChild(h("strong", null, fmt.toUpperCase()));
      const remux = f?.info && quality === "same" && !video && ((fmt === "mkv") || ((fmt === "mp4" || fmt === "mov") && ["h264", "hevc", "av1"].includes(f.info.videoCodec || "")));
      estimateBox.appendChild(h("span", { class: "small" }, remux ? "No re-encoding needed: same quality, done in seconds." : fmt === "gif" ? "Up to 720 px wide at 15 fps. Long clips make big GIFs." : ["mp3", "m4a", "wav"].includes(fmt) ? "Just the sound." : quality === "smaller" ? "Smaller file, slightly softer picture." : quality === "best" ? "Highest quality, bigger file." : "Close to the original quality."));
    } else {
      const n = Object.entries(fixes).filter(([, v]) => v).length;
      estimateBox.appendChild(h("strong", null, `${n} improvement${n === 1 ? "" : "s"}`));
      estimateBox.appendChild(h("span", { class: "small" }, fixes.upscale ? "Upscaling is slow: a few minutes per minute of video. Uses high-quality scaling, not AI." : "Preview first to compare before and after."));
    }
  }

  function renderPanel() {
    clear(panel);
    panel.appendChild(h("div", { class: "col", style: { gap: "12px" } },
      h("h2", null, "What do you want?"),
      segmented("Goal", [["smaller", "Make smaller"], ["format", "Change format"], ["enhance", "Enhance"]], goal, (v) => { goal = v; renderPanel(); })));

    if (goal === "smaller") {
      const grid = h("div", { class: "grid2" });
      for (const [mb, use] of [[10, "Chat apps"], [25, "Email"], [50, "Websites"], [100, "Keep it sharp"]] as [number, string][]) {
        grid.appendChild(opt(`${mb} MB`, use, target === mb && !customTarget, () => { target = mb; customTarget = ""; store.set({ defaultTargetMb: mb }); renderPanel(); }));
      }
      const custom = h("input", { class: "input", type: "number", min: "1", step: "1", placeholder: "Any size in MB", value: customTarget, "aria-label": "Custom size in MB" }) as HTMLInputElement;
      custom.addEventListener("change", () => { customTarget = custom.value; if (+custom.value > 0) { target = +custom.value; renderPanel(); } });
      panel.append(h("div", { class: "col" }, h("span", { class: "small muted" }, "Make it fit under"), grid, custom),
        h("details", null, h("summary", { class: "small muted", style: { cursor: "pointer" } }, "How does this work?"),
          h("p", { class: "small muted", style: { marginTop: "8px" } }, "Alchemist divides the size you want by the video's length to get a bitrate, keeps a little room for safety, and lowers the resolution only when that bitrate can't carry it. If the result is still over, it tries again a bit smaller. The real quality score is measured afterwards.")));
    } else if (goal === "format") {
      const grid = h("div", { class: "grid3" });
      for (const [c, use] of [["mp4", "Plays anywhere"], ["webm", "Websites"], ["mov", "Apple apps"], ["mkv", "Keeps everything"], ["gif", "Short loops"], ["mp3", "Audio only"], ["m4a", "Audio, AAC"], ["wav", "Audio, lossless"]] as [Container, string][]) {
        grid.appendChild(opt(c.toUpperCase(), use, fmt === c, () => { fmt = c; renderPanel(); }));
      }
      panel.append(h("div", { class: "col" }, h("span", { class: "small muted" }, "Turn it into"), grid),
        h("div", { class: "field" }, "Quality", segmented("Quality", [["smaller", "Smaller"], ["same", "Same"], ["best", "Best"]], quality, (v) => { quality = v; renderEstimate(); })));
    } else {
      const fixList: [keyof EnhanceOptions, string, string][] = [
        ["sharpen", "Sharpen", "Crisper text and edges"], ["denoise", "Remove noise", "Cleans grainy, low-light video"], ["stabilize", "Stabilize", "Smooths shaky handheld shots"],
        ["upscale", "Upscale 2×", "Bigger picture; best for old footage"], ["deinterlace", "Fix interlacing", "For old TV and camcorder footage"], ["hdrToSdr", "HDR to normal", "Stops phone video looking washed out"],
      ];
      const box = h("div", { class: "col", style: { gap: "4px" } }, h("span", { class: "small muted" }, "Improve"));
      for (const [k, title, sub] of fixList) box.appendChild(toggleRow(title, sub, fixes[k], (v) => { fixes[k] = v; renderEstimate(); }));
      panel.appendChild(box);
    }
    panel.appendChild(estimateBox);
    panel.appendChild(h("button", { type: "button", class: "btn", style: { justifyContent: "space-between" }, onclick: () => moreOptions() }, "More options", h("span", { class: "tiny muted" }, video ? `${video.width}×${video.height} · ${video.fps} fps` : "size, frame rate, hardware, metadata")));
    panel.appendChild(h("div", { class: "row small", style: { justifyContent: "space-between" } }, h("span", null, "Save to"),
      h("button", { type: "button", class: "btn ghost", style: { height: "32px" }, onclick: async () => { outFolder = await pickFolder(); renderPanel(); } }, outFolder ? fileName(outFolder) : "Same folder as the original")));
    const n = files.length;
    ctaBtn.textContent = !n ? "Add a video first" : goal === "smaller" ? `Shrink ${n > 1 ? `${n} files ` : ""}to ${target} MB` : goal === "format" ? `Convert ${n > 1 ? `${n} files ` : ""}to ${fmt.toUpperCase()}` : `Enhance ${n > 1 ? `${n} files` : ""}`.trim();
    ctaBtn.disabled = !n;
    previewBtn.disabled = !files[selected]?.info || ["mp3", "m4a", "wav"].includes(fmt);
    renderEstimate();
  }

  function buildGoal(): Goal {
    if (goal === "smaller") return { goal: "targetSize", targetMb: target };
    if (goal === "format") return { goal: "format", container: fmt, quality };
    return { goal: "enhance", options: { ...fixes } };
  }

  function request(path: string): ConvertRequest {
    const name = fileName(path).replace(/\.[^.]+$/, "");
    const ext = goal === "format" ? fmt : "mp4";
    const suffix = goal === "smaller" ? ` (${target} MB)` : goal === "enhance" ? " (enhanced)" : "";
    const sep = outFolder && outFolder.includes("\\") ? "\\" : "/";
    return { input: path, output: outFolder ? `${outFolder}${sep}${name}${suffix}.${ext}` : null, goal: buildGoal(), video, fit, useHardware, keepMetadata };
  }

  async function start() {
    for (const f of files) {
      if (f.error) continue;
      try {
        const job = await call<Job>("convert_start", { req: request(f.path) });
        myJobs.add(job.id);
        store.jobs.set(job.id, job);
      } catch (e) {
        toast(`${fileName(f.path)}: ${errorText(e)}`, { error: true });
      }
    }
    files.length = 0;
    renderFiles();
    renderPanel();
    renderJobs();
  }

  async function preview() {
    const f = files[selected];
    if (!f?.info) return;
    try {
      const job = await call<Job>("convert_preview", { req: request(f.path) });
      toast("Making a 5-second preview…");
      const off = store.sub("jobs", async () => {
        const j = store.jobs.get(job.id);
        if (!j || (j.status !== "done" && j.status !== "failed")) return;
        off();
        if (j.status === "failed") return toast(j.error || "Preview failed.", { error: true });
        showCompare(f, j);
      });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }

  async function showCompare(f: FileItem, j: Job) {
    const offset = Math.max(0, ((f.info?.duration || 5) - 5) / 2);
    const before = h("video", { muted: true, playsInline: true, loop: true }) as HTMLVideoElement;
    const after = h("video", { class: "after", muted: true, playsInline: true, loop: true }) as HTMLVideoElement;
    before.src = await fileUrl(f.path);
    after.src = await fileUrl(j.output);
    before.addEventListener("loadedmetadata", () => (before.currentTime = offset));
    after.addEventListener("timeupdate", () => { if (Math.abs(before.currentTime - (offset + after.currentTime)) > 0.15) before.currentTime = offset + after.currentTime; });
    const cmp = h("div", { class: "compare", role: "slider", tabindex: "0", "aria-label": "Before and after", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "50" }, before, after, h("div", { class: "handle" }), h("span", { class: "tag", style: { left: "10px" } }, "Before"), h("span", { class: "tag", style: { right: "10px" } }, "After"));
    const setPos = (x: number) => { const r = cmp.getBoundingClientRect(); const p = Math.min(98, Math.max(2, ((x - r.left) / r.width) * 100)); cmp.style.setProperty("--pos", `${p}%`); cmp.setAttribute("aria-valuenow", String(Math.round(p))); };
    let drag = false;
    cmp.addEventListener("pointerdown", (e) => { drag = true; cmp.setPointerCapture(e.pointerId); setPos(e.clientX); });
    cmp.addEventListener("pointermove", (e) => drag && setPos(e.clientX));
    cmp.addEventListener("pointerup", () => (drag = false));
    cmp.addEventListener("keydown", (e) => { const v = +(cmp.getAttribute("aria-valuenow") || 50) + (e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0); cmp.style.setProperty("--pos", `${v}%`); cmp.setAttribute("aria-valuenow", String(v)); });
    before.play().catch(() => {});
    after.play().catch(() => {});
    const sampleRate = j.report?.outputBytes && f.info ? (j.report.outputBytes / 5) * f.info.duration : 0;
    modal((close) => h("div", { class: "dialog", style: { width: "900px" } },
      h("header", null, h("h2", null, "Preview"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16))),
      h("div", { class: "content" }, cmp,
        sampleRate && goal !== "smaller" ? h("p", { class: "muted small" }, `Estimated full size from this sample: about ${bytes(sampleRate)}.`) : null),
      h("footer", null, h("span", { class: "grow muted small" }, "Drag the line to compare."), h("button", { type: "button", class: "btn", onclick: close }, "Back"), h("button", { type: "button", class: "btn primary", onclick: () => { close(); start(); } }, "Looks good, start"))),
    { label: "Preview" });
  }

  function moreOptions() {
    modal((close) => {
      const w = h("input", { class: "input", type: "number", placeholder: "Same", value: String(video?.width ?? ""), "aria-label": "Width" }) as HTMLInputElement;
      const hh = h("input", { class: "input", type: "number", placeholder: "Same", value: String(video?.height ?? ""), "aria-label": "Height" }) as HTMLInputElement;
      const fpsSel = h("select", { class: "input", "aria-label": "Frame rate" }, h("option", { value: "" }, "Same as original"), ...["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => h("option", { value: v, selected: String(video?.fps) === v }, `${v} fps`))) as HTMLSelectElement;
      const lock = { on: true };
      const notes = h("div", { class: "col small" });
      const src = files[selected]?.info;
      w.addEventListener("input", () => { if (lock.on && src?.width && +w.value) hh.value = String(Math.round((+w.value * src.height) / src.width / 2) * 2); });
      const presets = h("div", { class: "chips" }, ...[["16:9", 1920, 1080], ["9:16", 1080, 1920], ["1:1", 1080, 1080], ["4:5", 1080, 1350], ["21:9", 2560, 1080]].map(([n, pw, ph]) => h("button", { type: "button", onclick: () => { w.value = String(pw); hh.value = String(ph); fit = "fill"; } }, n as string)));
      const apply = async () => {
        notes.replaceChildren();
        if (!w.value && !hh.value && !fpsSel.value) { video = null; return true; }
        const c = await call<Clamped>("check_limits", { width: +w.value || src?.width || 1920, height: +hh.value || src?.height || 1080, fps: +fpsSel.value || src?.fps || 30 });
        video = c.value;
        c.notes.forEach((n) => notes.appendChild(h("span", { style: { color: "var(--warn)" } }, n)));
        if (src && (c.value.width > src.width || c.value.height > src.height)) notes.appendChild(h("span", { style: { color: "var(--warn)" } }, "This is bigger than the original, so it's upscaled. Turn on Enhance › Upscale for the best result."));
        if (src && c.value.fps > src.fps + 0.5) notes.appendChild(h("span", { style: { color: "var(--warn)" } }, "Raising the frame rate repeats frames; it won't make motion smoother."));
        return c.notes.length === 0;
      };
      return h("div", { class: "dialog", style: { width: "620px" } },
        h("header", null, h("h2", null, "More options"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16))),
        h("div", { class: "content" },
          h("div", { class: "field" }, "Size", h("div", { class: "grid2" }, w, hh), presets, toggleRow("Keep proportions", null, true, (v) => (lock.on = v))),
          h("div", { class: "field" }, "When proportions differ", segmented("Fit", [["fit", "Fit (bars)"], ["fill", "Fill (crop)"], ["stretch", "Stretch"]], fit, (v) => (fit = v))),
          h("label", { class: "field" }, "Frame rate", fpsSel), notes,
          toggleRow("Use the graphics card", "Much faster. Turn off if a file comes out wrong.", useHardware, (v) => (useHardware = v)),
          toggleRow("Keep titles, chapters and subtitles", null, keepMetadata, (v) => (keepMetadata = v))),
        h("footer", null, h("button", { type: "button", class: "btn", onclick: () => { video = null; fit = "fit"; close(); renderPanel(); } }, "Reset"), h("span", { class: "grow" }), h("button", { type: "button", class: "btn primary", onclick: async () => { await apply(); close(); renderPanel(); } }, "Done")));
    }, { label: "More options" });
  }

  const page = h("div", { class: "convert" },
    h("div", { class: "files" },
      h("div", { class: "col", style: { gap: "6px" } }, h("h1", null, "Convert & compress"), h("p", { class: "muted" }, "Add videos, choose what you want, press start. You can close this window: it keeps working.")),
      h("button", { type: "button", class: "dropzone", style: { minHeight: "92px" }, onclick: async () => addFiles(await pickFiles({ multiple: true })) }, icon("plus", 22), "Add videos or drop them here"),
      list, jobsBox),
    h("aside", { "aria-label": "Settings for the selected file" }, panel, h("div", { class: "bottom" }, previewBtn, ctaBtn)));
  shell.main.appendChild(page);

  const incoming = take<string[]>("convert-files");
  if (incoming) await addFiles(incoming);
  renderFiles();
  renderPanel();
  // Show jobs started earlier from this screen type.
  for (const j of store.jobs.values()) if (["convert", "compress", "enhance"].includes(j.kind) && (j.status === "running" || j.status === "queued")) myJobs.add(j.id);
  renderJobs();
  if (take("convert-help")) (panel.querySelector("details") as HTMLDetailsElement | null)?.setAttribute("open", "");
  return () => unsub();
}
