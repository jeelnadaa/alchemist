// Hash router. Routes: "", "record", "edit/<id>", "convert", "projects",
// "settings/<section>", "welcome", plus the special windows "bar" and "picker".

type Handler = (route: Route) => void;
export interface Route {
  name: string;
  arg: string | null;
  params: URLSearchParams;
}

const handlers = new Set<Handler>();

export function parse(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const [path, query = ""] = clean.split("?");
  const [name = "", arg = null] = path.split("/");
  return { name, arg: arg ? decodeURIComponent(arg) : null, params: new URLSearchParams(query) };
}

export function current(): Route {
  return parse(location.hash);
}

export function go(path: string) {
  const target = `#/${path.replace(/^#?\/?/, "")}`;
  if (location.hash === target) handlers.forEach((h) => h(current()));
  else location.hash = target;
}

export function onRoute(h: Handler) {
  handlers.add(h);
}

window.addEventListener("hashchange", () => handlers.forEach((h) => h(current())));

// One-shot requests passed between screens ("open the captions panel").
const pending = new Map<string, unknown>();
export function request(key: string, value: unknown = true) {
  pending.set(key, value);
}
export function take<T = unknown>(key: string): T | undefined {
  const v = pending.get(key) as T | undefined;
  pending.delete(key);
  return v;
}
