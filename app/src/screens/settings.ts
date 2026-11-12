// Settings: one short page per topic, with a search box on top.

import { call, openUrl, pickFiles, pickFolder, reveal, type AppInfo, type Capabilities } from "../api";
import { clear, h, icon } from "../dom";
import { go, type Route } from "../router";
import { bindings, comboFromEvent, conflicts, pretty, PRESETS, SHORTCUTS } from "../shortcuts";
import type { Shell } from "../shell";
import { store } from "../store";
import { ACCENTS, parseCustomTheme, THEMES, themeById, type Theme } from "../themes";
import { errorText, segmented, toast, toggleRow } from "../ui/common";
import { checkNow, confirmBeta, RELEASES } from "../updater";

const SECTIONS: [string, string, string][] = [
  ["appearance", "Appearance", "theme dark light color accent text size motion"],
  ["recording", "Recording", "quality microphone sound camera keystrokes countdown fps"],
  ["convert", "Convert", "compression size hardware gpu folder save"],
  ["shortcuts", "Shortcuts", "keyboard keys hotkeys premiere final cut davinci"],
  ["updates", "Updates", "update version beta automatic"],
  ["privacy", "Privacy", "privacy data telemetry permissions crash"],
  ["storage", "Storage", "storage disk portable folder data"],
  ["about", "About", "version license credits"],
];

export async function mount(shell: Shell, route: Route) {
  const section = SECTIONS.some((s) => s[0] === route.arg) ? route.arg! : "appearance";
  const nav = h("nav", { "aria-label": "Settings sections" });
  const search = h("input", { class: "input", type: "search", placeholder: "Search settings", "aria-label": "Search settings", style: { marginBottom: "12px" } }) as HTMLInputElement;
  const renderNav = () => {
    clear(nav);
    nav.appendChild(search);
    const q = search.value.toLowerCase().trim();
    for (const [id, name, kw] of SECTIONS) {
      if (q && !`${name} ${kw}`.toLowerCase().includes(q)) continue;
      nav.appendChild(h("a", { href: `#/settings/${id}`, "aria-current": id === section ? "page" : undefined }, name));
    }
  };
  search.addEventListener("input", renderNav);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nav.querySelector<HTMLAnchorElement>("a")?.click();
  });
  renderNav();
  const main = h("main", null);
  shell.main.appendChild(h("div", { class: "settings" }, nav, main));
  const render = () => {
    clear(main);
    PAGES[section](main, render);
  };
  render();
  return store.sub("settings", () => {});
}

