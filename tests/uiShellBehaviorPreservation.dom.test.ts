// Behavior-preservation regression guard for the UI structural redesign (task 4.7).
// These are DOM-structural behavior checks (not a generative property-based library),
// per the design's Testing Strategy.
//
// Validates:
//   - Property 10 (Behavior preservation): the consumed subsystems re-homed into the new
//     shell must produce the SAME observable output for identical inputs as the pre-redesign
//     client, with differences limited to control location / shell layout.
//   - Requirements 16.1, 16.2, 16.3, 16.4, 16.5.
//
// Concretely this suite pins the observable contract of three pure/observable surfaces that the
// redesign merely moved (old `.chat__head` -> new `.topbar`):
//   * Trace docking via the existing `openTrace`/`closeTrace`/`toggleTrace` — open adds the
//     `.app.trace-open` class and sets `toggle-trace` `aria-pressed="true"`; close reverses both.
//     (Req 16.2, 16.3 — trace state unchanged by the relocation.)
//   * The run-status pill idle / active / failed states (`setRunStatus` + `statusPillClass`) —
//     identical `textContent` + `className` for identical inputs. (Req 16.2, 16.3, 16.5.)
//   * The live-connection badge live / polling / disconnected modes (`setLiveIndicator` with
//     "sse" / "polling" / "off") — identical `hidden`, `dataset.mode`, `.live-badge__text`, and
//     `title`. (Req 16.4 — the SSE->polling fallback still drives the same badge output.)
//
// app.js is a plain browser script (no module exports) that wires the UI and calls `init()` on
// load. Like the other *.dom.test.ts suites it is loaded into a `vm` context backed by a minimal
// fake DOM — no jsdom, no network. This harness extends that approach with the one extra the trace
// controller needs: a STABLE `.app` element returned by `document.querySelector(".app")` so the
// `trace-open` class set by `openTrace()` is observable by a later `closeTrace()`/`toggleTrace()`.
// `init()` runs with a stubbed fetch so `els` is populated by the real `cacheEls()`.
//
// The broader pipeline / SSE / cost / approval / provider suites are NOT rewritten here; this file
// pins the observable functions those suites exercise, and the "existing suites pass unchanged"
// half of Property 10 is satisfied by the full `vitest run` being green.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(HERE, "../src/public/app.js");

// ---------------------------------------------------------------------------
// Minimal fake DOM (deterministic; no jsdom). Mirrors the shapes app.js touches
// for the trace / run-status / live-indicator surfaces under test.
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
  value = "";
  type = "";
  title = "";

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

interface Harness {
  sandbox: any;
  document: any;
  getEl: (id: string) => FakeElement;
  /** Stable `.app` element returned by document.querySelector(".app"). */
  app: FakeElement;
  toggleTraceBtn: FakeElement;
  runStatus: FakeElement;
  liveIndicator: FakeElement;
  liveText: FakeElement;
}

