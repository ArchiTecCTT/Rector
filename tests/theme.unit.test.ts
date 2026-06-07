// Unit tests for the Theme_System runtime (src/public/theme.js, task 9.1).
//
// Validates (by example/DOM-double assertion):
//   - 1.5  exactly one data-theme is applied at a time
//   - 1.6  default theme (halo) when nothing is persisted / unknown name
//   - 3.1  selecting a theme persists it and is reapplied on next load
//   - 3.4  reduced-motion toggle applies an attribute hook and persists
//   - 3.5/3.10 unreadable/missing storage falls back to defaults without error
//   - 3.6/3.7 density / font-scale map to --density-scale / --font-scale and persist
//   - 3.8  clearing/resetting a customization reverts to the theme token
//   - 4.4  only the active theme's stylesheet is attached (single <link> href swap)
//
// theme.js is a dependency-free browser script. We load it for its global
// side-effect (in node it assigns globalThis.createRectorTheme) and drive the
// injectable factory with plain DOM/storage doubles — no jsdom, no network.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import "../src/public/theme.js";

type ThemeApi = {
  STORAGE_KEY: string;
  DEFAULT_THEME: string;
  THEMES: string[];
  DENSITIES: Record<string, number>;
  FONT_SCALES: Record<string, number>;
  applyTheme: (name: string) => string;
  setAccent: (value: string | null) => unknown;
  setDensity: (value: string) => string;
  setFontScale: (value: string) => string;
  setReducedMotion: (on: boolean) => boolean;
  resetCustomizations: () => string;
  getAppearance: () => {
    theme: string;
    accents: Record<string, string>;
    density: string | null;
    fontScale: string | null;
    reducedMotion: boolean;
  };
  currentTheme: () => string;
  hydrate: () => string;
};

type Factory = (options?: {
  root?: unknown;
  storage?: unknown;
  getThemeLink?: () => unknown;
  themeHrefBase?: string;
}) => ThemeApi;

function createFakeRoot() {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  return {
    style: {
      setProperty: (k: string, v: string) => props.set(k, String(v)),
      removeProperty: (k: string) => props.delete(k),
      getPropertyValue: (k: string) => props.get(k) ?? "",
    },
    setAttribute: (k: string, v: string) => attrs.set(k, String(v)),
    getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
    removeAttribute: (k: string) => attrs.delete(k),
    _attrs: attrs,
    _props: props,
  };
}

function createFakeStorage(throwOnRead = false) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (throwOnRead) throw new Error("storage unavailable");
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: (k: string, v: string) => map.set(k, String(v)),
    removeItem: (k: string) => map.delete(k),
    _map: map,
  };
}

function createFakeLink(initial = "styles/themes/halo.css") {
  let href = initial;
  return {
    getAttribute: (k: string) => (k === "href" ? href : null),
    setAttribute: (k: string, v: string) => {
      if (k === "href") href = String(v);
    },
    get href() {
      return href;
    },
  };
}

let createRectorTheme: Factory;

beforeAll(() => {
  createRectorTheme = (globalThis as unknown as { createRectorTheme: Factory })
    .createRectorTheme;
  expect(typeof createRectorTheme).toBe("function");
});

