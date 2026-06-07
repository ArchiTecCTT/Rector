// DOM/structural tests for id-preservation and handler-integrity of the redesigned shell
// wiring in src/public/app.js (task 4.6). These are DOM-structural checks (not a generative
// property-based library), per the design's Testing Strategy.
//
// Validates:
//   - Property 2 (ID preservation): every id in the cacheEls() lookup list is present in the
//     served index.html and resolves to a non-null element after load. (Requirements 10.1, 10.5)
//   - Property 3 (Handler integrity): init() attaches every bind*() handler and completes without
//     throwing — including when a target element is absent, in which case it skips that binding,
//     emits a developer-facing diagnostic, and still finishes; and each preserved control invokes
//     the same open/close/toggle function it invoked before the redesign. (Requirements 10.2,
//     10.3, 10.4)
//
// app.js is a plain browser script (no module exports) that wires the UI and calls `init()` on
// load. Like the other *.dom.test.ts suites it is loaded into a `vm` context backed by a minimal
// fake DOM — no jsdom, no network. The harness defers init() (readyState="loading") so the
// preserved open/close/toggle functions can be replaced with spies *before* init() binds them,
// letting us assert each control delegates to the real handler. The cached `els` map is surfaced
// onto the sandbox via a tiny test-only shim appended to the in-memory source (the on-disk file is
// never modified), so the els[id] resolution can be asserted directly.
//
// The authoritative "the id exists in the served document" guarantee comes from parsing the real
// src/public/index.html text (the fake DOM's getElementById auto-fabricates ids, so it cannot prove
// presence on its own); the vm harness then proves cacheEls()/init() resolve each cached id to a
// non-null element without throwing.
import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(HERE, "../src/public/app.js");
const INDEX_HTML_PATH = resolve(HERE, "../src/public/index.html");

const APP_SOURCE = readFileSync(APP_JS_PATH, "utf8");
const INDEX_HTML = readFileSync(INDEX_HTML_PATH, "utf8");

// ---------------------------------------------------------------------------
// Static derivation of the expected ids from the real served files.
// ---------------------------------------------------------------------------

// The exact id list cacheEls() caches, parsed straight from the app.js source so the test tracks
// the real code rather than a hand-maintained duplicate. We slice the cacheEls() body (the `ids`
// array literal up to the `for (const id of ids)` loop) and collect every quoted string in it.
function parseCachedIds(source: string): string[] {
  const fnMatch = /function cacheEls\(\)\s*\{([\s\S]*?)for \(const id of ids\)/.exec(source);
  if (!fnMatch) throw new Error("could not locate cacheEls() id list in app.js");
  const body = fnMatch[1];
  const ids = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 0) throw new Error("cacheEls() id list parsed as empty");
  return ids;
}

// Every id="..." occurrence in the served index.html (the source of truth for "present in the
// served document").
function parseHtmlIds(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

const CACHED_IDS = parseCachedIds(APP_SOURCE);
const HTML_IDS = parseHtmlIds(INDEX_HTML);

// Preserved controls and the open/close/toggle function each must still invoke after the redesign.
// These mirror the pre-redesign wiring: the six System_Action menu items delegate to their existing
// Open_Functions, and the direct affordances keep their trace/new-conversation handlers.
const PRESERVED_CONTROLS: Array<{ id: string; fn: string }> = [
  { id: "open-setup-wizard", fn: "openSetupWizard" },
  { id: "open-provider-config", fn: "openProviderConfig" },
  { id: "open-provider-test", fn: "openProviderTest" },
  { id: "open-workspace-safety", fn: "openWorkspaceSafety" },
  { id: "open-appearance", fn: "openAppearance" },
  { id: "open-approval", fn: "openApprovalPanel" },
  { id: "toggle-trace", fn: "toggleTrace" },
  { id: "close-trace", fn: "closeTrace" },
  { id: "new-conversation", fn: "startNewConversation" },
];

// ---------------------------------------------------------------------------
// Minimal fake DOM (deterministic; no jsdom). Mirrors the shapes app.js touches during init() and
// the bind*() handlers — enough for the full init() path the settings-menu suite also exercises.
// ---------------------------------------------------------------------------

interface FakeDoc {
  activeElement: FakeElement | null;
}

class FakeElement {
  tagName: string;
  id = "";
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  ownerDocument: FakeDoc | null = null;
  listeners: Map<string, Array<(ev: any) => void>> = new Map();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Map<string, string> = new Map();
  private classes: Set<string> = new Set();
  private _textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  type = "";
  name = "";
  title = "";
  scrollTop = 0;
  scrollHeight = 0;

  constructor(tagName = "DIV") {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this._textContent;
  }
  set textContent(v: string) {
    this._textContent = String(v ?? "");
    this.children = [];
  }
  set innerHTML(_v: string) {
    this.children = [];
  }
  get innerHTML(): string {
    return "";
  }

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(String(v ?? "").split(/\s+/).filter(Boolean));
  }
  classList = {
    add: (...cls: string[]) => cls.forEach((c) => this.classes.add(c)),
    remove: (...cls: string[]) => cls.forEach((c) => this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string) => (this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c)),
  };

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    if (!child.ownerDocument) child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  scrollIntoView() {}

  contains(node: FakeElement | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  private descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const c of node.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  private matchesSingle(selector: string): boolean {
    const sel = selector.trim();
    if (!sel) return false;
    if (sel.startsWith(".")) return this.classes.has(sel.slice(1));
    const attr = /^\[([\w-]+)\s*=\s*['"]?([^'"\]]+)['"]?\]$/.exec(sel);
    if (attr) return this.getAttribute(attr[1]) === attr[2];
    if (sel.includes("input") && sel.includes("checkbox")) {
      return this.tagName === "INPUT" && this.type === "checkbox";
    }
    return this.tagName === sel.toUpperCase();
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => this.matchesSingle(part));
  }

  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((d) => d.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((d) => d.matches(selector));
  }
  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  addEventListener(type: string, handler: (ev: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, handler: (ev: any) => void) {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((h) => h !== handler),
    );
  }
  dispatch(type: string, ev: any = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ type, ...ev });
  }
}

