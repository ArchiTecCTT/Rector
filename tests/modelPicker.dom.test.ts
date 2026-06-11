// DOM tests for the Setup_UI Model_Picker (src/public/app.js, task 12.1 / 12.4).
//
// Validates (by DOM assertion against the same fake-DOM vm harness used by the
// Provider_Config_UI tests) the client behaviors required by:
//   - Req 19.1/19.2/19.3: Discover + Refresh controls call the Discovery_API and the result's
//     `lastRefreshedAt` is rendered; Refresh hits the cache-bypassing refresh endpoint.
//   - Req 19.4: a classified discovery error renders the redacted message while manual entry stays.
//   - Req 21.1/21.2/21.3: per-role candidate selects plus an always-available manual override that
//     is retained (and resolvable) even when discovery returns no candidates.
//   - Req 22.3/22.4: a successful Model_Probe marks the role verified and a verified save persists
//     to the Active_Route_Map.
//   - Req 22.5: the verified save is gated when unverified, and the explicit "save unverified"
//     action requires a displayed warning before it proceeds.
//   - Req 24.2: the Azure provider renders the deployment-name explanation; non-Azure does not.
//
// Every `fetch` is served by an in-test double — zero network/provider calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type FakeResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

type AnyEl = any;

interface FetchCall {
  url: string;
  method: string;
  body: any;
}

/** Find a rendered provider card by its provider id within the preset cards container. */
function cardFor(harness: ProviderPanelHarness, providerId: string): AnyEl {
  const container = harness.getEl("provider-config-cards");
  return container
    .querySelectorAll(".provider-config-card")
    .find((c: AnyEl) => c.dataset.providerId === providerId);
}