describe("Theme_System runtime (theme.js)", () => {
  let root: ReturnType<typeof createFakeRoot>;
  let storage: ReturnType<typeof createFakeStorage>;
  let link: ReturnType<typeof createFakeLink>;
  let theme: ThemeApi;

  beforeEach(() => {
    root = createFakeRoot();
    storage = createFakeStorage();
    link = createFakeLink();
    theme = createRectorTheme({
      root,
      storage,
      getThemeLink: () => link,
    });
  });

  it("defaults to halo when nothing is persisted (Req 1.6)", () => {
    expect(theme.getAppearance().theme).toBe("halo");
    expect(theme.DEFAULT_THEME).toBe("halo");
  });

  it("applies, persists, and lazily attaches exactly one theme (Req 1.5, 3.1, 4.4)", () => {
    theme.applyTheme("aether");
    expect(root.getAttribute("data-theme")).toBe("aether");
    expect(link.href).toBe("styles/themes/aether.css");

    // Switching again leaves only the new theme attached (one at a time).
    theme.applyTheme("vellum");
    expect(root.getAttribute("data-theme")).toBe("vellum");
    expect(link.href).toBe("styles/themes/vellum.css");

    // Persisted and reflected by a fresh instance over the same storage (Req 3.1).
    const reloaded = createRectorTheme({
      root: createFakeRoot(),
      storage,
      getThemeLink: () => link,
    });
    expect(reloaded.getAppearance().theme).toBe("vellum");
  });

  it("falls back to the default theme for an unknown name (Req 1.6/3.10)", () => {
    const applied = theme.applyTheme("not-a-theme");
    expect(applied).toBe("halo");
    expect(root.getAttribute("data-theme")).toBe("halo");
  });

  it("persists accent per theme and preserves it across switches (Req 3.5, Property 5)", () => {
    theme.applyTheme("halo");
    theme.setAccent("#112233");
    expect(root._props.get("--accent")).toBe("#112233");

    // Switch to a theme with no accent override -> override is cleared.
    theme.applyTheme("aether");
    expect(root._props.has("--accent")).toBe(false);

    // Switch back -> halo's per-theme accent is reapplied.
    theme.applyTheme("halo");
    expect(root._props.get("--accent")).toBe("#112233");

    const appearance = theme.getAppearance();
    expect(appearance.accents.halo).toBe("#112233");
    expect(appearance.accents.aether).toBeUndefined();
  });

  it("clears an accent override back to the theme token (Req 3.8)", () => {
    theme.setAccent("#abcdef");
    expect(root._props.get("--accent")).toBe("#abcdef");
    theme.setAccent("");
    expect(root._props.has("--accent")).toBe(false);
    expect(theme.getAppearance().accents.halo).toBeUndefined();
  });

  it("maps density and font-scale to scale custom properties and persists (Req 3.6, 3.7)", () => {
    theme.setDensity("compact");
    expect(root._props.get("--density-scale")).toBe("0.85");
    theme.setFontScale("large");
    expect(root._props.get("--font-scale")).toBe(String(theme.FONT_SCALES.large));

    const appearance = theme.getAppearance();
    expect(appearance.density).toBe("compact");
    expect(appearance.fontScale).toBe("large");
  });

  it("ignores unknown density/font-scale values by using the defaults", () => {
    theme.setDensity("ludicrous");
    expect(root._props.get("--density-scale")).toBe("1");
    theme.setFontScale("gigantic");
    expect(root._props.get("--font-scale")).toBe("1");
  });

  it("toggles reduced-motion via an attribute hook and persists (Req 3.4)", () => {
    theme.setReducedMotion(true);
    expect(root.getAttribute("data-reduced-motion")).toBe("true");
    expect(theme.getAppearance().reducedMotion).toBe(true);

    theme.setReducedMotion(false);
    expect(root.getAttribute("data-reduced-motion")).toBeNull();
    expect(theme.getAppearance().reducedMotion).toBe(false);
  });

  it("resetCustomizations reverts overrides but keeps the selected theme (Req 3.8)", () => {
    theme.applyTheme("cairn");
    theme.setAccent("#0f0f0f");
    theme.setDensity("compact");
    theme.setFontScale("small");
    theme.setReducedMotion(true);

    theme.resetCustomizations();

    expect(root._props.has("--accent")).toBe(false);
    expect(root._props.has("--density-scale")).toBe(false);
    expect(root._props.has("--font-scale")).toBe(false);
    expect(root.getAttribute("data-reduced-motion")).toBeNull();

    const appearance = theme.getAppearance();
    expect(appearance.theme).toBe("cairn");
    expect(appearance.accents.cairn).toBeUndefined();
    expect(appearance.density).toBeNull();
    expect(appearance.fontScale).toBeNull();
    expect(appearance.reducedMotion).toBe(false);
  });

  it("never throws when storage is unreadable and uses defaults (Req 3.5/3.10)", () => {
    const throwingStorage = createFakeStorage(true);
    const safeRoot = createFakeRoot();
    const safeTheme = createRectorTheme({
      root: safeRoot,
      storage: throwingStorage,
      getThemeLink: () => link,
    });

    expect(() => safeTheme.getAppearance()).not.toThrow();
    expect(safeTheme.getAppearance().theme).toBe("halo");
    expect(() => safeTheme.applyTheme("penumbra")).not.toThrow();
    expect(safeRoot.getAttribute("data-theme")).toBe("penumbra");
  });

  it("hydrate reapplies the full persisted appearance to the DOM (Req 3.2 parity)", () => {
    // Seed storage as the boot script would, then hydrate a fresh root.
    storage.setItem(
      theme.STORAGE_KEY,
      JSON.stringify({
        theme: "vellum",
        accents: { vellum: "#008080" },
        density: "compact",
        fontScale: "large",
        reducedMotion: true,
      }),
    );

    const freshRoot = createFakeRoot();
    const freshLink = createFakeLink();
    const hydrated = createRectorTheme({
      root: freshRoot,
      storage,
      getThemeLink: () => freshLink,
    });
    hydrated.hydrate();

    expect(freshRoot.getAttribute("data-theme")).toBe("vellum");
    expect(freshLink.href).toBe("styles/themes/vellum.css");
    expect(freshRoot._props.get("--accent")).toBe("#008080");
    expect(freshRoot._props.get("--density-scale")).toBe("0.85");
    expect(freshRoot._props.get("--font-scale")).toBe(String(hydrated.FONT_SCALES.large));
    expect(freshRoot.getAttribute("data-reduced-motion")).toBe("true");
  });

  it("stores no secret-bearing keys in the appearance payload (Req 3.3)", () => {
    theme.applyTheme("aether");
    theme.setAccent("#5b6bff");
    theme.setDensity("compact");
    theme.setReducedMotion(true);

    const raw = storage._map.get(theme.STORAGE_KEY) ?? "";
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.toLowerCase()).not.toMatch(/secret|apikey|api_key|token|password|bearer/);
  });
});
