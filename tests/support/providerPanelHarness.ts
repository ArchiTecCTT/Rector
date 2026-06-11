// Test harness for the Provider Test Panel client logic (src/public/app.js).
//
// `app.js` is a plain browser script (no module exports) that wires the chat UI and the
// Provider_Test_Panel and calls `init()` on load. To exercise the panel's state transitions in the
// Node/vitest environment without a real browser, this harness loads the script source into a
// `vm` context backed by a minimal fake DOM, an injectable `fetch` double, and timer functions that
// delegate to the host globals (so vitest fake timers can drive the 30s client timeout).
//
// Zero network/provider calls: every `fetch` is served by an in-test handler. No real DOM, no
// real network, no real providers — only deterministic doubles.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(HERE, "../../src/public/app.js");

/** A minimal fake response shaped like the subset of `fetch`'s Response that `app.js` consumes. */
export interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

/** Build a JSON-bodied fake response. */
export function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): FakeResponse {
  const status = init.status ?? (init.ok === false ? 400 : 200);
  const ok = init.ok ?? (status >= 200 && status < 300);
  const text = JSON.stringify(body ?? {});
  return { ok, status, text: async () => text };
}

type FetchHandler = (url: string, options: any) => Promise<FakeResponse>;

/** A deliberately small fake DOM element supporting only what `app.js` touches. */
class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
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

  // --- text / markup ---
  get textContent(): string {
    return this._textContent;
  }
  set textContent(v: string) {
    this._textContent = String(v ?? "");
    this.children = [];
  }
  set innerHTML(_v: string) {
    // The panel only ever assigns "" to clear a container; treat any assignment as a clear.
    this.children = [];
  }
  get innerHTML(): string {
    return "";
  }

  // --- class handling ---
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

  // --- attributes ---
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }

  // --- tree ---
  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
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
    /* no-op */
  }

  // --- query helpers (only the selector shapes app.js uses) ---
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

  private matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
    if (selector.includes("input") && selector.includes("checkbox")) {
      return this.tagName === "INPUT" && this.type === "checkbox";
    }
    return this.tagName === selector.toUpperCase();
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

  // --- events ---
  addEventListener(type: string, handler: (ev: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: any = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, ...ev });
  }
}

export interface ProviderPanelHarness {
  /** The vm sandbox/global; top-level `function` declarations from app.js are reachable here. */
  sandbox: any;
  /** Look up a fake element by the id app.js cached in `init()`. */
  getEl: (id: string) => FakeElement;
  /** Open the modal and render the provider checkbox list. */
  openPanel: () => void;
  /** Tick a provider checkbox and fire its change handler (updates selection + action state). */
  selectProvider: (providerId: string) => void;
  /** Trigger the connection test; returns the in-flight promise from `runProviderTest`. */
  runTest: () => Promise<void>;
  /** Set the fetch double used for the next request(s). */
  setFetchHandler: (handler: FetchHandler) => void;
}

/**
 * Load `app.js` into a fresh vm context with a fake DOM and an injectable fetch double, run its
 * `init()`, and return handles for driving the Provider_Test_Panel.
 */
export function createProviderPanelHarness(): ProviderPanelHarness {
  const registry = new Map<string, FakeElement>();
  const getEl = (id: string): FakeElement => {
    let el = registry.get(id);
    if (!el) {
      el = new FakeElement("div");
      registry.set(id, el);
    }
    return el;
  };

  // Default fetch: serve init-time GETs (/setup, /chat/conversations) with empty ok bodies so
  // `init()` settles without touching the network. Tests override this for the panel requests.
  let fetchHandler: FetchHandler = async () => jsonResponse({});

  const fakeDocument = {
    readyState: "complete",
    getElementById: (id: string) => getEl(id),
    createElement: (tag: string) => new FakeElement(tag),
    querySelector: (_sel: string) => new FakeElement("div"),
    addEventListener: (_type: string, _handler: (ev: any) => void) => {
      /* DOMContentLoaded never fires here; readyState is "complete" so init() runs inline. */
    },
  };

  const sandbox: Record<string, unknown> = {
    document: fakeDocument,
    window: {},
    console,
    // Timers delegate to the host globals at call time so vitest fake timers (if installed) drive
    // the 30s client-side timeout deterministically.
    setTimeout: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => globalThis.setTimeout(fn, ms, ...args),
    clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
    setInterval: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => globalThis.setInterval(fn, ms, ...args),
    clearInterval: (handle: any) => globalThis.clearInterval(handle),
    AbortController: globalThis.AbortController,
    fetch: (url: string, options: any = {}) => fetchHandler(url, options),
  };
  (sandbox as any).window = sandbox; // app.js reads window.EventSource (undefined here -> polling path, unused)
  (sandbox as any).globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = readFileSync(APP_JS_PATH, "utf8");
  vm.runInContext(source, context, { filename: "app.js" });

  return {
    sandbox,
    getEl,
    openPanel: () => (sandbox as any).openProviderTest(),
    selectProvider: (providerId: string) => {
      const list = getEl("provider-list");
      const input = list.querySelectorAll("input[type=checkbox]").find((i) => i.value === providerId);
      if (!input) throw new Error(`No provider checkbox for id "${providerId}"`);
      input.checked = true;
      input.dispatch("change");
    },
    runTest: () => (sandbox as any).runProviderTest(),
    setFetchHandler: (handler: FetchHandler) => {
      fetchHandler = handler;
    },
  };
}
