// The small always-on-top bar shown while recording: timer, mic level,
// pause, cancel and stop. It's its own tiny window; the editor isn't loaded.

import { call, inTauri, type Manifest, type RecordStatus } from "../api";
import { h, icon } from "../dom";
import { clock } from "../format";
import { errorText } from "../ui/common";

export function mount(host: HTMLElement, onDone?: (m: Manifest) => void) {
  const time = h("span", { class: "mono", style: { fontSize: "15px", padding: "0 8px", minWidth: "74px" } }, "0:00");
  const meter = h("span", { class: "meter", "aria-label": "Microphone level" }, h("i", { style: { height: "4px" } }), h("i", { style: { height: "4px" } }), h("i", { style: { height: "4px" } }));
  const pauseBtn = h("button", { type: "button", class: "round", "aria-label": "Pause" }, icon("pause", 14));
  const warn = h("span", { class: "tiny", style: { color: "var(--warn)", maxWidth: "120px" } });
  const bar = h("div", { class: "bar", role: "toolbar", "aria-label": "Recording controls" },
    h("span", { class: "dot" }), time, meter, warn, h("span", { class: "grow" }), pauseBtn,
    h("button", { type: "button", class: "round", "aria-label": "Cancel recording", onclick: async () => {
      if (!confirm("Throw away this recording?")) return;
      clearInterval(timer);
      await call("record_cancel");
    } }, icon("close", 14)),
    h("button", { type: "button", class: "stop", onclick: () => stop() }, icon("stop", 12), "Stop"));
  host.appendChild(bar);

  let paused = false;
  pauseBtn.addEventListener("click", async () => {
    try {
      await call(paused ? "record_resume" : "record_pause");
    } catch (e) {
      warn.textContent = errorText(e);
    }
  });

  const timer = setInterval(async () => {
    const s = await call<RecordStatus | null>("record_status").catch(() => null);
    if (!s) return;
    time.textContent = clock(s.seconds);
    paused = s.paused;
    bar.classList.toggle("paused", s.paused);
    pauseBtn.replaceChildren(icon(s.paused ? "play" : "pause", 14));
    pauseBtn.setAttribute("aria-label", s.paused ? "Resume" : "Pause");
    const lv = Math.min(1, s.micLevel * 3);
    meter.querySelectorAll("i").forEach((el, i) => ((el as HTMLElement).style.height = `${Math.max(3, Math.min(14, lv * 14 * [0.7, 1, 0.5][i]))}px`));
    warn.textContent = s.warning || "";
  }, 400);

  async function stop() {
    clearInterval(timer);
    try {
      const m = await call<Manifest>("record_stop");
      if (inTauri) await call("recording_ui_done");
      else onDone?.(m);
    } catch (e) {
      warn.textContent = errorText(e);
    }
  }
}
