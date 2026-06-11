// Unit tests for the Provider_Test_Panel state machine (src/public/app.js, task 4.1).
//
// Validates (by example): Requirements 2.2, 2.4, 2.6, 2.7
//   - 2.2: a connection test invokes the existing Connection_Test_API
//   - 2.6: while a test is in flight, a loading indicator shows and the action is disabled
//   - 2.4: a failure renders a human-language, key-free message and retains the provider selection
//   - 2.7: a test with no result within 30s aborts, clears loading, and shows a timeout message
//
// The panel is exercised through a fake-DOM vm harness with an injected `fetch` double and
// host-delegating timers. Zero network/provider calls; the 30s timeout is driven by fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderPanelHarness,
  jsonResponse,
  type FakeResponse,
  type ProviderPanelHarness,
} from "./support/providerPanelHarness";

const PROVIDER_TEST_TIMEOUT_MS = 30_000;
const PROVIDER_ID = "together";

/** A manually-resolved fake fetch, so a test can observe the in-flight state before completion. */
function deferredResponse(): {
  promise: Promise<FakeResponse>;
  resolve: (res: FakeResponse) => void;
} {
  let resolve!: (res: FakeResponse) => void;
  const promise = new Promise<FakeResponse>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Provider_Test_Panel states", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    harness = createProviderPanelHarness();
    harness.openPanel();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the loading indicator and disables the action while a test is in flight (Req 2.6, 2.2)", async () => {
    harness.selectProvider(PROVIDER_ID);
    // Exactly one provider selected -> action enabled before the test starts.
    expect(harness.getEl("run-provider-test").disabled).toBe(false);

    const deferred = deferredResponse();
    let requestedUrl: string | undefined;
    harness.setFetchHandler(async (url) => {
      requestedUrl = url;
      return deferred.promise;
    });

    const inFlight = harness.runTest();

    // Req 2.6: while in flight the loading indicator is visible, the action is disabled, and the
    // provider inputs are locked.
    expect(harness.getEl("provider-test-loading").hidden).toBe(false);
    expect(harness.getEl("run-provider-test").disabled).toBe(true);
    expect(harness.getEl("provider-list").querySelectorAll("input[type=checkbox]").every((i) => i.disabled)).toBe(true);
    // Req 2.2: the existing Connection_Test_API was invoked.
    expect(requestedUrl).toBe("/api/setup/test-connection");

    // Complete the test successfully; the panel clears loading and re-enables the action.
    deferred.resolve(jsonResponse({ ok: true, model: "meta-llama/Llama-3-8b" }));
    await inFlight;

    expect(harness.getEl("provider-test-loading").hidden).toBe(true);
    expect(harness.getEl("run-provider-test").disabled).toBe(false);
    const result = harness.getEl("provider-test-result");
    expect(result.hidden).toBe(false);
    expect(result.className).toContain("provider-result--ok");
    expect(result.textContent).toContain("is ready");
  });

  it("renders a redacted failure message and retains the selection on failure (Req 2.4)", async () => {
    harness.selectProvider(PROVIDER_ID);

    // The server already redacts; the panel surfaces the redacted reason verbatim. A raw key must
    // never appear in the displayed message.
    harness.setFetchHandler(async () =>
      jsonResponse({ ok: false, error: "invalid api key [redacted]" }, { ok: false, status: 401 }),
    );

    await harness.runTest();

    const result = harness.getEl("provider-test-result");
    expect(result.hidden).toBe(false);
    expect(result.className).toContain("provider-result--err");
    expect(result.textContent).toContain("connection failed");
    expect(result.textContent).toContain("[redacted]");
    // No API key material in the displayed message.
    expect(result.textContent).not.toMatch(/sk-[A-Za-z0-9]/);

    // Req 2.4: the provider selection is retained so the user can retry.
    const checkbox = harness
      .getEl("provider-list")
      .querySelectorAll("input[type=checkbox]")
      .find((i) => i.value === PROVIDER_ID);
    expect(checkbox?.checked).toBe(true);
    expect(harness.getEl("run-provider-test").disabled).toBe(false);
  });

  it("aborts, clears loading, and shows a timeout message after 30s with no result (Req 2.7)", async () => {
    vi.useFakeTimers();
    harness.selectProvider(PROVIDER_ID);

    // A request that never resolves on its own; it only settles when the client aborts on timeout.
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

    const inFlight = harness.runTest();
    expect(harness.getEl("provider-test-loading").hidden).toBe(false);

    // Advance to the 30s client-side deadline; the panel aborts the request.
    await vi.advanceTimersByTimeAsync(PROVIDER_TEST_TIMEOUT_MS);
    await inFlight;

    const result = harness.getEl("provider-test-result");
    expect(result.hidden).toBe(false);
    expect(result.className).toContain("provider-result--err");
    expect(result.textContent).toContain("timed out after 30 seconds");
    // Loading cleared and the action re-enabled after the timeout.
    expect(harness.getEl("provider-test-loading").hidden).toBe(true);
    expect(harness.getEl("run-provider-test").disabled).toBe(false);
    // Selection retained so the user can retry.
    const checkbox = harness
      .getEl("provider-list")
      .querySelectorAll("input[type=checkbox]")
      .find((i) => i.value === PROVIDER_ID);
    expect(checkbox?.checked).toBe(true);
  });
});
