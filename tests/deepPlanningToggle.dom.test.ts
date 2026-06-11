// DOM tests for the opt-in Deep planning toggle (src/public/app.js, Chunk 36 Wave 2D).
//
// Validates:
//   - The toggle is hidden in Local mode and visible in External mode (setup status mode detection).
//   - Chat POST includes deepPlanning: true only when the toggle is enabled in External mode.
//   - The preference persists to localStorage["rector.deepPlanning"] (non-secret boolean string).
//
// Every `fetch` is served by an in-test double — zero network/provider calls.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type FakeResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

const DEEP_PLANNING_STORAGE_KEY = "rector.deepPlanning";

interface FetchCall {
  url: string;
  method: string;
  body: any;
}

function statusResponse(mode: "local" | "external") {
  return {
    mode,
    categories: [
      { category: "provider", status: "Ready", detail: "Provider configured." },
      { category: "persistence", status: "Ready", detail: "SQLite default in use." },
      { category: "workspace", status: "Ready", detail: "Workspace root set." },
      { category: "budget", status: "Ready", detail: "Budget configured." },
      { category: "memory", status: "Ready", detail: "Local in-memory provider active." },
    ],
  };
}

/** Flush pending microtasks + macrotasks so awaited fetch chains settle. */
async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function wireDeepPlanningElements(harness: ProviderPanelHarness): void {
  const toggle = harness.getEl("deep-planning-toggle");
  toggle.type = "checkbox";
}

describe("Deep planning toggle (external mode chat)", () => {
  let harness: ProviderPanelHarness;
  let calls: FetchCall[];
  let storage: Map<string, string>;

  beforeEach(() => {
    calls = [];
    storage = new Map();
    harness = createProviderPanelHarness();
    wireDeepPlanningElements(harness);
    harness.sandbox.localStorage = {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
    };
  });

  afterEach(() => {
    /* no shared timers */
  });

  function recordCall(url: string, options: any = {}): FetchCall {
    let body: any;
    try {
      body = options && typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    } catch {
      body = options?.body;
    }
    const call = { url, method: (options && options.method) || "GET", body };
    calls.push(call);
    return call;
  }

  function installFetch(mode: "local" | "external") {
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);

      if (url === "/api/setup/status") {
        return jsonResponse(statusResponse(mode));
      }
      if (url === "/api/setup") {
        return jsonResponse({ ok: true });
      }
      if (url === "/api/chat/conversations?workspaceId=browser") {
        return jsonResponse({ conversations: [] });
      }
      if (url === "/api/chat/conversations" && options?.method === "POST") {
        return jsonResponse({ id: "conv-1", title: "New conversation", workspaceId: "browser" });
      }
      if (url.includes("/messages?stream=1") && options?.method === "POST") {
        return jsonResponse({
          assistantMessage: { id: "msg-1", content: "Done." },
          run: { phase: "DONE", status: "completed" },
        });
      }
      return jsonResponse({});
    });
  }

  it("hides the toggle in Local mode after orchestration mode refresh", async () => {
    installFetch("local");
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    expect(harness.getEl("deep-planning-wrap").hidden).toBe(true);
  });

  it("shows the toggle in External mode after orchestration mode refresh", async () => {
    installFetch("external");
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    expect(harness.getEl("deep-planning-wrap").hidden).toBe(false);
    expect(harness.getEl("deep-planning-toggle").type).toBe("checkbox");
  });

  it("restores the persisted preference from localStorage on bind", async () => {
    storage.set(DEEP_PLANNING_STORAGE_KEY, "true");
    installFetch("external");
    harness.sandbox.bindDeepPlanning();
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    expect(harness.getEl("deep-planning-toggle").checked).toBe(true);
  });

  it("persists toggle changes to localStorage", async () => {
    installFetch("external");
    harness.sandbox.bindDeepPlanning();
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    const toggle = harness.getEl("deep-planning-toggle");
    toggle.checked = true;
    toggle.dispatch("change");

    expect(storage.get(DEEP_PLANNING_STORAGE_KEY)).toBe("true");

    toggle.checked = false;
    toggle.dispatch("change");

    expect(storage.get(DEEP_PLANNING_STORAGE_KEY)).toBe("false");
  });

  it("includes deepPlanning: true on chat POST when enabled in External mode", async () => {
    storage.set(DEEP_PLANNING_STORAGE_KEY, "true");
    installFetch("external");
    harness.sandbox.bindDeepPlanning();
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    await harness.sandbox.sendMessage("Plan this refactor");
    await flush();

    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/messages?stream=1"),
    );
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ content: "Plan this refactor", deepPlanning: true });
  });

  it("omits deepPlanning on chat POST when the toggle is disabled", async () => {
    storage.set(DEEP_PLANNING_STORAGE_KEY, "false");
    installFetch("external");
    harness.sandbox.bindDeepPlanning();
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    await harness.sandbox.sendMessage("Quick question");
    await flush();

    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/messages?stream=1"),
    );
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ content: "Quick question" });
    expect(post?.body).not.toHaveProperty("deepPlanning");
  });

  it("does not send deepPlanning in Local mode even when the preference is true", async () => {
    storage.set(DEEP_PLANNING_STORAGE_KEY, "true");
    installFetch("local");
    harness.sandbox.bindDeepPlanning();
    await harness.sandbox.refreshOrchestrationMode();
    await flush();

    expect(harness.getEl("deep-planning-wrap").hidden).toBe(true);

    await harness.sandbox.sendMessage("Should not deep plan");
    await flush();

    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/messages?stream=1"),
    );
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ content: "Should not deep plan" });
    expect(post?.body).not.toHaveProperty("deepPlanning");
  });
});