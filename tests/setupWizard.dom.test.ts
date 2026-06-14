// DOM/snapshot tests for the Setup_Wizard panel (src/public/app.js, task 3.1).
//
// Validates (by example/DOM assertion): Requirements 1.5, 1.6, 1.7, 1.8, 1.9
//   - 1.1/1.2: the wizard renders the orchestration mode plus exactly one readiness pill per
//     configuration category (provider, persistence, workspace, budget, memory).
//   - 1.5: the wizard writes no secret values to localStorage/sessionStorage (it touches no storage).
//   - 1.6: the wizard renders no configuration-mutation controls (no inputs/buttons in the pills).
//   - 1.7: while the wizard is displayed (including error/timeout states) the chat and trace UI stay
//     mounted and accessible.
//   - 1.8: an API error / malformed response shows an error state, chat/trace still accessible.
//   - 1.9: no response within 10s shows a timeout error state, chat/trace still accessible.
//
// The wizard is exercised through the same fake-DOM vm harness used by the Provider_Test_Panel
// tests, with an injected `fetch` double and host-delegating timers. Zero network/provider calls;
// the 10s client timeout is driven by fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type FakeResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

const SETUP_STATUS_TIMEOUT_MS = 10_000;

// A redacted, value-free SetupStatusResponse with one entry per category and the closed-set
// readiness values exercised across all three styles (Ready / Incomplete / Error).
function statusResponse(mode: "local" | "external") {
  return {
    mode,
    categories: [
      { category: "provider", status: "Ready", detail: "Provider configured." },
      { category: "persistence", status: "Ready", detail: "SQLite default in use." },
      { category: "workspace", status: "Incomplete", detail: "Workspace root not set." },
      { category: "budget", status: "Error", detail: "Budget configuration invalid." },
      { category: "memory", status: "Ready", detail: "Local in-memory provider active." },
    ],
    secretPresence: { together: true },
  };
}

// Chat + trace surfaces that must remain mounted and accessible while the wizard is shown
// (Requirement 1.7). The wizard never touches these, so they stay un-hidden and enabled.
function expectChatAndTraceAccessible(harness: ProviderPanelHarness): void {
  for (const id of ["messages", "composer", "composer-input", "trace-drawer", "toggle-trace"]) {
    const el = harness.getEl(id);
    expect(el).toBeDefined();
    expect(el.hidden).toBe(false);
  }
  // The chat composer input is never disabled by the wizard.
  expect(harness.getEl("composer-input").disabled).toBe(false);
}

