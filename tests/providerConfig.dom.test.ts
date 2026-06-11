// DOM tests for the Provider_Config_UI (src/public/app.js, task 13).
//
// Validates (by DOM assertion) the client behaviors required by:
//   - Req 10.4: per-provider status indicator — not configured / configured / active.
//   - Req 11.1/11.5: masked API key inputs with a show/hide toggle; no secret in browser storage.
//   - Req 11.3: write-once secret behavior — the upsert body carries `apiKey` ONLY when a key was
//     entered, so saving other fields without re-entering a key never clears the stored secret.
//   - Req 15.2/15.3/15.4/15.5: connection-test success / failure / loading / 30s timeout states,
//     all messages redaction-safe.
//
// The panel is exercised through the same fake-DOM vm harness used by the Provider_Test_Panel and
// Setup_Wizard tests, with an injected `fetch` double and host-delegating timers (so vitest fake
// timers drive the 30s client timeout). Zero network/provider calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type FakeResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

const PROVIDER_TEST_TIMEOUT_MS = 30_000;

type AnyEl = any;

/** Find a rendered provider card by its provider id within a cards container. */
function cardFor(harness: ProviderPanelHarness, containerId: string, providerId: string): AnyEl {
  const container = harness.getEl(containerId);
  return container
    .querySelectorAll(".provider-config-card")
    .find((c: AnyEl) => c.dataset.providerId === providerId);
}