interface WiringHarness {
  sandbox: any;
  document: any;
  getEl: (id: string) => FakeElement;
  /** The live cacheEls() map (els) surfaced via a test-only shim. */
  els: Record<string, FakeElement | null>;
  spies: Record<string, ReturnType<typeof vi.fn>>;
  /** Captured console.error message strings, in order. */
  errors: string[];
  /** Runs init() (via DOMContentLoaded); returns the thrown error, or null on success. */
  runInit: () => unknown;
}

interface HarnessOpts {
  /** Ids for which getElementById returns null (simulating absent markup). */
  missingIds?: string[];
  /** Names of app.js functions to replace with spies BEFORE init() binds them. */
  spyFns?: string[];
}

function createWiringHarness(opts: HarnessOpts = {}): WiringHarness {
  const missing = new Set(opts.missingIds ?? []);
  const registry = new Map<string, FakeElement>();
  const docListeners = new Map<string, Array<(ev: any) => void>>();
  const errors: string[] = [];

  const fakeDocument: any = {
    readyState: "loading", // defer init() so spies install before binding
    activeElement: null as FakeElement | null,
    getElementById: (id: string) => {
      if (missing.has(id)) return null; // simulate absent markup
      let el = registry.get(id);
      if (!el) {
        el = new FakeElement("div");
        el.id = id;
        el.ownerDocument = fakeDocument;
        registry.set(id, el);
      }
      return el;
    },
    createElement: (tag: string) => {
      const el = new FakeElement(tag);
      el.ownerDocument = fakeDocument;
      return el;
    },
    querySelector: (_sel: string) => {
      const el = new FakeElement("div");
      el.ownerDocument = fakeDocument;
      return el;
    },
    addEventListener: (type: string, handler: (ev: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(handler);
      docListeners.set(type, list);
    },
    removeEventListener: (type: string, handler: (ev: any) => void) => {
      const list = docListeners.get(type);
      if (!list) return;
      docListeners.set(
        type,
        list.filter((h) => h !== handler),
      );
    },
    dispatch: (type: string, ev: any = {}) => {
      for (const handler of [...(docListeners.get(type) ?? [])]) handler({ type, ...ev });
    },
  };
  fakeDocument.documentElement = fakeDocument.createElement("html");

  // Capture console.error (the developer-facing diagnostic channel) while delegating the rest.
  const fakeConsole = {
    log: (...a: unknown[]) => console.log(...a),
    info: (...a: unknown[]) => console.info(...a),
    debug: (...a: unknown[]) => console.debug(...a),
    warn: (...a: unknown[]) => console.warn(...a),
    error: (...a: unknown[]) => {
      errors.push(a.map((x) => String(x)).join(" "));
    },
  };

  // init-time GETs (/health, /chat/conversations) resolve with empty ok bodies, no network.
  const fetchHandler = async () => ({ ok: true, status: 200, text: async () => "{}" });

  const sandbox: Record<string, unknown> = {
    document: fakeDocument,
    console: fakeConsole,
    setTimeout: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) =>
      globalThis.setTimeout(fn, ms, ...args),
    clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
    setInterval: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) =>
      globalThis.setInterval(fn, ms, ...args),
    clearInterval: (handle: any) => globalThis.clearInterval(handle),
    AbortController: globalThis.AbortController,
    fetch: (_url: string, _options: any = {}) => fetchHandler(),
  };
  (sandbox as any).window = sandbox;
  (sandbox as any).globalThis = sandbox;

  const context = vm.createContext(sandbox);
  // Append a test-only shim that surfaces the module-private `els` map onto the sandbox. `els` is a
  // top-level const in this same script, so it is in scope here; cacheEls() mutates it in place, so
  // capturing the reference now reflects the populated map after init() runs. The on-disk file is
  // untouched.
  const source = `${APP_SOURCE}\n;try { window.__els = els; } catch (_e) {}\n`;
  vm.runInContext(source, context, { filename: "app.js" });

  // Replace the requested functions with spies BEFORE init() binds them to controls.
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const fn of opts.spyFns ?? []) {
    const spy = vi.fn();
    spies[fn] = spy;
    (sandbox as any)[fn] = spy;
  }

  const runInit = (): unknown => {
    fakeDocument.readyState = "complete";
    try {
      fakeDocument.dispatch("DOMContentLoaded");
      return null;
    } catch (err) {
      return err;
    }
  };

  return {
    sandbox,
    document: fakeDocument,
    getEl: (id: string) => fakeDocument.getElementById(id) as FakeElement,
    get els() {
      return (sandbox as any).__els as Record<string, FakeElement | null>;
    },
    spies,
    errors,
    runInit,
  };
}

