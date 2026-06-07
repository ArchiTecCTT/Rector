// Theme_System tests (DOM) — task 9.3.
//
// Covers the slices the task calls out that the task-9.1 unit test
// (tests/theme.unit.test.ts) does not already exercise, reusing the same
// dependency-injection doubles (tests/support/themeDoubles.ts):
//
//   - Token-contract presence per theme: every styles/themes/*.css file declares
//     the full token-name contract from base.css (design A1).            (Req 1.5)
//   - apply/override functions set the correct attributes/props: applyTheme sets
//     exactly one data-theme; setAccent/setDensity/setFontScale set the right
//     inline custom props; setReducedMotion sets the attribute.   (Req 3.2, 3.5)
//   - Persistence round-trip + fallback on unreadable/corrupt prefs.    (Req 3.5)
//   - Reduced-motion disables non-essential animation: the
//     :root[data-reduced-motion="true"] rule in base.css zeroes/!important-
//     disables transitions + animations.                                (Req 9.2)
//   - Switching theme preserves customizations (Property 5): density/font-scale/
//     reduced-motion persist across applyTheme, per-theme accent reapplies, and
//     switching never rewrites a theme file's own token block.     (Req 3.9, 1.5)
//
// theme.js is a plain browser script; we import it for its side-effect (it
// assigns globalThis.createRectorTheme) and drive the injectable factory with
// DOM/storage doubles. CSS contract checks parse the static files directly.
// No jsdom, no network — deterministic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import "../src/public/theme.js";
import {
  createFakeLink,
  createFakeRoot,
  createFakeStorage,
  getThemeFactory,
  type FakeLink,
  type FakeRoot,
  type FakeStorage,
  type ThemeApi,
  type ThemeFactory,
} from "./support/themeDoubles";

// ---- static asset helpers -------------------------------------------------

function readPublic(relPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/public/${relPath}`, import.meta.url)),
    "utf8",
  );
}

// The token-name CONTRACT every theme must define (design A1, declared in
// styles/base.css). Theme-specific extras like --accent-gradient / --font-serif
// / --user-bubble / --cta are intentionally NOT part of the required contract.
const TOKEN_CONTRACT: string[] = [
  // color tiers
  "--bg",
  "--surface",
  "--elevated",
  "--overlay",
  // borders
  "--border",
  "--border-strong",
  "--border-soft",
  // foreground
  "--text",
  "--text-dim",
  "--text-faint",
  "--text-inverse",
  // accent
  "--accent",
  "--accent-hover",
  "--accent-pressed",
  "--accent-soft",
  // signal
  "--ok",
  "--warn",
  "--info",
  "--err",
  "--ok-soft",
  "--warn-soft",
  "--info-soft",
  "--err-soft",
  // type
  "--font-display",
  "--font-body",
  "--font-mono",
  "--fs-base",
  // geometry
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius-full",
  // space
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--space-10",
  "--space-12",
  "--space-16",
  "--space-20",
  // elevation
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--focus-ring",
  // motion
  "--motion-fast",
  "--motion-base",
  "--motion-slow",
  "--easing-standard",
];

// theme name -> stylesheet file under styles/themes/. The id is the data-theme
// value the runtime applies; the file is the lazily-attached stylesheet.
const THEME_FILES: Array<{ id: string; file: string }> = [
  { id: "halo", file: "styles/themes/halo.css" },
  { id: "aether", file: "styles/themes/aether.css" },
  { id: "cairn", file: "styles/themes/cairn.css" },
  { id: "penumbra", file: "styles/themes/penumbra.css" },
  { id: "vellum", file: "styles/themes/vellum.css" },
];

// Extract the declared custom-property names inside a theme's scoped block.
function declaredTokens(css: string): Set<string> {
  const names = new Set<string>();
  const re = /(--[a-z0-9-]+)\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) names.add(match[1]);
  return names;
}

let createRectorTheme: ThemeFactory;

beforeAll(() => {
  createRectorTheme = getThemeFactory();
  expect(typeof createRectorTheme).toBe("function");
});

// ===========================================================================
// 1. Token-contract presence per theme (Req 1.5)
// ===========================================================================
describe("Theme token contract (styles/themes/*.css)", () => {
  it("base.css declares the full token contract with default values", () => {
    const declared = declaredTokens(readPublic("styles/base.css"));
    for (const token of TOKEN_CONTRACT) {
      expect(declared.has(token), `base.css must declare ${token}`).toBe(true);
    }
  });

  it.each(THEME_FILES)(
    "$id defines every contract token, scoped to its own data-theme block",
    ({ id, file }) => {
      const css = readPublic(file);

      // The theme set is scoped to :root[data-theme="<id>"] (design A3), which is
      // how applyTheme selects it. The actual rule must use a selector that opens
      // a declaration block (distinct from any mention in the file's comment).
      const scopedRule = new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{`, "g");
      expect((css.match(scopedRule) ?? []).length).toBe(1);

      const declared = declaredTokens(css);
      const missing = TOKEN_CONTRACT.filter((t) => !declared.has(t));
      expect(missing, `${id} is missing tokens: ${missing.join(", ")}`).toEqual(
        [],
      );
    },
  );

  it("every theme defines the identical contract (no theme drifts from the set)", () => {
    for (const { id, file } of THEME_FILES) {
      const declared = declaredTokens(readPublic(file));
      const present = TOKEN_CONTRACT.filter((t) => declared.has(t));
      expect(present.length, `${id} token-contract coverage`).toBe(
        TOKEN_CONTRACT.length,
      );
    }
  });
});

