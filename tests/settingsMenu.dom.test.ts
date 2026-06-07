// DOM/behavior tests for the Settings_Menu (gear popover) controller in src/public/app.js
// (task 4.2). These are DOM-structural behavior checks (not a generative property-based
// library), per the design's Testing Strategy.
//
// Validates:
//   - Property 1  (Action reachability — menu side): each of the six System_Action menu items
//     invokes the same existing Open_Function the former sidebar button called, then the menu
//     closes. (Requirements 6.3, 8.1, 8.3)
//   - Property 6  (Keyboard accessibility — menu side): opening moves focus to the first menu
//     item; Escape closes the menu and returns focus to the gear; outside-click closes the menu.
//     (Requirements 6.1, 6.4, 6.5)
//   - Property 9  (Overlay listener hygiene — menu side): opening attaches exactly one document
//     outside-click listener and one Escape listener; closing removes exactly those, so the
//     document-level listener counts return to the pre-open baseline; a repeat open while already
//     open attaches nothing more. (Requirements 14.1, 14.2, 14.3, 14.4)
//
// app.js is a plain browser script (no module exports) that wires the UI and calls `init()` on
// load. Like the other *.dom.test.ts suites it is loaded into a `vm` context backed by a minimal
// fake DOM — no jsdom, no network. This harness extends that approach with the small extras the
// settings-menu controller exercises: compound-selector matching (`.menu__item, [role='menuitem']`),
// element `contains()`, focus tracking (`document.activeElement`), and document-level listener
// counting for the listener-hygiene assertions. `init()` is deferred (readyState="loading") so the
// six Open_Functions can be replaced with spies *before* their menu items are bound, letting us
// assert the item delegates to the real handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(HERE, "../src/public/app.js");

// The six System_Action menu item ids, each paired with the Open_Function it must delegate to.
const MENU_ACTIONS: Array<{ itemId: string; fn: string }> = [
  { itemId: "open-setup-wizard", fn: "openSetupWizard" },
  { itemId: "open-provider-config", fn: "openProviderConfig" },
  { itemId: "open-provider-test", fn: "openProviderTest" },
  { itemId: "open-workspace-safety", fn: "openWorkspaceSafety" },
  { itemId: "open-appearance", fn: "openAppearance" },
  { itemId: "open-approval", fn: "openApprovalPanel" },
];

// ---------------------------------------------------------------------------
// Minimal fake DOM (deterministic; no jsdom). Mirrors the shapes app.js touches
// and adds compound-selector matching, contains(), focus tracking, and listener
// counting used by the settings-menu controller + its hygiene assertions.
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

  // Does this element's subtree (inclusive) contain `node`? Used by the outside-click guard.
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

  // Single-selector match: class (`.x`), attribute (`[role='menuitem']`),
  // the checkbox shape app.js uses, or a tag name.
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

  // Supports comma-separated selector lists (e.g. ".menu__item, [role='menuitem']").
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

interface SettingsMenuHarness {
  sandbox: any;
  getEl: (id: string) => FakeElement;
  document: any;
  spies: Record<string, ReturnType<typeof vi.fn>>;
  /** Live element handles for the menu region. */
  gear: FakeElement;
  popover: FakeElement;
  wrap: FakeElement;
  items: Record<string, FakeElement>;
  outsideEl: FakeElement;
  /** Count of document-level listeners currently registered for `type`. */
  docListenerCount: (type: string) => number;
}

