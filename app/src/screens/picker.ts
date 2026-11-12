// Full-screen transparent window for choosing a recording area by dragging.

import { call } from "../api";
import { h } from "../dom";

export function mount(host: HTMLElement) {
  const sel = h("div", { class: "sel hidden" });
  const label = h("span", { class: "label" });
  sel.appendChild(label);
  const root = h("div", { class: "picker", tabindex: "0" },
    h("div", { class: "help" }, "Drag to choose an area. Press Enter to confirm or Esc to cancel."), sel);
  host.appendChild(root);
  root.focus();
  const dpr = window.devicePixelRatio || 1;
  let start: { x: number; y: number } | null = null;
  let rect = { x: 0, y: 0, w: 0, h: 0 };

  const draw = () => {
    sel.classList.remove("hidden");
    Object.assign(sel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    label.textContent = `${Math.round(rect.w * dpr / 2) * 2} × ${Math.round(rect.h * dpr / 2) * 2}`;
  };
  root.addEventListener("mousedown", (e) => {
    start = { x: e.clientX, y: e.clientY };
    rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  });
  root.addEventListener("mousemove", (e) => {
    if (!start) return;
    rect = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
    draw();
  });
  root.addEventListener("mouseup", () => {
    start = null;
  });
  const done = (ok: boolean) =>
    call("area_picked", {
      area: ok && rect.w > 40 && rect.h > 40 ? { x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr), width: Math.round((rect.w * dpr) / 2) * 2, height: Math.round((rect.h * dpr) / 2) * 2 } : null,
    });
  root.addEventListener("dblclick", () => done(true));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
}