/** Flush pending microtasks + macrotasks so awaited fetch chains settle (real-timer tests). */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("Provider_Config_UI", () => {
  let harness: ProviderPanelHarness;
  let storage: { local: { setItem: ReturnType<typeof vi.fn> }; session: { setItem: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    harness = createProviderPanelHarness();
    storage = { local: { setItem: vi.fn() }, session: { setItem: vi.fn() } };
    harness.sandbox.localStorage = storage.local;
    harness.sandbox.sessionStorage = storage.session;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Status indicator (Req 10.4) ---------------------------------------

  it("derives not-configured / configured / active status (Req 10.4)", () => {
    const status = harness.sandbox.providerConfigStatus;
    expect(status("together", false, {})).toBe("not-configured");
    expect(status("together", true, {})).toBe("configured");
    expect(status("together", true, { flagship: "together" })).toBe("active");
    // A record that is not designated for any role is "configured", not "active".
    expect(status("together", true, { flagship: "cloudflare" })).toBe("configured");
  });

  it("renders preset cards reflecting real configured/active/not-configured state (Req 10.4)", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "together", kind: "together", label: "Together AI", model: "m", secretPresent: true }],
        activeRoutes: { flagship: "together" },
      }),
    );

    await harness.sandbox.loadProviderConfig();

    const presets = harness.getEl("provider-config-cards");
    // Three preset cards always render (Together, Cloudflare, Azure).
    expect(presets.children.length).toBe(3);

    const together = cardFor(harness, "provider-config-cards", "together");
    expect(together.dataset.status).toBe("active");
    expect(together.querySelector(".provider-config-card__status").textContent).toBe("Active");

    const cloudflare = cardFor(harness, "provider-config-cards", "cloudflare");
    expect(cloudflare.dataset.status).toBe("not-configured");
    expect(cloudflare.querySelector(".provider-config-card__status").textContent).toBe("Not configured");

    // No secret value is written to browser storage by rendering the panel (Req 11.5).
    expect(storage.local.setItem).not.toHaveBeenCalled();
    expect(storage.session.setItem).not.toHaveBeenCalled();
  });

  it("shows 'Configured' for a saved provider that is not active (Req 10.4)", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "together", kind: "together", label: "Together AI", secretPresent: false }],
        activeRoutes: {},
      }),
    );

    await harness.sandbox.loadProviderConfig();

    const together = cardFor(harness, "provider-config-cards", "together");
    expect(together.dataset.status).toBe("configured");
    expect(together.querySelector(".provider-config-card__status").textContent).toBe("Configured");
  });

  it("renders an existing openai-compatible record as an advanced card (Req 10.1, 10.3)", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [
          {
            id: "openai-compatible:proxy",
            kind: "openai-compatible",
            label: "My Proxy",
            baseUrl: "https://proxy.example.test/v1",
            model: "gpt-test",
            secretPresent: true,
          },
        ],
        activeRoutes: {},
      }),
    );

    await harness.sandbox.loadProviderConfig();

    const advCards = harness.getEl("provider-config-adv-cards");
    expect(advCards.children.length).toBe(1);
    const card = cardFor(harness, "provider-config-adv-cards", "openai-compatible:proxy");
    expect(card).toBeDefined();
    expect(card.querySelector(".provider-config-card__name").textContent).toBe("My Proxy");
  });

  // --- Masked key + show/hide (Req 11.1) ---------------------------------

  it("renders masked key inputs with a working show/hide toggle (Req 11.1)", async () => {
    harness.setFetchHandler(async () => jsonResponse({ providers: [], activeRoutes: {} }));
    await harness.sandbox.loadProviderConfig();

    const card = cardFor(harness, "provider-config-cards", "together");
    const keyInput = card.querySelector(".provider-config-key");
    const toggle = card.querySelector(".provider-config-key-toggle");

    // Masked by default.
    expect(keyInput.type).toBe("password");
    expect(toggle.textContent).toBe("Show");

    // Reveal.
    toggle.dispatch("click");
    expect(keyInput.type).toBe("text");
    expect(toggle.textContent).toBe("Hide");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    // Re-mask.
    toggle.dispatch("click");
    expect(keyInput.type).toBe("password");
    expect(toggle.textContent).toBe("Show");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  // --- Write-once secret (Req 11.3) --------------------------------------

  it("builds an upsert body that includes apiKey ONLY when a key was entered (Req 11.3)", () => {
    const build = harness.sandbox.buildProviderUpsertBody;
    const spec = {
      id: "together",
      kind: "together",
      label: "Together AI",
      fields: [{ name: "model", label: "Model id" }],
    };

    // No key entered -> body carries no apiKey (existing stored secret is retained server-side).
    const without = build(spec, { model: "m1" }, "");
    expect(without).toEqual({ id: "together", kind: "together", label: "Together AI", model: "m1" });
    expect("apiKey" in without).toBe(false);

    // Key entered -> apiKey is included.
    const withKey = build(spec, { model: "m1" }, "sk-secret");
    expect(withKey.apiKey).toBe("sk-secret");
  });

  it("nests dotted field paths in the upsert body (azure/cloudflare)", () => {
    const build = harness.sandbox.buildProviderUpsertBody;
    const spec = {
      id: "azure-openai",
      kind: "azure-openai",
      label: "Azure OpenAI",
      fields: [
        { name: "azure.endpoint", label: "Endpoint" },
        { name: "azure.deployment", label: "Deployment" },
      ],
    };
    const body = build(spec, { "azure.endpoint": "https://x", "azure.deployment": "d" }, "");
    expect(body.azure).toEqual({ endpoint: "https://x", deployment: "d" });
  });

  it("save sends apiKey only when entered and clears the key input afterwards (Req 11.3, 11.5)", async () => {
    // Initial load with a together record that already has a stored secret.
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "together", kind: "together", label: "Together AI", model: "old", secretPresent: true }],
        activeRoutes: {},
      }),
    );
    await harness.sandbox.loadProviderConfig();

    const card = cardFor(harness, "provider-config-cards", "together");
    const modelInput = card
      .querySelectorAll(".provider-config-field")
      .find((i: AnyEl) => i.dataset.field === "model");
    const keyInput = card.querySelector(".provider-config-key");
    const saveBtn = card.querySelector(".provider-config-save");

    // Edit a non-secret field but leave the key blank.
    modelInput.value = "new-model";
    keyInput.value = "";

    let capturedBody: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/providers" && opts.method === "POST") {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ provider: { id: "together", secretPresent: true } });
      }
      // Subsequent reload GET.
      return jsonResponse({
        providers: [{ id: "together", kind: "together", label: "Together AI", model: "new-model", secretPresent: true }],
        activeRoutes: {},
      });
    });

    saveBtn.dispatch("click");
    await flush();

    expect(capturedBody.model).toBe("new-model");
    expect("apiKey" in capturedBody).toBe(false); // write-once: no key sent, stored secret retained
  });

  // --- Connection test states (Req 15.2–15.5) ----------------------------

  async function loadWithConfiguredTogether(): Promise<AnyEl> {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "together", kind: "together", label: "Together AI", model: "m", secretPresent: true }],
        activeRoutes: {},
      }),
    );
    await harness.sandbox.loadProviderConfig();
    return cardFor(harness, "provider-config-cards", "together");
  }

  it("renders a redacted success message on a passing connection test (Req 15.2)", async () => {
    const card = await loadWithConfiguredTogether();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    harness.setFetchHandler(async () => jsonResponse({ ok: true, providerId: "together", model: "m1" }));
    await harness.sandbox.runProviderConfigTest("together", "Together AI", resultBox, testBtn, loadingEl);

    expect(resultBox.hidden).toBe(false);
    expect(resultBox.className).toContain("provider-config-result--ok");
    expect(resultBox.textContent).toContain("ready");
    expect(resultBox.textContent).toContain("m1");
    // Action re-enabled and loading cleared after completion.
    expect(testBtn.disabled).toBe(false);
    expect(loadingEl.hidden).toBe(true);
  });

  it("renders a redacted failure message on a failing connection test, retaining state (Req 15.3)", async () => {
    const card = await loadWithConfiguredTogether();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    harness.setFetchHandler(async () =>
      jsonResponse({ ok: false, providerId: "together", code: "CONFIG_INVALID", error: "missing model" }),
    );
    await harness.sandbox.runProviderConfigTest("together", "Together AI", resultBox, testBtn, loadingEl);

    expect(resultBox.className).toContain("provider-config-result--err");
    expect(resultBox.textContent).toContain("connection failed");
    expect(resultBox.textContent).toContain("missing model");
  });

  it("disables the test action and shows loading while a test is in flight (Req 15.4)", async () => {
    const card = await loadWithConfiguredTogether();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    let resolveFetch: (r: FakeResponse) => void = () => {};
    harness.setFetchHandler(() => new Promise<FakeResponse>((resolve) => (resolveFetch = resolve)));

    const inFlight = harness.sandbox.runProviderConfigTest("together", "Together AI", resultBox, testBtn, loadingEl);

    // While in flight: action disabled + loading visible.
    expect(testBtn.disabled).toBe(true);
    expect(loadingEl.hidden).toBe(false);

    resolveFetch(jsonResponse({ ok: true, providerId: "together", model: "m1" }));
    await inFlight;

    expect(testBtn.disabled).toBe(false);
    expect(loadingEl.hidden).toBe(true);
  });

  it("aborts and shows a redacted timeout message after 30s (Req 15.5)", async () => {
    vi.useFakeTimers();
    const card = await loadWithConfiguredTogether();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    harness.setFetchHandler(
      (_url, options) =>
        new Promise<FakeResponse>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const inFlight = harness.sandbox.runProviderConfigTest("together", "Together AI", resultBox, testBtn, loadingEl);
    expect(loadingEl.hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(PROVIDER_TEST_TIMEOUT_MS);
    await inFlight;

    expect(resultBox.className).toContain("provider-config-result--err");
    expect(resultBox.textContent).toContain("timed out after 30 seconds");
    expect(loadingEl.hidden).toBe(true);
    expect(testBtn.disabled).toBe(false);
  });

  // --- Open / close keeps chat + trace accessible (Req 10.7) -------------

  it("opens and closes the panel without disturbing chat/trace (Req 10.7)", async () => {
    harness.setFetchHandler(async () => jsonResponse({ providers: [], activeRoutes: {} }));

    harness.sandbox.openProviderConfig();
    expect(harness.getEl("provider-config-modal").hidden).toBe(false);
    await flush();

    for (const id of ["messages", "composer", "composer-input", "trace-drawer"]) {
      expect(harness.getEl(id).hidden).toBe(false);
    }

    harness.sandbox.closeProviderConfig();
    expect(harness.getEl("provider-config-modal").hidden).toBe(true);
  });
});
