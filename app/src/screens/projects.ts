// All projects: open, delete, or open a project file from elsewhere.

import { call, pickFiles, type Project } from "../api";
import { h, icon } from "../dom";
import { go, take } from "../router";
import type { Shell } from "../shell";
import { errorText, toast } from "../ui/common";
import { renderRecents } from "./home";

export async function mount(shell: Shell) {
  const box = h("div", { class: "recents" });
  const openFile = async (path?: string) => {
    const file = path || (await pickFiles({ project: true }))[0];
    if (!file) return;
    try {
      const p = await call<Project>("project_open_file", { path: file });
      await call("project_save", { project: p });
      go(`edit/${p.id}`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  shell.main.appendChild(
    h("div", { class: "projects" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("h1", null, "Projects"),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn", onclick: () => openFile() }, icon("folder", 16), "Open a project file"),
          h("button", { type: "button", class: "btn primary", onclick: () => go("edit/new") }, icon("plus", 16), "New edit"))),
      h("p", { class: "muted" }, "Projects only point at your videos. Your original files are never changed."),
      box));
  await renderRecents(box, 200);
  if (take("open-project-file")) openFile();
  const path = take<string>("open-project-path");
  if (path) openFile(path);
}
