// ============================================================
// Rector — Theme_System runtime (design A3 + A5)
// ------------------------------------------------------------
// Plain script (no build step, no modules, no remote origins) that
// matches app.js's <script src> loading style. It is the runtime
// counterpart to the inline no-flash boot script in index.html:
// the boot script applies the persisted appearance BEFORE first
// paint (Req 3.2); this file exposes the runtime API used by the
// Appearance_Settings panel (task 9.2) and the DOM tests (task 9.3)
// to CHANGE and PERSIST those choices.
//
// Exposure (documented for later tasks):
//   * window.RectorTheme   — a singleton bound to the real document +
//                            localStorage, auto-created in the browser.
//                            Call window.RectorTheme.applyTheme("aether"),
//                            .setAccent("#5b6bff"), .setDensity("compact"),
//                            .setFontScale("large"), .setReducedMotion(true),
//                            .resetCustomizations(), etc.
//   * window.createRectorTheme(options) — factory for dependency-injected
//                            instances. Tests pass { root, storage,
//                            getThemeLink } doubles so the runtime can be
//                            exercised without a real browser. Also exported
//                            via module.exports for Node-based tests.
//
// Persistence model (design A5, localStorage key "rector.appearance"):
//   { theme, accents: { <theme>: <accent> }, density, fontScale, reducedMotion }
// `accents` is a per-theme map so an accent override is persisted PER THEME
// (Req 3.5). No secret is ever written here (Req 3.3, 11.5).
// ============================================================

