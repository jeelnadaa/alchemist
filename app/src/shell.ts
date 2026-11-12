// The app frame: title bar with search, the rail with five places, the
// status bar, the background-jobs panel and drop-a-file-anywhere.

import { call, inTauri, reveal, type Job } from "./api";
import { clear, h, icon } from "./dom";
import { bytes, eta, fileName, ratio } from "./format";
import { go, request } from "./router";
import { store } from "./store";
import { logo, modal } from "./ui/common";
import { openPalette, rememberFile } from "./ui/palette";

export interface Shell {
  root: HTMLElement;
  main: HTMLElement;
  setActive(name: string): void;
  setCrumbs(node: Node | null): void;
  setTitleRight(node: Node | null): void;
  setStatus(text: string): void;
}

const NAV: [string, string, Parameters<typeof icon>[0]][] = [
  ["", "Home", "home"],
  ["record", "Record", "record"],
  ["edit", "Edit", "edit"],
  ["convert", "Convert", "convert"],
  ["projects", "Projects", "folder"],
];

export function buildShell(): Shell {
  const brand = h("div", { class: "brand" }, logo(22), "Alchemist");
  const crumbs = h("div", { class: "crumbs hidden" });
  const left = h("div", { style: { minWidth: "220px", display: "flex", alignItems: "center" } }, brand, crumbs);
  const search = h("button", { type: "button", class: "searchbar", onclick: () => openPalette(), "aria-label": "Search actions, files and settings", "data-tooltip": "Search actions, files and settings", "data-tooltip-pos": "bottom" },
    icon("search", 16), h("span", { class: "grow" }, "Search actions, files and settings"), h("span", { class: "kbd" }, navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"));
  const jobChip = h("button", { type: "button", class: "jobchip hidden", onclick: () => openJobs(), "data-tooltip": "Active background jobs", "data-tooltip-pos": "bottom" });
  const replayChip = h("button", {
    type: "button",
    class: "jobchip hidden",
    style: { borderColor: "color-mix(in srgb, var(--accent) 50%, transparent)" },
    "data-tooltip": "Instant replay active. Click to save (Ctrl Shift S)",
    "data-tooltip-pos": "bottom",
    onclick: async () => {
      try {
        const p = await call<string>("replay_save");
        import("./ui/common").then(({ toast }) => toast(`Instant replay saved: ${fileName(p)}`));
      } catch (e: any) {
        import("./ui/common").then(({ toast, errorText }) => toast(errorText(e), { error: true }));
      }
    }
  });
  const rightSlot = h("div", { class: "row" });
  const right = h("div", { class: "title-right" }, replayChip, jobChip, rightSlot);
  const titlebar = h("header", { class: "titlebar" }, left, search, right);

  const links = new Map<string, HTMLAnchorElement>();
  const rail = h("nav", { class: "rail", "aria-label": "Main" });
  for (const [route, label, ic] of NAV) {
    const a = h("a", { href: `#/${route}`, "data-tooltip": label, "data-tooltip-pos": "right" }, icon(ic, 22), label) as HTMLAnchorElement;
    if (route === "edit") {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const last = localStorage.getItem("alc-last-project");
        go(last ? `edit/${last}` : "edit/new");
      });
    }
    links.set(route, a);
    rail.appendChild(a);
  }
  rail.appendChild(h("div", { class: "spacer" }));
  const settingsLink = h("a", { href: "#/settings/appearance", "data-tooltip": "Settings", "data-tooltip-pos": "right" }, icon("settings", 22), "Settings") as HTMLAnchorElement;
  links.set("settings", settingsLink);
  rail.appendChild(settingsLink);

  const main = h("main", { class: "main", id: "main" });
  const statusText = h("span", null);
  const updateBtn = h("button", { type: "button", class: "hidden" });
  const statusbar = h("footer", { class: "statusbar" },
    h("span", { class: "row", style: { gap: "8px" } }, icon("lock", 13), "Everything stays on this computer"),
    h("span", { class: "row" }, statusText, updateBtn));

  const root = h("div", { class: "shell" }, titlebar, h("div", { class: "body" }, rail, main), statusbar);

  const renderJobs = () => {
    const active = store.activeJobs();
    jobChip.classList.toggle("hidden", active.length === 0);
    if (active.length) {
      const run = active.find((j) => j.status === "running") || active[0];
      clear(jobChip);
      jobChip.append(h("span", { class: "dot" }), `${run.kind === "export" ? "Exporting" : run.kind === "preview" ? "Previewing" : run.kind === "recording" ? "Recording" : "Working"} ${Math.round(run.progress * 100)}%${active.length > 1 ? ` · ${active.length - 1} more` : ""}`);
    }
  };
  store.sub("jobs", renderJobs);
  renderJobs();

  const updateReplayChip = async () => {
    const st = await call<{ running: boolean; buffered: number }>("replay_status").catch(() => null);
    if (st?.running) {
      replayChip.classList.remove("hidden");
      clear(replayChip);
      replayChip.append(
        h("span", { class: "dot", style: { background: "var(--ok)", boxShadow: "0 0 8px var(--ok)" } }),
        `Replay ${Math.round(st.buffered)}s · Save`
      );
    } else {
      replayChip.classList.add("hidden");
    }
  };
  import("./api").then(({ on }) => {
    on("replay", updateReplayChip);
    on("replay-saved", updateReplayChip);
  });
  setInterval(updateReplayChip, 2000);
  updateReplayChip();

  // Finished-job notifications.
  const seen = new Set<string>();
  store.sub("jobs", () => {
    for (const j of store.jobs.values()) {
      if ((j.status === "done" || j.status === "failed") && !seen.has(j.id) && j.kind !== "preview" && j.kind !== "proxy") {
        seen.add(j.id);
        import("./ui/common").then(({ toast }) =>
          j.status === "done"
            ? toast(`${j.title}: done${j.report?.outputBytes ? `, ${bytes(j.report.outputBytes)}` : ""}.`, { action: { label: "Show", run: () => reveal(j.output) } })
            : toast(`${j.title}: ${j.error || "failed"}`, { error: true }),
        );
      }
    }
  });
  for (const j of store.jobs.values()) if (j.status === "done" || j.status === "failed") seen.add(j.id);

  setupDrop(root);

  return {
    root,
    main,
    setActive(name) {
      for (const [k, a] of links) {
        if (k === name) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
    },
    setCrumbs(node) {
      clear(crumbs);
      brand.classList.toggle("hidden", !!node);
      crumbs.classList.toggle("hidden", !node);
      if (node) crumbs.append(logo(22), node);
    },
    setTitleRight(node) {
      clear(rightSlot);
      if (node) rightSlot.appendChild(node);
    },
    setStatus(text) {
      statusText.textContent = text;
    },
  };
}

export function jobRow(j: Job, onChange?: () => void): HTMLElement {
  const done = j.status === "done";
  const report = j.report;
  const detail = done && report
    ? h("span", { class: "small" },
        h("span", { style: { color: "var(--ok)" } }, "Done. "),
        report.inputBytes ? `${bytes(report.inputBytes)} → ${bytes(report.outputBytes)}, ${ratio(report.inputBytes, report.outputBytes)}` : bytes(report.outputBytes),
        report.quality ? ` · ${report.quality.metric} ${report.quality.metric === "VMAF" ? report.quality.value.toFixed(0) + " of 100" : report.quality.value.toFixed(3)} (${report.quality.verdict.toLowerCase()})` : "",
        ` · took ${Math.round(report.seconds)} s`,
        report.note ? h("div", { class: "small", style: { color: "var(--warn)" } }, report.note) : null)
    : j.status === "failed"
      ? h("span", { class: "small", style: { color: "var(--rec)" } }, j.error || "Failed")
      : j.status === "cancelled"
        ? h("span", { class: "small muted" }, "Cancelled")
        : h("div", { class: "col", style: { gap: "6px" } },
            h("div", { class: "progress", style: { maxWidth: "420px" } }, h("span", { style: { width: `${Math.round(j.progress * 100)}%` } })),
            h("span", { class: "small muted" }, `${j.stage} · ${Math.round(j.progress * 100)}%${j.etaSeconds ? ` · ${eta(j.etaSeconds)}` : ""}`));
  const actions = h("div", { class: "row" });
  if (j.status === "running" || j.status === "queued") {
    actions.appendChild(h("button", { type: "button", class: "btn", onclick: async () => { await call("job_cancel", { id: j.id }); onChange?.(); } }, "Cancel"));
  } else if (done) {
    actions.appendChild(h("button", { type: "button", class: "btn", onclick: () => reveal(j.output) }, "Show in folder"));
  }
  return h("div", { class: "filerow", style: { cursor: "default" } },
    h("span", { class: "grow col", style: { gap: "4px" } }, h("strong", null, j.title), detail), actions);
}

function openJobs() {
  modal((close) => {
    const list = h("div", { class: "col" });
    const render = () => {
      clear(list);
      const jobs = [...store.jobs.values()].reverse();
      if (!jobs.length) list.appendChild(h("p", { class: "muted" }, "Nothing is running."));
      for (const j of jobs) list.appendChild(jobRow(j, render));
    };
    const unsub = store.sub("jobs", render);
    render();
    const box = h("div", { class: "dialog" },
      h("header", null, h("h2", null, "Background work"), h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => { unsub(); close(); } }, icon("close", 16))),
      h("div", { class: "content" }, h("p", { class: "muted small" }, "Jobs keep running if you close this window. Alchemist stays in the tray until they finish."), list),
      h("footer", null, h("button", { type: "button", class: "btn", onclick: async () => { await call("jobs_clear"); for (const [id, j] of store.jobs) if (j.status !== "running" && j.status !== "queued") store.jobs.delete(id); render(); } }, "Clear finished"), h("span", { class: "grow" }), h("button", { type: "button", class: "btn primary", onclick: () => { unsub(); close(); } }, "Done")));
    return box;
  }, { label: "Background work" });
}

