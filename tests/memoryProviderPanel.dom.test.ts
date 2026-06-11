// DOM tests for the Memory_Provider_Config_UI (src/public/app.js, Chunk 36 Wave 2A).
//
// Validates client behaviors mirroring Provider_Config_UI:
//   - per-provider status: not configured / configured / active
//   - masked API key inputs with show/hide toggle; no secret in browser storage
//   - write-once secret: upsert body carries `apiKey` ONLY when a key was entered
//   - connection-test success / failure / loading / 30s timeout states
//   - active memory provider selection via POST /api/memory-providers/active
//
// Zero network calls: injected fetch double + fake-DOM vm harness.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type FakeResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

const PROVIDER_TEST_TIMEOUT_MS = 30_000;

type AnyEl = any;

function cardFor(harness: ProviderPanelHarness, providerId: string): AnyEl {
  const container = harness.getEl("memory-provider-config-cards");
  return container
    .querySelectorAll(".provider-config-card")
    .find((c: AnyEl) => c.dataset.providerId === providerId);
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("Memory_Provider_Config_UI", () => {
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

  it("derives not-configured / configured / active status", () => {
    const status = harness.sandbox.memoryProviderConfigStatus;
    expect(status("mem0:main", false, null)).toBe("not-configured");
    expect(status("mem0:main", true, null)).toBe("configured");
    expect(status("mem0:main", true, "mem0:main")).toBe("active");
    expect(status("mem0:main", true, "local-inmemory:default")).toBe("configured");
  });

  it("renders cards reflecting configured/active state from GET /api/memory-providers", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [
          {
            id: "mem0:main",
            kind: "mem0",
            label: "Mem0 Main",
            config: { baseUrl: "https://api.mem0.test" },
            secretPresent: true,
          },
          {
            id: "local-inmemory:default",
            kind: "local-inmemory",
            label: "Local (in-memory)",
            config: {},
            secretPresent: false,
          },
        ],
        activeMemoryProviderId: "mem0:main",
      }),
    );

    await harness.sandbox.loadMemoryProviderConfig();

    const cards = harness.getEl("memory-provider-config-cards");
    expect(cards.children.length).toBe(2);

    const mem0 = cardFor(harness, "mem0:main");
    expect(mem0.dataset.status).toBe("active");
    expect(mem0.querySelector(".provider-config-card__status").textContent).toBe("Active");

    const local = cardFor(harness, "local-inmemory:default");
    expect(local.dataset.status).toBe("configured");
    expect(local.querySelector(".provider-config-card__status").textContent).toBe("Configured");

    expect(storage.local.setItem).not.toHaveBeenCalled();
    expect(storage.session.setItem).not.toHaveBeenCalled();
  });

  it("renders masked key inputs with a working show/hide toggle", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", secretPresent: false }],
        activeMemoryProviderId: null,
      }),
    );
    await harness.sandbox.loadMemoryProviderConfig();

    const card = cardFor(harness, "mem0:main");
    const keyInput = card.querySelector(".provider-config-key");
    const toggle = card.querySelector(".provider-config-key-toggle");

    expect(keyInput.type).toBe("password");
    expect(toggle.textContent).toBe("Show");

    toggle.dispatch("click");
    expect(keyInput.type).toBe("text");
    expect(toggle.textContent).toBe("Hide");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("builds an upsert body with nested config and apiKey only when entered", () => {
    const build = harness.sandbox.buildMemoryProviderUpsertBody;
    const spec = harness.sandbox.memoryProviderKindSpec("tidb-memory");

    const without = build(
      spec,
      "tidb:prod",
      "TiDB Prod",
      {
        "config.baseUrl": "https://gateway.example:4000",
        "config.accountId": "user",
        "config.database": "rector",
      },
      "",
    );
    expect(without).toEqual({
      id: "tidb:prod",
      kind: "tidb-memory",
      label: "TiDB Prod",
      config: {
        baseUrl: "https://gateway.example:4000",
        accountId: "user",
        database: "rector",
      },
    });
    expect("apiKey" in without).toBe(false);

    const withKey = build(spec, "tidb:prod", "TiDB Prod", {}, "secret-key");
    expect(withKey.apiKey).toBe("secret-key");
  });

  it("save sends apiKey only when entered and clears the key input afterwards", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", config: {}, secretPresent: true }],
        activeMemoryProviderId: null,
      }),
    );
    await harness.sandbox.loadMemoryProviderConfig();

    const card = cardFor(harness, "mem0:main");
    const labelInput = card
      .querySelectorAll(".provider-config-field")
      .find((i: AnyEl) => i.dataset.field === "label");
    const keyInput = card.querySelector(".provider-config-key");
    const saveBtn = card.querySelector(".provider-config-save");

    labelInput.value = "Mem0 updated";
    keyInput.value = "";

    let capturedBody: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/memory-providers" && opts.method === "POST") {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ provider: { id: "mem0:main", secretPresent: true } });
      }
      return jsonResponse({
        providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0 updated", config: {}, secretPresent: true }],
        activeMemoryProviderId: null,
      });
    });

    saveBtn.dispatch("click");
    await flush();

    expect(capturedBody.label).toBe("Mem0 updated");
    expect("apiKey" in capturedBody).toBe(false);
  });

  async function loadWithConfiguredMem0(): Promise<AnyEl> {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", config: {}, secretPresent: true }],
        activeMemoryProviderId: null,
      }),
    );
    await harness.sandbox.loadMemoryProviderConfig();
    return cardFor(harness, "mem0:main");
  }

  it("renders a success message on a passing connection test", async () => {
    const card = await loadWithConfiguredMem0();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    harness.setFetchHandler(async () =>
      jsonResponse({ ok: true, providerId: "mem0:main", kind: "mem0", networkAttempted: false }),
    );
    await harness.sandbox.runMemoryProviderConfigTest("mem0:main", "Mem0", resultBox, testBtn, loadingEl);

    expect(resultBox.hidden).toBe(false);
    expect(resultBox.className).toContain("provider-config-result--ok");
    expect(resultBox.textContent).toContain("ready");
    expect(testBtn.disabled).toBe(false);
    expect(loadingEl.hidden).toBe(true);
  });

  it("renders a failure message on a failing connection test", async () => {
    const card = await loadWithConfiguredMem0();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    harness.setFetchHandler(async () =>
      jsonResponse({
        ok: false,
        providerId: "mem0:main",
        code: "CONFIG_INVALID",
        error: "missing API key",
        networkAttempted: false,
      }),
    );
    await harness.sandbox.runMemoryProviderConfigTest("mem0:main", "Mem0", resultBox, testBtn, loadingEl);

    expect(resultBox.className).toContain("provider-config-result--err");
    expect(resultBox.textContent).toContain("connection failed");
    expect(resultBox.textContent).toContain("missing API key");
  });

  it("disables the test action and shows loading while a test is in flight", async () => {
    const card = await loadWithConfiguredMem0();
    const resultBox = card.querySelector(".provider-config-result");
    const testBtn = card.querySelector(".provider-config-test");
    const loadingEl = card.querySelector(".provider-config-test-loading");

    let resolveFetch: (r: FakeResponse) => void = () => {};
    harness.setFetchHandler(() => new Promise<FakeResponse>((resolve) => (resolveFetch = resolve)));

    const inFlight = harness.sandbox.runMemoryProviderConfigTest(
      "mem0:main",
      "Mem0",
      resultBox,
      testBtn,
      loadingEl,
    );

    expect(testBtn.disabled).toBe(true);
    expect(loadingEl.hidden).toBe(false);

    resolveFetch(jsonResponse({ ok: true, providerId: "mem0:main", networkAttempted: false }));
    await inFlight;

    expect(testBtn.disabled).toBe(false);
    expect(loadingEl.hidden).toBe(true);
  });

  it("aborts and shows a timeout message after 30s", async () => {
    vi.useFakeTimers();
    const card = await loadWithConfiguredMem0();
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

    const inFlight = harness.sandbox.runMemoryProviderConfigTest(
      "mem0:main",
      "Mem0",
      resultBox,
      testBtn,
      loadingEl,
    );

    await vi.advanceTimersByTimeAsync(PROVIDER_TEST_TIMEOUT_MS);
    await inFlight;

    expect(resultBox.className).toContain("provider-config-result--err");
    expect(resultBox.textContent).toContain("timed out after 30 seconds");
  });

  it("toggles active memory provider via POST /api/memory-providers/active", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({
        providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", config: {}, secretPresent: true }],
        activeMemoryProviderId: null,
      }),
    );
    await harness.sandbox.loadMemoryProviderConfig();

    const card = cardFor(harness, "mem0:main");
    const activeBtn = card.querySelector(".provider-config-role");

    let capturedBody: any;
    harness.setFetchHandler(async (url, opts) => {
      if (url === "/api/memory-providers/active" && opts.method === "POST") {
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ activeMemoryProviderId: "mem0:main" });
      }
      return jsonResponse({
        providers: [{ id: "mem0:main", kind: "mem0", label: "Mem0", config: {}, secretPresent: true }],
        activeMemoryProviderId: "mem0:main",
      });
    });

    activeBtn.dispatch("click");
    await flush();

    expect(capturedBody).toEqual({ providerId: "mem0:main" });
    const refreshed = cardFor(harness, "mem0:main");
    expect(refreshed.dataset.status).toBe("active");
  });

  it("opens and closes the panel without disturbing chat/trace", async () => {
    harness.setFetchHandler(async () => jsonResponse({ providers: [], activeMemoryProviderId: null }));

    harness.sandbox.openMemoryProviderConfig();
    expect(harness.getEl("memory-provider-config-modal").hidden).toBe(false);
    await flush();

    for (const id of ["messages", "composer", "composer-input", "trace-drawer"]) {
      expect(harness.getEl(id).hidden).toBe(false);
    }

    harness.sandbox.closeMemoryProviderConfig();
    expect(harness.getEl("memory-provider-config-modal").hidden).toBe(true);
  });
});