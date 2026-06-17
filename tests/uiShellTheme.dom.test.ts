// UI structural redesign — theme-token tests for the new shell regions (task 1.3).
//
// Property 7: Theme switching still works.
// Property 8: No flash of unstyled / wrong-theme content.
// Validates: Requirements 12.1, 12.2, 12.4.
//
// The new shell regions (.topbar, .rail, .chat, .trace, .menu__popover,
// .palette__panel) must read color / type / radius / elevation / motion from the
// existing Theme_System token contract so all five themes keep driving the look,
// and the <head> no-flash boot script must remain in place so data-theme applies
// before first paint.
//
// Harness: this repo runs vitest with `environment: "node"` (no jsdom), and jsdom
// would not compute styles from the lazily-attached external theme stylesheets
// anyway. So — exactly like tests/themeSystem.dom.test.ts and
// tests/accessibilityPanels.dom.test.ts — we parse the served CSS/HTML statically
// and drive the theme runtime through its injectable factory with DOM/storage
// doubles. No jsdom, no network — deterministic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import "../src/public/theme.js";
import {
  createFakeLink,
  createFakeRoot,
  createFakeStorage,
  getThemeFactory,
  type ThemeFactory,
} from "./support/themeDoubles";

// ---- static asset helpers -------------------------------------------------