/** Flush pending microtasks + macrotasks so awaited fetch chains settle. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("Model_Picker (Setup_UI model discovery + selection)", () => {
  let harness: ProviderPanelHarness;
  let calls: FetchCall[];

  beforeEach(() => {
    harness = createProviderPanelHarness();
    calls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Record every request the picker makes so tests can assert URL/method/body. */
  function recordCall(url: string, options: any): FetchCall {
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

  /**
   * Load the provider config with the given providers/active routes, then return the rendered card
   * and its Model_Picker section for `providerId`.
   */
  async function loadPickerFor(
    providerId: string,
    providers: any[],
    activeRoutes: Record<string, string> = {},
  ): Promise<{ card: AnyEl; section: AnyEl }> {
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);
      return jsonResponse({ providers, activeRoutes });
    });
    await harness.sandbox.loadProviderConfig();
    const card = cardFor(harness, providerId);
    const section = card.querySelector(".model-picker");
    return { card, section };
  }

  const togetherConfigured = [
    { id: "together", kind: "together", label: "Together AI", model: "m", secretPresent: true },
  ];

  function makeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      providerId: "together",
      kind: "together",
      scope: {},
      displayName: "Llama 3 70B",
      modelId: "meta-llama/Llama-3-70b",
      capabilities: ["chat", "text-generation"],
      requiresDeployment: false,
      requiresRegion: false,
      source: "native",
      lifecycle: "active",
      contextWindow: 8192,
      lastRefreshedAt: "2024-01-01T00:00:00Z",
      ...overrides,
    };
  }

  // --- Discover + lastRefreshedAt (Req 19.1, 19.2, 19.3) ------------------

  it("discovers models and renders lastRefreshedAt (Req 19.1, 19.2, 19.3)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);

    const discoverBtn = section.querySelector(".model-picker-discover");
    const refreshedEl = section.querySelector(".model-picker-refreshed");
    expect(discoverBtn.disabled).toBe(false); // enabled for a configured provider (Req 19.1)
    expect(refreshedEl.hidden).toBe(true);

    let discoveryUrl = "";
    let discoveryMethod = "";
    harness.setFetchHandler(async (url, options) => {
      discoveryUrl = url;
      discoveryMethod = (options && options.method) || "GET";
      return jsonResponse({ ok: true, candidates: [makeCandidate()], lastRefreshedAt: "2024-01-01T00:00:00Z" });
    });

    discoverBtn.dispatch("click");
    await flush();

    // GET to the discovery endpoint (Req 19.2).
    expect(discoveryUrl).toBe("/api/providers/together/models");
    expect(discoveryMethod).toBe("GET");

    // lastRefreshedAt is rendered (Req 19.3).
    expect(refreshedEl.hidden).toBe(false);
    expect(refreshedEl.textContent).toContain("2024-01-01T00:00:00Z");

    // The role <select>s are repopulated with the discovered candidate.
    const selects = section.querySelectorAll(".model-picker-role-select");
    expect(selects.length).toBe(2); // flagship + slm
    for (const select of selects) {
      expect(select.children.length).toBe(2); // placeholder + 1 candidate
      expect(select.children[1].value).toBe("meta-llama/Llama-3-70b");
    }
  });

  it("Refresh hits the cache-bypassing refresh endpoint (Req 19.2)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    const refreshBtn = section.querySelector(".model-picker-refresh");
    expect(refreshBtn.disabled).toBe(false);

    let refreshUrl = "";
    let refreshMethod = "";
    harness.setFetchHandler(async (url, options) => {
      refreshUrl = url;
      refreshMethod = (options && options.method) || "GET";
      return jsonResponse({ ok: true, candidates: [makeCandidate()], lastRefreshedAt: "2024-02-02T00:00:00Z" });
    });

    refreshBtn.dispatch("click");
    await flush();

    expect(refreshUrl).toBe("/api/providers/together/models/refresh");
    expect(refreshMethod).toBe("POST");
    expect(section.querySelector(".model-picker-refreshed").textContent).toContain("2024-02-02T00:00:00Z");
  });

  it("renders a redacted discovery error and keeps manual entry available (Req 19.4)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    const discoverBtn = section.querySelector(".model-picker-discover");
    const errorEl = section.querySelector(".model-picker-error");
    expect(errorEl.hidden).toBe(true);

    harness.setFetchHandler(async () =>
      jsonResponse(
        { ok: false, error: { category: "auth", message: "Authentication failed for this provider." } },
        { ok: false, status: 401 },
      ),
    );

    discoverBtn.dispatch("click");
    await flush();

    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("Authentication failed for this provider.");

    // Manual entry stays usable for every role (Req 19.4 / 21.2).
    const rows = section.querySelectorAll(".model-picker-role-row");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const manual = row.querySelector(".model-picker-role-manual");
      expect(manual).toBeDefined();
      expect(manual.disabled).toBe(false);
    }
  });

  // --- Role manual override retained with no candidates (Req 21.1–21.3) --

  it("retains a usable manual override for each role when discovery returns no candidates (Req 21.2, 21.3)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    const discoverBtn = section.querySelector(".model-picker-discover");

    harness.setFetchHandler(async () => jsonResponse({ ok: true, candidates: [], lastRefreshedAt: "2024-03-03T00:00:00Z" }));
    discoverBtn.dispatch("click");
    await flush();

    const rows = section.querySelectorAll(".model-picker-role-row");
    expect(rows.length).toBe(2); // flagship + slm (Req 21.1)

    for (const row of rows) {
      const select = row.querySelector(".model-picker-role-select");
      const manual = row.querySelector(".model-picker-role-manual");

      // No discovered options: only the empty-state placeholder remains.
      expect(select.children.length).toBe(1);
      expect(select.children[0].textContent).toContain("No models discovered");

      // The manual override is available and wins when used (Req 21.2/21.3).
      manual.value = "manual/model-id";
      const resolved = harness.sandbox.resolveRoleSelection(row, false);
      expect(resolved.model).toBe("manual/model-id");
    }
  });

  // --- Verified probe + verified save (Req 22.3, 22.4) -------------------

  it("marks a role verified on a successful probe and persists a verified save (Req 22.3, 22.4)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    const row = section.querySelectorAll(".model-picker-role-row")[0]; // flagship
    const manual = row.querySelector(".model-picker-role-manual");
    const verifyEl = row.querySelector(".model-picker-role-verify");
    const testBtn = row.querySelector(".model-picker-role-test");
    const saveBtn = row.querySelector(".model-picker-role-save");
    const resultBox = section.querySelector(".model-picker-result");

    manual.value = "meta-llama/Llama-3-70b";
    expect(verifyEl.textContent).toBe("Unverified");

    // Probe succeeds via the existing Connection_Test_Service path (Req 22.1/22.2 → 22.3).
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);
      return jsonResponse({ ok: true, providerId: "together", model: "meta-llama/Llama-3-70b" });
    });
    testBtn.dispatch("click");
    await flush();

    const probeCall = calls.find((c) => c.url === "/api/setup/test-connection");
    expect(probeCall).toBeDefined();
    expect(probeCall!.body.model).toBe("meta-llama/Llama-3-70b");
    expect(verifyEl.textContent).toContain("Verified");
    expect(verifyEl.className).toContain("is-verified");

    // A verified save persists the model and designates the active route (Req 22.4).
    calls = [];
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);
      if (url === "/api/providers" && options.method === "GET") {
        return jsonResponse({ providers: togetherConfigured, activeRoutes: { flagship: "together" } });
      }
      return jsonResponse({ ok: true, provider: { id: "together" } });
    });
    saveBtn.dispatch("click");
    await flush();

    const upsert = calls.find((c) => c.url === "/api/providers" && c.method === "POST");
    const activate = calls.find((c) => c.url === "/api/providers/active" && c.method === "POST");
    expect(upsert).toBeDefined();
    expect(upsert!.body.model).toBe("meta-llama/Llama-3-70b");
    expect(activate).toBeDefined();
    expect(activate!.body).toEqual({ role: "flagship", providerId: "together" });
    expect(resultBox.textContent).toContain("(verified)");
  });

  it("blocks a verified save while the selection is unverified (Req 22.5)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    const row = section.querySelectorAll(".model-picker-role-row")[0];
    const manual = row.querySelector(".model-picker-role-manual");
    const saveBtn = row.querySelector(".model-picker-role-save");
    const resultBox = section.querySelector(".model-picker-result");

    manual.value = "meta-llama/Llama-3-70b";

    calls = [];
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);
      return jsonResponse({ ok: true });
    });
    saveBtn.dispatch("click");
    await flush();

    // No persistence happened; the user is told to test first or save unverified.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
    expect(resultBox.className).toContain("provider-config-result--err");
    expect(resultBox.textContent).toContain("Test the model first");
  });

  // --- Verified/unverified save warning gate (Req 22.5) ------------------

  it("requires a displayed warning before an unverified save proceeds (Req 22.5)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    const row = section.querySelectorAll(".model-picker-role-row")[0];
    const manual = row.querySelector(".model-picker-role-manual");
    const warning = row.querySelector(".model-picker-role-warning");
    const saveUnverifiedBtn = row.querySelector(".model-picker-role-save-unverified");
    const resultBox = section.querySelector(".model-picker-result");

    manual.value = "meta-llama/Llama-3-70b";
    expect(warning.hidden).toBe(true);

    // First activation only reveals the warning and arms confirmation — it does NOT persist.
    calls = [];
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);
      return jsonResponse({ ok: true });
    });
    saveUnverifiedBtn.dispatch("click");
    await flush();

    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain("has not been verified");
    expect(saveUnverifiedBtn.textContent).toContain("Confirm");
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();

    // Second activation (after the warning is shown) proceeds with the unverified save.
    calls = [];
    harness.setFetchHandler(async (url, options) => {
      recordCall(url, options);
      if (url === "/api/providers" && options.method === "GET") {
        return jsonResponse({ providers: togetherConfigured, activeRoutes: {} });
      }
      return jsonResponse({ ok: true, provider: { id: "together" } });
    });
    saveUnverifiedBtn.dispatch("click");
    await flush();

    const upsert = calls.find((c) => c.url === "/api/providers" && c.method === "POST");
    const activate = calls.find((c) => c.url === "/api/providers/active" && c.method === "POST");
    expect(upsert).toBeDefined();
    expect(activate).toBeDefined();
    expect(resultBox.textContent).toContain("(unverified)");
    expect(warning.hidden).toBe(true); // gate reset after the save
  });

  // --- Azure deployment-name explanation (Req 24.2) ----------------------

  it("renders the Azure deployment-name explanation for an Azure provider (Req 24.2)", async () => {
    const azureConfigured = [
      {
        id: "azure-openai",
        kind: "azure-openai",
        label: "Azure OpenAI",
        secretPresent: true,
      },
    ];
    const { section } = await loadPickerFor("azure-openai", azureConfigured);

    const note = section.querySelector(".model-picker-azure-note");
    expect(note).toBeDefined();
    expect(note.textContent).toContain("deployment name");
    expect(note.textContent).toContain("do not enumerate your deployments");
  });

  it("does not render the Azure explanation for a non-Azure provider (Req 24.2)", async () => {
    const { section } = await loadPickerFor("together", togetherConfigured);
    expect(section.querySelector(".model-picker-azure-note")).toBeNull();
  });
});
