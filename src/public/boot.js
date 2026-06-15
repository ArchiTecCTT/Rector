/**
 * No-flash theme boot (design A3, Req 3.2). Inline, no external fetch:
 * reads the persisted appearance from localStorage and applies data-theme +
 * override custom properties on <html> BEFORE first paint. Never throws on
 * unreadable/missing storage (Req 3.5) — it falls back to the Halo default
 * and the theme's own tokens. Kept tiny and self-contained; the constants
 * mirror theme.js (which cannot be imported here without an external fetch).
 */
(function () {
  var KEY = "rector.appearance";
  var DEFAULT_THEME = "halo";
  var THEMES = ["halo", "aether", "cairn", "penumbra", "vellum"];
  var DENSITY = { comfortable: "1", compact: "0.85" };
  var FONT = { small: "0.9", default: "1", large: "1.15" };
  var el = document.documentElement;
  var pref = {};
  try {
    var raw = window.localStorage.getItem(KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") pref = parsed;
    }
  } catch (e) {
    pref = {};
  }
  var theme = THEMES.indexOf(pref.theme) !== -1 ? pref.theme : DEFAULT_THEME;
  el.setAttribute("data-theme", theme);
  // Lazy single-theme stylesheet: point the one theme <link> at the
  // active theme before first paint so only its tokens/fonts load.
  try {
    var link = document.getElementById("theme-stylesheet");
    if (link) {
      var href = "styles/themes/" + theme + ".css";
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    }
  } catch (e) {}
  // Per-theme accent override (Req 3.5).
  try {
    var accents = pref.accents && typeof pref.accents === "object" ? pref.accents : {};
    var accent = accents[theme];
    if (typeof accent === "string" && accent) el.style.setProperty("--accent", accent);
  } catch (e) {}
  // Density / font-scale / reduced-motion overrides (Req 3.4, 3.6, 3.7).
  if (DENSITY[pref.density]) el.style.setProperty("--density-scale", DENSITY[pref.density]);
  if (FONT[pref.fontScale]) el.style.setProperty("--font-scale", FONT[pref.fontScale]);
  if (pref.reducedMotion === true) el.setAttribute("data-reduced-motion", "true");
})();
