// Shared dependency-injection doubles for the Theme_System runtime tests.
//
// theme.js (src/public/theme.js) is a dependency-free browser script whose
// factory `createRectorTheme({ root, storage, getThemeLink })` accepts injected
// DOM/storage doubles so the runtime can be exercised in Node without jsdom or
// a network. These doubles mirror the minimal surface theme.js touches:
//   - root: data-theme / data-reduced-motion attributes + inline custom props
//   - storage: a localStorage-like get/set/remove backed by a Map
//   - link: a single <link> whose href is swapped for lazy per-theme attachment
//
// Used by tests/theme.unit.test.ts (task 9.1) and tests/themeSystem.dom.test.ts
// (task 9.3). Keeping them here avoids duplicating the doubles across files.

export type FakeRoot = {
  style: {
    setProperty: (k: string, v: string) => void;
    removeProperty: (k: string) => void;
    getPropertyValue: (k: string) => string;
  };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  _attrs: Map<string, string>;
  _props: Map<string, string>;
};

export type FakeStorage = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  _map: Map<string, string>;
};

export type FakeLink = {
  getAttribute: (k: string) => string | null;
  setAttribute: (k: string, v: string) => void;
  readonly href: string;
};

export type ThemeApi = {
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

export type ThemeFactory = (options?: {
  root?: unknown;
  storage?: unknown;
  getThemeLink?: () => unknown;
  themeHrefBase?: string;
}) => ThemeApi;

export function createFakeRoot(): FakeRoot {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  return {
    style: {
      setProperty: (k, v) => props.set(k, String(v)),
      removeProperty: (k) => props.delete(k),
      getPropertyValue: (k) => props.get(k) ?? "",
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k)! : null),
    removeAttribute: (k) => attrs.delete(k),
    _attrs: attrs,
    _props: props,
  };
}

export function createFakeStorage(throwOnRead = false): FakeStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => {
      if (throwOnRead) throw new Error("storage unavailable");
      return map.has(k) ? map.get(k)! : null;
    },
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

export function createFakeLink(initial = "styles/themes/halo.css"): FakeLink {
  let href = initial;
  return {
    getAttribute: (k) => (k === "href" ? href : null),
    setAttribute: (k, v) => {
      if (k === "href") href = String(v);
    },
    get href() {
      return href;
    },
  };
}

// Resolve the global factory installed by importing src/public/theme.js for its
// side-effect. The caller must `import "../src/public/theme.js"` first.
export function getThemeFactory(): ThemeFactory {
  const factory = (globalThis as unknown as { createRectorTheme?: ThemeFactory })
    .createRectorTheme;
  if (typeof factory !== "function") {
    throw new Error(
      "createRectorTheme is not installed — import src/public/theme.js first",
    );
  }
  return factory;
}
