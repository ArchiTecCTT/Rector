// DOM/behavior tests for the Command_Palette (Cmd/Ctrl+K overlay) controller in src/public/app.js
// (task 4.4). These are DOM-structural behavior checks (not a generative property-based library),
// per the design's Testing Strategy.
//
// Validates:
//   - Property 1  (Action reachability — palette side): each registered command is selectable via
//     the filter input and, on Enter, closes the palette and invokes the same existing function the
//     former sidebar button called — the palette delegates, it never re-implements.
//     (Requirements 7.7, 8.2)
//   - Property 6  (Keyboard accessibility — palette side): Cmd/Ctrl+K toggles the palette open and
//     closed; filter-as-you-type selects the first match (and selects nothing on no results);
//     ArrowUp/ArrowDown move the selection clamped at the ends without wrapping; Enter invokes the
//     selected command (and is a no-op with no selection); Escape and backdrop activation close.
//     (Requirements 7.1, 7.2, 7.4, 7.5, 7.6, 7.8, 7.9)
//   - Property 9  (Overlay listener hygiene — palette side): opening attaches exactly one document
//     keydown listener and one backdrop click listener; closing removes exactly those, so the
//     counts return to the pre-open baseline; a repeat open while already open attaches nothing
//     more; and the global Cmd/Ctrl+K hotkey is the single persistent app-level listener that keeps
//     working while the palette is closed. (Requirements 7.9, 8.2, 14.5)
//
// app.js is a plain browser script (no module exports) that wires the UI and calls `init()` on
// load. Like the sibling settingsMenu.dom.test.ts suite it is loaded into a `vm` context backed by
// a minimal fake DOM — no jsdom, no network. This harness extends that fake DOM with the extras the
// palette controller exercises: createElement-driven list rendering (`list.innerHTML = ""` +
// appended `<li>` options), compound class+attribute selector matching
// (`.palette__option[aria-selected="true"]`), focus tracking, and document/element listener
// counting for the hygiene assertions. `init()` is deferred (readyState="loading") so the eight
// command functions can be replaced with spies *before* the registry's `run` references resolve,
// letting us assert each command delegates to the real handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(HERE, "../src/public/app.js");

// Every Command_Registry entry, paired with the existing function its `run` must delegate to and
// the unique label substring used to filter to it. Order mirrors commandRegistry() in app.js.
const COMMANDS: Array<{ id: string; label: string; fn: string }> = [
  { id: "setup", label: "Setup status", fn: "openSetupWizard" },
  { id: "provider-config", label: "Provider configuration", fn: "openProviderConfig" },
  { id: "provider-test", label: "Test provider connection", fn: "openProviderTest" },
  { id: "safety", label: "Workspace safety", fn: "openWorkspaceSafety" },
  { id: "appearance", label: "Appearance", fn: "openAppearance" },
  { id: "approval", label: "Pending approvals", fn: "openApprovalPanel" },
  { id: "toggle-trace", label: "Toggle trace panel", fn: "toggleTrace" },
  { id: "new-conversation", label: "New conversation", fn: "startNewConversation" },
];

