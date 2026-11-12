// Home: "What do you want to do?" — a search box, four starting points,
// recent projects and a drop area. Nothing else.

import { call, fileUrl, pickFiles, type ProjectSummary } from "../api";
import { h, icon } from "../dom";
import { ago, clock } from "../format";
import { go, request } from "../router";
import type { Shell } from "../shell";
import { openPalette, rememberFile } from "../ui/palette";

export async function mount(shell: Shell) {
  const action = (route: string, title: string, sub: string, keys: string, ic: Parameters<typeof icon>[0], tint: string, run?: () => void) =>
    h("a", { href: `#/${route}`, class: "action", onclick: run ? (e: Event) => { e.preventDefault(); run(); } : undefined },
      h("span", { class: "ic", style: { background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint } }, icon(ic, 22)),
      h("span", { class: "col", style: { gap: "4px" } }, h("strong", null, title), h("span", { class: "muted small" }, sub)),
      h("span", { class: "mono tiny muted" }, keys));

  const suggestion = (text: string, run: () => void) => h("button", { type: "button", class: "chip", onclick: run }, text);
  const recentsBox = h("div", { class: "recents" });

  const page = h("div", { class: "home" },
    h("section", { class: "col", style: { gap: "18px" } },
      h("h1", null, "What do you want to do?"),
      h("button", { type: "button", class: "bigsearch", onclick: () => openPalette() },
        icon("search", 20), h("span", { class: "grow" }, 'Type what you need, like "make this smaller" or "add captions"'), h("span", { class: "kbd" }, "Ctrl K")),
      h("div", { class: "row wrap", style: { gap: "8px" } },
        suggestion("Record my screen", () => go("record")),
        suggestion("Make a video under 25 MB", () => { request("convert-goal", "smaller"); go("convert"); }),
        suggestion("Turn a video into a GIF", () => { request("convert-goal", "format"); request("convert-format", "gif"); go("convert"); }),
        suggestion("Add captions", () => { request("editor-open", "captions"); request("new-edit"); go("edit/new"); }))),
    h("section", { class: "actions4", "aria-label": "Start something new" },
      action("record", "Record screen", "Screen, window or area, with your mic and camera.", "Ctrl Shift R", "record", "var(--rec)"),
      action("edit/new", "Edit a video", "Trim, zoom, add text and captions.", "Ctrl N", "edit", "var(--accent)", () => { request("new-edit"); go("edit/new"); }),
      action("convert", "Convert or shrink", "Change format or hit a file size.", "Ctrl Shift C", "shrink", "var(--ok)", () => { request("convert-goal", "smaller"); go("convert"); }),
      action("convert", "Enhance", "Sharpen, denoise, upscale or stabilize.", "Ctrl Shift E", "sparkle", "var(--warn)", () => { request("convert-goal", "enhance"); go("convert"); })),
    h("section", { class: "col", style: { gap: "16px" }, "aria-labelledby": "recent-h" },
      h("div", { class: "row", style: { justifyContent: "space-between" } }, h("h2", { id: "recent-h" }, "Pick up where you left off"), h("a", { href: "#/projects" }, "All projects")),
      recentsBox),
    h("button", { type: "button", class: "dropzone", onclick: async () => {
      const files = await pickFiles({ multiple: true });
      if (!files.length) return;
      files.forEach(rememberFile);
      request("new-edit-files", files);
      go("edit/new");
    } }, icon("upload", 18), "Drop a video anywhere, or click to open one. Alchemist will ask what you want to do."));

  shell.main.appendChild(page);
  await renderRecents(recentsBox, 4);
}

export async function renderRecents(box: HTMLElement, limit: number) {
  const list = await call<ProjectSummary[]>("project_list").catch(() => [] as ProjectSummary[]);
  box.replaceChildren();
  if (!list.length) {
    box.style.display = "block";
    box.appendChild(h("p", { class: "muted" }, "Your projects will show up here. Record something or open a video to start."));
    return;
  }
  for (const p of list.slice(0, limit)) {
    const thumb = h("span", { class: "thumb" }, h("span", { class: "len" }, clock(p.duration)));
    box.appendChild(h("button", { type: "button", class: "recent", onclick: () => go(`edit/${p.id}`) }, thumb,
      h("span", { class: "col", style: { gap: "2px" } }, h("strong", null, p.name), h("span", { class: "muted small" }, `Edited ${ago(p.modified).toLowerCase()}`))));
    if (p.thumb) {
      call<string>("thumbnail", { path: p.thumb, at: 1 })
        .then(fileUrl)
        .then((u) => { if (u) thumb.prepend(h("img", { src: u, alt: "" })); })
        .catch(() => {});
    }
  }
}
