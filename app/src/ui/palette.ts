// Ctrl K search palette: actions, files, settings and help from anywhere.

import { call, type ProjectSummary } from "../api";
import { clear, h, icon } from "../dom";
import { fileName } from "../format";
import { go, request } from "../router";
import { rank, type Entry } from "../search";
import { modal, toast } from "./common";

let open = false;

export function recentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem("alc-recent-files") || "[]");
  } catch {
    return [];
  }
}

export function rememberFile(path: string) {
  const list = [path, ...recentFiles().filter((p) => p !== path)].slice(0, 12);
  try {
    localStorage.setItem("alc-recent-files", JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function staticEntries(): Entry[] {
  const a = (id: string, title: string, sub: string, keywords: string, hint: string, run: () => void): Entry => ({ id, group: "Actions", title, sub, keywords, hint, run });
  const s = (section: string, title: string, keywords: string): Entry => ({ id: `s-${section}-${title}`, group: "Settings", title, sub: `Settings › ${section[0].toUpperCase()}${section.slice(1)}`, keywords, hint: "Settings", run: () => go(`settings/${section}`) });
  const help = (title: string, sub: string, keywords: string, run: () => void): Entry => ({ id: `h-${title}`, group: "Help", title, sub, keywords, hint: "Guide", run });
  return [
    a("record", "Record screen", "Full screen, a window or an area", "record capture screen window area start video", "Ctrl Shift R", () => go("record")),
    a("replay-save", "Save instant replay", "Save the buffered replay to your Replays folder", "replay instant buffer clip shadowplay save last moments", "Ctrl Shift S", () => {
      call<string>("replay_save")
        .then((p) => toast(`Instant replay saved: ${p.split(/[\\/]/).pop()}`))
        .catch((e) => toast(e?.message || String(e), { error: true }));
    }),
    a("record-window", "Record a window", "Capture just one app", "record window app", "Record", () => { request("record-source", "window"); go("record"); }),
    a("record-area", "Record an area", "Drag a box around what to capture", "record area region part", "Record", () => { request("record-source", "area"); go("record"); }),
    a("shrink", "Shrink a video to a target size", "Pick 10, 25 or 50 MB, or any size", "small smaller compress shrink size mb target reduce email", "Convert", () => { request("convert-goal", "smaller"); go("convert"); }),
    a("format", "Convert to another format", "MP4, WebM, MOV, MKV, GIF, MP3", "convert format mp4 webm mov mkv mp3 change", "Convert", () => { request("convert-goal", "format"); go("convert"); }),
    a("gif", "Make a GIF", "From any video", "gif animation loop", "Convert", () => { request("convert-goal", "format"); request("convert-format", "gif"); go("convert"); }),
    a("audio", "Extract the audio", "Save the sound as MP3", "audio mp3 sound extract music", "Convert", () => { request("convert-goal", "format"); request("convert-format", "mp3"); go("convert"); }),
    a("enhance", "Enhance video quality", "Sharpen, denoise, upscale, stabilize", "enhance sharpen upscale denoise stabilize quality better restore", "Enhance", () => { request("convert-goal", "enhance"); go("convert"); }),
    a("new-edit", "Start a new edit", "Open a video in the editor", "new edit project video open", "Ctrl N", () => { request("new-edit"); go("edit/new"); }),
    a("open-project", "Open a project file", "An .alc file from anywhere", "open project file alc", "", () => { request("open-project-file"); go("projects"); }),
    a("captions", "Add captions", "Type them or import an SRT file", "captions subtitles text transcript words srt vtt", "Edit", () => { request("editor-open", "captions"); goEditor(); }),
    a("silence", "Remove silent parts", "Finds pauses and cuts them in one click", "silence silent pause gaps cut remove dead air shorter", "Edit", () => { request("editor-open", "silence"); goEditor(); }),
    a("text", "Add text", "Titles, labels and callouts", "text title label callout words", "Edit", () => { request("editor-open", "text"); goEditor(); }),
    a("blur", "Blur something private", "Hide passwords, emails or faces", "blur pixelate hide private sensitive password", "Edit", () => { request("editor-open", "blur"); goEditor(); }),
    a("export", "Export this project", "Choose a preset and where to save", "export save render output share", "Ctrl E", () => { request("editor-open", "export"); goEditor(); }),
    a("package", "Package project for another computer", "Copies all media into one folder", "package portable move copy folder relink", "", () => { request("editor-open", "package"); goEditor(); }),
    a("projects", "See all projects", "Everything you've made", "projects library all recent", "", () => go("projects")),
    a("home", "Go home", "", "home start", "Ctrl 1", () => go("")),
    s("appearance", "Theme and colors", "theme dark light color appearance accent look"),
    s("appearance", "Text size", "text size font bigger smaller readable"),
    s("recording", "Recording quality and sound", "recording quality fps resolution microphone sound countdown"),
    s("recording", "Record keystrokes", "keys keystrokes keyboard overlay"),
    s("convert", "Default compression size", "compression quality default smaller size mb"),
    s("convert", "Hardware encoding", "gpu hardware encoding nvenc quicksync speed"),
    s("shortcuts", "Keyboard shortcuts", "keyboard shortcuts hotkeys keys premiere final cut davinci"),
    s("updates", "Check for updates", "update updates version beta"),
    s("privacy", "Privacy", "privacy telemetry data offline permissions"),
    s("storage", "Storage and portable mode", "storage disk space cache portable folder"),
    s("about", "About Alchemist", "about version license"),
    help("How target size works", "Why the file lands under your limit", "help target size smaller how why", () => { request("convert-goal", "smaller"); request("convert-help"); go("convert"); }),
    help("Recording with sound", "Mic and computer sound on separate tracks", "help record audio sound mic microphone", () => go("record")),
    help("Fix screen-recording permissions", "Opens the right system setting", "help permissions privacy allow screen recording microphone camera", () => go("welcome?step=2")),
  ];
}

function goEditor() {
  const last = localStorage.getItem("alc-last-project");
  go(last ? `edit/${last}` : "edit/new");
}

export async function openPalette(initial = "") {
  if (open) return;
  open = true;
  const projects = await call<ProjectSummary[]>("project_list").catch(() => [] as ProjectSummary[]);
  const entries: Entry[] = [
    ...staticEntries(),
    ...projects.map<Entry>((p) => ({ id: `p-${p.id}`, group: "Files", title: p.name, sub: "Project", keywords: "project open", hint: "Open", run: () => go(`edit/${p.id}`) })),
    ...recentFiles().map<Entry>((f) => ({ id: `f-${f}`, group: "Files", title: fileName(f), sub: f, keywords: "file video recent", hint: "Convert", run: () => { request("convert-files", [f]); go("convert"); } })),
  ];

  modal(
    (close) => {
      let selected = 0;
      let flat: Entry[] = [];
      const input = h("input", { type: "search", placeholder: "Search actions, files, settings and help", "aria-label": "Search", value: initial, autofocus: true }) as HTMLInputElement;
      const results = h("div", { class: "results", role: "listbox", "aria-label": "Results" });
      const run = (e: Entry) => {
        close();
        e.run();
      };
      const render = () => {
        clear(results);
        const groups = rank(entries, input.value);
        flat = groups.flatMap((g) => g.items);
        selected = Math.min(selected, Math.max(0, flat.length - 1));
        if (!flat.length) {
          results.appendChild(
            h("div", { class: "empty" },
              h("strong", { style: { color: "var(--text)" } }, `Nothing matches "${input.value}"`),
              h("span", null, "Try one of these"),
              h("div", { class: "row" }, ...["record", "smaller", "gif", "captions"].map((w) => h("button", { class: "chip", type: "button", onclick: () => { input.value = w; render(); input.focus(); } }, w)))),
          );
          return;
        }
        let i = 0;
        for (const g of groups) {
          results.appendChild(h("p", { class: "group" }, g.group));
          for (const e of g.items) {
            const idx = i++;
            results.appendChild(
              h("button", { type: "button", class: "res", role: "option", "aria-selected": String(idx === selected), onclick: () => run(e), onmousemove: () => { if (selected !== idx) { selected = idx; render(); } } },
                h("span", { class: "gl" }, icon(g.group === "Settings" ? "settings" : g.group === "Files" ? "folder" : g.group === "Help" ? "sparkle" : "search", 16)),
                h("span", { class: "grow col", style: { gap: "1px" } }, h("span", { style: { fontWeight: "500" } }, e.title), e.sub ? h("span", { class: "muted small" }, e.sub) : null),
                e.hint ? h("span", { class: "kbd" }, e.hint) : null),
            );
          }
        }
        results.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      };
      input.addEventListener("input", () => {
        selected = 0;
        render();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { selected = Math.min(flat.length - 1, selected + 1); render(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { selected = Math.max(0, selected - 1); render(); e.preventDefault(); }
        else if (e.key === "Enter" && flat[selected]) { e.preventDefault(); run(flat[selected]); }
      });
      render();
      return h("div", { class: "dialog palette" },
        h("label", { class: "q" }, icon("search", 20), input, h("span", { class: "kbd" }, "Esc")),
        results,
        h("div", { class: "foot" }, h("span", null, h("span", { class: "mono" }, "↑ ↓"), " move"), h("span", null, h("span", { class: "mono" }, "Enter"), " open"), h("span", { class: "grow" }), h("span", null, "Works from every screen")));
    },
    { label: "Search", onClose: () => (open = false) },
  );
}