describe("Setup_Wizard panel", () => {
  let harness: ProviderPanelHarness;
  let storage: { local: { setItem: ReturnType<typeof vi.fn> }; session: { setItem: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    harness = createProviderPanelHarness();
    // Install browser-storage spies on the vm global so any (forbidden) write would be observable.
    // app.js resolves `localStorage`/`sessionStorage` as globals at call time, so assigning them
    // here makes a write detectable; the wizard must never call setItem (Requirement 1.5).
    storage = {
      local: { setItem: vi.fn() },
      session: { setItem: vi.fn() },
    };
    harness.sandbox.localStorage = storage.local;
    harness.sandbox.sessionStorage = storage.session;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the mode and exactly five category pills, with no mutation controls or storage writes (Req 1.1, 1.2, 1.5, 1.6, 1.7)", async () => {
    let requestedUrl: string | undefined;
    harness.setFetchHandler(async (url) => {
      requestedUrl = url;
      return jsonResponse(statusResponse("local"));
    });

    await harness.sandbox.loadSetupStatus();

    // Req 1.1: the orchestration mode is displayed in human language.
    expect(harness.getEl("setup-wizard-mode").textContent).toBe("Unconfigured");
    expect(requestedUrl).toBe("/api/setup/status");

    // Req 1.2: exactly one pill per category, in order, each carrying one closed-set status.
    const container = harness.getEl("setup-wizard-categories");
    expect(container.children.length).toBe(5);
    for (const pill of container.children) {
      expect(pill.className).toContain("wizard-pill");
    }
    const names = container.querySelectorAll(".wizard-pill__name").map((e) => e.textContent);
    expect(names).toEqual(["Provider", "Persistence", "Workspace", "Budget", "Memory"]);
    const statuses = container.querySelectorAll(".wizard-pill__status").map((e) => e.textContent);
    expect(statuses).toEqual(["Ready", "Ready", "Incomplete", "Error", "Ready"]);

    // Status body visible, error hidden.
    expect(harness.getEl("setup-wizard-body").hidden).toBe(false);
    expect(harness.getEl("setup-wizard-error").hidden).toBe(true);

    // Req 1.6: the wizard presents status only — no configuration-mutation controls are rendered.
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);

    // Req 1.5: no secret values were written to browser storage.
    expect(storage.local.setItem).not.toHaveBeenCalled();
    expect(storage.session.setItem).not.toHaveBeenCalled();

    // Req 1.7: chat and trace stay accessible while the wizard is shown.
    expectChatAndTraceAccessible(harness);
  });

  it("labels configured profile when the server reports configured (Req 1.1)", async () => {
    harness.setFetchHandler(async () =>
      jsonResponse({ ...statusResponse("external"), orchestrationProfile: "configured" }),
    );

    await harness.sandbox.loadSetupStatus();

    expect(harness.getEl("setup-wizard-mode").textContent).toBe("Configured");
    expect(harness.getEl("setup-wizard-categories").children.length).toBe(5);
  });

  it("shows an error state on an API failure and keeps chat/trace accessible (Req 1.8)", async () => {
    harness.setFetchHandler(async () => jsonResponse({ error: "boom" }, { ok: false, status: 500 }));

    await harness.sandbox.loadSetupStatus();

    const error = harness.getEl("setup-wizard-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("unavailable");
    // The status body stays hidden when only an error is available.
    expect(harness.getEl("setup-wizard-body").hidden).toBe(true);
    // No pills are rendered from an error response.
    expect(harness.getEl("setup-wizard-categories").children.length).toBe(0);
    // Req 1.8: chat/trace remain accessible alongside the error state.
    expectChatAndTraceAccessible(harness);
  });

  it("shows an error state on a malformed (categories-less) response (Req 1.8)", async () => {
    harness.setFetchHandler(async () => jsonResponse({ mode: "local" }));

    await harness.sandbox.loadSetupStatus();

    const error = harness.getEl("setup-wizard-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("unavailable");
    expect(harness.getEl("setup-wizard-body").hidden).toBe(true);
    expectChatAndTraceAccessible(harness);
  });

  it("aborts and shows a timeout error state after 10s with no response, keeping chat/trace accessible (Req 1.9)", async () => {
    vi.useFakeTimers();

    // A request that never settles on its own; it only rejects when the client aborts on timeout.
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

    const inFlight = harness.sandbox.loadSetupStatus();

    // Loading indicator is visible while in flight.
    expect(harness.getEl("setup-wizard-loading").hidden).toBe(false);

    // Advance to the 10s client-side deadline; the wizard aborts the request.
    await vi.advanceTimersByTimeAsync(SETUP_STATUS_TIMEOUT_MS);
    await inFlight;

    const error = harness.getEl("setup-wizard-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("timed out after 10 seconds");
    // Loading cleared and the status body hidden after the timeout.
    expect(harness.getEl("setup-wizard-loading").hidden).toBe(true);
    expect(harness.getEl("setup-wizard-body").hidden).toBe(true);
    // Req 1.9: chat/trace remain accessible alongside the timeout error state.
    expectChatAndTraceAccessible(harness);
  });

  it("opens and closes the wizard modal without disturbing chat/trace (Req 1.7)", async () => {
    harness.setFetchHandler(async () => jsonResponse(statusResponse("local")));

    harness.sandbox.openSetupWizard();
    expect(harness.getEl("setup-wizard-modal").hidden).toBe(false);
    expectChatAndTraceAccessible(harness);

    harness.sandbox.closeSetupWizard();
    expect(harness.getEl("setup-wizard-modal").hidden).toBe(true);
    expectChatAndTraceAccessible(harness);
  });
});