// ---------------------------------------------------------------------------
// Minimal fake DOM (deterministic; no jsdom). Mirrors the shapes app.js touches
// and adds createElement list rendering, compound class+attribute selector
// matching, contains(), focus tracking, and element/document listener counting.
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
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._textContent;
  }
  set textContent(v: string) {
    this._textContent = String(v ?? "");
    this.children = [];
  }
  // Setting innerHTML to "" is how renderPaletteList clears the list before re-rendering.
  set innerHTML(_v: string) {
    this.children = [];
    this._textContent = "";
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
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
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

  // Does this element's subtree (inclusive) contain `node`?
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

  // Single compound-selector match supporting an optional tag/class/id lead followed by any number
  // of `.class` and `[attr]` / `[attr='val']` filters (e.g. `.palette__option[aria-selected="true"]`).
  private matchesSingle(selector: string): boolean {
    const sel = selector.trim();
    if (!sel) return false;
    if (sel.includes("input") && sel.includes("checkbox")) {
      return this.tagName === "INPUT" && this.type === "checkbox";
    }
    const tokenRe = /([.#][\w-]+)|(\[[^\]]+\])|(\*)|([\w-]+)/g;
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = tokenRe.exec(sel))) {
      matched = true;
      const tok = m[0];
      if (tok === "*") continue;
      if (tok.startsWith(".")) {
        if (!this.classes.has(tok.slice(1))) return false;
      } else if (tok.startsWith("#")) {
        if (this.id !== tok.slice(1)) return false;
      } else if (tok.startsWith("[")) {
        const attr = /^\[([\w-]+)(?:\s*=\s*['"]?([^'"\]]*)['"]?)?\]$/.exec(tok);
        if (!attr) return false;
        const val = this.getAttribute(attr[1]);
        if (attr[2] === undefined) {
          if (val === null) return false; // [attr] presence check
        } else if (val !== attr[2]) {
          return false;
        }
      } else if (this.tagName !== tok.toUpperCase()) {
        return false; // bare tag name
      }
    }
    return matched;
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
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  dispatch(type: string, ev: any = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ type, ...ev });
  }
}

interface PaletteHarness {
  sandbox: any;
  document: any;
  getEl: (id: string) => FakeElement;
  spies: Record<string, ReturnType<typeof vi.fn>>;
  dialog: FakeElement;
  backdrop: FakeElement;
  input: FakeElement;
  list: FakeElement;
  launcher: FakeElement;
  docListenerCount: (type: string) => number;
  /** Convenience accessors over the rendered list. */
  options: () => FakeElement[];
  selectedId: () => string | null;
  type: (query: string) => void;
}

function createPaletteHarness(): PaletteHarness {
  const registry = new Map<string, FakeElement>();
  const docListeners = new Map<string, Array<(ev: any) => void>>();

  const fakeDocument: any = {
    readyState: "loading", // defer init() so spies install before the registry resolves
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

  // Default fetch: serve init-time GETs with empty ok bodies so init() settles offline.
  const fetchHandler = async () => ({ ok: true, status: 200, text: async () => "{}" });

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
    fetch: (_url: string, _options: any = {}) => fetchHandler(),
  };
  (sandbox as any).window = sandbox; // app.js reads window.* (EventSource/RectorTheme undefined here)
  (sandbox as any).globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = readFileSync(APP_JS_PATH, "utf8");
  vm.runInContext(source, context, { filename: "app.js" });

  // Replace each registry-referenced function with a spy BEFORE init binds + before any `run`
  // resolves the global, so we can assert each command delegates to the real handler unchanged.
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const { fn } of COMMANDS) {
    const spy = vi.fn();
    spies[fn] = spy;
    (sandbox as any)[fn] = spy;
  }

  // Build the palette element tree so refs resolve like the real markup:
  // dialog #command-palette → [backdrop, input, list]; plus the top-bar launcher.
  const getEl = (id: string) => fakeDocument.getElementById(id) as FakeElement;
  const dialog = getEl("command-palette");
  const backdrop = getEl("command-palette-backdrop");
  const input = getEl("command-palette-input");
  const list = getEl("command-palette-list");
  const launcher = getEl("open-command-palette");
  input.type = "text";
  dialog.appendChild(backdrop);
  dialog.appendChild(input);
  dialog.appendChild(list);
  dialog.hidden = true; // closed by default

  // Run init() now (caches els, binds controllers incl. bindCommandPalette → global hotkey).
  fakeDocument.readyState = "complete";
  fakeDocument.dispatch("DOMContentLoaded");

  return {
    sandbox,
    document: fakeDocument,
    getEl,
    spies,
    dialog,
    backdrop,
    input,
    list,
    launcher,
    docListenerCount: (type: string) => docListeners.get(type)?.length ?? 0,
    options: () => list.querySelectorAll(".palette__option"),
    selectedId: () => {
      const sel = list.querySelector('.palette__option[aria-selected="true"]');
      return sel ? sel.dataset.commandId : null;
    },
    type: (query: string) => {
      input.value = query;
      input.dispatch("input");
    },
  };
}