/** Drop any file anywhere: ask what to do with it. */
function setupDrop(root: HTMLElement) {
  const handle = (paths: string[]) => {
    if (!paths.length) return;
    if (paths.length === 1 && /\.alc$/i.test(paths[0])) {
      request("open-project-path", paths[0]);
      go("projects");
      return;
    }
    paths.forEach(rememberFile);
    const name = paths.length === 1 ? fileName(paths[0]) : `${paths.length} files`;
    modal((close) => {
      const choice = (title: string, sub: string, ic: Parameters<typeof icon>[0], run: () => void) =>
        h("button", { type: "button", class: "opt", style: { flexDirection: "row", alignItems: "center", gap: "14px" }, onclick: () => { close(); run(); } },
          h("span", { style: { color: "var(--accent)" } }, icon(ic, 22)), h("span", { class: "col", style: { gap: "2px" } }, h("strong", null, title), h("small", null, sub)));
      return h("div", { class: "dialog", style: { width: "520px" } },
        h("header", null, h("h2", null, `What do you want to do with ${name}?`)),
        h("div", { class: "content" },
          choice("Edit it", "Trim, zoom, add text and captions", "edit", () => { request("new-edit-files", paths); go("edit/new"); }),
          choice("Make it smaller", "Hit a file size like 25 MB", "shrink", () => { request("convert-files", paths); request("convert-goal", "smaller"); go("convert"); }),
          choice("Change the format", "MP4, WebM, GIF, MP3 and more", "convert", () => { request("convert-files", paths); request("convert-goal", "format"); go("convert"); }),
          choice("Enhance it", "Sharpen, denoise, upscale, stabilize", "sparkle", () => { request("convert-files", paths); request("convert-goal", "enhance"); go("convert"); })),
        h("footer", null, h("span", { class: "grow" }), h("button", { class: "btn", type: "button", onclick: close }, "Cancel")));
    }, { label: "What to do with the dropped file" });
  };

  if (inTauri) {
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload as { type: string; paths?: string[] };
        root.classList.toggle("drag-over", p.type === "over" || p.type === "enter");
        if (p.type === "drop") handle(p.paths || []);
        if (p.type === "leave" || p.type === "drop") root.classList.remove("drag-over");
      }),
    );
  } else {
    root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("drag-over"); });
    root.addEventListener("dragleave", () => root.classList.remove("drag-over"));
    root.addEventListener("drop", (e) => {
      e.preventDefault();
      root.classList.remove("drag-over");
      handle([...(e.dataTransfer?.files || [])].map((f) => URL.createObjectURL(f)));
    });
  }
}
