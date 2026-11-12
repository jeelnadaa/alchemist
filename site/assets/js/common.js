/* ==========================================================================
   Alchemist — shared behaviour: theme, smooth scroll, cursor, magnetic
   buttons, text splitting, reveals, page transitions, platform detection.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var hasGSAP = typeof window.gsap !== "undefined";

  var ALC = (window.ALC = window.ALC || {});
  ALC.reduceMotion = reduceMotion;

  /* ---------- Theme ---------- */
  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  ALC.currentTheme = currentTheme;
  function setTheme(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("alc-theme", t); } catch (e) {}
    document.dispatchEvent(new CustomEvent("alc:theme", { detail: t }));
  }
  document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
    if (!root.getAttribute("data-theme")) document.dispatchEvent(new CustomEvent("alc:theme", { detail: currentTheme() }));
  });

  /* ---------- Platform detection (shared with download page) ---------- */
  ALC.detectPlatform = function () {
    var ua = navigator.userAgent || "";
    var uad = navigator.userAgentData;
    var info = { os: "unknown", arch: "x64", archKnown: false, mobile: false };

    if (/iPhone|iPad|iPod|Android/i.test(ua) || (uad && uad.mobile)) info.mobile = true;
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) info.mobile = true; // iPadOS

    if (/Windows/i.test(ua)) info.os = "windows";
    else if (/Macintosh|Mac OS X/i.test(ua)) info.os = "macos";
    else if (/Linux|X11|CrOS/i.test(ua) && !/Android/i.test(ua)) info.os = "linux";

    if (/aarch64|arm64|armv8/i.test(ua)) { info.arch = "arm64"; info.archKnown = true; }

    var done = Promise.resolve(info);
    if (uad && uad.getHighEntropyValues) {
      done = uad.getHighEntropyValues(["architecture", "bitness"]).then(function (h) {
        if (h.architecture) { info.arch = h.architecture === "arm" ? "arm64" : "x64"; info.archKnown = true; }
        return info;
      }).catch(function () { return info; });
    }
    return done.then(function (i) {
      if (i.os === "macos" && !i.archKnown) {
        // Safari/Firefox don't expose arch. The GPU string tells Apple silicon apart from Intel.
        try {
          var c = document.createElement("canvas");
          var gl = c.getContext("webgl");
          var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
          var r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
          if (/Intel|AMD|Radeon/i.test(r)) i.arch = "x64";
          else i.arch = "arm64"; // Apple M-series, or unknown on a modern Mac
          i.archKnown = /Apple|Intel|AMD|Radeon/i.test(r);
        } catch (e) { i.arch = "arm64"; }
      }
      return i;
    });
  };
  ALC.osLabel = { windows: "Windows", macos: "macOS", linux: "Linux", unknown: "your system" };

  /* ---------- Toast ---------- */
  var toastEl;
  ALC.toast = function (msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("is-on");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove("is-on"); }, 2200);
  };
  ALC.copy = function (text, msg) {
    var p = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject();
    p.then(function () { ALC.toast(msg || "Copied"); }).catch(function () {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ALC.toast(msg || "Copied"); } catch (e) {}
      ta.remove();
    });
  };

  /* ---------- Pause CSS loops in sections that are off screen ---------- */
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle("is-offscreen", !e.isIntersecting); });
    }, { rootMargin: "100px 0px" });
    document.querySelectorAll("main > section, .marquee").forEach(function (s) { io.observe(s); });
  }

  /* ---------- Footer year ---------- */
  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });

  if (!hasGSAP) {
    root.classList.remove("is-entering");
    root.classList.add("no-motion");
    ALC.ready = Promise.resolve();
    return;
  }

  var gsap = window.gsap;
  if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
  var ST = window.ScrollTrigger;

  /* ---------- Smooth scroll ---------- */
  var lenis = null;
  if (!reduceMotion && window.Lenis) {
    lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 1 });
    lenis.on("scroll", ST ? ST.update : function () {});
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
  }
  ALC.lenis = lenis;

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute("href");
    if (id.length < 2) return;
    var target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: -40, duration: 1.4 });
    else target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    history.replaceState(null, "", id);
  });

  /* ---------- Nav state ---------- */
  var nav = document.querySelector(".nav");
  if (nav) {
    var lastY = 0;
    var onScroll = function () {
      var y = window.scrollY;
      nav.classList.toggle("is-scrolled", y > 24);
      nav.classList.toggle("is-hidden", y > 400 && y > lastY + 2);
      if (y < lastY - 2) nav.classList.remove("is-hidden");
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- Text splitting ---------- */
  ALC.split = function (el, mode) {
    if (el._split) return el._split;
    var chars = [], words = [];
    var walk = function (node, parent) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var parts = child.textContent.split(/(\s+)/);
          var frag = document.createDocumentFragment();
          parts.forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
            var w = document.createElement("span");
            w.className = "split-word";
            if (mode === "chars") {
              Array.from(part).forEach(function (ch) {
                var c = document.createElement("span");
                c.className = "split-char";
                c.textContent = ch;
                w.appendChild(c);
                chars.push(c);
              });
            } else {
              w.textContent = part;
            }
            words.push(w);
            frag.appendChild(w);
          });
          child.parentNode.replaceChild(frag, child);
        } else if (child.nodeType === 1 && child.classList.contains("grad-text")) {
          // Gradient text can't be split (background-clip breaks on transformed children),
          // so the whole element moves as one unit.
          child.classList.add("split-word");
          words.push(child);
          chars.push(child);
        } else if (child.nodeType === 1 && !child.matches("br")) {
          walk(child);
        }
      });
    };
    el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
    walk(el);
    Array.prototype.forEach.call(el.querySelectorAll(".split-word"), function (w) { w.setAttribute("aria-hidden", "true"); });
    el._split = { chars: chars, words: words };
    return el._split;
  };

  /* Wrap each visual line of words in a mask so words rise from below a clean edge. */
  ALC.maskLines = function (el) {
    var s = ALC.split(el, "words");
    var lines = [], top = null, line = null;
    s.words.forEach(function (w) {
      var t = w.offsetTop;
      if (top === null || Math.abs(t - top) > 4) { line = []; lines.push(line); top = t; }
      line.push(w);
    });
    lines.forEach(function (ws) {
      var mask = document.createElement("span");
      mask.className = "split-line";
      ws[0].parentNode.insertBefore(mask, ws[0]);
      ws.forEach(function (w, i) {
        mask.appendChild(w);
        if (i < ws.length - 1) mask.appendChild(document.createTextNode(" "));
      });
    });
    return s;
  };

  /* ---------- Reveals ---------- */
  function initReveals() {
    if (reduceMotion || !ST) {
      gsap.set("[data-reveal]", { opacity: 1, y: 0 });
      return;
    }
    gsap.utils.toArray("[data-reveal]").forEach(function (el) {
      gsap.to(el, {
        opacity: 1, y: 0, duration: 1.2, ease: "expo.out",
        delay: parseFloat(el.getAttribute("data-reveal-delay") || 0),
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      });
    });
    gsap.utils.toArray("[data-split]").forEach(function (el) {
      var s = ALC.maskLines(el);
      gsap.from(s.words, {
        yPercent: 110, rotate: 4, duration: 1.2, ease: "expo.out", stagger: 0.04,
        scrollTrigger: { trigger: el, start: "top 86%", once: true },
      });
    });
  }

  /* ---------- Spotlight cards ---------- */
  document.addEventListener("pointermove", function (e) {
    var card = e.target.closest && e.target.closest(".card");
    if (!card) return;
    var r = card.getBoundingClientRect();
    card.style.setProperty("--mx", e.clientX - r.left + "px");
    card.style.setProperty("--my", e.clientY - r.top + "px");
  });

  /* ---------- Cursor + magnetic ---------- */
  if (finePointer && !reduceMotion) {
    var cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.innerHTML = '<div class="cursor__ring"><span class="cursor__label"></span></div><div class="cursor__dot"></div>';
    document.body.appendChild(cursor);
    var ring = cursor.querySelector(".cursor__ring");
    var dot = cursor.querySelector(".cursor__dot");
    var label = cursor.querySelector(".cursor__label");
    var rx = gsap.quickTo(ring, "x", { duration: 0.55, ease: "power3" });
    var ry = gsap.quickTo(ring, "y", { duration: 0.55, ease: "power3" });
    var dx = gsap.quickTo(dot, "x", { duration: 0.1, ease: "power3" });
    var dy = gsap.quickTo(dot, "y", { duration: 0.1, ease: "power3" });
    window.addEventListener("pointermove", function (e) {
      rx(e.clientX); ry(e.clientY); dx(e.clientX); dy(e.clientY);
      var t = e.target.closest ? e.target.closest("a, button, [data-cursor], input, label") : null;
      var lbl = t && t.getAttribute("data-cursor");
      cursor.classList.toggle("is-hover", !!t && !lbl);
      cursor.classList.toggle("is-label", !!lbl);
      if (lbl) label.textContent = lbl;
    }, { passive: true });
    document.addEventListener("pointerleave", function () { cursor.classList.add("is-hidden"); });
    document.addEventListener("pointerenter", function () { cursor.classList.remove("is-hidden"); });

    document.querySelectorAll("[data-magnetic]").forEach(function (el) {
      var strength = parseFloat(el.getAttribute("data-magnetic")) || 0.35;
      // Animate a proxy and write the CSS `translate` property, which is independent of
      // `transform`, so entrance/scroll tweens on the same element are never overwritten.
      var pos = { x: 0, y: 0 };
      var apply = function () { el.style.translate = pos.x.toFixed(2) + "px " + pos.y.toFixed(2) + "px"; };
      var xTo = gsap.quickTo(pos, "x", { duration: 0.8, ease: "elastic.out(1, 0.4)", onUpdate: apply });
      var yTo = gsap.quickTo(pos, "y", { duration: 0.8, ease: "elastic.out(1, 0.4)", onUpdate: apply });
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * strength);
        yTo((e.clientY - (r.top + r.height / 2)) * strength);
      });
      el.addEventListener("pointerleave", function () { xTo(0); yTo(0); });
    });
  }

  /* ---------- Page transitions ---------- */
  var curtain = document.querySelector(".curtain");
  var bars = curtain ? curtain.querySelectorAll("span") : [];
  var mark = document.querySelector(".curtain__mark");

  function enter() {
    if (!curtain || reduceMotion) { root.classList.remove("is-entering"); return Promise.resolve(); }
    gsap.set(bars, { scaleY: 1, transformOrigin: "top" });
    gsap.set(mark, { opacity: 1 });
    root.classList.remove("is-entering");
    var tl = gsap.timeline();
    tl.to(mark, { opacity: 0, scale: 0.8, duration: 0.4, ease: "power2.in" })
      .to(bars, { scaleY: 0, duration: 0.9, ease: "expo.inOut", stagger: { each: 0.06, from: "start" } }, 0.1);
    return tl.then ? tl.then() : Promise.resolve();
  }
  function leave(href) {
    if (!curtain || reduceMotion) { window.location.href = href; return; }
    gsap.set(bars, { transformOrigin: "bottom" });
    gsap.timeline({ onComplete: function () { window.location.href = href; } })
      .to(bars, { scaleY: 1, duration: 0.7, ease: "expo.inOut", stagger: { each: 0.05, from: "end" } })
      .to(mark, { opacity: 1, scale: 1, duration: 0.3 }, "-=0.25");
  }
  ALC.enter = enter;

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    var url = new URL(a.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.hash)) return;
    if (url.pathname === location.pathname && !url.hash) return;
    e.preventDefault();
    leave(url.href);
  });
  window.addEventListener("pageshow", function (e) {
    if (e.persisted && bars.length) { gsap.set(bars, { scaleY: 0 }); gsap.set(mark, { opacity: 0 }); }
  });

  /* ---------- Boot ---------- */
  ALC.ready = (document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 1200); })]) : Promise.resolve())
    .then(function () {
      initReveals();
      var e = enter();
      if (ST) ST.refresh();
      return e;
    });
})();
