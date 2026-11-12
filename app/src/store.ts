// App-wide state: settings (persisted by the core) and the job list.

import { call, DEFAULT_SETTINGS, on, type Job, type Settings } from "./api";
import { applyTheme, resolveTheme, type Theme } from "./themes";

type Listener = () => void;

class Store {
  settings: Settings = { ...DEFAULT_SETTINGS };
  jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<Listener>>();
  private systemDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true;

  async init() {
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...(await call<Settings>("settings_get")) };
    } catch {
      /* defaults */
    }
    this.applyLook();
    if (typeof matchMedia === "function") {
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        this.systemDark = e.matches;
        this.applyLook();
      });
    }
    for (const j of await call<Job[]>("jobs_list").catch(() => [] as Job[])) this.jobs.set(j.id, j);
    await on<Job>("job", (j) => {
      this.jobs.set(j.id, j);
      this.emit("jobs");
    });
  }

  applyLook() {
    const s = this.settings;
    applyTheme(resolveTheme({ theme: s.theme, followSystem: s.followSystem, darkTheme: s.darkTheme, lightTheme: s.lightTheme, accent: s.accent, customTheme: (s.customTheme as Theme | undefined) ?? null }, this.systemDark));
    const size = { small: "14px", default: "15px", large: "17px" }[s.textSize] || "15px";
    document.documentElement.style.fontSize = size;
    document.documentElement.dataset.reduceMotion = String(s.reduceMotion || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches));
  }

  async set(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.applyLook();
    this.emit("settings");
    await call("settings_set", { value: this.settings }).catch(() => {});
  }

  activeJobs(): Job[] {
    return [...this.jobs.values()].filter((j) => j.status === "running" || j.status === "queued");
  }

  sub(topic: string, fn: Listener): () => void {
    if (!this.listeners.has(topic)) this.listeners.set(topic, new Set());
    this.listeners.get(topic)!.add(fn);
    return () => this.listeners.get(topic)?.delete(fn);
  }

  emit(topic: string) {
    this.listeners.get(topic)?.forEach((f) => f());
  }
}

export const store = new Store();