// Event factories with no-op preventDefault/stopPropagation (the controller calls both).
function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, preventDefault: () => {}, stopPropagation: () => {}, ...extra };
}
function hotkeyEvent() {
  return keyEvent("k", { metaKey: true, ctrlKey: false });
}

describe("Command_Palette controller (Cmd/Ctrl+K overlay)", () => {
  let h: PaletteHarness;

  beforeEach(() => {
    h = createPaletteHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Property 6 — Cmd/Ctrl+K toggles open/close (Req 7.1, 7.2)
  // -------------------------------------------------------------------------
  describe("global hotkey toggle (Property 6 — Req 7.1, 7.2)", () => {
    it("Cmd/Ctrl+K opens the palette: unhides, empty query showing all commands, first selected", () => {
      expect(h.dialog.hidden).toBe(true);

      h.document.dispatch("keydown", hotkeyEvent());

      expect(h.dialog.hidden).toBe(false);
      expect(h.input.value).toBe(""); // empty query (Req 7.1)
      expect(h.document.activeElement).toBe(h.input); // input focused (Req 7.1)
      expect(h.options()).toHaveLength(COMMANDS.length); // all registered commands (Req 7.3 surface)
      expect(h.selectedId()).toBe(COMMANDS[0].id); // first command selected (Req 7.1)
    });

    it("Cmd/Ctrl+K again while open closes the palette (Req 7.2)", () => {
      h.document.dispatch("keydown", hotkeyEvent());
      expect(h.dialog.hidden).toBe(false);

      h.document.dispatch("keydown", hotkeyEvent());
      expect(h.dialog.hidden).toBe(true);
    });

    it("Ctrl+K (non-mac) also toggles the palette", () => {
      h.document.dispatch("keydown", keyEvent("k", { ctrlKey: true }));
      expect(h.dialog.hidden).toBe(false);
      h.document.dispatch("keydown", keyEvent("K", { ctrlKey: true })); // capitalized variant
      expect(h.dialog.hidden).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Property 6 — filter-as-you-type selection (Req 7.4, 7.5)
  // -------------------------------------------------------------------------
  describe("filter-as-you-type (Property 6 — Req 7.4, 7.5)", () => {
    it("typing narrows the list and sets aria-selected on the first match (Req 7.4)", () => {
      h.document.dispatch("keydown", hotkeyEvent());

      h.type("provider"); // matches "Provider configuration" and "Test provider connection"

      const opts = h.options();
      expect(opts.map((o) => o.dataset.commandId)).toEqual(["provider-config", "provider-test"]);
      // First match selected, the rest explicitly unselected.
      expect(opts[0].getAttribute("aria-selected")).toBe("true");
      expect(opts[1].getAttribute("aria-selected")).toBe("false");
      expect(h.selectedId()).toBe("provider-config");
    });

    it("matching is case-insensitive and trims surrounding whitespace (Req 7.4)", () => {
      h.document.dispatch("keydown", hotkeyEvent());

      h.type("   APPEARANCE   ");

      expect(h.options().map((o) => o.dataset.commandId)).toEqual(["appearance"]);
      expect(h.selectedId()).toBe("appearance");
    });

    it("a query matching nothing shows no options and selects nothing (Req 7.5)", () => {
      h.document.dispatch("keydown", hotkeyEvent());

      h.type("zzz-no-such-command");

      expect(h.options()).toHaveLength(0); // no-results
      expect(h.selectedId()).toBeNull(); // aria-selected set on no option
    });
  });

  // -------------------------------------------------------------------------
  // Property 6 — Arrow keys clamp at the ends without wrapping (Req 7.6)
  // -------------------------------------------------------------------------
  describe("arrow selection clamps at the ends (Property 6 — Req 7.6)", () => {
    it("ArrowUp at the first option keeps the first selected (no wrap to last)", () => {
      h.document.dispatch("keydown", hotkeyEvent());
      expect(h.selectedId()).toBe(COMMANDS[0].id);

      h.document.dispatch("keydown", keyEvent("ArrowUp"));
      h.document.dispatch("keydown", keyEvent("ArrowUp"));

      expect(h.selectedId()).toBe(COMMANDS[0].id); // clamped at the first
    });

    it("ArrowDown past the last option keeps the last selected (no wrap to first)", () => {
      h.document.dispatch("keydown", hotkeyEvent());

      // Press ArrowDown well past the number of options.
      for (let i = 0; i < COMMANDS.length + 5; i++) {
        h.document.dispatch("keydown", keyEvent("ArrowDown"));
      }

      expect(h.selectedId()).toBe(COMMANDS[COMMANDS.length - 1].id); // clamped at the last
      // Exactly one option is selected at any time.
      const selectedCount = h.options().filter((o) => o.getAttribute("aria-selected") === "true").length;
      expect(selectedCount).toBe(1);
    });

    it("ArrowDown then ArrowUp moves the selection by one in each direction", () => {
      h.document.dispatch("keydown", hotkeyEvent());

      h.document.dispatch("keydown", keyEvent("ArrowDown"));
      expect(h.selectedId()).toBe(COMMANDS[1].id);
      h.document.dispatch("keydown", keyEvent("ArrowDown"));
      expect(h.selectedId()).toBe(COMMANDS[2].id);
      h.document.dispatch("keydown", keyEvent("ArrowUp"));
      expect(h.selectedId()).toBe(COMMANDS[1].id);
    });
  });

  // -------------------------------------------------------------------------
  // Property 1 + Property 6 — Enter invokes the selected command and closes (Req 7.7, 8.2)
  // -------------------------------------------------------------------------
  describe("Enter invokes the selected command then closes (Property 1 — Req 7.7, 8.2)", () => {
    it.each(COMMANDS)("filtering to '$label' and pressing Enter invokes $fn and closes", ({ label, fn }) => {
      h.document.dispatch("keydown", hotkeyEvent());
      h.type(label); // each label is a unique substring -> a single selected match

      h.document.dispatch("keydown", keyEvent("Enter"));

      // Property 1: the command delegates to the existing function, unchanged.
      expect(h.spies[fn]).toHaveBeenCalledTimes(1);
      // No other command function fired.
      for (const other of COMMANDS) {
        if (other.fn !== fn) expect(h.spies[other.fn]).not.toHaveBeenCalled();
      }
      // ...and the palette closed (Req 7.7).
      expect(h.dialog.hidden).toBe(true);
    });

    it("the palette closes BEFORE the command's run function is called (Req 14.5)", () => {
      let openWhenRun: boolean | null = null;
      let keydownWhenRun = -1;
      const baseKeydown = h.docListenerCount("keydown");
      // openProviderConfig is spied; capture overlay state at the moment it runs.
      h.spies["openProviderConfig"].mockImplementation(() => {
        openWhenRun = h.dialog.hidden === false;
        keydownWhenRun = h.docListenerCount("keydown");
      });

      h.document.dispatch("keydown", hotkeyEvent());
      h.type("Provider configuration");
      h.document.dispatch("keydown", keyEvent("Enter"));

      expect(openWhenRun).toBe(false); // dialog already hidden when run() fired
      expect(keydownWhenRun).toBe(baseKeydown); // per-open keydown listener already removed
    });
  });

  // -------------------------------------------------------------------------
  // Property 6 — Enter with no selection is a no-op (Req 7.8)
  // -------------------------------------------------------------------------
  describe("Enter with no selection (Property 6 — Req 7.8)", () => {
    it("pressing Enter on a no-results list takes no action and keeps the palette open", () => {
      h.document.dispatch("keydown", hotkeyEvent());
      h.type("zzz-no-such-command");
      expect(h.selectedId()).toBeNull();

      h.document.dispatch("keydown", keyEvent("Enter"));

      // No command invoked, palette remains open (Req 7.8).
      for (const { fn } of COMMANDS) expect(h.spies[fn]).not.toHaveBeenCalled();
      expect(h.dialog.hidden).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Property 6 — Escape and backdrop click close (Req 7.9, 7.10)
  // -------------------------------------------------------------------------
  describe("Escape / backdrop close (Property 6 — Req 7.9, 7.10)", () => {
    it("Escape closes the palette (Req 7.9)", () => {
      h.document.dispatch("keydown", hotkeyEvent());
      expect(h.dialog.hidden).toBe(false);

      h.document.dispatch("keydown", keyEvent("Escape"));

      expect(h.dialog.hidden).toBe(true);
    });

    it("activating the backdrop closes the palette (Req 7.10)", () => {
      h.document.dispatch("keydown", hotkeyEvent());
      expect(h.dialog.hidden).toBe(false);

      h.backdrop.dispatch("click", { target: h.backdrop });

      expect(h.dialog.hidden).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Property 9 — overlay listener hygiene (Req 7.9, 8.2, 14.5)
  // -------------------------------------------------------------------------
  describe("listener hygiene (Property 9 — Req 14.1, 14.2, 14.3, 14.5)", () => {
    it("open attaches exactly one document keydown + one backdrop click listener; close removes exactly those", () => {
      const baseKeydown = h.docListenerCount("keydown");
      const baseBackdrop = h.backdrop.listenerCount("click");

      h.document.dispatch("keydown", hotkeyEvent()); // open

      expect(h.docListenerCount("keydown")).toBe(baseKeydown + 1); // per-open keydown
      expect(h.backdrop.listenerCount("click")).toBe(baseBackdrop + 1); // per-open backdrop click

      h.document.dispatch("keydown", hotkeyEvent()); // close

      expect(h.docListenerCount("keydown")).toBe(baseKeydown); // back to baseline
      expect(h.backdrop.listenerCount("click")).toBe(baseBackdrop);
    });

    it("listener counts return to baseline after each close path (Cmd+K / Escape / backdrop / Enter)", () => {
      const baseKeydown = h.docListenerCount("keydown");
      const baseBackdrop = h.backdrop.listenerCount("click");
      const atBaseline = () =>
        h.docListenerCount("keydown") === baseKeydown && h.backdrop.listenerCount("click") === baseBackdrop;

      // 1) Cmd+K close.
      h.document.dispatch("keydown", hotkeyEvent());
      h.document.dispatch("keydown", hotkeyEvent());
      expect(atBaseline()).toBe(true);

      // 2) Escape close.
      h.document.dispatch("keydown", hotkeyEvent());
      h.document.dispatch("keydown", keyEvent("Escape"));
      expect(atBaseline()).toBe(true);

      // 3) Backdrop close.
      h.document.dispatch("keydown", hotkeyEvent());
      h.backdrop.dispatch("click", { target: h.backdrop });
      expect(atBaseline()).toBe(true);

      // 4) Enter (command invocation) close.
      h.document.dispatch("keydown", hotkeyEvent());
      h.type("Appearance");
      h.document.dispatch("keydown", keyEvent("Enter"));
      expect(atBaseline()).toBe(true);
    });

    it("a repeat open while already open attaches no additional listeners (Req 14.3)", () => {
      h.sandbox.openCommandPalette();
      const openKeydown = h.docListenerCount("keydown");
      const openBackdrop = h.backdrop.listenerCount("click");

      h.sandbox.openCommandPalette(); // already open -> must be a no-op for listeners

      expect(h.docListenerCount("keydown")).toBe(openKeydown);
      expect(h.backdrop.listenerCount("click")).toBe(openBackdrop);
    });

    it("the global Cmd/Ctrl+K hotkey is the persistent app-level listener (survives close)", () => {
      // While closed, exactly one persistent document keydown listener (the global hotkey) remains,
      // and it still toggles the palette open afterwards.
      const baseKeydown = h.docListenerCount("keydown");
      expect(baseKeydown).toBeGreaterThanOrEqual(1);

      h.document.dispatch("keydown", hotkeyEvent()); // open
      h.document.dispatch("keydown", hotkeyEvent()); // close
      expect(h.docListenerCount("keydown")).toBe(baseKeydown); // persistent listener intact

      // The persistent hotkey still works after a full open/close cycle.
      h.document.dispatch("keydown", hotkeyEvent());
      expect(h.dialog.hidden).toBe(false);
    });
  });
});
