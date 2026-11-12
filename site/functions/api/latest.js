/**
 * Cloudflare Pages Function: GET /api/latest
 *
 * Fetches the latest GitHub Release server-side, caches it at the edge,
 * and returns a small normalized JSON document for the download page.
 *
 * Environment (Pages → Settings → Variables):
 *   GITHUB_REPO   "owner/repo"            (required)
 *   GITHUB_TOKEN  fine-grained read token (optional; raises rate limits)
 */

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

export async function onRequestGet(context) {
  const { env, request, waitUntil } = context;
  const repo = env.GITHUB_REPO;
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
    return json({ status: "error" }, 502, 30);
  }

  if (res.status === 404) {
    const r = json({ status: "none", repo }, 200, 120);
    waitUntil(cache.put(cacheKey, r.clone()));
    return r;
  }
  if (!res.ok) return json({ status: "error", code: res.status }, 502, 30);

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
