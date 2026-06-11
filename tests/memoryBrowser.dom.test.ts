// DOM tests for the Memory browser panel (src/public/app.js, Chunk 36 stretch).
//
// Validates:
//   - GET /api/memory/entries when the panel opens
//   - layer filter buttons request episodic/core/all query params
//   - entries render with layer badges and redacted content
//
// Every `fetch` is served by an in-test double — zero network calls.
import { beforeEach, describe, expect, it } from "vitest";

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

class FakeElement {
  tagName: string;
  id = "";
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners: Map<string, Array<(ev: any) => void>> = new Map();
  dataset: Record<string, string> = {};
  private classes: Set<string> = new Set();
  private _textContent = "";
  hidden = false;
  value = "";

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
    if (name === "aria-pressed") this.dataset.ariaPressed = value;
  }
  getAttribute(name: string): string | null {
    if (name === "aria-pressed") return this.dataset.ariaPressed ?? null;
    return null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
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

  addEventListener(type: string, handler: (ev: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: any = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, ...ev });
  }
  focus() {
    /* no-op */
  }
}

interface MemoryBrowserHarness {
  sandbox: any;
  getEl: (id: string) => FakeElement;
  setFetchHandler: (handler: FetchHandler) => void;
}

function createMemoryBrowserHarness(): MemoryBrowserHarness {
  const registry = new Map<string, FakeElement>();
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

  const fakeDocument = {
    readyState: "complete",
    getElementById: (id: string) => getEl(id),
    createElement: (tag: string) => new FakeElement(tag),
    querySelector: (_sel: string) => new FakeElement("div"),
    addEventListener: () => {
      /* init runs inline */
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

  getEl("memory-browser-filter-all").dataset.layer = "";
  getEl("memory-browser-filter-episodic").dataset.layer = "episodic";
  getEl("memory-browser-filter-core").dataset.layer = "core";

  return {
    sandbox,
    getEl,
    setFetchHandler: (handler: FetchHandler) => {
      fetchHandler = handler;
    },
  };
}

const SAMPLE_PAYLOAD = {
  entries: [
    {
      id: "mem-1",
      layer: "episodic",
      content: "Remember to add pagination",
      timestamp: "2026-06-10T12:00:00.000Z",
      lastMentioned: "2026-06-10T12:00:00.000Z",
      accessCount: 1,
      tags: ["note"],
      source: "user-note",
      metadata: {},
    },
    {
      id: "mem-2",
      layer: "core",
      content: "[summary] Always redact secrets",
      timestamp: "2026-06-09T12:00:00.000Z",
      lastMentioned: "2026-06-09T12:00:00.000Z",
      accessCount: 3,
      tags: ["auto-summary"],
      source: "prune",
      metadata: {},
    },
  ],
  count: 2,
  provider: { id: "local-inmemory:default", kind: "local-inmemory", label: "Local (in-memory)" },
};

describe("Memory browser UI (Chunk 36 stretch)", () => {
  let harness: MemoryBrowserHarness;
  let calls: string[];

  beforeEach(() => {
    harness = createMemoryBrowserHarness();
    calls = [];
    harness.setFetchHandler(async (url) => {
      calls.push(url);
      if (url.startsWith("/api/memory/entries")) {
        return jsonResponse(SAMPLE_PAYLOAD);
      }
      return jsonResponse({});
    });
  });

  it("loads entries from GET /api/memory/entries when opened", async () => {
    await harness.sandbox.loadMemoryBrowser("");

    expect(calls.some((u) => u === "/api/memory/entries")).toBe(true);

    const list = harness.getEl("memory-browser-list");
    expect(list.hidden).toBe(false);
    expect(list.children).toHaveLength(2);

    const badges = list.querySelectorAll(".memory-browser__badge");
    expect(badges.map((b: FakeElement) => b.textContent)).toEqual(["Episodic", "Core"]);
  });

  it("requests episodic layer when the episodic filter is clicked", async () => {
    const episodicBtn = harness.getEl("memory-browser-filter-episodic");
    episodicBtn.dispatch("click");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toContain("/api/memory/entries?layer=episodic");
    expect(episodicBtn.classList.contains("memory-browser__filter--active")).toBe(true);
  });

  it("shows the empty state when no entries are returned", async () => {
    harness.setFetchHandler(async (url) => {
      calls.push(url);
      return jsonResponse({
        entries: [],
        count: 0,
        provider: { id: "local-inmemory:default", kind: "local-inmemory" },
      });
    });

    await harness.sandbox.loadMemoryBrowser("");
    expect(harness.getEl("memory-browser-empty").hidden).toBe(false);
    expect(harness.getEl("memory-browser-list").hidden).toBe(true);
  });

  it("renders entry content without leaking raw secrets from the payload", async () => {
    harness.setFetchHandler(async (url) => {
      calls.push(url);
      return jsonResponse({
        entries: [
          {
            id: "mem-secret",
            layer: "episodic",
            content: "token is [REDACTED]",
            timestamp: "2026-06-10T12:00:00.000Z",
            lastMentioned: "2026-06-10T12:00:00.000Z",
            accessCount: 1,
            tags: [],
            metadata: {},
          },
        ],
        count: 1,
        provider: { id: "local-inmemory:default", kind: "local-inmemory" },
      });
    });

    await harness.sandbox.loadMemoryBrowser("");
    const content = harness.getEl("memory-browser-list").querySelector(".memory-browser__content");
    expect(content?.textContent).toBe("token is [REDACTED]");
    expect(content?.textContent).not.toContain("sk-");
  });
});