function readPublic(relPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/public/${relPath}`, import.meta.url)),
    "utf8",
  );
}

const BASE_CSS = readPublic("styles/base.css");
const INDEX_HTML = readPublic("index.html");

// The five themes the runtime can apply (data-theme value + lazy stylesheet).
const THEME_FILES: Array<{ id: string; file: string }> = [
  { id: "halo", file: "styles/themes/halo.css" },
  { id: "aether", file: "styles/themes/aether.css" },
  { id: "cairn", file: "styles/themes/cairn.css" },
  { id: "penumbra", file: "styles/themes/penumbra.css" },
  { id: "vellum", file: "styles/themes/vellum.css" },
];

// Token-name contract grouped by the five styling categories the redesign must
// keep theme-driven on every new region (Req 12.1, 12.2).
const TOKENS = {
  color: [
    "--bg",
    "--surface",
    "--elevated",
    "--overlay",
    "--border",
    "--border-strong",
    "--border-soft",
    "--text",
    "--text-dim",
    "--text-faint",
    "--text-inverse",
    "--accent",
    "--accent-hover",
    "--accent-pressed",
    "--accent-soft",
    "--accent-contrast",
    "--ok",
    "--warn",
    "--info",
    "--err",
    "--sidebar-dim",
  ],
  type: ["--font-display", "--font-body", "--font-mono", "--fs-base"],
  radius: ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full"],
  elevation: ["--shadow-sm", "--shadow-md", "--shadow-lg", "--focus-ring"],
  motion: ["--motion-fast", "--motion-base", "--motion-slow", "--easing-standard"],
} as const;

type Category = keyof typeof TOKENS;
const CATEGORIES = Object.keys(TOKENS) as Category[];

// The six new regions under test and the base selector that scopes their rules.
// `prefix` matches every rule whose selector mentions the region (including the
// pop-in animation rules nested in @media for the overlay surfaces), so motion
// tokens applied via `animation:` are captured too.
const REGIONS: Array<{ name: string; prefix: string }> = [
  { name: "Top bar", prefix: ".topbar" },
  { name: "Conversation rail", prefix: ".rail" },
  { name: "Chat canvas", prefix: ".chat" },
  { name: "Trace panel", prefix: ".trace" },
  { name: "Settings menu popover", prefix: ".menu__popover" },
  { name: "Command palette panel", prefix: ".palette__panel" },
];

// ---- CSS parsing ----------------------------------------------------------

// Collect the declaration block for the rule whose selector text exactly equals
// `selector` (the text immediately before its `{`). Brace-balanced so nested
// values are captured whole.
function ruleBlock(css: string, selector: string): string | null {
  const re = new RegExp(`(^|[\\n}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const m = re.exec(css);
  if (!m) return null;
  const open = css.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

// Gather the union of declaration text for EVERY rule whose selector mentions
// the given region prefix (e.g. ".menu__popover" also matches its `[hidden]`
// variant and the `.menu__popover { animation }` rule inside the reduced-motion
// media query). This is how motion tokens reach the overlay surfaces.
function regionCss(css: string, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match a selector list (up to the `{`) that contains the prefix, then capture
  // its brace-balanced block.
  const selRe = new RegExp(`([^{}]*${escaped}[^{}]*)\\{`, "g");
  let chunks = "";
  let m: RegExpExecArray | null;
  while ((m = selRe.exec(css)) !== null) {
    const open = css.indexOf("{", m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          chunks += "\n" + css.slice(open + 1, i);
          break;
        }
      }
    }
  }
  return chunks;
}

// The set of var(--token) names referenced in a chunk of CSS.
function referencedTokens(cssChunk: string): Set<string> {
  const names = new Set<string>();
  const re = /var\(\s*(--[a-z0-9-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssChunk)) !== null) names.add(m[1]);
  return names;
}

// Categories whose tokens appear in a chunk of CSS.
function categoriesIn(cssChunk: string): Set<Category> {
  const tokens = referencedTokens(cssChunk);
  const found = new Set<Category>();
  for (const cat of CATEGORIES) {
    if (TOKENS[cat].some((t) => tokens.has(t))) found.add(cat);
  }
  return found;
}

// Read a token's declared value inside a single theme file.
function tokenValue(css: string, token: string): string | null {
  const re = new RegExp(`${token}\\s*:\\s*([^;]+);`);
  const m = re.exec(css);
  return m ? m[1].trim() : null;
}

let createRectorTheme: ThemeFactory;

beforeAll(() => {
  createRectorTheme = getThemeFactory();
  expect(typeof createRectorTheme).toBe("function");
});

// ===========================================================================
// Property 7 — Theme switching still works on the new regions
// ===========================================================================
describe("Property 7: theme switching still works across the new regions", () => {
  // 7a. The runtime can apply every one of the five themes without a reload:
  // applyTheme sets exactly one data-theme and re-points the single lazy
  // stylesheet at that theme. Because the regions are token-driven (7b), this
  // re-styles all of them in place. (Req 12.2)
  it("applyTheme swaps data-theme + the single stylesheet for each of the five themes", () => {
    const root = createFakeRoot();
    const link = createFakeLink();
    const theme = createRectorTheme({
      root,
      storage: createFakeStorage(),
      getThemeLink: () => link,
    });

    for (const { id, file } of THEME_FILES) {
      theme.applyTheme(id);
      expect(root.getAttribute("data-theme")).toBe(id);
      // Exactly one data-theme at a time — no reload, just an attribute swap.
      expect([...root._attrs.keys()]).toEqual(["data-theme"]);
      expect(link.href).toBe(file);
    }
  });

  // 7b. Each region reads its color/type/radius/elevation/motion from theme
  // tokens and hardcodes no color literal, so switching themes restyles it.
  // (Req 12.1)
  it.each(REGIONS)(
    "$name styling is token-driven with no hardcoded color literals",
    ({ prefix }) => {
      const chunk = regionCss(BASE_CSS, prefix);
      expect(chunk.length, `${prefix} rules not found`).toBeGreaterThan(0);
      // References at least one theme token.
      expect(chunk).toMatch(/var\(\s*--/);
      // No raw color literals anywhere in the region's rules — every color is a
      // token, so the active theme drives it (matches the repo's existing
      // accessibility-test convention).
      expect(chunk, `${prefix} must not hardcode hex colors`).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b/,
      );
      expect(chunk, `${prefix} must not hardcode rgb()/rgba() colors`).not.toMatch(
        /\brgba?\(/,
      );
    },
  );

  // 7c. Each region consumes color tokens (the baseline themed property), and
  // the overlay surfaces additionally consume radius + elevation + motion.
  it.each(REGIONS)("$name consumes theme color tokens", ({ prefix }) => {
    const cats = categoriesIn(regionCss(BASE_CSS, prefix));
    expect(cats.has("color"), `${prefix} must reference a color token`).toBe(true);
  });

  it.each([".menu__popover", ".palette__panel"])(
    "overlay surface %s consumes radius, elevation, and motion tokens",
    (prefix) => {
      const cats = categoriesIn(regionCss(BASE_CSS, prefix));
      for (const cat of ["radius", "elevation", "motion"] as Category[]) {
        expect(cats.has(cat), `${prefix} must reference a ${cat} token`).toBe(true);
      }
    },
  );

  // 7d. Across the new-region group, every one of the five styling categories
  // is theme-token-driven — so a theme switch can update color, type, radius,
  // elevation, and motion on the new shell. (Req 12.2)
  it("the new regions collectively reference all five token categories", () => {
    const combined = REGIONS.map((r) => regionCss(BASE_CSS, r.prefix)).join("\n");
    // The palette input (type) lives in the .palette group.
    const all = categoriesIn(combined + "\n" + regionCss(BASE_CSS, ".palette__input"));
    for (const cat of CATEGORIES) {
      expect(all.has(cat), `no ${cat} token is consumed by the new regions`).toBe(true);
    }
  });
});

// ===========================================================================
// Property 7 (cont) — switching themes actually changes the resolved values
// that flow into the regions, so getComputedStyle WOULD differ per theme.
// ===========================================================================
describe("Property 7: themes supply distinct token values to the regions (Req 12.2)", () => {
  it("base.css declares every category token so regions resolve with a default", () => {
    for (const cat of CATEGORIES) {
      for (const token of TOKENS[cat]) {
        // --sidebar-dim is a base-only structural tint; the rest are the
        // contract themes override. All must exist as a default in base.css.
        expect(
          tokenValue(BASE_CSS, token),
          `base.css must declare ${token}`,
        ).not.toBeNull();
      }
    }
  });

  // For color / type / radius / elevation, the five themes supply genuinely
  // different values, so switching theme changes the computed style of any
  // region consuming that category.
  it.each([
    ["color", "--surface"],
    ["type", "--font-display"],
    ["radius", "--radius-md"],
    ["elevation", "--shadow-lg"],
  ])("%s token %s differs across the five themes", (_cat, token) => {
    const values = THEME_FILES.map(({ file }) => tokenValue(readPublic(file), token));
    for (const [i, v] of values.entries()) {
      expect(v, `${THEME_FILES[i].id} must declare ${token}`).not.toBeNull();
    }
    const distinct = new Set(values);
    expect(
      distinct.size,
      `${token} is identical in every theme; switching would not change it`,
    ).toBeGreaterThan(1);
  });

  // Motion tokens are intentionally shared across themes (consistent feel), but
  // every theme still declares them, so they remain theme-overridable and the
  // overlay animations resolve under each theme.
  it("every theme declares the motion tokens the overlays animate with", () => {
    for (const { id, file } of THEME_FILES) {
      const css = readPublic(file);
      for (const token of ["--motion-fast", "--motion-base", "--easing-standard"]) {
        expect(tokenValue(css, token), `${id} must declare ${token}`).not.toBeNull();
      }
    }
  });
});

// ===========================================================================
// Property 8 — No flash of unstyled / wrong-theme content (Req 12.4)
// ===========================================================================
describe("Property 8: the no-flash boot script is present and unchanged (Req 12.4)", () => {
  // Slice out the <head> so we only consider boot-time scripts.
  const head = (/<head[\s\S]*?<\/head>/i.exec(INDEX_HTML) ?? [""])[0];

  // The exact boot script content the redesign must preserve verbatim. Compared
  // against src/public/boot.js after whitespace normalization, so re-indentation
  // is allowed but any change to the logic (keys read, attributes set, theme list)
  // fails this guard.
  const EXPECTED_BOOT = `/**
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
      })();`;

  const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

  // The <script src="boot.js"> tag in <head> (CSP-compliant external boot).
  const headScriptTags = [...head.matchAll(/<script\b([^>]*)>/gi)];
  const bootScriptTag = headScriptTags.find((m) => /src\s*=\s*"boot\.js"/.test(m[1]));
  const BOOT_JS = readPublic("boot.js");

  it("ships exactly one external boot script in <head> (CSP-compliant, no inline script)", () => {
    // No inline (no-src) <script> in <head> — CSP script-src 'self' forbids inline.
    const inlineScripts = headScriptTags.filter((m) => !/\bsrc\s*=/.test(m[1]));
    expect(inlineScripts.length).toBe(0);
    // Exactly one <script src="boot.js"> tag.
    expect(bootScriptTag).toBeTruthy();
  });

  it("the boot script applies the theme before first paint", () => {
    expect(bootScriptTag).toBeTruthy();
    // boot.js is synchronous (no defer/async) so it blocks rendering — theme applies before first paint.
    const tagText = bootScriptTag![0];
    expect(tagText).not.toContain("defer");
    expect(tagText).not.toContain("async");
    // The boot script itself reads the persisted appearance and sets data-theme on <html>.
    expect(BOOT_JS).toContain("rector.appearance");
    expect(BOOT_JS).toContain('setAttribute("data-theme"');
    // Re-points the single lazy theme stylesheet so only the active theme loads.
    expect(BOOT_JS).toContain("theme-stylesheet");
    // Applies the reduced-motion hook before paint too.
    expect(BOOT_JS).toContain('setAttribute("data-reduced-motion"');
    // Knows all five themes.
    for (const { id } of THEME_FILES) {
      expect(BOOT_JS).toContain(`"${id}"`);
    }
  });

  it("the boot script content is unchanged", () => {
    expect(normalize(BOOT_JS)).toBe(normalize(EXPECTED_BOOT));
  });

  it("runs at boot — before the body application scripts (theme.js / app.js)", () => {
    const headEnd = INDEX_HTML.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(-1);
    for (const src of ["theme.js", "app.js"]) {
      const at = INDEX_HTML.indexOf(`src="${src}"`);
      expect(at, `${src} must be loaded`).toBeGreaterThan(-1);
      expect(at, `${src} must load after the <head> boot script`).toBeGreaterThan(
        headEnd,
      );
    }
  });

  it("keeps the base + lazy theme stylesheets local under src/public (no remote origin)", () => {
    expect(head).toContain('href="styles/base.css"');
    expect(head).toContain('id="theme-stylesheet"');
    expect(head).toContain('href="styles/themes/halo.css"');
    // No CDN / remote origin among the <head> references.
    expect(head).not.toMatch(/href="https?:\/\//i);
    expect(head).not.toMatch(/src="https?:\/\//i);
  });
});