describe("UI shell wiring — id preservation & handler integrity (task 4.6)", () => {
  // -------------------------------------------------------------------------
  // Property 2 — ID preservation
  // -------------------------------------------------------------------------
  describe("Property 2 — ID preservation (Req 10.1, 10.5)", () => {
    it("parses a non-empty cacheEls() id list from app.js", () => {
      expect(CACHED_IDS.length).toBeGreaterThan(0);
      // No duplicate ids in the cache list.
      expect(new Set(CACHED_IDS).size).toBe(CACHED_IDS.length);
    });

    it("every cached id is present in the served index.html (cacheEls list ⊆ document ids)", () => {
      const missing = CACHED_IDS.filter((id) => !HTML_IDS.has(id));
      expect(missing, `ids cached by app.js but absent from index.html: ${missing.join(", ")}`).toEqual(
        [],
      );
    });

    it("every cached id resolves to a non-null element after init() runs", () => {
      const h = createWiringHarness();
      const err = h.runInit();
      expect(err).toBeNull();

      const els = h.els;
      expect(els, "els map should be surfaced by the test shim").toBeTruthy();
      const unresolved = CACHED_IDS.filter((id) => els[id] == null);
      expect(unresolved, `cached ids that resolved to null after init: ${unresolved.join(", ")}`).toEqual(
        [],
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 3 — Handler integrity
  // -------------------------------------------------------------------------
  describe("Property 3 — Handler integrity (Req 10.2, 10.3, 10.4)", () => {
    it("init() attaches every bind*() handler and completes without throwing (Req 10.2)", () => {
      const h = createWiringHarness();
      const err = h.runInit();
      expect(err).toBeNull();
    });

    it("init() skips absent targets, logs a diagnostic, and still completes (Req 10.3)", () => {
      // Drop a representative set of targets across init()'s direct affordances and several bind*()
      // controllers; each must degrade gracefully rather than throw.
      const missingIds = [
        "toggle-trace",
        "close-trace",
        "new-conversation",
        "composer",
        "command-palette-input",
      ];
      const h = createWiringHarness({ missingIds });
      const err = h.runInit();

      // init() ran to completion without raising.
      expect(err).toBeNull();

      // A developer-facing diagnostic was emitted for the absent references (Req 15.4 / 10.3).
      const joined = h.errors.join("\n");
      expect(joined).toContain("toggle-trace");
      expect(joined).toContain("close-trace");
      expect(joined).toContain("new-conversation");
      expect(joined).toContain("composer");
      expect(joined).toContain("command-palette");

      // Controls whose targets are present still resolve (the rest of init() kept working).
      expect(h.els["chat-title"]).not.toBeNull();
      expect(h.els["messages"]).not.toBeNull();
    });

    it.each(PRESERVED_CONTROLS)(
      "the $id control invokes $fn after init() (Req 10.4)",
      ({ id, fn }) => {
        const h = createWiringHarness({ spyFns: [fn] });
        const err = h.runInit();
        expect(err).toBeNull();

        const control = h.getEl(id);
        control.dispatch("click", { target: control, stopPropagation: () => {}, preventDefault: () => {} });

        // The preserved control delegates to the same function as before the redesign.
        expect(h.spies[fn], `expected ${id} click to invoke ${fn}`).toHaveBeenCalledTimes(1);
      },
    );
  });
});