function createSettingsMenuHarness(): SettingsMenuHarness {
  const registry = new Map<string, FakeElement>();

  // Document-level listener tracking (the basis for the hygiene assertions).
  const docListeners = new Map<string, Array<(ev: any) => void>>();

  const fakeDocument: any = {
    readyState: "loading", // defer init() so we can install spies before binding
    activeElement: null as FakeElement | null,
    getElementById: (id: string) => {
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

  // Default fetch: serve init-time GETs (/health, /chat/conversations) with empty ok bodies so
  // init() settles without touching the network.
  const fetchHandler = async () => ({
    ok: true,
    status: 200,
    text: async () => "{}",
  });

  const sandbox: Record<string, unknown> = {
    document: fakeDocument,
    console,
    setTimeout: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) =>
      globalThis.setTimeout(fn, ms, ...args),
    clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
    setInterval: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) =>
      globalThis.setInterval(fn, ms, ...args),
    clearInterval: (handle: any) => globalThis.clearInterval(handle),
    AbortController: globalThis.AbortController,
    fetch: (url: string, options: any = {}) => fetchHandler(),
  };
  (sandbox as any).window = sandbox; // app.js reads window.* (EventSource/RectorTheme undefined here)
  (sandbox as any).globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = readFileSync(APP_JS_PATH, "utf8");
  vm.runInContext(source, context, { filename: "app.js" });

  // Replace the six Open_Functions with spies BEFORE init() binds them to the menu items.
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const { fn } of MENU_ACTIONS) {
    const spy = vi.fn();
    spies[fn] = spy;
    (sandbox as any)[fn] = spy;
  }

  // Run init() now (binds composer/panels + bindSettingsMenu + bindCommandPalette).
  fakeDocument.readyState = "complete";
  fakeDocument.dispatch("DOMContentLoaded");

  const getEl = (id: string) => fakeDocument.getElementById(id) as FakeElement;

  // Build the menu region tree so the controller's querySelector/closest/contains resolve like
  // the real markup: wrap → [gear, popover → six menuitems].
  const gear = getEl("open-settings-menu");
  const popover = getEl("settings-menu");
  const wrap = getEl("settings-menu-wrap");
  popover.hidden = true;
  gear.setAttribute("aria-expanded", "false");

  const items: Record<string, FakeElement> = {};
  for (const { itemId } of MENU_ACTIONS) {
    const item = getEl(itemId);
    item.classList.add("menu__item");
    item.setAttribute("role", "menuitem");
    popover.appendChild(item);
    items[itemId] = item;
  }
  wrap.appendChild(gear);
  wrap.appendChild(popover);

  // An element outside the menu wrapper, used to simulate an outside click.
  const outsideEl = getEl("messages");

  return {
    sandbox,
    getEl,
    document: fakeDocument,
    spies,
    gear,
    popover,
    wrap,
    items,
    outsideEl,
    docListenerCount: (type: string) => docListeners.get(type)?.length ?? 0,
  };
}

// Convenience event with a no-op stopPropagation (the controller calls it on the gear click).
function clickEvent(target: FakeElement) {
  return { target, stopPropagation: () => {} };
}

