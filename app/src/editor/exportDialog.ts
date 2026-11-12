// Export dialog: five plain presets, a name, a folder, and "More options".

import { call, pickFolder, type Clamped, type ExportRequest, type Job, type Project } from "../api";
import { h, icon } from "../dom";
import { bytes, clock } from "../format";
import { store } from "../store";
import { errorText, modal, toast, toggleRow } from "../ui/common";
import { duration } from "./model";

type Preset = ExportRequest["preset"];

export function openExport(project: Project, onStarted: (job: Job) => void) {
  const total = duration(project);
  const range: [number, number] | null = project.inPoint != null || project.outPoint != null ? [project.inPoint ?? 0, project.outPoint ?? total] : null;
  const len = range ? range[1] - range[0] : total;
  const hasCaptions = project.captions.length > 0;
  let preset: Preset = "share";
  let name = project.name.replace(/[^\w\- ]+/g, "-").trim() || "video";
  let folder = store.settings.exportFolder || "";
  let burn = false;
  let sidecar = hasCaptions;
  let loudness = true;
  let useRange = !!range;
  let targetMb = store.settings.defaultTargetMb;
  let custom: { width: number; height: number; fps: number } | null = null;

  const presets: { id: Preset; name: string; detail: string; size: () => string; ext: string }[] = [
    { id: "share", name: "Best for sharing", detail: `MP4 · ${project.settings.width}×${project.settings.height} · ${project.settings.fps} fps. Plays everywhere.`, size: () => `≈ ${bytes(len * 8_000_000 / 8)}`, ext: "mp4" },
    { id: "vertical", name: "Vertical for phones", detail: "9:16 · 1080 × 1920, filled and centred.", size: () => `≈ ${bytes(len * 7_000_000 / 8)}`, ext: "mp4" },
    { id: "small", name: "Small file", detail: "Fits under a size you choose, for email and chat.", size: () => `< ${targetMb} MB`, ext: "mp4" },
    { id: "gif", name: "GIF", detail: "Silent loop, up to 720 px at 15 fps.", size: () => `≈ ${bytes(len * 400_000)}`, ext: "gif" },
    { id: "audio", name: "Audio only", detail: "MP3 of all the sound tracks.", size: () => `≈ ${bytes(len * 24_000)}`, ext: "mp3" },
  ];

  type Saved = { name: string; preset: Preset; custom: { width: number; height: number; fps: number } | null; loudness: boolean; burn: boolean; sidecar: boolean; targetMb: number };

  modal((close) => {
    const list = h("div", { class: "col", role: "radiogroup", "aria-label": "Export preset" });
    const savedBox = h("div", { class: "chips", "aria-label": "Your presets" });
    const renderSaved = () => {
      savedBox.replaceChildren();
      for (const sp of (store.settings.exportPresets as Saved[] | undefined) || []) {
        savedBox.appendChild(h("button", { type: "button", title: "Use this preset", onclick: () => { preset = sp.preset; custom = sp.custom; loudness = sp.loudness; burn = sp.burn; sidecar = sp.sidecar; targetMb = sp.targetMb; renderList(); toast(`Using "${sp.name}".`); } }, sp.name));
        savedBox.appendChild(h("button", { type: "button", "aria-label": `Delete preset ${sp.name}`, title: "Delete", onclick: () => { store.set({ exportPresets: ((store.settings.exportPresets as Saved[]) || []).filter((x) => x.name !== sp.name) }).then(renderSaved); } }, "×"));
      }
    };
    renderSaved();
    const note = h("span", { class: "grow muted small" });
    const renderList = () => {
      list.replaceChildren();
      for (const p of presets) {
        list.appendChild(h("button", { type: "button", class: "opt", role: "radio", "aria-checked": String(p.id === preset), style: { flexDirection: "row", alignItems: "center", gap: "14px" }, onclick: () => { preset = p.id; renderList(); } },
          h("span", { style: { width: "18px", height: "18px", flex: "none", borderRadius: "50%", border: p.id === preset ? "5px solid var(--accent)" : "2px solid var(--muted)" } }),
          h("span", { class: "grow col", style: { gap: "2px" } }, h("strong", null, p.name), h("small", null, p.detail)),
          h("span", { class: "mono tiny muted" }, p.size())));
      }
      note.textContent = `${clock(len)} of video. Keep editing while it exports; you'll be told when it's done.`;
    };
    renderList();
    const nameInput = h("input", { class: "input", value: name, "aria-label": "File name", oninput: (e: Event) => (name = (e.target as HTMLInputElement).value) }) as HTMLInputElement;
    const folderBtn = h("button", { type: "button", class: "btn", style: { justifyContent: "space-between", width: "100%" }, onclick: async () => { const f = await pickFolder(); if (f) { folder = f; folderBtn.firstChild!.textContent = f; store.set({ exportFolder: f }); } } }, folder || "Choose a folder", h("span", { class: "small", style: { color: "var(--accent)" } }, "Change"));
    const more = h("div", { class: "col hidden" },
      range ? toggleRow("Export only the marked range", `${clock(range[0])} to ${clock(range[1])}`, useRange, (v) => (useRange = v)) : null,
      hasCaptions ? toggleRow("Burn captions into the video", "Always visible, on every player.", burn, (v) => (burn = v)) : null,
      hasCaptions ? toggleRow("Save captions as an .srt file too", "Players can turn them on and off.", sidecar, (v) => (sidecar = v)) : null,
      toggleRow("Even out the loudness", "Targets −14 LUFS, the level most sites use.", loudness, (v) => (loudness = v)),
      h("label", { class: "field" }, "Small file target (MB)", h("input", { class: "input", type: "number", min: "1", value: String(targetMb), onchange: (e: Event) => { targetMb = +(e.target as HTMLInputElement).value || 25; renderList(); } })),
      h("div", { class: "field" }, "Custom size and frame rate", customFields((c) => (custom = c))),
      (() => {
        const nameIn = h("input", { class: "input", placeholder: "Preset name", "aria-label": "Preset name", style: { maxWidth: "240px" } }) as HTMLInputElement;
        const save = () => {
          const name = nameIn.value.trim() || presets.find((x) => x.id === preset)?.name || "My preset";
          const list2 = ((store.settings.exportPresets as Saved[]) || []).filter((x) => x.name !== name);
          list2.push({ name, preset, custom, loudness, burn, sidecar, targetMb });
          store.set({ exportPresets: list2 }).then(renderSaved);
          nameIn.value = "";
          toast(`Saved "${name}".`);
        };
        nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
        return h("div", { class: "row" }, nameIn, h("button", { type: "button", class: "btn", onclick: save }, "Save as preset"));
      })());
    return h("div", { class: "dialog" },
      h("header", null, h("h2", null, `Export "${project.name}"`), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16))),
      h("div", { class: "content" }, savedBox, list,
        h("div", { class: "grid2" }, h("label", { class: "field" }, "File name", nameInput), h("div", { class: "field" }, "Save to", folderBtn)),
        h("button", { type: "button", class: "btn", style: { justifyContent: "space-between" }, onclick: () => more.classList.toggle("hidden") }, "More options", h("span", { class: "tiny muted" }, "range, captions, loudness, size")),
        more),
      h("footer", null, note,
        h("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
        h("button", { type: "button", class: "btn primary", onclick: async () => {
          if (!folder) {
            const f = await pickFolder();
            if (!f) return;
            folder = f;
            store.set({ exportFolder: f });
          }
          const p = presets.find((x) => x.id === preset)!;
          const sep = folder.includes("\\") ? "\\" : "/";
          const req: ExportRequest = {
            preset: custom && preset === "share" ? "custom" : preset,
            output: `${folder}${sep}${name || "video"}.${p.ext}`,
            range: useRange ? range : null,
            width: custom?.width ?? null, height: custom?.height ?? null, fps: custom?.fps ?? null,
            burnCaptions: burn, sidecarCaptions: sidecar, loudness, useHardware: store.settings.useHardware, targetMb,
          };
          try {
            const job = await call<Job>("export_start", { project, req });
            store.jobs.set(job.id, job);
            close();
            onStarted(job);
          } catch (e) {
            toast(errorText(e), { error: true });
          }
        } }, "Export")));
  }, { label: "Export" });
}

function customFields(onChange: (v: { width: number; height: number; fps: number } | null) => void): HTMLElement {
  const w = h("input", { class: "input", type: "number", placeholder: "Width", "aria-label": "Width" }) as HTMLInputElement;
  const hh = h("input", { class: "input", type: "number", placeholder: "Height", "aria-label": "Height" }) as HTMLInputElement;
  const f = h("input", { class: "input", type: "number", step: "0.01", min: "1", max: "240", placeholder: "fps (up to 240)", "aria-label": "Frame rate" }) as HTMLInputElement;
  const notes = h("div", { class: "col small" });
  const check = async () => {
    notes.replaceChildren();
    if (!w.value || !hh.value) return onChange(null);
    const c = await call<Clamped>("check_limits", { width: +w.value, height: +hh.value, fps: +f.value || 30 });
    c.notes.forEach((n) => notes.appendChild(h("span", { style: { color: "var(--warn)" } }, n)));
    onChange(c.value);
  };
  [w, hh, f].forEach((el) => el.addEventListener("change", check));
  return h("div", { class: "col" }, h("div", { class: "grid3" }, w, hh, f), notes);
}