function createHarness(): Harness {
  const registry = new Map<string, FakeElement>();
  const docListeners = new Map<string, Array<(ev: any) => void>>();

  const fakeDocument: any = {
    readyState: "loading", // defer init() until we're ready
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
    // STABLE `.app` element so trace-open survives across openTrace/closeTrace/toggleTrace.
    // Any other selector returns a throwaway element (none of the functions under test use them).
    querySelector: (sel: string) => {
      if (sel === ".app") return appEl;
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

  const appEl = new FakeElement("div");
  appEl.ownerDocument = fakeDocument;
  appEl.classList.add("app");

  fakeDocument.documentElement = fakeDocument.createElement("html");

  // Default fetch: serve init-time GETs with empty ok bodies so init() settles offline.
  const fetchHandler = async () => ({
    ok: true,
    status: 200,
    text: async () => "{}",
    json: async () => ({}),
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
    fetch: (_url: string, _options: any = {}) => fetchHandler(),
  };
  (sandbox as any).window = sandbox;
  (sandbox as any).globalThis = sandbox;

  const context = vm.createContext(sandbox);
  const source = readFileSync(APP_JS_PATH, "utf8");
  vm.runInContext(source, context, { filename: "app.js" });

  // Build the live-indicator with its `.live-badge__text` child BEFORE init, so setLiveIndicator's
  // querySelector(".live-badge__text") resolves like the real markup.
  const liveIndicator = fakeDocument.getElementById("live-indicator") as FakeElement;
  const liveText = fakeDocument.createElement("span");
  liveText.classList.add("live-badge__text");
  liveText.textContent = "LIVE";
  liveIndicator.appendChild(liveText);

  // Run init() now: app.js registered an init() DOMContentLoaded listener at load time (readyState
  // was "loading"); flipping to "complete" and dispatching fires init(), which calls cacheEls() and
  // binds the toggle-trace / close-trace click handlers.
  fakeDocument.readyState = "complete";
  fakeDocument.dispatch("DOMContentLoaded");

  const getEl = (id: string) => fakeDocument.getElementById(id) as FakeElement;

  return {
    sandbox,
    document: fakeDocument,
    getEl,
    app: appEl,
    toggleTraceBtn: getEl("toggle-trace"),
    runStatus: getEl("run-status"),
    liveIndicator,
    liveText,
  };
}

describe("UI shell behavior preservation (Property 10 — Req 16.1–16.5)", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    // nothing persistent to tear down
  });

  // -------------------------------------------------------------------------
  // Trace docking — openTrace / closeTrace / toggleTrace observable state
  // (Req 16.2, 16.3: trace state unchanged by the relocation into the shell.)
  // -------------------------------------------------------------------------
  describe("trace docking via openTrace/closeTrace/toggleTrace", () => {
    it("openTrace adds .trace-open to .app and sets toggle-trace aria-pressed=true", () => {
      expect(h.app.classList.contains("trace-open")).toBe(false);

      h.sandbox.openTrace();

      expect(h.app.classList.contains("trace-open")).toBe(true);
      expect(h.toggleTraceBtn.getAttribute("aria-pressed")).toBe("true");
    });

    it("closeTrace removes .trace-open from .app and sets toggle-trace aria-pressed=false", () => {
      h.sandbox.openTrace();
      expect(h.app.classList.contains("trace-open")).toBe(true);

      h.sandbox.closeTrace();

      expect(h.app.classList.contains("trace-open")).toBe(false);
      expect(h.toggleTraceBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("toggleTrace opens when closed and closes when open (same observable state both ways)", () => {
      // closed -> open
      h.sandbox.toggleTrace();
      expect(h.app.classList.contains("trace-open")).toBe(true);
      expect(h.toggleTraceBtn.getAttribute("aria-pressed")).toBe("true");

      // open -> closed
      h.sandbox.toggleTrace();
      expect(h.app.classList.contains("trace-open")).toBe(false);
      expect(h.toggleTraceBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("the toggle-trace and close-trace controls drive the same open/close functions", () => {
      // toggle-trace click opens (delegates to toggleTrace bound in init()).
      h.toggleTraceBtn.dispatch("click", {});
      expect(h.app.classList.contains("trace-open")).toBe(true);

      // close-trace click closes (delegates to closeTrace bound in init()).
      h.getEl("close-trace").dispatch("click", {});
      expect(h.app.classList.contains("trace-open")).toBe(false);
      expect(h.toggleTraceBtn.getAttribute("aria-pressed")).toBe("false");
    });
  });

  // -------------------------------------------------------------------------
  // Run-status pill — statusPillClass mapping + setRunStatus observable output
  // (Req 16.2, 16.3, 16.5: idle/active/failed states unchanged for identical inputs.)
  // -------------------------------------------------------------------------
  describe("run-status pill (statusPillClass + setRunStatus)", () => {
    // The phase/status -> pill-class contract that existed before the redesign.
    const PILL_CASES: Array<{ phase: any; runStatus: any; expected: string }> = [
      { phase: "FAILED", runStatus: undefined, expected: "status-pill--failed" },
      { phase: "ABORTED", runStatus: undefined, expected: "status-pill--failed" },
      { phase: undefined, runStatus: "failed", expected: "status-pill--failed" },
      { phase: undefined, runStatus: "aborted", expected: "status-pill--failed" },
      { phase: "NEEDS_DECISION", runStatus: undefined, expected: "status-pill--decision" },
      { phase: undefined, runStatus: "needs_decision", expected: "status-pill--decision" },
      { phase: "DONE", runStatus: undefined, expected: "status-pill--done" },
      { phase: undefined, runStatus: "completed", expected: "status-pill--done" },
      { phase: "PLANNING", runStatus: undefined, expected: "status-pill--running" },
      { phase: undefined, runStatus: undefined, expected: "status-pill--running" },
    ];

    it.each(PILL_CASES)(
      "statusPillClass(phase=$phase, runStatus=$runStatus) -> $expected",
      ({ phase, runStatus, expected }) => {
        expect(h.sandbox.statusPillClass(phase, runStatus)).toBe(expected);
      },
    );

    it("setRunStatus renders the idle state with identical textContent + className", () => {
      h.sandbox.setRunStatus("Idle", "status-pill--idle");
      expect(h.runStatus.textContent).toBe("Idle");
      expect(h.runStatus.className).toBe("status-pill status-pill--idle");
    });

    it("setRunStatus renders an active/in-progress state with identical textContent + className", () => {
      h.sandbox.setRunStatus("Thinking", "status-pill--running");
      expect(h.runStatus.textContent).toBe("Thinking");
      expect(h.runStatus.className).toBe("status-pill status-pill--running");
    });

    it("setRunStatus renders the failed state with identical textContent + className", () => {
      h.sandbox.setRunStatus("Failed", "status-pill--failed");
      expect(h.runStatus.textContent).toBe("Failed");
      expect(h.runStatus.className).toBe("status-pill status-pill--failed");
    });

    it("failed state is visibly distinct from idle and from in-progress phases (Req 16.5 / 2.4, 2.5)", () => {
      h.sandbox.setRunStatus("Idle", "status-pill--idle");
      const idle = h.runStatus.className;
      h.sandbox.setRunStatus("Thinking", "status-pill--running");
      const running = h.runStatus.className;
      h.sandbox.setRunStatus("Failed", "status-pill--failed");
      const failed = h.runStatus.className;

      expect(failed).not.toBe(idle);
      expect(failed).not.toBe(running);
      expect(idle).not.toBe(running);
    });
  });

  // -------------------------------------------------------------------------
  // Live-connection badge — setLiveIndicator observable output for each mode
  // (Req 16.4: SSE / polling-fallback / disconnected badge output unchanged.)
  // -------------------------------------------------------------------------
  describe("live-indicator badge (setLiveIndicator)", () => {
    it('"sse" (live streaming) shows the badge in LIVE mode with the streaming title', () => {
      h.sandbox.setLiveIndicator("sse");
      expect(h.liveIndicator.hidden).toBe(false);
      expect(h.liveIndicator.dataset.mode).toBe("sse");
      expect(h.liveText.textContent).toBe("LIVE");
      expect(h.liveIndicator.title).toBe("Live updates via streaming");
    });

    it('"polling" (fallback) shows the badge in POLLING mode with the polling title', () => {
      h.sandbox.setLiveIndicator("polling");
      expect(h.liveIndicator.hidden).toBe(false);
      expect(h.liveIndicator.dataset.mode).toBe("polling");
      expect(h.liveText.textContent).toBe("POLLING");
      expect(h.liveIndicator.title).toBe("Live updates via polling fallback");
    });

    it('"off" (disconnected) hides the badge and records the off mode', () => {
      // Put it into a visible state first to prove "off" actually hides it.
      h.sandbox.setLiveIndicator("sse");
      expect(h.liveIndicator.hidden).toBe(false);

      h.sandbox.setLiveIndicator("off");
      expect(h.liveIndicator.hidden).toBe(true);
      expect(h.liveIndicator.dataset.mode).toBe("off");
    });

    it("the SSE->polling fallback transition updates the badge to the polling mode (Req 16.4)", () => {
      // Mirrors the pre-redesign live-run flow: open SSE (live) then fall back to polling.
      h.sandbox.setLiveIndicator("sse");
      expect(h.liveText.textContent).toBe("LIVE");
      expect(h.liveIndicator.dataset.mode).toBe("sse");

      h.sandbox.setLiveIndicator("polling");
      expect(h.liveIndicator.hidden).toBe(false);
      expect(h.liveText.textContent).toBe("POLLING");
      expect(h.liveIndicator.dataset.mode).toBe("polling");
    });
  });
});
