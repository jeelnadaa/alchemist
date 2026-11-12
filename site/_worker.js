/**
 * Alchemist website worker (Cloudflare Workers static assets, or Pages
 * "advanced mode" — the same file works for both).
 *
 *   GET /api/latest  latest GitHub Release, normalized and cached at the edge
 *   everything else  the static site in this folder (env.ASSETS)
 *
 * Variables (optional): GITHUB_REPO "owner/repo", GITHUB_TOKEN read token.
 */

const DEFAULT_REPO = "jeelnadaa/alchemist";

const CACHE_SECONDS = 300;

const ASSET_RE =
  /^alchemist-(\d+\.\d+\.\d+(?:-[0-9a-z.]+)?)-(windows|macos|linux)-(x64|arm64|universal)(?:-(setup|portable))?\.(exe|msi|zip|dmg|appimage|tar\.gz|deb|rpm)$/i;

export function parseAsset(name) {
  const m = ASSET_RE.exec(name);
  if (!m) return null;
  const [, version, os, arch, kindHint, extRaw] = m;
  const ext = extRaw.toLowerCase();
  let kind;
  if (kindHint) kind = kindHint.toLowerCase() === "setup" ? "installer" : "portable";
  else if (ext === "zip" || ext === "appimage" || ext === "tar.gz") kind = "portable";
  else kind = "installer";
  return { version, os: os.toLowerCase(), arch: arch.toLowerCase(), kind, ext };
}

function parseSums(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

function json(body, status = 200, maxAge = CACHE_SECONDS) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${Math.min(maxAge, 60)}, s-maxage=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });
}

/** Build the release summary from latest.json, SHA256SUMS.txt and sizes.json. */
async function fromReleaseFiles(repo) {
  const base = `https://github.com/${repo}/releases/latest/download/`;
  const get = (name) => fetch(base + name, { headers: { "user-agent": "alchemist-website" }, redirect: "follow" });
  const [m, s, z] = await Promise.all([get("latest.json"), get("SHA256SUMS.txt"), get("sizes.json")]);
  if (!m.ok || !s.ok) return null;
  const manifest = await m.json();
  const version = String(manifest.version || "").replace(/^v/, "");
  if (!version) return null;
  const sums = parseSums(await s.text());
  const sizes = z.ok ? await z.json().catch(() => ({})) : {};
  const tag = `v${version}`;
  const assets = Object.keys(sums)
    .map((name) => {
      const p = parseAsset(name);
      if (!p) return null;
      const size = sizes[name.replace(version, "VERSION")] ?? sizes[name] ?? null;
      return { name, url: `https://github.com/${repo}/releases/download/${tag}/${name}`, size, sha256: sums[name], downloads: null, ...p };
    })
    .filter(Boolean);
  if (!assets.length) return null;
  return {
    status: "ok",
    repo,
    version,
    name: tag,
    published: manifest.pub_date || null,
    url: `https://github.com/${repo}/releases/tag/${tag}`,
    notes: String(manifest.notes || "").slice(0, 20000),
    checksums: `https://github.com/${repo}/releases/download/${tag}/SHA256SUMS.txt`,
    assets,
  };
}

async function latest(context) {
  const { env, request, waitUntil } = context;
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return json({ status: "unconfigured" }, 200, 60);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/latest?repo=${encodeURIComponent(repo)}`, request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const headers = {
    "user-agent": "alchemist-website",
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  } catch {
    res = null;
  }

  if (res && res.status === 404) {
    const r = json({ status: "none", repo }, 200, 120);
    waitUntil(cache.put(cacheKey, r.clone()));
    return r;
  }
  if (!res || !res.ok) {
    // The API is rate-limited per IP and Cloudflare's outgoing IPs are shared.
    // The release's own files are plain downloads and say everything we need.
    const body = await fromReleaseFiles(repo).catch(() => null);
    if (body) {
      const out = json(body);
      waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    }
    return json({ status: "error", code: res ? res.status : 0 }, 502, 30);
  }

  const rel = await res.json();

  // Prefer GitHub's own per-asset digest; fall back to SHA256SUMS.txt.
  let sums = {};
  const sumsAsset = rel.assets.find((a) => /^SHA256SUMS(\.txt)?$/i.test(a.name));
  const missing = rel.assets.some((a) => parseAsset(a.name) && !(a.digest || "").startsWith("sha256:"));
  if (sumsAsset && missing) {
    try {
      const s = await fetch(sumsAsset.browser_download_url, { headers: { "user-agent": "alchemist-website" } });
      if (s.ok) sums = parseSums(await s.text());
    } catch {
      /* checksums are optional for the page */
    }
  }

  const assets = rel.assets
    .map((a) => {
      const p = parseAsset(a.name);
      if (!p) return null;
      const digest = (a.digest || "").startsWith("sha256:") ? a.digest.slice(7) : sums[a.name] || null;
      return { name: a.name, url: a.browser_download_url, size: a.size, sha256: digest, downloads: a.download_count, ...p };
    })
    .filter(Boolean);

  const body = {
    status: "ok",
    repo,
    version: String(rel.tag_name || "").replace(/^v/, ""),
    name: rel.name,
    published: rel.published_at,
    url: rel.html_url,
    notes: (rel.body || "").slice(0, 20000),
    checksums: sumsAsset ? sumsAsset.browser_download_url : null,
    assets,
  };

  const out = json(body);
  waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/latest" || url.pathname === "/api/latest/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return latest({ env, request, waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (url.pathname.startsWith("/api/")) return json({ status: "not_found" }, 404, 60);
    return env.ASSETS.fetch(request);
  },
};