const PAGES: Record<string, (el: HTMLElement, rerender: () => void) => void | Promise<void>> = {
  appearance(el, rerender) {
    const s = store.settings;
    const themeCard = (t: Theme, on: boolean, pick: () => void) =>
      h("button", { type: "button", class: "tcard", role: "radio", "aria-checked": String(on), onclick: pick },
        h("span", { class: "pv", style: { background: t.bg, border: `1px solid ${t.line}` } },
          h("span", { style: { width: "22px", background: t.surf, borderRight: `1px solid ${t.line}` } }),
          h("span", { class: "col", style: { flex: "1", gap: "6px", padding: "10px" } },
            h("span", { style: { height: "7px", width: "70%", borderRadius: "4px", background: t.text, opacity: "0.85" } }),
            h("span", { style: { height: "7px", width: "50%", borderRadius: "4px", background: t.muted, opacity: "0.6" } }),
            h("span", { style: { marginTop: "auto", height: "14px", width: "46px", borderRadius: "5px", background: t.btn } }))),
        h("span", { class: "small", style: { fontWeight: "500" } }, t.name));
    const grid = (dark: boolean, label: string) => {
      const box = h("div", { class: "themes-grid", role: "radiogroup", "aria-label": label, style: { gridTemplateColumns: "repeat(6, minmax(0, 1fr))" } });
      const custom = s.customTheme as Theme | undefined;
      const all = custom && custom.dark === dark ? [...THEMES.filter((x) => x.dark === dark), { ...custom, id: "custom" }] : THEMES.filter((x) => x.dark === dark);
      for (const t of all) {
        const on = s.followSystem ? (dark ? s.darkTheme : s.lightTheme) === t.id : s.theme === t.id;
        box.appendChild(themeCard(t as Theme, on, () => {
          store.set(s.followSystem ? (dark ? { darkTheme: t.id } : { lightTheme: t.id }) : { theme: t.id, accent: null });
          rerender();
        }));
      }
      return h("div", { class: "col" }, h("span", { class: "small muted" }, label), box);
    };
    const accents = h("div", { class: "row", role: "radiogroup", "aria-label": "Accent color" },
      h("button", { type: "button", class: "swatch", role: "radio", "aria-label": "Theme default", "aria-checked": String(!s.accent), style: { background: themeById(s.theme).btn }, onclick: () => { store.set({ accent: null }); rerender(); } }),
      ...ACCENTS.map((a) => h("button", { type: "button", class: "swatch", role: "radio", "aria-label": a.name, "aria-checked": String(s.accent === a.id), style: { background: a.btn }, onclick: () => { store.set({ accent: a.id }); rerender(); } })));
    el.append(
      h("div", { class: "col", style: { gap: "6px" } }, h("h1", null, "Appearance"), h("p", { class: "muted" }, "Pick a look. It changes instantly and applies to the recorder, editor and converter.")),
      h("div", { class: "setting-card" }, toggleRow("Match my system", "Uses your dark theme at night and your light theme by day, following your computer's setting.", s.followSystem, (v) => { store.set({ followSystem: v }); rerender(); })),
      grid(true, s.followSystem ? "Dark theme to use" : "Dark themes"),
      grid(false, s.followSystem ? "Light theme to use" : "Light themes"),
      h("div", { class: "row wrap", style: { gap: "40px", alignItems: "flex-start" } },
        h("div", { class: "col" }, h("span", { class: "small muted" }, "Accent color"), accents),
        h("div", { class: "col" }, h("span", { class: "small muted" }, "Text size"), segmented("Text size", [["small", "Small"], ["default", "Default"], ["large", "Large"]], s.textSize as "small" | "default" | "large", (v) => store.set({ textSize: v }))),
        h("div", { class: "col" }, h("span", { class: "small muted" }, "Your own theme"), h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: importTheme }, "Import…"), h("button", { type: "button", class: "btn", onclick: exportTheme }, "Export current")))),
      h("div", { class: "setting-card" }, toggleRow("Reduce motion", "Turns off animations. Alchemist also follows your system setting.", s.reduceMotion, (v) => store.set({ reduceMotion: v }))));
  },

  recording(el) {
    const s = store.settings;
    el.append(
      h("h1", null, "Recording"),
      h("div", { class: "field" }, "Default quality", segmented("Quality", [["tutorial", "Tutorial · 30 fps"], ["high", "High · 60 fps"], ["tiny", "Tiny file"]], s.recordPreset, (v) => store.set({ recordPreset: v }))),
      h("div", { class: "setting-card" },
        toggleRow("Microphone", "Recorded on its own track.", s.recordMic, (v) => store.set({ recordMic: v })),
        toggleRow("Computer sound", "Also on its own track, so you can turn it down later.", s.recordSystemAudio, (v) => store.set({ recordSystemAudio: v })),
        toggleRow("Camera bubble", null, s.recordCamera, (v) => store.set({ recordCamera: v })),
        toggleRow("Record keystrokes", "For keystroke overlays. Saved only on this computer.", s.recordKeys, (v) => store.set({ recordKeys: v }))),
      h("div", { class: "field" }, "Countdown", segmented("Countdown", [["0", "Off"], ["3", "3 seconds"], ["5", "5 seconds"]], String(s.countdown) as "0" | "3" | "5", (v) => store.set({ countdown: +v }))),
      h("p", { class: "muted small" }, "Start and stop from anywhere with ", h("span", { class: "kbd" }, "Ctrl Shift R"), ". Supports high-refresh gaming and custom frame rates up to 240 fps (120, 144, 240 fps) in recording options."),
      h("div", { class: "field", style: { marginTop: "12px" } }, "Instant replay buffer", segmented("Replay buffer", [["15", "15 s"], ["30", "30 s"], ["60", "1 min"], ["120", "2 min"]], String(s.replaySeconds || 30) as any, (v) => store.set({ replaySeconds: +v }))),
      h("p", { class: "muted small" }, "Save the last replay buffer anytime with ", h("span", { class: "kbd" }, "Ctrl Shift S"), ". Saved into your Replays folder."));
  },

  async convert(el, rerender) {
    const s = store.settings;
    const caps = await call<Capabilities>("capabilities").catch(() => null);
    el.append(
      h("h1", null, "Convert"),
      h("div", { class: "field" }, "Default target size", segmented("Default size", [["10", "10 MB"], ["25", "25 MB"], ["50", "50 MB"], ["100", "100 MB"]], String(s.defaultTargetMb) as "10" | "25" | "50" | "100", (v) => store.set({ defaultTargetMb: +v }))),
      h("div", { class: "setting-card" },
        toggleRow("Use the graphics card", caps?.hwH264 ? `Found: ${caps.hwH264.replace("h264_", "").toUpperCase()}. Much faster, with a software fallback.` : "No supported graphics card encoder was found; software encoding is used.", s.useHardware, (v) => store.set({ useHardware: v })),
        toggleRow("Save next to the original", s.exportFolder ? `Otherwise: ${s.exportFolder}` : null, s.saveNextToOriginal, async (v) => {
          if (!v && !s.exportFolder) {
            const f = await pickFolder();
            if (!f) return rerender();
            await store.set({ exportFolder: f });
          }
          await store.set({ saveNextToOriginal: v });
          rerender();
        })),
      caps ? h("p", { class: "muted tiny mono" }, caps.version) : "");
  },

  shortcuts(el, rerender) {
    const s = store.settings;
    const map = bindings(s.shortcutPreset, s.shortcuts);
    const bad = conflicts(map);
    const card = h("div", { class: "setting-card" });
    for (const def of SHORTCUTS) {
      const btn = h("button", { type: "button", class: "kbd", "aria-label": `Change shortcut for ${def.label}` }, pretty(map[def.id] || "None")) as HTMLButtonElement;
      btn.addEventListener("click", () => {
        btn.classList.add("listening");
        btn.textContent = "Press keys…";
        const onKey = (e: KeyboardEvent) => {
          e.preventDefault();
          e.stopPropagation();
          document.removeEventListener("keydown", onKey, true);
          if (e.key === "Escape") return rerender();
          store.set({ shortcuts: { ...s.shortcuts, [def.id]: comboFromEvent(e) } }).then(rerender);
        };
        document.addEventListener("keydown", onKey, true);
      });
      card.appendChild(h("div", { class: "keyrow" }, h("span", null, def.label, def.scope === "editor" ? h("span", { class: "muted tiny" }, "  editor") : null), btn));
    }
    el.append(
      h("h1", null, "Shortcuts"),
      h("div", { class: "field" }, "Start from a familiar layout", segmented("Layout", [["alchemist", "Alchemist"], ["premiere", "Premiere-style"], ["finalcut", "Final Cut-style"], ["davinci", "DaVinci-style"]], s.shortcutPreset as keyof typeof PRESETS, (v) => store.set({ shortcutPreset: v, shortcuts: {} }).then(rerender))),
      bad.length ? h("div", { class: "notice warn" }, `Used twice: ${bad.map(pretty).join(", ")}. Change one of them.`) : "",
      card,
      h("button", { type: "button", class: "btn", style: { alignSelf: "flex-start" }, onclick: () => store.set({ shortcuts: {} }).then(rerender) }, "Reset to layout defaults"));
  },

  async updates(el, rerender) {
    const s = store.settings;
    const info = await call<AppInfo>("app_info");
    const status = h("p", { class: "muted small", "aria-live": "polite" });
    el.append(
      h("h1", null, "Updates"),
      h("p", { class: "muted" }, `You have Alchemist ${info.version}${info.portable ? " (portable)" : ""}. Updates come from GitHub, are checked against a signature before they're applied, and never install during a recording or export.`),
      h("div", { class: "field" }, "When a new version is out", segmented("Update mode", [["auto", "Update automatically"], ["notify", "Just tell me"], ["off", "Never check"]], s.updateMode, (v) => store.set({ updateMode: v }))),
      h("div", { class: "setting-card" }, toggleRow("Early versions", "Get new features sooner. They may have rough edges.", s.betaChannel, async (v) => { if (v && !(await confirmBeta())) return rerender(); store.set({ betaChannel: v }); })),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn primary", onclick: async () => { status.textContent = "Checking…"; status.textContent = (await checkNow(null, true)) || "Done."; } }, "Check now"),
        h("button", { type: "button", class: "btn", onclick: () => openUrl(RELEASES) }, "All releases")),
      status);
  },

  async privacy(el) {
    const reports = await call<string[]>("crash_reports").catch(() => []);
    el.append(
      h("h1", null, "Privacy"),
      h("div", { class: "setting-card", style: { padding: "16px 18px", gap: "10px" } },
        h("p", null, h("strong", null, "Nothing leaves this computer. "), "No account, no cloud, no telemetry. Recordings, projects and settings stay on your disk."),
        h("p", { class: "muted small" }, "The only network request Alchemist makes is the daily update check to GitHub, which sends no information about you. You can turn it off under Updates.")),
      h("h2", null, "Permissions"),
      h("p", { class: "muted" }, "If recording shows a black screen or no sound, your computer is blocking it."),
      h("button", { type: "button", class: "btn", style: { alignSelf: "flex-start" }, onclick: () => go("welcome?step=2") }, "Check permissions"),
      h("h2", null, "Crash reports"),
      h("p", { class: "muted small" }, reports.length ? `${reports.length} report${reports.length > 1 ? "s" : ""} saved on this computer. They are never sent anywhere; share one only if you want to.` : "No crashes recorded."),
      reports.length ? h("button", { type: "button", class: "btn", style: { alignSelf: "flex-start" }, onclick: () => reveal(reports[0]) }, "Show reports") : "");
  },

  async storage(el) {
    const info = await call<AppInfo>("app_info");
    el.append(
      h("h1", null, "Storage"),
      h("div", { class: "setting-card", style: { padding: "16px 18px", gap: "12px" } },
        h("div", { class: "row" }, h("span", { class: "grow" }, h("strong", null, info.portable ? "Portable mode is on" : "Installed mode"), h("br"), h("span", { class: "muted small" }, info.portable ? "Everything is kept in the data folder next to Alchemist." : "Settings and projects live in your user folder.")), h("span", { class: "badge" }, info.portable ? "Portable" : "Installed")),
        h("div", { class: "row" }, h("span", { class: "grow mono small" }, info.dataDir), h("button", { type: "button", class: "btn", onclick: () => reveal(info.dataDir) }, "Show")),
        h("div", { class: "row" }, h("span", { class: "grow small" }, "Recordings", h("br"), h("span", { class: "mono tiny muted" }, info.recordingsDir)), h("button", { type: "button", class: "btn", onclick: () => reveal(info.recordingsDir) }, "Show")),
        h("div", { class: "row" }, h("span", { class: "grow small" }, "Instant replays", h("br"), h("span", { class: "mono tiny muted" }, store.settings.replaysFolder || `${info.dataDir}/Replays`)), h("button", { type: "button", class: "btn", onclick: () => reveal(store.settings.replaysFolder || `${info.dataDir}/Replays`) }, "Show"))),
      h("p", { class: "muted small" }, "Original videos are never changed or moved. Projects only point at them."));
  },

  async about(el) {
    const info = await call<AppInfo>("app_info");
    el.append(
      h("h1", null, "About"),
      h("p", null, `Alchemist ${info.version}`),
      h("p", { class: "muted" }, "Record, edit, convert, compress and enhance video, locally."),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn", onclick: () => openUrl("https://github.com/jeelnadaa/alchemist") }, icon("folder", 16), "Source code"),
        h("button", { type: "button", class: "btn", onclick: () => openUrl("https://github.com/jeelnadaa/alchemist/blob/main/THIRD_PARTY_NOTICES.md") }, "Third-party notices")),
      h("p", { class: "muted small" }, "Uses FFmpeg (GPL build) as a separate program, Tauri, Satoshi, Inter and JetBrains Mono. Full notices ship with the app."));
  },
};

async function importTheme() {
  const [file] = await pickFiles({ theme: true });
  if (!file) return;
  try {
    const text = await call<string>("read_text_file", { path: file });
    const r = parseCustomTheme(text);
    if (r.error) return toast(r.error, { error: true });
    await store.set({ customTheme: r.theme, theme: "custom", followSystem: false, accent: null });
    toast(`"${r.theme!.name}" is now your theme.`);
    go("settings/appearance");
  } catch (e) {
    toast(errorText(e), { error: true });
  }
}

function exportTheme() {
  const t = (store.settings.customTheme as Theme | undefined) ?? themeById(store.settings.theme);
  const blob = new Blob([JSON.stringify({ name: `${t.name} (copy)`, bg: t.bg, surf: t.surf, raised: t.raised, line: t.line, text: t.text, muted: t.muted, accent: t.accent, btn: t.btn, on: t.on, rec: t.rec, ok: t.ok, warn: t.warn }, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "alchemist-theme.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
