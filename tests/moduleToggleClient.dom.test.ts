// Client contract test for module toggle (src/public/app.js).
// Pins that toggleModule POSTs to "/api/modules" (not a per-id path) with body {moduleId, enabled}.
// Uses the existing providerPanelHarness vm sandbox (no jsdom, no new deps).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

interface FetchCall {
  url: string;
  method: string;
  body: any;
}

/** Flush pending microtasks + macrotasks so awaited fetch chains settle. */
async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("Module toggle client contract", () => {
  let harness: ProviderPanelHarness;
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
    harness = createProviderPanelHarness();
    harness.setFetchHandler(async (url, options) => {
      let body: any;
      try {
        body = options && typeof options.body === "string" ? JSON.parse(options.body) : undefined;
      } catch {
        body = options?.body;
      }
      calls.push({ url, method: (options && options.method) || "GET", body });
      return jsonResponse({ ok: true });
    });
  });

  afterEach(() => {
    /* no shared state */
  });

  it("posts toggle to /api/modules (not per-id path) with correct body", async () => {
    const checkbox = { checked: true } as any;
    await harness.sandbox.toggleModule("@rector/some-module", true, checkbox);
    await flush();

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.url).toBe("/api/modules");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ moduleId: "@rector/some-module", enabled: true });
  });
});
