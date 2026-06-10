// DOM tests for episodic notes quick-capture UI (src/public/app.js, Chunk 036 Wave 2B).
//
// Validates:
//   - POST /api/notes with note content on submit
//   - Inline success/error confirmation in #note-capture-status
//   - Sidebar launcher and Ctrl/Cmd+Shift+N focus the capture input
//   - Whitespace-only input does not POST
//
// Every `fetch` is served by an in-test double — zero network calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(HERE, "../src/public/app.js");

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): FakeResponse {
  const status = init.status ?? (init.ok === false ? 400 : 200);
  const ok = init.ok ?? (status >= 200 && status < 300);
  const text = JSON.stringify(body ?? {});
  return { ok, status, text: async () => text };
}

type FetchHandler = (url: string, options: any) => Promise<FakeResponse>;

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

  addEventListener(type: string, handler: (ev: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: any = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, ...ev });
  }
}

interface NotesCaptureHarness {
  sandbox: any;
  document: FakeDoc & {
    dispatch: (type: string, ev?: any) => void;
  };
  getEl: (id: string) => FakeElement;
  setFetchHandler: (handler: FetchHandler) => void;
}

function createNotesCaptureHarness(): NotesCaptureHarness {
  const registry = new Map<string, FakeElement>();
  const docListeners = new Map<string, Array<(ev: any) => void>>();

  const getEl = (id: string): FakeElement => {
    let el = registry.get(id);
    if (!el) {
      el = new FakeElement("div");
      el.id = id;
      registry.set(id, el);
    }
    return el;
  };

  let fetchHandler: FetchHandler = async () => jsonResponse({});

  const fakeDocument: any = {
    readyState: "complete",
    activeElement: null as FakeElement | null,
    getElementById: (id: string) => {
      const el = getEl(id);
      el.ownerDocument = fakeDocument;
      return el;
    },
    createElement: (tag: string) => {
      const el = new FakeElement(tag);
      el.ownerDocument = fakeDocument;
      return el;
    },
    querySelector: (_sel: string) => new FakeElement("div"),
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

  const sandbox: Record<string, unknown> = {
    document: fakeDocument,
    window: {},
    console,
    setTimeout: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => globalThis.setTimeout(fn, ms, ...args),
    clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
    setInterval: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => globalThis.setInterval(fn, ms, ...args),
    clearInterval: (handle: any) => globalThis.clearInterval(handle),
    AbortController: globalThis.AbortController,
    fetch: (url: string, options: any = {}) => fetchHandler(url, options),
  };
  (sandbox as any).window = sandbox;
  (sandbox as any).globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = readFileSync(APP_JS_PATH, "utf8");
  vm.runInContext(source, context, { filename: "app.js" });

  return {
    sandbox,
    document: fakeDocument,
    getEl,
    setFetchHandler: (handler: FetchHandler) => {
      fetchHandler = handler;
    },
  };
}

function noteHotkeyEvent(): Record<string, unknown> {
  return { key: "N", ctrlKey: true, metaKey: false, shiftKey: true, preventDefault: vi.fn() };
}

describe("Notes quick-capture UI (Chunk 036 Wave 2B)", () => {
  let harness: NotesCaptureHarness;
  let calls: Array<{ url: string; method: string; body: any }>;

  beforeEach(() => {
    harness = createNotesCaptureHarness();
    calls = [];
    harness.setFetchHandler(async (url, options) => {
      let body: any;
      try {
        body = options && typeof options.body === "string" ? JSON.parse(options.body) : undefined;
      } catch {
        body = options?.body;
      }
      calls.push({ url, method: (options && options.method) || "GET", body });
      if (url === "/api/notes") {
        return jsonResponse({ note: { id: "note-1", content: body?.content } }, { status: 201 });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("POSTs note content to /api/notes and shows a success confirmation", async () => {
    await harness.sandbox.submitQuickNote("Remember to add pagination");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/notes");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ content: "Remember to add pagination" });

    const status = harness.getEl("note-capture-status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("Note saved");
    expect(status.className).toContain("note-capture__status--ok");
  });

  it("shows an error confirmation when the API rejects the note", async () => {
    harness.setFetchHandler(async (url, options) => {
      let body: any;
      try {
        body = options && typeof options.body === "string" ? JSON.parse(options.body) : undefined;
      } catch {
        body = options?.body;
      }
      calls.push({ url, method: (options && options.method) || "GET", body });
      return jsonResponse({ error: "content (string) is required" }, { ok: false, status: 400 });
    });

    await harness.sandbox.submitQuickNote("   ");

    expect(calls).toHaveLength(0);

    await harness.sandbox.submitQuickNote("Broken note");

    expect(calls).toHaveLength(1);
    const status = harness.getEl("note-capture-status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("content (string) is required");
    expect(status.className).toContain("note-capture__status--err");
  });

  it("focuses the capture input on Ctrl/Cmd+Shift+N", () => {
    const input = harness.getEl("note-capture-input");
    harness.document.dispatch("keydown", noteHotkeyEvent());
    expect(harness.document.activeElement).toBe(input);
  });

  it("focuses the capture input when the sidebar Note button is clicked", () => {
    const input = harness.getEl("note-capture-input");
    harness.getEl("open-note-capture").dispatch("click");
    expect(harness.document.activeElement).toBe(input);
  });

  it("clears the input after a successful save", async () => {
    const input = harness.getEl("note-capture-input");
    input.value = "Ephemeral thought";
    await harness.sandbox.submitQuickNote();
    expect(input.value).toBe("");
  });
});