// Shared UI pieces: toasts, dialogs, the logo, small builders.

import { clear, h, icon } from "../dom";

let toastHost: HTMLElement | null = null;

export function toast(message: string, opts: { error?: boolean; action?: { label: string; run: () => void }; ms?: number } = {}) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastHost);
  }
  const el = h("div", { class: `toast${opts.error ? " error" : ""}` }, h("span", null, message));
  if (opts.action) {
    el.appendChild(h("button", { type: "button", onclick: () => { opts.action!.run(); el.remove(); } }, opts.action.label));
  }
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), opts.ms ?? (opts.error ? 7000 : 3500));
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as Error).message);
  return "Something went wrong.";
}

/** A modal dialog; returns a close function. Esc and clicking outside close it. */
export function modal(build: (close: () => void) => HTMLElement, opts: { label: string; onClose?: () => void }): () => void {
  const prev = document.activeElement as HTMLElement | null;
  const scrim = h("div", { class: "scrim" });
  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
    prev?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const box = build(close);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", opts.label);
  scrim.appendChild(box);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(scrim);
  requestAnimationFrame(() => (box.querySelector<HTMLElement>("[autofocus], input, button.primary, button") || box).focus());
  return close;
}

export function confirmDialog(title: string, body: string, ok = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    modal(
      (close) =>
        h("div", { class: "dialog", style: { width: "460px" } },
          h("header", null, h("h2", null, title)),
          h("div", { class: "content" }, h("p", { class: "muted" }, body)),
          h("footer", null,
            h("span", { class: "grow" }),
            h("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
            h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "button", onclick: () => { result = true; close(); } }, ok))),
      { label: title, onClose: () => resolve(result) },
    );
  });
}

export function logo(size = 22, color = "currentColor"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", color);
  svg.setAttribute("stroke-width", size <= 20 ? "6" : "4.5");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<path d="M32 6 58 53H6Z" stroke-linejoin="round"/><circle cx="32" cy="38" r="9"/><path d="M20 22h24" stroke-linecap="round"/>';
  return svg;
}

export function switchButton(checked: boolean, label: string, onChange: (v: boolean) => void): HTMLButtonElement {
  const b = h("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(checked), "aria-label": label });
  b.addEventListener("click", () => {
    const v = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", String(v));
    onChange(v);
  });
  return b;
}

export function toggleRow(title: string, sub: string | null, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h("div", { class: "toggle-row" },
    h("div", { class: "col", style: { gap: "2px" } }, h("strong", null, title), sub ? h("span", { class: "muted small" }, sub) : null),
    switchButton(checked, title, onChange));
}

export function segmented<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const box = h("div", { class: "seg", role: "radiogroup", "aria-label": label });
  const render = (v: T) => {
    clear(box);
    for (const [id, text] of options) {
      box.appendChild(h("button", { type: "button", role: "radio", "aria-checked": String(id === v), onclick: () => { render(id); onChange(id); } }, text));
    }
  };
  render(value);
  return box;
}

export function rangeControl(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void, onCommit?: (v: number) => void): HTMLElement {
  const out = h("span", null, fmt(value));
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label }) as HTMLInputElement;
  const fill = () => input.style.setProperty("--fill", `${((+input.value - min) / (max - min)) * 100}%`);
  fill();
  input.addEventListener("input", () => {
    out.textContent = fmt(+input.value);
    fill();
    onInput(+input.value);
  });
  input.addEventListener("change", () => onCommit?.(+input.value));
  return h("label", { class: "ctl" }, h("span", { class: "lab" }, h("span", null, label), out), input);
}

export function chipGroup<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const box = h("div", { class: "chips", role: "group", "aria-label": label });
  for (const [id, text] of options) {
    const b = h("button", { type: "button", "aria-pressed": String(id === value) }, text);
    b.addEventListener("click", () => {
      box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      onChange(id);
    });
    box.appendChild(b);
  }
  return h("div", { class: "ctl" }, h("span", null, label), box);
}

export { icon };