describe("Settings_Menu controller (gear popover)", () => {
  let h: SettingsMenuHarness;

  beforeEach(() => {
    h = createSettingsMenuHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Property 6 — keyboard accessibility (open focus, Escape/outside-click close)
  // -------------------------------------------------------------------------
  describe("open/close lifecycle (Property 6 — Req 6.1, 6.4, 6.5)", () => {
    it("opening via the gear unhides the popover, sets aria-expanded, and focuses the first item (Req 6.1)", () => {
      expect(h.popover.hidden).toBe(true);

      h.gear.dispatch("click", clickEvent(h.gear));

      expect(h.popover.hidden).toBe(false);
      expect(h.gear.getAttribute("aria-expanded")).toBe("true");
      // Focus moved to the first menu item (the first child of the popover).
      expect(h.document.activeElement).toBe(h.items["open-setup-wizard"]);
    });

    it("activating the gear again while open closes the menu (Req 6.6)", () => {
      h.gear.dispatch("click", clickEvent(h.gear));
      expect(h.popover.hidden).toBe(false);

      h.gear.dispatch("click", clickEvent(h.gear));
      expect(h.popover.hidden).toBe(true);
      expect(h.gear.getAttribute("aria-expanded")).toBe("false");
    });

    it("Escape closes the menu and returns focus to the gear (Req 6.5)", () => {
      h.gear.dispatch("click", clickEvent(h.gear));
      expect(h.popover.hidden).toBe(false);

      h.document.dispatch("keydown", { key: "Escape", stopPropagation: () => {} });

      expect(h.popover.hidden).toBe(true);
      expect(h.gear.getAttribute("aria-expanded")).toBe("false");
      expect(h.document.activeElement).toBe(h.gear);
    });

    it("a click outside the menu wrapper closes the menu (Req 6.4)", () => {
      h.gear.dispatch("click", clickEvent(h.gear));
      expect(h.popover.hidden).toBe(false);

      // Outside click: target is not within #settings-menu-wrap.
      h.document.dispatch("click", { target: h.outsideEl });

      expect(h.popover.hidden).toBe(true);
      expect(h.gear.getAttribute("aria-expanded")).toBe("false");
    });

    it("a click inside the menu wrapper does NOT close the menu (Req 6.4)", () => {
      h.gear.dispatch("click", clickEvent(h.gear));

      // A click landing inside the popover (still within the wrapper) keeps the menu open.
      h.document.dispatch("click", { target: h.popover });

      expect(h.popover.hidden).toBe(false);
      expect(h.gear.getAttribute("aria-expanded")).toBe("true");
    });
  });

  // -------------------------------------------------------------------------
  // Property 1 — action reachability: each item delegates then closes
  // -------------------------------------------------------------------------
  describe("action reachability (Property 1 — Req 6.3, 8.1, 8.3)", () => {
    it.each(MENU_ACTIONS)(
      "the $itemId item invokes $fn and then closes the menu",
      ({ itemId, fn }) => {
        h.gear.dispatch("click", clickEvent(h.gear));
        expect(h.popover.hidden).toBe(false);

        const item = h.items[itemId];
        const ev = clickEvent(item);
        // The item's own click handler (bound by its bind*()) fires first...
        item.dispatch("click", ev);
        // ...then the bubble-phase popover handler closes the menu (Req 6.3).
        h.popover.dispatch("click", ev);

        // Property 1: the menu item delegates to the existing Open_Function, unchanged.
        expect(h.spies[fn]).toHaveBeenCalledTimes(1);
        // No other Open_Function was invoked.
        for (const other of MENU_ACTIONS) {
          if (other.fn !== fn) expect(h.spies[other.fn]).not.toHaveBeenCalled();
        }
        // ...and the menu closed after activation.
        expect(h.popover.hidden).toBe(true);
        expect(h.gear.getAttribute("aria-expanded")).toBe("false");
      },
    );

    it("every System_Action has exactly one operable menu item with an accessible name (Req 8.1)", () => {
      for (const { itemId } of MENU_ACTIONS) {
        const matches = h.popover.querySelectorAll(`[role='menuitem']`).filter((el) => el.id === itemId);
        expect(matches, `expected exactly one menu item for ${itemId}`).toHaveLength(1);
        // Operable by keyboard activation: it is reachable as a menuitem in the popover.
        expect(matches[0].getAttribute("role")).toBe("menuitem");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Property 9 — overlay listener hygiene
  // -------------------------------------------------------------------------
  describe("listener hygiene (Property 9 — Req 14.1, 14.2, 14.3, 14.4)", () => {
    it("opens attach exactly one outside-click + one Escape listener; close removes exactly those (Req 14.1, 14.2)", () => {
      const baseClick = h.docListenerCount("click");
      const baseKeydown = h.docListenerCount("keydown");

      h.gear.dispatch("click", clickEvent(h.gear));

      // Exactly one outside-click and one Escape (keydown) listener were added.
      expect(h.docListenerCount("click")).toBe(baseClick + 1);
      expect(h.docListenerCount("keydown")).toBe(baseKeydown + 1);

      h.gear.dispatch("click", clickEvent(h.gear)); // toggle closed

      // Counts return precisely to the pre-open baseline (no leaked handlers).
      expect(h.docListenerCount("click")).toBe(baseClick);
      expect(h.docListenerCount("keydown")).toBe(baseKeydown);
    });

    it("listener counts return to baseline after each close path (Escape / outside-click / item activation)", () => {
      const baseClick = h.docListenerCount("click");
      const baseKeydown = h.docListenerCount("keydown");

      // 1) Escape close.
      h.gear.dispatch("click", clickEvent(h.gear));
      h.document.dispatch("keydown", { key: "Escape", stopPropagation: () => {} });
      expect(h.docListenerCount("click")).toBe(baseClick);
      expect(h.docListenerCount("keydown")).toBe(baseKeydown);

      // 2) Outside-click close.
      h.gear.dispatch("click", clickEvent(h.gear));
      h.document.dispatch("click", { target: h.outsideEl });
      expect(h.docListenerCount("click")).toBe(baseClick);
      expect(h.docListenerCount("keydown")).toBe(baseKeydown);

      // 3) Menu-item activation close.
      h.gear.dispatch("click", clickEvent(h.gear));
      const ev = clickEvent(h.items["open-appearance"]);
      h.items["open-appearance"].dispatch("click", ev);
      h.popover.dispatch("click", ev);
      expect(h.docListenerCount("click")).toBe(baseClick);
      expect(h.docListenerCount("keydown")).toBe(baseKeydown);
    });

    it("while closed the menu owns zero outside-click/Escape listeners (Req 14.4)", () => {
      const baseClick = h.docListenerCount("click");
      const baseKeydown = h.docListenerCount("keydown");

      // Open then close; the delta over baseline must be zero while closed.
      h.gear.dispatch("click", clickEvent(h.gear));
      h.gear.dispatch("click", clickEvent(h.gear));

      expect(h.docListenerCount("click")).toBe(baseClick);
      expect(h.docListenerCount("keydown")).toBe(baseKeydown);
    });

    it("a repeat open while already open attaches no additional listeners (Req 14.3)", () => {
      h.sandbox.openSettingsMenu();
      const openClick = h.docListenerCount("click");
      const openKeydown = h.docListenerCount("keydown");

      // Requesting open again must be a no-op for listeners.
      h.sandbox.openSettingsMenu();

      expect(h.docListenerCount("click")).toBe(openClick);
      expect(h.docListenerCount("keydown")).toBe(openKeydown);
    });
  });
});
