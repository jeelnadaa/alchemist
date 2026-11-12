/* ==========================================================================
   Alchemist — landing page motion
   ========================================================================== */
(function () {
  "use strict";
  var ALC = window.ALC || {};
  var gsap = window.gsap;
  var ST = window.ScrollTrigger;
  var reduce = !!ALC.reduceMotion;
  var cfg = window.ALCHEMIST_CONFIG || {};

  /* ---------- GitHub links ---------- */
  document.querySelectorAll("[data-gh-link]").forEach(function (a) {
    a.href = "https://github.com/" + cfg.repo + (a.getAttribute("data-gh-link") || "");
  });

  /* ---------- OS-aware CTAs ---------- */
  if (ALC.detectPlatform) {
    ALC.detectPlatform().then(function (p) {
      var label = p.mobile ? "Get it for your desktop" : p.os === "unknown" ? "Download Alchemist" : "Download for " + ALC.osLabel[p.os];
      document.querySelectorAll("[data-os-cta-label]").forEach(function (el) { el.textContent = label; });
      document.querySelectorAll("[data-os-cta]").forEach(function (a) {
        if (p.os !== "unknown" && !p.mobile) a.href = "/download/?os=" + p.os + "&arch=" + p.arch;
      });
    });
  }

  /* ---------- Latest version chip ---------- */
  fetch("/api/latest", { headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.version) return;
      var chip = document.querySelector("[data-latest-chip]");
      if (chip) chip.textContent = "Alchemist " + d.version + " is out";
      var uv = document.querySelector("[data-upd-version]");
      if (uv) uv.textContent = "Alchemist " + d.version;
    })
    .catch(function () {});

  /* ======================================================================
     WebGL hero — liquid metal (domain-warped fbm with lit normals)
     ====================================================================== */
  function initShader() {
    var canvas = document.querySelector(".hero__canvas");
    if (!canvas) return;
    var gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (!gl) return;

    var vert = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
    // One field evaluation per pixel; normals come from screen-space derivatives
    // (3x cheaper than finite differences). Falls back to flat shading without the extension.
    var deriv = !!gl.getExtension("OES_standard_derivatives");
    var frag = [
      deriv ? "#extension GL_OES_standard_derivatives : enable" : "",
      "precision highp float;",
      "uniform vec2 r;uniform float t;uniform vec2 m;uniform float lt;",
      "float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}",
      "float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);",
      " return mix(mix(h(i),h(i+vec2(1,0)),u.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x),u.y);}",
      "float fbm(vec2 p){float v=0.,a=.5;mat2 R=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<4;i++){v+=a*n(p);p=R*p;a*=.5;}return v;}",
      "void main(){",
      " vec2 uv=(gl_FragCoord.xy-.5*r)/r.y;",
      " float s=t*.05;",
      " vec2 q=vec2(fbm(uv*1.3+vec2(0.,s)),fbm(uv*1.3+vec2(5.2,1.3)-s));",
      " vec2 d=uv-m; q+=exp(-dot(d,d)*5.)*.35*vec2(-d.y,d.x);",
      " vec2 w=vec2(fbm(uv*1.5+2.2*q+vec2(1.7,9.2)+s*1.4),fbm(uv*1.5+2.2*q+vec2(8.3,2.8)-s));",
      " float f=fbm(uv*1.15+2.6*w);",
      deriv ? " vec3 N=normalize(vec3(-dFdx(f)*r.y*.06,-dFdy(f)*r.y*.06,1.));" : " vec3 N=vec3(0.,0.,1.);",
      " vec3 L=normalize(vec3(m*1.2+vec2(.2,.6),.9));",
      " float diff=clamp(dot(N,L),0.,1.);",
      " float spec=pow(clamp(reflect(-L,N).z,0.,1.),30.);",
      " float k=clamp((f-.26)/.34,0.,1.);",
      " float band=.5+.5*sin(k*9.+t*.3);",
      // dark: graphite -> deep navy -> royal blue, soft white highlights
      " vec3 c0=vec3(.03,.035,.045),c1=vec3(.07,.12,.26),c2=vec3(.3,.5,.98),c3=vec3(.85,.9,1.);",
      " vec3 col=mix(c0,c1,smoothstep(.15,.6,k));",
      " col=mix(col,c2,smoothstep(.6,1.,k)*(.45+.35*band));",
      " col*=.55+.7*diff;",
      " col+=c3*spec*smoothstep(.35,.85,k)*.6;",
      // light: soft white with pale blue folds
      " vec3 p0=vec3(.965,.97,.98),p1=vec3(.83,.87,.96),p2=vec3(.36,.52,.92);",
      " vec3 lc=mix(p0,p1,smoothstep(.35,.75,k));",
      " lc=mix(lc,p2,smoothstep(.72,1.,k)*(.4+.4*band));",
      " lc*=.92+.12*diff; lc+=vec3(1.)*spec*.3*smoothstep(.4,.9,k);",
      " col=mix(col,lc,lt);",
      " float vig=smoothstep(1.35,.15,length(uv*vec2(.85,1.1)));",
      " col=mix(mix(c0,p0,lt),col,vig);",
      " gl_FragColor=vec4(col,1.);",
      "}",
    ].join("\n");

    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
      return s;
    }
    var vs = sh(gl.VERTEX_SHADER, vert), fs = sh(gl.FRAGMENT_SHADER, frag);
    if (!vs || !fs) return;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var uR = gl.getUniformLocation(prog, "r"), uT = gl.getUniformLocation(prog, "t"), uM = gl.getUniformLocation(prog, "m"), uL = gl.getUniformLocation(prog, "lt");

    // Render at reduced resolution: the field is soft, and this keeps the GPU cost tiny.
    var scale = 0.4;
    function resize() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.25) * scale;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    window.addEventListener("resize", resize);

    var mouse = { x: 0.25, y: 0.1 }, target = { x: 0.25, y: 0.1 };
    window.addEventListener("pointermove", function (e) {
      var rect = canvas.getBoundingClientRect();
      target.x = (e.clientX - rect.left - rect.width / 2) / rect.height;
      target.y = -(e.clientY - rect.top - rect.height / 2) / rect.height;
    }, { passive: true });

    var lightTarget = ALC.currentTheme && ALC.currentTheme() === "light" ? 1 : 0, light = lightTarget;
    document.addEventListener("alc:theme", function (e) { lightTarget = e.detail === "light" ? 1 : 0; });

    var visible = true, running = false, start = performance.now(), last = 0;
    function frame(now) {
      if (!visible || document.hidden) { running = false; return; }
      running = true;
      // ~30 fps is plenty for slow liquid; saves GPU and battery.
      if (now - last > 32) {
        last = now;
        mouse.x += (target.x - mouse.x) * 0.04;
        mouse.y += (target.y - mouse.y) * 0.04;
        light += (lightTarget - light) * 0.06;
        gl.uniform2f(uR, canvas.width, canvas.height);
        gl.uniform1f(uT, reduce ? 20 : (now - start) / 1000);
        gl.uniform2f(uM, mouse.x, mouse.y);
        gl.uniform1f(uL, light);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (reduce) { running = false; return; }
      requestAnimationFrame(frame);
    }
    function kick() { if (!running) requestAnimationFrame(frame); }
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) kick(); }).observe(canvas);
    document.addEventListener("visibilitychange", kick);
    document.addEventListener("alc:theme", function () { if (reduce) requestAnimationFrame(frame); });
    requestAnimationFrame(function (t) { frame(t); canvas.classList.add("is-ready"); });
  }
  initShader();

  /* ---------- Themes stage: clone the hero mockup ---------- */
  var stage = document.querySelector("[data-theme-stage]");
  var heroApp = document.getElementById("app-mock");
  var themeApp = null;
  if (stage && heroApp) {
    themeApp = heroApp.cloneNode(true);
    themeApp.removeAttribute("id");
    themeApp.setAttribute("aria-label", "Alchemist editor shown in the selected theme");
    stage.appendChild(themeApp);
  }
  var swatches = Array.prototype.slice.call(document.querySelectorAll("[data-set-theme]"));
  var autoCycle = null, userPicked = false;
  function pickTheme(btn) {
    swatches.forEach(function (b) { var on = b === btn; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", on ? "true" : "false"); });
    if (themeApp) themeApp.setAttribute("data-app-theme", btn.getAttribute("data-set-theme"));
  }
  swatches.forEach(function (btn) {
    btn.addEventListener("click", function () { userPicked = true; clearInterval(autoCycle); pickTheme(btn); });
  });

  /* ---------- Compress playground ---------- */
  (function () {
    var range = document.getElementById("sq-range");
    if (!range) return;
    var out = document.getElementById("sq-out"), br = document.getElementById("sq-bitrate"), res = document.getElementById("sq-res"), ratio = document.getElementById("sq-ratio");
    var bar = document.querySelector(".sq__new");
    var presets = document.querySelectorAll("[data-size]");
    var SRC_MB = 1240, DURATION = 180, AUDIO_KBPS = 128;
    function update() {
      var mb = +range.value;
      var totalKbps = (mb * 8 * 1024) / DURATION;
      var vKbps = Math.max(totalKbps - AUDIO_KBPS, 40);
      var r = vKbps >= 4500 ? "1080p · 60" : vKbps >= 2200 ? "1080p · 30" : vKbps >= 900 ? "720p · 30" : vKbps >= 400 ? "480p · 30" : "360p · 24";
      out.textContent = mb + " MB";
      br.textContent = vKbps >= 1000 ? (vKbps / 1000).toFixed(2) + " Mbps" : Math.round(vKbps) + " kbps";
      res.textContent = r;
      ratio.textContent = (SRC_MB / mb).toFixed(SRC_MB / mb >= 10 ? 0 : 1) + "×";
      var pct = ((mb - range.min) / (range.max - range.min)) * 100;
      range.style.setProperty("--fill", pct + "%");
      bar.style.height = Math.max(3, (mb / SRC_MB) * 100) + "%";
      presets.forEach(function (p) { p.classList.toggle("is-on", +p.getAttribute("data-size") === mb); });
    }
    range.addEventListener("input", update);
    presets.forEach(function (p) {
      p.addEventListener("click", function () {
        var to = +p.getAttribute("data-size");
        if (gsap && !reduce) gsap.to(range, { value: to, duration: 0.8, ease: "expo.out", onUpdate: function () { range.value = Math.round(range.value); update(); } });
        else { range.value = to; update(); }
      });
    });
    update();
  })();

  /* ---------- Before / after compare ---------- */
  document.querySelectorAll("[data-compare]").forEach(function (el) {
    var dragging = false;
    function set(x) {
      var r = el.getBoundingClientRect();
      var p = Math.min(96, Math.max(4, ((x - r.left) / r.width) * 100));
      el.style.setProperty("--pos", p + "%");
    }
    el.addEventListener("pointerdown", function (e) { dragging = true; el.setPointerCapture(e.pointerId); set(e.clientX); el._touched = true; });
    el.addEventListener("pointermove", function (e) { if (dragging) set(e.clientX); });
    el.addEventListener("pointerup", function () { dragging = false; });
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", "Before and after comparison");
    el.setAttribute("aria-valuemin", "0"); el.setAttribute("aria-valuemax", "100"); el.setAttribute("aria-valuenow", "50");
    el.addEventListener("keydown", function (e) {
      var cur = parseFloat(getComputedStyle(el).getPropertyValue("--pos")) || 50;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); el._touched = true;
        cur = Math.min(96, Math.max(4, cur + (e.key === "ArrowRight" ? 5 : -5)));
        el.style.setProperty("--pos", cur + "%");
        el.setAttribute("aria-valuenow", Math.round(cur));
      }
    });
  });

  /* ---------- Scramble text ---------- */
  function scramble(el, to) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var from = el.textContent, len = Math.max(from.length, to.length), frame = 0, total = 18;
    (function tick() {
      var s = "";
      for (var i = 0; i < len; i++) {
        var settle = (i / len) * total * 0.6 + total * 0.4;
        s += frame >= settle ? to[i] || "" : chars[(Math.random() * chars.length) | 0];
      }
      el.textContent = s;
      if (frame++ < total) requestAnimationFrame(tick);
      else el.textContent = to;
    })();
  }
  if (!reduce) {
    document.querySelectorAll("[data-scramble]").forEach(function (el, idx) {
      var list = el.getAttribute("data-scramble").split(","), i = 0;
      setTimeout(function () {
        setInterval(function () {
          if (document.hidden || el.closest(".is-offscreen")) return;
          i = (i + 1) % list.length; scramble(el, list[i]);
        }, 2400);
      }, idx * 400);
    });
  }

  if (!gsap) return;

  ALC.ready.then(function () {
    /* ---------- Hero entrance ---------- */
    var lines = document.querySelectorAll(".hero__line");
    var heroTl = gsap.timeline({ defaults: { ease: "expo.out" }, delay: reduce ? 0 : 0.35 });
    if (!reduce) {
      lines.forEach(function (line) {
        var s = ALC.split(line, "chars");
        heroTl.from(s.chars, { yPercent: 115, rotate: 8, duration: 1.4, stagger: 0.022 }, line === lines[0] ? 0 : 0.12);
      });
      heroTl
        .from(".hero__chip", { y: 20, opacity: 0, duration: 1 }, 0.2)
        .from(".hero__lede", { y: 24, opacity: 0, duration: 1.2 }, 0.5)
        .from(".hero__cta > *", { y: 24, opacity: 0, duration: 1.2, stagger: 0.08 }, 0.62)
        .from(".hero__meta", { opacity: 0, duration: 1.2 }, 0.8)
        .from("#app-mock", { y: 120, rotateX: 28, opacity: 0, duration: 1.8 }, 0.5);
    }

    if (!ST) return;
    var mm = gsap.matchMedia();

    /* ---------- Hero: mockup settles as you scroll; text drifts ---------- */
    if (!reduce) {
      gsap.fromTo("#app-mock", { rotateX: 16, scale: 0.92 }, {
        rotateX: 0, scale: 1, ease: "none",
        scrollTrigger: { trigger: ".hero__stage", start: "top 95%", end: "top 25%", scrub: 1 },
      });
      gsap.to(".hero__inner", {
        yPercent: -18, opacity: 0.2, ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
      });
      gsap.to(".hero__canvas", {
        yPercent: 20, ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
      });
    }

    /* ---------- Marquee skews with scroll velocity ---------- */
    if (!reduce) {
      var skewTo = gsap.quickTo(".marquee__row", "skewX", { duration: 0.6, ease: "power3" });
      ST.create({
        trigger: ".marquee", start: "top bottom", end: "bottom top",
        onUpdate: function (self) { skewTo(gsap.utils.clamp(-12, 12, self.getVelocity() / -250)); },
      });
    }

    /* ---------- Horizontal pinned stages (desktop) ---------- */
    mm.add("(min-width: 900px) and (prefers-reduced-motion: no-preference)", function () {
      var track = document.querySelector(".transmute__track");
      var pin = document.querySelector(".transmute__pin");
      var dist = function () { return track.scrollWidth - window.innerWidth; };
      var tween = gsap.to(track, {
        x: function () { return -dist(); }, ease: "none",
        scrollTrigger: { trigger: pin, start: "top 12%", end: function () { return "+=" + dist(); }, pin: true, scrub: 1, invalidateOnRefresh: true, anticipatePin: 1 },
      });
      gsap.utils.toArray("[data-stage]").forEach(function (st) {
        gsap.from(st.querySelector(".viz"), {
          scale: 0.86, opacity: 0.3, ease: "none",
          scrollTrigger: { trigger: st, containerAnimation: tween, start: "left 95%", end: "left 45%", scrub: true },
        });
      });
      compressAnim(tween);
    });
    mm.add("(max-width: 899px), (prefers-reduced-motion: reduce)", function () {
      gsap.utils.toArray("[data-stage]").forEach(function (st) {
        gsap.from(st, { y: 60, opacity: 0, duration: 1.1, ease: "expo.out", scrollTrigger: { trigger: st, start: "top 88%", once: true } });
      });
      compressAnim(null);
    });

    function compressAnim(containerTween) {
      var el = document.querySelector("[data-count-from]");
      var stageEl = el && el.closest("[data-stage]");
      if (!el) return;
      var from = +el.getAttribute("data-count-from"), to = +el.getAttribute("data-count-to");
      var bar = stageEl.querySelector(".cp__bar i");
      var obj = { v: from };
      var tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1.6, yoyo: true });
      tl.to(obj, {
        v: to, duration: 2.4, ease: "expo.inOut",
        onUpdate: function () { el.textContent = obj.v >= 100 ? Math.round(obj.v).toLocaleString() : obj.v.toFixed(1); },
      }, 0).fromTo(bar, { scaleX: 1 }, { scaleX: to / from + 0.015, duration: 2.4, ease: "expo.inOut" }, 0);
      var opts = { trigger: stageEl, onToggle: function (s) { s.isActive ? tl.play() : tl.pause(); } };
      if (containerTween) { opts.containerAnimation = containerTween; opts.start = "left 80%"; opts.end = "right 10%"; }
      else { opts.start = "top 80%"; opts.end = "bottom 10%"; }
      ST.create(opts);
      if (reduce) { tl.progress(0.5).pause(); }
    }

    /* ---------- Enhance compare: auto sweep until touched ---------- */
    var cmp = document.querySelector("[data-compare]");
    if (cmp && !reduce) {
      var sweep = { p: 50 };
      var sweepTl = gsap.timeline({ repeat: -1, yoyo: true, paused: true })
        .to(sweep, { p: 22, duration: 1.8, ease: "sine.inOut", onUpdate: function () { if (!cmp._touched) cmp.style.setProperty("--pos", sweep.p + "%"); } })
        .to(sweep, { p: 78, duration: 3, ease: "sine.inOut", onUpdate: function () { if (!cmp._touched) cmp.style.setProperty("--pos", sweep.p + "%"); } });
      ST.create({ trigger: cmp, start: "top bottom", end: "bottom top", onToggle: function (s) { s.isActive && !cmp._touched ? sweepTl.play() : sweepTl.pause(); } });
    }

    /* ---------- Stat counters + bars ---------- */
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var to = +el.getAttribute("data-count"), o = { v: 0 };
      if (reduce) return;
      el.textContent = "0";
      gsap.to(o, {
        v: to, duration: 2, ease: "expo.out",
        onUpdate: function () { el.textContent = Math.round(o.v); },
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      });
    });
    gsap.utils.toArray(".stat__bar i").forEach(function (b) {
      gsap.from(b, { scaleX: 0, duration: 1.6, ease: "expo.out", scrollTrigger: { trigger: b, start: "top 92%", once: true } });
    });

    /* ---------- Memory chart draws in ---------- */
    (function () {
      var good = document.querySelector(".chart__good"), bad = document.querySelector(".chart__bad");
      if (!good || reduce) return;
      var len = good.getTotalLength();
      gsap.set(good, { strokeDasharray: len, strokeDashoffset: len });
      gsap.set(".chart__area", { opacity: 0 });
      gsap.set(".chart__dot", { scale: 0, transformOrigin: "center" });
      gsap.set(bad, { opacity: 0 });
      gsap.timeline({ scrollTrigger: { trigger: ".chart", start: "top 75%", once: true } })
        .to(bad, { opacity: 0.7, duration: 1 })
        .to(good, { strokeDashoffset: 0, duration: 2.4, ease: "power2.inOut" }, 0.2)
        .to(".chart__area", { opacity: 1, duration: 1.4 }, 1.2)
        .to(".chart__dot", { scale: 1, duration: 0.6, ease: "back.out(3)" }, 2.4);
    })();

    /* ---------- Themes: auto-cycle while in view, until the visitor picks ---------- */
    if (themeApp) {
      gsap.from(themeApp, { rotateY: -14, rotateX: 8, y: 60, opacity: 0, duration: 1.6, ease: "expo.out", scrollTrigger: { trigger: stage, start: "top 85%", once: true } });
      ST.create({
        trigger: stage, start: "top 70%", end: "bottom 20%",
        onToggle: function (s) {
          clearInterval(autoCycle);
          if (s.isActive && !userPicked && !reduce) {
            autoCycle = setInterval(function () {
              var i = swatches.findIndex(function (b) { return b.classList.contains("is-on"); });
              pickTheme(swatches[(i + 1) % swatches.length]);
            }, 2200);
          }
        },
      });
    }

    /* ---------- Privacy: words light up as you scroll ---------- */
    (function () {
      var p = document.querySelector("[data-scrub]");
      if (!p) return;
      var s = ALC.split(p, "words");
      if (reduce) { gsap.set(s.words, { opacity: 1 }); return; }
      gsap.to(s.words, {
        opacity: 1, stagger: 0.1, ease: "none",
        scrollTrigger: { trigger: p, start: "top 80%", end: "bottom 45%", scrub: true },
      });
    })();

    /* ---------- Update card sequence ---------- */
    (function () {
      var card = document.querySelector(".upd");
      if (!card) return;
      var items = card.querySelectorAll(".upd__checks li");
      var prog = card.querySelector(".upd__progress i");
      var tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 2.5 });
      tl.set(items, { className: "" })
        .fromTo(prog, { scaleX: 0 }, { scaleX: 1, duration: 2.2, ease: "power2.inOut" })
        .call(function () { items[0].className = "is-done"; }, null, 2.2)
        .call(function () { items[1].className = "is-done"; }, null, 2.7)
        .call(function () { items[2].className = "is-done"; }, null, 3.2)
        .call(function () { items[3].className = "is-wait"; }, null, 3.6)
        .to({}, { duration: 2 });
      if (reduce) { items.forEach(function (li, i) { li.className = i < 3 ? "is-done" : "is-wait"; }); gsap.set(prog, { scaleX: 1 }); return; }
      gsap.from(card, { y: 80, rotate: -4, opacity: 0, duration: 1.4, ease: "expo.out", scrollTrigger: { trigger: card, start: "top 85%", once: true } });
      ST.create({ trigger: card, start: "top 85%", end: "bottom top", onToggle: function (s) { s.isActive ? tl.play() : tl.pause(); } });
    })();

    /* ---------- Final word ---------- */
    if (!reduce) {
      gsap.fromTo("[data-final-word]", { yPercent: 40, scale: 0.85, opacity: 0, filter: "blur(20px)" }, {
        yPercent: 0, scale: 1, opacity: 1, filter: "blur(0px)", ease: "expo.out", duration: 1.8,
        scrollTrigger: { trigger: ".final", start: "top 70%", once: true },
      });
      gsap.fromTo(".final__glow", { scale: 0.6, opacity: 0 }, {
        scale: 1.1, opacity: 1, ease: "none",
        scrollTrigger: { trigger: ".final", start: "top bottom", end: "bottom bottom", scrub: true },
      });
    }

    ST.refresh();
  });
})();
