import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

function unreadyStatus() {
  return {
    mode: "local",
    ready: false,
    orchestrationProfile: "unconfigured",
    onboardingStep: 1,
    onboardingComplete: false,
    blockers: ["Add at least one provider with a stored secret."],
    categories: [
      { category: "provider", status: "Incomplete", detail: "No provider configured." },
      { category: "persistence", status: "Ready", detail: "SQLite default in use." },
      { category: "workspace", status: "Ready", detail: "Local sandbox runtime is active." },
      { category: "budget", status: "Ready", detail: "Budget defaults active." },
      { category: "memory", status: "Ready", detail: "Local memory ready." },
    ],
    secretPresence: {},
  };
}

function readyStatus() {
  return {
    ...unreadyStatus(),
    ready: true,
    orchestrationProfile: "configured",
    onboardingStep: 4,
    onboardingComplete: true,
    blockers: [],
    mode: "external",
  };
}

describe("mandatory onboarding overlay", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    harness = createProviderPanelHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the overlay when setup status reports ready=false", async () => {
    harness.setFetchHandler(async (url) => {
      if (url === "/api/setup/status") return jsonResponse(unreadyStatus());
      return jsonResponse({});
    });

    await harness.sandbox.loadProductReadiness();

    const overlay = harness.getEl("onboarding-overlay");
    expect(overlay.hidden).toBe(false);
    expect(harness.getEl("composer-input").disabled).toBe(true);
    expect(harness.getEl("new-conversation").disabled).toBe(true);
  });

  it("does not dismiss on Escape, backdrop click, or a close control while unready", async () => {
    harness.setFetchHandler(async (url) => {
      if (url === "/api/setup/status") return jsonResponse(unreadyStatus());
      return jsonResponse({});
    });
    await harness.sandbox.loadProductReadiness();

    const overlay = harness.getEl("onboarding-overlay");
    let escapeDefaultPrevented = false;
    harness.sandbox.document.dispatchEvent({
      type: "keydown",
      key: "Escape",
      preventDefault: () => {
        escapeDefaultPrevented = true;
      },
      stopPropagation: () => undefined,
    });
    expect(escapeDefaultPrevented).toBe(true);
    expect(overlay.hidden).toBe(false);
    const overlayButtons = harness.getEl("onboarding-overlay").querySelectorAll("button");
    expect(overlayButtons.some((button) => button.getAttribute("aria-label") === "Close")).toBe(false);
  });

  it("unlocks the shell after activate succeeds", async () => {
    harness.setFetchHandler(async (url, options = {}) => {
      if (url === "/api/setup/status") return jsonResponse(unreadyStatus());
      if (url === "/api/setup/activate" && options.method === "POST") {
        return jsonResponse({ readiness: readyStatus() });
      }
      return jsonResponse({});
    });

    await harness.sandbox.loadProductReadiness();
    await harness.sandbox.activateProduct();

    expect(harness.getEl("onboarding-overlay").hidden).toBe(true);
    expect(harness.getEl("composer-input").disabled).toBe(false);
    expect(harness.getEl("new-conversation").disabled).toBe(false);
  });
});