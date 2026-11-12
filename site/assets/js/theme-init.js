/* Runs synchronously in <head> so the page never flashes the wrong theme
   and the entry curtain is already closed before first paint. */
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem("alc-theme"); } catch (e) {}
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  root.classList.add("js");
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("is-entering");
    // Safety net: never leave the page covered if a script fails to load.
    setTimeout(function () { root.classList.remove("is-entering"); }, 3000);
  }
})();