// ===========================================================================
// 2. Reduced-motion disables non-essential animation (Req 9.2)
// ===========================================================================
describe("Reduced-motion hook (styles/base.css)", () => {
  // Capture the declaration block of the :root[data-reduced-motion="true"] rule.
  function reducedMotionBlock(): string {
    const css = readPublic("styles/base.css");
    const idx = css.indexOf('[data-reduced-motion="true"]');
    expect(idx, "base.css must define a :root[data-reduced-motion] rule").toBeGreaterThan(
      -1,
    );
    const open = css.indexOf("{", idx);
    const close = css.indexOf("}", open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return css.slice(open + 1, close);
  }

  it("targets the runtime attribute set by setReducedMotion(true)", () => {
    const css = readPublic("styles/base.css");
    expect(css).toContain(':root[data-reduced-motion="true"]');
  });

  it("zeroes/!important-disables transitions and animations", () => {
    const block = reducedMotionBlock();
    // Animations are collapsed to a single near-zero-duration run.
    expect(block).toMatch(/animation-duration:\s*0\.0*1m?s\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.0*1m?s\s*!important/);
    // The override must be forced so it wins over per-component animation rules.
    expect(block).toContain("!important");
  });
});

// ===========================================================================
// 3. apply/override functions set the correct attributes/props (Req 3.2, 3.5)
// ===========================================================================
describe("Theme runtime attribute/prop wiring", () => {
  let root: FakeRoot;
  let storage: FakeStorage;
  let link: FakeLink;
  let theme: ThemeApi;

  beforeEach(() => {
    root = createFakeRoot();
    storage = createFakeStorage();
    link = createFakeLink();
    theme = createRectorTheme({ root, storage, getThemeLink: () => link });
  });

  it("applyTheme sets exactly one data-theme and swaps the single stylesheet", () => {
    theme.applyTheme("aether");
    expect(root.getAttribute("data-theme")).toBe("aether");
    // Exactly one data-theme attribute exists at a time (Req 1.5): the fake root
    // is a flat attribute map, so a second applyTheme replaces rather than adds.
    expect([...root._attrs.keys()]).toEqual(["data-theme"]);
    expect(link.href).toBe("styles/themes/aether.css");

    theme.applyTheme("penumbra");
    expect(root.getAttribute("data-theme")).toBe("penumbra");
    expect([...root._attrs.keys()]).toEqual(["data-theme"]);
    expect(link.href).toBe("styles/themes/penumbra.css");
  });

  it("setAccent writes the exact --accent inline prop and clears it on empty", () => {
    theme.setAccent("#1a2b3c");
    expect(root._props.get("--accent")).toBe("#1a2b3c");
    theme.setAccent(null);
    expect(root._props.has("--accent")).toBe(false);
  });

  it("setDensity maps to --density-scale", () => {
    expect(theme.setDensity("compact")).toBe("compact");
    expect(root._props.get("--density-scale")).toBe(String(theme.DENSITIES.compact));
    theme.setDensity("comfortable");
    expect(root._props.get("--density-scale")).toBe(
      String(theme.DENSITIES.comfortable),
    );
  });

  it("setFontScale maps to --font-scale", () => {
    expect(theme.setFontScale("large")).toBe("large");
    expect(root._props.get("--font-scale")).toBe(String(theme.FONT_SCALES.large));
    theme.setFontScale("small");
    expect(root._props.get("--font-scale")).toBe(String(theme.FONT_SCALES.small));
  });

  it("setReducedMotion toggles the data-reduced-motion attribute", () => {
    theme.setReducedMotion(true);
    expect(root.getAttribute("data-reduced-motion")).toBe("true");
    theme.setReducedMotion(false);
    expect(root.getAttribute("data-reduced-motion")).toBeNull();
  });
});

// ===========================================================================
// 4. Persistence round-trip + fallback on unreadable/corrupt prefs (Req 3.5)
// ===========================================================================
describe("Appearance persistence", () => {
  it("round-trips the full appearance to a fresh instance over the same storage", () => {
    const storage = createFakeStorage();
    const a = createRectorTheme({
      root: createFakeRoot(),
      storage,
      getThemeLink: () => createFakeLink(),
    });
    a.applyTheme("cairn");
    a.setAccent("#9fe7c7");
    a.setDensity("compact");
    a.setFontScale("large");
    a.setReducedMotion(true);

    // A new instance reading the same storage reflects every persisted choice.
    const b = createRectorTheme({
      root: createFakeRoot(),
      storage,
      getThemeLink: () => createFakeLink(),
    });
    const appearance = b.getAppearance();
    expect(appearance.theme).toBe("cairn");
    expect(appearance.accents.cairn).toBe("#9fe7c7");
    expect(appearance.density).toBe("compact");
    expect(appearance.fontScale).toBe("large");
    expect(appearance.reducedMotion).toBe(true);
  });

  it("falls back to defaults on corrupt (unparseable) persisted prefs without throwing", () => {
    const storage = createFakeStorage();
    const root = createFakeRoot();
    const theme = createRectorTheme({ root, storage, getThemeLink: () => createFakeLink() });
    // Seed garbage under the appearance key.
    storage.setItem(theme.STORAGE_KEY, "{not json");

    expect(() => theme.getAppearance()).not.toThrow();
    const appearance = theme.getAppearance();
    expect(appearance.theme).toBe(theme.DEFAULT_THEME);
    expect(appearance.density).toBeNull();
    expect(appearance.fontScale).toBeNull();
    expect(appearance.reducedMotion).toBe(false);
  });

  it("falls back to defaults when storage reads throw (unreadable prefs)", () => {
    const theme = createRectorTheme({
      root: createFakeRoot(),
      storage: createFakeStorage(true),
      getThemeLink: () => createFakeLink(),
    });
    expect(() => theme.getAppearance()).not.toThrow();
    expect(theme.getAppearance().theme).toBe(theme.DEFAULT_THEME);
  });
});

// ===========================================================================
// 5. Switching theme preserves customizations — Property 5 (Req 3.9, 1.5)
// ===========================================================================
describe("Property 5: switching themes preserves customizations", () => {
  it("density, font-scale, and reduced-motion persist across applyTheme", () => {
    const root = createFakeRoot();
    const storage = createFakeStorage();
    const theme = createRectorTheme({ root, storage, getThemeLink: () => createFakeLink() });

    theme.setDensity("compact");
    theme.setFontScale("large");
    theme.setReducedMotion(true);

    // Switching themes must not disturb these non-accent customizations.
    for (const id of ["aether", "vellum", "penumbra", "halo"]) {
      theme.applyTheme(id);
      expect(root._props.get("--density-scale")).toBe(String(theme.DENSITIES.compact));
      expect(root._props.get("--font-scale")).toBe(String(theme.FONT_SCALES.large));
      expect(root.getAttribute("data-reduced-motion")).toBe("true");
    }

    const appearance = theme.getAppearance();
    expect(appearance.density).toBe("compact");
    expect(appearance.fontScale).toBe("large");
    expect(appearance.reducedMotion).toBe(true);
  });

  it("re-applies each theme's own per-theme accent override when switched back", () => {
    const root = createFakeRoot();
    const storage = createFakeStorage();
    const theme = createRectorTheme({ root, storage, getThemeLink: () => createFakeLink() });

    theme.applyTheme("halo");
    theme.setAccent("#111111");
    theme.applyTheme("cairn");
    theme.setAccent("#222222");

    // aether has no accent override -> the inline prop is cleared (theme token wins).
    theme.applyTheme("aether");
    expect(root._props.has("--accent")).toBe(false);

    // Switching back re-applies each theme's stored accent (overrides are per-theme).
    theme.applyTheme("halo");
    expect(root._props.get("--accent")).toBe("#111111");
    theme.applyTheme("cairn");
    expect(root._props.get("--accent")).toBe("#222222");
  });

  it("never rewrites a theme file's own token block (overrides live only in the DOM/storage)", () => {
    // Capture every theme file before any runtime activity.
    const before = THEME_FILES.map(({ file }) => readPublic(file));

    const root = createFakeRoot();
    const storage = createFakeStorage();
    const theme = createRectorTheme({ root, storage, getThemeLink: () => createFakeLink() });

    // A representative storm of theme switches + overrides.
    for (const { id } of THEME_FILES) {
      theme.applyTheme(id);
      theme.setAccent("#abcabc");
      theme.setDensity("compact");
      theme.setFontScale("small");
      theme.setReducedMotion(true);
    }
    theme.resetCustomizations();

    // The token DEFINITIONS in the theme stylesheets are untouched: overrides are
    // inline custom props on <html> (the override layer), not edits to the files.
    const after = THEME_FILES.map(({ file }) => readPublic(file));
    expect(after).toEqual(before);
  });
});
