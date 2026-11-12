/* ==========================================================================
   Alchemist — download page: platform detection, release data, rendering
   ========================================================================== */
(function () {
  "use strict";
  var ALC = window.ALC || {};
  var cfg = window.ALCHEMIST_CONFIG || {};
  var gsap = window.gsap;
  var reduce = !!ALC.reduceMotion;
  var repoOk = cfg.repo && !/^OWNER\//.test(cfg.repo);
  var RELEASES_URL = "https://github.com/" + (cfg.repo || "") + "/releases";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  $$("[data-gh-releases]").forEach(function (a) { a.href = RELEASES_URL + (a.href.indexOf("/latest") > -1 ? "/latest" : ""); });
  $$("[data-gh-link]").forEach(function (a) { a.href = "https://github.com/" + cfg.repo + (a.getAttribute("data-gh-link") || ""); });

  /* ---------- Catalog: what each OS should offer, in display order ---------- */
  var CATALOG = {
    windows: [
      { ext: "exe", kind: "installer", title: "Installer", desc: "Installs for you only, no admin prompt. Updates itself quietly.", rec: true },
      { ext: "zip", kind: "portable", title: "Portable", desc: "Unzip and run from any folder or USB stick. Settings stay inside the folder." },
    ],
    macos: [
      { ext: "dmg", kind: "installer", title: "Disk image", desc: "Drag to Applications. Updates itself in place.", rec: true },
      { ext: "zip", kind: "portable", title: "Portable", desc: "The app in a zip. Run it from anywhere, settings stay beside it." },
    ],
    linux: [
      { ext: "appimage", kind: "portable", title: "AppImage", desc: "One file, runs on almost any distribution. Updates itself.", rec: true },
      { ext: "deb", kind: "installer", title: "Debian / Ubuntu", desc: "Native package. Your package manager owns updates." },
      { ext: "rpm", kind: "installer", title: "Fedora / RHEL", desc: "Native package. Your package manager owns updates." },
      { ext: "tar.gz", kind: "portable", title: "Tarball", desc: "Extract anywhere and run. No system changes." },
    ],
  };
  var ARCH_LABEL = {
    windows: { x64: "Intel / AMD", arm64: "Snapdragon / ARM" },
    macos: { x64: "Intel", arm64: "Apple silicon" },
    linux: { x64: "Intel / AMD", arm64: "ARM64" },
  };
  var TIPS = {
    windows: {
      title: "Installing on Windows",
      steps: [
        "<strong>Installer:</strong> run the setup file. It installs for your user only, so no admin prompt.",
        "<strong>Portable:</strong> unzip anywhere and run <span class=\"kbd\">alchemist.exe</span>. Everything stays in its <span class=\"kbd\">data</span> folder.",
        "If SmartScreen warns about an early unsigned build, choose <strong>More info → Run anyway</strong>. Verify the checksum first.",
      ],
    },
    macos: {
      title: "Installing on macOS",
      steps: [
        "Open the disk image and drag <strong>Alchemist</strong> into <strong>Applications</strong>.",
        "Launch it from Applications, not from the disk image, so updates can be applied.",
        "Your first recording asks for <strong>Screen Recording</strong> permission. Alchemist explains why before macOS asks.",
      ],
    },
    linux: {
      title: "Installing on Linux",
      steps: [
        "<strong>AppImage:</strong> <span class=\"kbd\">chmod +x</span> the file, then run it.",
        "<strong>Packages:</strong> <span class=\"kbd\">sudo apt install ./file.deb</span> or <span class=\"kbd\">sudo dnf install ./file.rpm</span>.",
        "On Wayland, screen capture goes through the system portal, so you'll pick which screen or window to share.",
      ],
    },
  };

  /* ---------- Helpers ---------- */
  function fmtSize(b) {
    if (!b && b !== 0) return "";
    var u = ["B", "KB", "MB", "GB"], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i >= 2 ? b.toFixed(1) : Math.round(b)) + " " + u[i];
  }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return ""; }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  var ASSET_RE = /^alchemist-(\d+\.\d+\.\d+(?:-[0-9a-z.]+)?)-(windows|macos|linux)-(x64|arm64|universal)(?:-(setup|portable))?\.(exe|msi|zip|dmg|appimage|tar\.gz|deb|rpm)$/i;
  function parseAsset(name) {
    var m = ASSET_RE.exec(name);
    if (!m) return null;
    var ext = m[5].toLowerCase(), kind;
    if (m[4]) kind = m[4].toLowerCase() === "setup" ? "installer" : "portable";
    else kind = ext === "zip" || ext === "appimage" || ext === "tar.gz" ? "portable" : "installer";
    return { version: m[1], os: m[2].toLowerCase(), arch: m[3].toLowerCase(), kind: kind, ext: ext };
  }

  /* Minimal, safe Markdown for release notes (escape first, then format). */
  function md(src) {
    var lines = esc(src.replace(/<!--[\s\S]*?-->/g, "")).split(/\r?\n/);
    var html = "", inList = false;
    function inline(t) {
      return t
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener nofollow" target="_blank">$1</a>');
    }
    lines.forEach(function (l) {
      var h = /^(#{1,6})\s+(.*)$/.exec(l), li = /^\s*[-*]\s+(.*)$/.exec(l);
      if (li) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + inline(li[1]) + "</li>"; return; }
      if (inList) { html += "</ul>"; inList = false; }
      if (h) html += (h[1].length <= 2 ? "<h3>" : "<h4>") + inline(h[2]) + (h[1].length <= 2 ? "</h3>" : "</h4>");
      else if (l.trim()) html += "<p>" + inline(l) + "</p>";
    });
    if (inList) html += "</ul>";
    return html;
  }

  /* ---------- Release loading: edge function → GitHub API → nothing ---------- */
  function fromGitHub() {
    if (!repoOk) return Promise.resolve({ status: "unconfigured" });
    return fetch("https://api.github.com/repos/" + cfg.repo + "/releases/latest", { headers: { accept: "application/vnd.github+json" } })
      .then(function (r) {
        if (r.status === 404) return { status: "none" };
        if (!r.ok) throw new Error("gh " + r.status);
        return r.json().then(function (rel) {
          return {
            status: "ok",
            version: String(rel.tag_name || "").replace(/^v/, ""),
            published: rel.published_at,
            url: rel.html_url,
            notes: rel.body || "",
            assets: rel.assets.map(function (a) {
              var p = parseAsset(a.name);
              if (!p) return null;
              p.name = a.name; p.url = a.browser_download_url; p.size = a.size;
              p.sha256 = (a.digest || "").indexOf("sha256:") === 0 ? a.digest.slice(7) : null;
              return p;
            }).filter(Boolean),
          };
        });
      });
  }
  function loadRelease() {
    return fetch("/api/latest", { headers: { accept: "application/json" } })
      .then(function (r) {
        var type = r.headers.get("content-type") || "";
        if (!r.ok || type.indexOf("json") < 0) throw new Error("no fn");
        return r.json();
      })
      .then(function (d) { return d.status === "ok" || d.status === "none" ? d : fromGitHub(); })
      .catch(fromGitHub)
      .catch(function () { return { status: "error" }; });
  }

  /* ---------- State ---------- */
  var params = new URLSearchParams(location.search);
  var state = { os: "windows", arch: "x64", detected: null, release: null };

  function findAsset(os, arch, ext) {
    var list = (state.release && state.release.assets) || [];
    var hit = list.filter(function (a) { return a.os === os && a.ext === ext && a.arch === arch; })[0];
    if (!hit && os === "macos") hit = list.filter(function (a) { return a.os === os && a.ext === ext && a.arch === "universal"; })[0];
    return hit || null;
  }
  function archAvailable(os, arch) {
    var list = (state.release && state.release.assets) || [];
    if (!list.length) return true;
    return list.some(function (a) { return a.os === os && (a.arch === arch || a.arch === "universal"); });
  }

  /* ---------- Render: tabs / arch ---------- */
  var tabs = $$(".tab[data-os]"), ink = $(".tabs__ink");
  function moveInk(animate) {
    var on = tabs.filter(function (t) { return t.getAttribute("aria-selected") === "true"; })[0];
    if (!on || !ink) return;
    if (!animate) ink.style.transition = "none";
    ink.style.width = on.offsetWidth + "px";
    ink.style.transform = "translateX(" + on.offsetLeft + "px)";
    if (!animate) { ink.offsetWidth; ink.style.transition = ""; }
  }
  window.addEventListener("resize", function () { moveInk(false); });

  function renderControls() {
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-os") === state.os;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
    $("#dl-panel").setAttribute("aria-labelledby", "tab-" + state.os);
    moveInk(true);
    $$(".seg__btn").forEach(function (b) {
      var a = b.getAttribute("data-arch");
      b.setAttribute("aria-checked", a === state.arch ? "true" : "false");
      var hint = b.querySelector("small");
      var det = state.detected && !state.detected.mobile && state.detected.os === state.os && state.detected.arch === a;
      hint.innerHTML = esc(ARCH_LABEL[state.os][a]) + (det ? '<span class="det">yours</span>' : "");
      b.disabled = !archAvailable(state.os, a);
      b.style.opacity = b.disabled ? 0.4 : "";
    });
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { selectOS(t.getAttribute("data-os")); });
    t.addEventListener("keydown", function (e) {
      var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var n = tabs[(i + d + tabs.length) % tabs.length];
      n.focus(); selectOS(n.getAttribute("data-os"));
    });
  });
  $$(".seg__btn").forEach(function (b) {
    b.addEventListener("click", function () { state.arch = b.getAttribute("data-arch"); renderControls(); renderList(true); });
  });
  function selectOS(os) {
    if (os === state.os) return;
    state.os = os;
    if (!archAvailable(os, state.arch)) state.arch = state.arch === "x64" ? "arm64" : "x64";
    if (state.detected && state.detected.os === os) state.arch = state.detected.arch;
    renderControls(); renderList(true); renderTip(); syncVerify();
  }

  /* ---------- Render: list ---------- */
  var copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
  var dlIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16"/></svg>';

  function renderList(animate) {
    var list = $("[data-dl-list]");
    var hasRelease = state.release && state.release.status === "ok";
    var html = CATALOG[state.os].map(function (item) {
      var a = hasRelease ? findAsset(state.os, state.arch, item.ext) : null;
      var extLabel = item.ext === "appimage" ? "APP" : item.ext === "tar.gz" ? "TGZ" : item.ext.toUpperCase();
      var badges = (item.rec ? '<span class="badge badge--accent">Recommended</span>' : "") + '<span class="badge">' + (item.kind === "portable" ? "Portable" : "Installer") + "</span>";
      var file = a
        ? '<span class="fname">' + esc(a.name) + "</span>" + (a.sha256 ? '<button type="button" class="hash" data-copy="' + esc(a.sha256) + '" title="Copy SHA-256">' + copyIcon + "sha256 " + esc(a.sha256.slice(0, 12)) + "…</button>" : "")
        : '<span class="fname">' + (hasRelease ? "Not included in this release" : "Available with the first release") + "</span>";
      var get = a
        ? '<span class="dl-row__size">' + fmtSize(a.size) + '</span><a class="btn ' + (item.rec ? "btn--accent" : "btn--ghost") + ' btn--sm" href="' + esc(a.url) + '" data-cursor="Get">' + dlIcon + "Download</a>"
        : '<span class="btn btn--ghost btn--sm" aria-disabled="true">Soon</span>';
      return '<div class="dl-row' + (item.rec ? " is-rec" : "") + (a ? "" : " is-missing") + '">' +
        '<span class="dl-row__icon" aria-hidden="true">' + extLabel + "</span>" +
        '<div class="dl-row__main"><div class="dl-row__title">' + esc(item.title) + badges + "</div>" +
        '<p class="dl-row__desc">' + esc(item.desc) + "</p>" +
        '<div class="dl-row__file">' + file + "</div></div>" +
        '<div class="dl-row__get">' + get + "</div></div>";
    }).join("");
    list.innerHTML = html;
    if (animate && gsap && !reduce) {
      gsap.fromTo(list.children, { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, ease: "expo.out", stagger: 0.06 });
    }
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-copy]");
    if (b) ALC.copy(b.getAttribute("data-copy"), "SHA-256 copied");
  });

  function renderTip() {
    var t = TIPS[state.os];
    $("[data-dl-tip]").innerHTML = "<h3>" + esc(t.title) + "</h3><ol>" + t.steps.map(function (s) { return "<li><span>" + s + "</span></li>"; }).join("") + "</ol>";
  }

  /* ---------- Verify code ---------- */
  var codeTabs = $$(".code__tab");
  function showCode(os) {
    codeTabs.forEach(function (t) { t.setAttribute("aria-selected", t.getAttribute("data-code") === os ? "true" : "false"); });
    $$("[data-code-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-code-panel") !== os; });
  }
  codeTabs.forEach(function (t) { t.addEventListener("click", function () { showCode(t.getAttribute("data-code")); }); });
  $("[data-code-copy]").addEventListener("click", function () {
    var p = $$("[data-code-panel]").filter(function (x) { return !x.hidden; })[0];
    var cmd = p.textContent.split("\n").filter(function (l) { return !/^\s*#/.test(l); }).join("\n").replace(/^\s*[>$]\s*/gm, "").trim();
    ALC.copy(cmd, "Command copied");
  });
  function syncVerify() {
    showCode(state.os);
    var ext = CATALOG[state.os].filter(function (i) { return i.rec; })[0].ext;
    var a = findAsset(state.os, state.arch, ext);
    var w = $('[data-code-file="windows"]'), m = $('[data-code-file="macos"]');
    if (a && state.os === "windows") w.textContent = ".\\" + a.name;
    if (a && state.os === "macos") m.textContent = a.name;
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    var d = state.detected, rel = state.release;
    var main = $("[data-dl-main]"), alt = $("[data-dl-alt]");
    var label = $("[data-dl-main-label]"), sub = $("[data-dl-main-sub]");
    var meta = $("[data-dl-meta]"), emblem = $("[data-emblem-os]");
    var osName = ALC.osLabel[state.os];
    emblem.textContent = osName + " · " + state.arch;

    if (d && d.mobile) {
      label.textContent = "Alchemist is a desktop app";
      sub.textContent = "Tap to copy this page's link for later";
      main.href = "#";
      main.onclick = function (e) { e.preventDefault(); ALC.copy(location.origin + "/download/", "Link copied"); };
      alt.hidden = true;
      emblem.textContent = "Desktop only";
    } else if (rel && rel.status === "ok") {
      var recExt = CATALOG[state.os].filter(function (i) { return i.rec; })[0].ext;
      var portExt = state.os === "linux" ? "tar.gz" : "zip";
      var a = findAsset(state.os, state.arch, recExt), p = findAsset(state.os, state.arch, portExt);
      if (a) {
        main.href = a.url; main.onclick = null;
        label.textContent = "Download for " + osName;
        sub.textContent = ARCH_LABEL[state.os][state.arch] + " · ." + (a.ext === "appimage" ? "AppImage" : a.ext) + " · " + fmtSize(a.size);
      } else {
        main.href = "#all";
        label.textContent = "Choose your build";
        sub.textContent = "No " + osName + " " + state.arch + " build in this release";
      }
      if (p) {
        alt.hidden = false; alt.href = p.url;
        $("[data-dl-alt-label]").textContent = "Portable";
        $("[data-dl-alt-sub]").textContent = "." + p.ext + " · " + fmtSize(p.size);
      } else alt.hidden = true;
    } else {
      main.href = "#all"; main.onclick = null;
      label.textContent = "See all platforms";
      sub.textContent = d && d.os !== "unknown" ? "We detected " + osName + " · " + ARCH_LABEL[state.os][state.arch] : "Windows, macOS & Linux";
      alt.hidden = true;
    }

    if (rel && rel.status === "ok") {
      meta.innerHTML =
        '<span class="dl-meta__item"><span class="pulse"></span>Latest <b>v' + esc(rel.version) + "</b></span>" +
        (rel.published ? '<span class="dl-meta__item">Released <b>' + esc(fmtDate(rel.published)) + "</b></span>" : "") +
        '<span class="dl-meta__item">Free · auto-updates</span>';
    } else {
      meta.innerHTML = '<span class="dl-meta__item"><span class="pulse" style="background:var(--accent);box-shadow:0 0 10px var(--accent)"></span>First release in the forge</span><span class="dl-meta__item">Installer &amp; portable for every OS</span>';
    }
  }

  function renderBanner() {
    var b = $("[data-dl-banner]"), rel = state.release;
    var icon = '<span class="dl-banner__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg></span>';
    if (!rel || rel.status === "ok") { b.hidden = true; return; }
    var msg = rel.status === "error"
      ? "<strong>Couldn't reach GitHub right now.</strong><p>Every build is still available on <a href=\"" + esc(RELEASES_URL) + "\" rel=\"noopener\">GitHub Releases</a>.</p>"
      : "<strong>The first release is being forged.</strong><p>Builds appear here automatically the moment a release is published" + (repoOk ? ' on <a href="' + esc(RELEASES_URL) + '" rel="noopener">GitHub</a>' : "") + ".</p>";
    b.innerHTML = icon + "<div>" + msg + "</div>";
    b.hidden = false;
  }

  function renderNotes() {
    var rel = state.release;
    if (!rel || rel.status !== "ok") return;
    $("[data-notes-ver]").textContent = "v" + rel.version;
    $("[data-notes-body]").innerHTML = rel.notes ? md(rel.notes) : '<p class="muted">No notes for this release.</p>';
  }

  /* ---------- Emblem tilt ---------- */
  (function () {
    var core = $(".emblem__core");
    if (!core || !gsap || reduce) return;
    var rx = gsap.quickTo(core, "rotationX", { duration: 1, ease: "power3" });
    var ry = gsap.quickTo(core, "rotationY", { duration: 1, ease: "power3" });
    window.addEventListener("pointermove", function (e) {
      ry((e.clientX / window.innerWidth - 0.5) * 30);
      rx(-(e.clientY / window.innerHeight - 0.5) * 30);
    }, { passive: true });
    gsap.to(core, { y: -14, duration: 3, ease: "sine.inOut", yoyo: true, repeat: -1 });
  })();

  /* ---------- Boot ---------- */
  var detectP = (ALC.detectPlatform ? ALC.detectPlatform() : Promise.resolve({ os: "unknown", arch: "x64" })).then(function (d) {
    state.detected = d;
    var qos = params.get("os"), qarch = params.get("arch");
    state.os = CATALOG[qos] ? qos : CATALOG[d.os] ? d.os : "windows";
    state.arch = qarch === "arm64" || qarch === "x64" ? qarch : d.os === state.os ? d.arch : "x64";
    renderControls(); moveInk(false); renderTip(); syncVerify(); renderHero();
  });
  var relP = loadRelease();

  Promise.all([detectP, relP]).then(function (r) {
    state.release = r[1];
    if (!archAvailable(state.os, state.arch)) state.arch = state.arch === "x64" ? "arm64" : "x64";
    renderControls(); renderList(false); renderHero(); renderBanner(); renderNotes(); syncVerify();
    if (window.ScrollTrigger) window.ScrollTrigger.refresh();
  });

  /* ---------- Entrance ---------- */
  if (gsap && ALC.ready) {
    ALC.ready.then(function () {
      if (reduce) return;
      var tl = gsap.timeline({ defaults: { ease: "expo.out" }, delay: 0.3 });
      $$(".dl-line").forEach(function (l, i) {
        var s = ALC.split(l, "chars");
        tl.from(s.chars, { yPercent: 115, rotate: 6, duration: 1.4, stagger: 0.03 }, i * 0.12);
      });
      tl.from("[data-dl-eyebrow]", { opacity: 0, y: 16, duration: 1 }, 0.1)
        .from("[data-dl-lede]", { opacity: 0, y: 24, duration: 1.2 }, 0.45)
        .from(".dl-primary > *", { opacity: 0, y: 24, duration: 1.2, stagger: 0.08 }, 0.55)
        .from(".dl-meta, .dl-switch", { opacity: 0, duration: 1.2 }, 0.75)
        .from(".emblem__ring", { scale: 0.6, opacity: 0, rotate: -90, duration: 2, stagger: 0.12 }, 0.2)
        .from(".emblem__core", { scale: 0.4, opacity: 0, duration: 1.6, ease: "elastic.out(1, 0.6)" }, 0.5)
        .from(".emblem__os", { opacity: 0, y: 10, duration: 1 }, 1);
    });
  }
})();