(function (global) {
  "use strict";

  // Constants mirror the inline boot script in index.html. Keep them in sync.
  var STORAGE_KEY = "rector.appearance";
  var DEFAULT_THEME = "halo";
  var THEMES = ["halo", "aether", "cairn", "penumbra", "vellum"];

  // Density set (design A5): comfortable = 1.0, compact = 0.85.
  var DENSITIES = { comfortable: 1, compact: 0.85 };
  // Font-size scale set (design A5): small / default / large.
  var FONT_SCALES = { small: 0.9, default: 1, large: 1.15 };

  var DEFAULT_DENSITY = "comfortable";
  var DEFAULT_FONT_SCALE = "default";

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * Create a Theme_System runtime bound to a root element + storage.
   * All dependencies are injectable so the runtime is unit-testable without a
   * real browser (task 9.3).
   *
   * @param {object} [options]
   * @param {HTMLElement} [options.root]  element carrying data-theme + inline
   *   override props (defaults to document.documentElement).
   * @param {Storage|null} [options.storage]  localStorage-like store (defaults
   *   to window.localStorage; null disables persistence).
   * @param {function} [options.getThemeLink]  returns the <link> whose href is
   *   swapped for lazy per-theme attachment (defaults to #theme-stylesheet).
   * @param {string} [options.themeHrefBase]  href prefix for theme files.
   */
  function createRectorTheme(options) {
    options = options || {};

    var root =
      options.root ||
      (typeof document !== "undefined" ? document.documentElement : null);

    var storage = options.storage;
    if (storage === undefined) {
      try {
        storage =
          typeof window !== "undefined" && window.localStorage
            ? window.localStorage
            : null;
      } catch (e) {
        // Accessing localStorage can throw (e.g. disabled cookies). Treat as
        // unavailable; the UI still works with in-memory defaults (Req 3.5).
        storage = null;
      }
    }

    var themeHrefBase = options.themeHrefBase || "styles/themes/";

    var getThemeLink =
      options.getThemeLink ||
      function () {
        if (typeof document === "undefined") return null;
        return document.getElementById("theme-stylesheet");
      };

    // ---------- storage helpers (fail-soft, never throw — Req 3.5/3.10) ----------

    function safeRead() {
      if (!storage) return {};
      try {
        var raw = storage.getItem(STORAGE_KEY);
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    function safeWrite(pref) {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(pref));
      } catch (e) {
        /* best-effort persistence; never throw */
      }
    }

    // ---------- DOM helpers (no-op when no root, e.g. SSR/early tests) ----------

    function setProp(name, value) {
      if (root && root.style) root.style.setProperty(name, value);
    }
    function removeProp(name) {
      if (root && root.style) root.style.removeProperty(name);
    }
    function setAttr(name, value) {
      if (root && root.setAttribute) root.setAttribute(name, value);
    }
    function removeAttr(name) {
      if (root && root.removeAttribute) root.removeAttribute(name);
    }

    function normalizeTheme(name) {
      return THEMES.indexOf(name) !== -1 ? name : DEFAULT_THEME;
    }

    function currentTheme() {
      if (root && root.getAttribute) {
        var attr = root.getAttribute("data-theme");
        if (THEMES.indexOf(attr) !== -1) return attr;
      }
      return normalizeTheme(safeRead().theme);
    }

    // Lazy per-theme attachment (Req 4.3, 4.4): only the active theme's
    // stylesheet — and therefore its fonts — is attached. Switching is a pure
    // href swap on a single <link>, well within the 200ms budget.
    function attachThemeStylesheet(name) {
      var link = getThemeLink();
      if (!link) return;
      var href = themeHrefBase + name + ".css";
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    }

    function applyAccentForTheme(name, pref) {
      pref = pref || safeRead();
      var accents =
        pref.accents && typeof pref.accents === "object" ? pref.accents : {};
      var accent = accents[name];
      if (typeof accent === "string" && accent) {
        setProp("--accent", accent);
      } else {
        // No override for this theme -> revert to the theme's own token (Req 3.8).
        removeProp("--accent");
      }
    }

    // ---------- public API ----------

    // Apply a theme as the single Active_Theme (Req 1.3, 1.5) and persist it
    // (Req 3.1). Unknown names fall back to the default (Req 1.6/3.10).
    function applyTheme(name) {
      var theme = normalizeTheme(name);
      setAttr("data-theme", theme); // exactly one data-theme at a time (Req 1.5)
      attachThemeStylesheet(theme); // lazy load (Req 4.3/4.4)
      var pref = safeRead();
      pref.theme = theme;
      safeWrite(pref);
      // Re-apply this theme's own persisted accent override (accents are
      // per-theme), so switching themes preserves customizations (Property 5).
      applyAccentForTheme(theme, pref);
      return theme;
    }

    // Override the active theme's accent at runtime and persist it PER THEME
    // (Req 3.5). Passing an empty value clears the override (Req 3.8).
    function setAccent(value) {
      var theme = currentTheme();
      var pref = safeRead();
      var accents =
        pref.accents && typeof pref.accents === "object" ? pref.accents : {};
      if (value === null || value === undefined || value === "") {
        delete accents[theme];
        removeProp("--accent");
      } else {
        accents[theme] = String(value);
        setProp("--accent", String(value));
      }
      pref.accents = accents;
      safeWrite(pref);
      return value === "" || value == null ? null : String(value);
    }

    // Select an interface density and persist it (Req 3.6).
    function setDensity(value) {
      if (!hasOwn(DENSITIES, value)) value = DEFAULT_DENSITY;
      setProp("--density-scale", String(DENSITIES[value]));
      var pref = safeRead();
      pref.density = value;
      safeWrite(pref);
      return value;
    }

    // Select an interface font-size scale and persist it (Req 3.7).
    function setFontScale(value) {
      if (!hasOwn(FONT_SCALES, value)) value = DEFAULT_FONT_SCALE;
      setProp("--font-scale", String(FONT_SCALES[value]));
      var pref = safeRead();
      pref.fontScale = value;
      safeWrite(pref);
      return value;
    }

    // Toggle Reduced_Motion and persist it (Req 3.4). The attribute hook is
    // honored by base.css to disable non-essential animation (Req 9.2).
    function setReducedMotion(on) {
      var bool = !!on;
      if (bool) setAttr("data-reduced-motion", "true");
      else removeAttr("data-reduced-motion");
      var pref = safeRead();
      pref.reducedMotion = bool;
      safeWrite(pref);
      return bool;
    }

    // Clear all customization overrides, reverting each property to the active
    // theme's defined token value (Req 3.8) while keeping the selected theme.
    function resetCustomizations() {
      removeProp("--accent");
      removeProp("--density-scale");
      removeProp("--font-scale");
      removeAttr("data-reduced-motion");
      var theme = normalizeTheme(safeRead().theme);
      safeWrite({ theme: theme });
      return theme;
    }

    // Read the normalized persisted appearance (for the panel to reflect state).
    function getAppearance() {
      var pref = safeRead();
      return {
        theme: normalizeTheme(pref.theme),
        accents:
          pref.accents && typeof pref.accents === "object"
            ? pref.accents
            : {},
        density: hasOwn(DENSITIES, pref.density) ? pref.density : null,
        fontScale: hasOwn(FONT_SCALES, pref.fontScale) ? pref.fontScale : null,
        reducedMotion: pref.reducedMotion === true,
      };
    }

    // Re-apply the full persisted appearance to the DOM. The inline boot script
    // already does this before paint; hydrate() lets the runtime (or a test)
    // reconcile DOM state with storage at any time. Idempotent.
    function hydrate() {
      var pref = safeRead();
      var theme = normalizeTheme(pref.theme);
      setAttr("data-theme", theme);
      attachThemeStylesheet(theme);
      applyAccentForTheme(theme, pref);
      if (hasOwn(DENSITIES, pref.density))
        setProp("--density-scale", String(DENSITIES[pref.density]));
      if (hasOwn(FONT_SCALES, pref.fontScale))
        setProp("--font-scale", String(FONT_SCALES[pref.fontScale]));
      if (pref.reducedMotion === true) setAttr("data-reduced-motion", "true");
      return theme;
    }

    return {
      // constants (read-only copies) for the panel + tests
      STORAGE_KEY: STORAGE_KEY,
      DEFAULT_THEME: DEFAULT_THEME,
      THEMES: THEMES.slice(),
      DENSITIES: Object.assign({}, DENSITIES),
      FONT_SCALES: Object.assign({}, FONT_SCALES),
      // runtime API
      applyTheme: applyTheme,
      setAccent: setAccent,
      setDensity: setDensity,
      setFontScale: setFontScale,
      setReducedMotion: setReducedMotion,
      resetCustomizations: resetCustomizations,
      getAppearance: getAppearance,
      currentTheme: currentTheme,
      hydrate: hydrate,
    };
  }

  // Factory for dependency-injected instances (task 9.3 DOM tests).
  global.createRectorTheme = createRectorTheme;

  // Browser singleton bound to the real document + localStorage so the
  // Appearance_Settings panel (task 9.2) and app.js can call it directly.
  if (typeof document !== "undefined") {
    global.RectorTheme = createRectorTheme();
  }

  // CommonJS export for Node-based tests, if used.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createRectorTheme: createRectorTheme };
  }
})(
  typeof window !== "undefined"
    ? window
    : typeof globalThis !== "undefined"
      ? globalThis
      : this,
);
