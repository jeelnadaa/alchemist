// First run: pick a look, allow recording, learn three shortcuts. Skippable.

import { call, inTauri, openUrl } from "../api";
import { clear, h, icon } from "../dom";
import { store } from "../store";
import { logo } from "../ui/common";

const SETTINGS_LINKS: Record<string, Record<string, string>> = {
  windows: { screen: "ms-settings:privacy-graphicscaptureprogrammatic", mic: "ms-settings:privacy-microphone", camera: "ms-settings:privacy-webcam" },
  macos: { screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", mic: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera" },
};

export async function mount(host: HTMLElement, startStep: number, done: () => void) {
  const info = await call<{ os: string }>("app_info").catch(() => ({ os: "windows" }));
  let step = Math.min(3, Math.max(1, startStep));
  let look: "system" | "dark" | "light" = store.settings.followSystem ? "system" : store.settings.theme === "salt" ? "light" : "dark";
  const section = h("section", null);
  const dots = h("div", { class: "dots", "aria-hidden": "true" });
  const stepLabel = h("span", { class: "small muted" });
  const footer = h("div", { class: "row", style: { justifyContent: "space-between" } });
  host.appendChild(h("div", { class: "welcome" }, h("div", { class: "wrap" },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("div", { class: "row", style: { gap: "12px" } }, h("span", { style: { width: "40px", height: "40px", borderRadius: "10px", background: "var(--btn)", display: "grid", placeItems: "center" } }, logo(24, "#ffffff")), h("strong", { style: { fontSize: "1.3rem" } }, "Alchemist")),
      h("div", { class: "row" }, stepLabel, dots)),
    section, footer)));

  const finish = async () => {
    await store.set({ firstRunDone: true });
    done();
  };

  const applyLook = (v: typeof look) => {
    look = v;
    if (v === "system") store.set({ followSystem: true, darkTheme: "obsidian", lightTheme: "salt" });
    else store.set({ followSystem: false, theme: v === "dark" ? "obsidian" : "salt", accent: null });
  };

  const render = () => {
    clear(section);
    clear(footer);
    clear(dots);
    for (let i = 1; i <= 3; i++) dots.appendChild(h("span", { class: i === step ? "on" : i < step ? "done" : "" }));
    stepLabel.textContent = `Step ${step} of 3`;

    if (step === 1) {
      const card = (id: typeof look, name: string, note: string, a: string, b: string) =>
        h("button", { type: "button", class: "opt", role: "radio", "aria-checked": String(look === id), style: { gap: "6px", padding: "14px" }, onclick: () => { applyLook(id); render(); } },
          h("span", { style: { display: "block", width: "100%", height: "110px", marginBottom: "6px", borderRadius: "10px", border: "1px solid var(--line)", background: `linear-gradient(90deg, ${a} 50%, ${b} 50%)`, position: "relative" } },
            h("span", { style: { position: "absolute", left: "14px", right: "14px", bottom: "14px", height: "16px", borderRadius: "5px", background: "var(--btn)" } })),
          h("strong", null, name), h("small", null, note));
      section.append(
        h("div", { class: "col", style: { gap: "8px" } }, h("h1", null, "Welcome. Pick a look."), h("p", { class: "muted" }, "You can switch any time in Settings. There are ten themes to try.")),
        h("div", { class: "grid3", role: "radiogroup", "aria-label": "Look", style: { gap: "14px" } },
          card("system", "Match my system", "Dark at night, light by day", "#0b0c0f", "#f6f7f9"),
          card("dark", "Dark", "Obsidian", "#0b0c0f", "#0b0c0f"),
          card("light", "Light", "Salt", "#fbfbfa", "#fbfbfa")));
    } else if (step === 2) {
      const links = SETTINGS_LINKS[info.os];
      const perm = (ic: Parameters<typeof icon>[0], name: string, why: string, key: string) =>
        h("div", { class: "perm" }, h("span", { class: "ic" }, icon(ic, 20)),
          h("span", { class: "grow col", style: { gap: "2px" } }, h("strong", null, name), h("span", { class: "muted small" }, why)),
          links ? h("button", { type: "button", class: "btn", onclick: () => openUrl(links[key]) }, "Open setting") : h("span", { class: "muted small" }, "Asked when you record"));
      section.append(
        h("div", { class: "col", style: { gap: "8px" } }, h("h1", null, "Let Alchemist see and hear"), h("p", { class: "muted" }, "Your computer asks before any app can record. Nothing you record leaves this computer.")),
        h("div", { class: "col" },
          perm("record", "Screen recording", "To capture your screen, a window or an area.", "screen"),
          perm("mic", "Microphone", "For your voice. Recorded on its own track.", "mic"),
          perm("camera", "Camera (optional)", "For a picture-in-picture bubble.", "camera")),
        h("p", { class: "muted small" }, info.os === "macos"
          ? "On macOS, turn Alchemist on under Screen Recording, then reopen Alchemist."
          : info.os === "linux"
            ? "On Wayland, your system asks which screen to share each time. On X11 no permission is needed."
            : "Windows normally allows recording. If you see a black screen, check the settings above."),
        h("p", { class: "muted small" }, 'Changed your mind later? Search "permissions" and Alchemist takes you back here.'));
    } else {
      const tip = (k: string, t: string, d: string) => h("div", { class: "card col", style: { padding: "20px", gap: "10px" } }, h("span", { class: "kbd", style: { alignSelf: "flex-start", fontSize: "0.85rem" } }, k), h("strong", null, t), h("span", { class: "muted small" }, d));
      section.append(
        h("div", { class: "col", style: { gap: "8px" } }, h("h1", null, "You're all set"), h("p", { class: "muted" }, "Three things worth remembering. That's it.")),
        h("div", { class: "grid3", style: { gap: "14px" } },
          tip("Ctrl K", "Search anything", 'Type what you want, like "make a GIF". No menus to dig through.'),
          tip("Ctrl Shift R", "Record from anywhere", "Starts and stops recording even when Alchemist is closed."),
          tip("Drop", "Drop any video", "Alchemist asks if you want to edit, shrink or convert it.")));
    }

    if (step > 1) footer.appendChild(h("button", { type: "button", class: "btn big", onclick: () => { step--; render(); } }, "Back"));
    else footer.appendChild(h("button", { type: "button", class: "btn ghost", onclick: finish }, "Skip setup"));
    footer.appendChild(step < 3
      ? h("button", { type: "button", class: "btn primary big", onclick: () => { step++; render(); } }, "Continue")
      : h("button", { type: "button", class: "btn primary big", onclick: finish }, "Open Alchemist"));
    (footer.lastElementChild as HTMLElement).focus();
  };
  render();
  void inTauri;
}
