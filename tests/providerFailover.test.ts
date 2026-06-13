import { describe, expect, it } from "vitest";

import { CredentialPool } from "../src/providers/credentialPool";
import { callWithResilience, type ProviderResilienceEvent } from "../src/providers/failover";
import { ProviderError, type ModelSelection } from "../src/providers/llm";
import { TurnRetryState } from "../src/providers/turnRetryState";
import { DEFAULT_SPY_USAGE, SpyLLMProvider } from "./support/byokArbitraries";

function selection(provider: SpyLLMProvider, providerId = provider.metadata.id): ModelSelection {
  return {
    provider,
    providerId,
    modelRoute: "flagship",
    model: provider.metadata.models.flagship,
    reason: `test ${providerId}`,
  };
}

describe("provider resilience failover", () => {
  it("substitutes a configured fallback after primary failure", async () => {
    const primary = new SpyLLMProvider({
      id: "primary",
      responses: [{ error: new Error("primary unavailable") }],
    });
    const fallback = new SpyLLMProvider({
      id: "fallback",
      responses: ["fallback ok"],
    });
    const events: ProviderResilienceEvent[] = [];

    const result = await callWithResilience({
      site: "planner",
      role: "planner",
      primary: selection(primary, "primary-record"),
      fallback: selection(fallback, "fallback-record"),
      retryState: new TurnRetryState(),
      emitEvent: (event) => events.push(event),
      invoke: (active) => active.provider.invoke({
        messages: [{ role: "user", content: "plan" }],
        modelRoute: "flagship",
        model: active.model,
      }),
    });

    expect(result.substituted).toBe(true);
    expect(result.selection.provider.metadata.id).toBe("fallback");
    expect(result.result.content).toBe("fallback ok");
    expect(events).toEqual([
      expect.objectContaining({
        type: "PROVIDER_SUBSTITUTED",
        payload: expect.objectContaining({
          primaryId: "primary-record",
          fallbackId: "fallback-record",
        }),
      }),
    ]);
  });

  it("throws a classified redacted error when no fallback is configured", async () => {
    const primary = new SpyLLMProvider({
      id: "primary",
      responses: [{ error: new Error("Authorization: Bearer secret-value") }],
    });

    await expect(callWithResilience({
      site: "skeptic",
      role: "skeptic",
      primary: selection(primary, "primary-record"),
      retryState: new TurnRetryState(),
      invoke: (active) => active.provider.invoke({
        messages: [{ role: "user", content: "review" }],
        modelRoute: "flagship",
        model: active.model,
      }),
    })).rejects.toMatchObject({
      name: "ProviderResilienceError",
      code: "PROVIDER_HTTP_ERROR",
      message: expect.not.stringContaining("secret-value"),
    });
  });

  it("retries a 429 once before returning success", async () => {
    const primary = new SpyLLMProvider({
      id: "primary",
      responses: [
        { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "primary", status: 429, message: "rate limited", retryable: true }) },
        { content: "retry ok", usage: DEFAULT_SPY_USAGE },
      ],
    });
    const events: ProviderResilienceEvent[] = [];

    const result = await callWithResilience({
      site: "planner",
      role: "planner",
      primary: selection(primary, "primary-record"),
      retryState: new TurnRetryState(),
      retryDelayMs: 1,
      emitEvent: (event) => events.push(event),
      invoke: (active) => active.provider.invoke({
        messages: [{ role: "user", content: "plan" }],
        modelRoute: "flagship",
        model: active.model,
      }),
    });

    expect(result.result.content).toBe("retry ok");
    expect(primary.invokeCount).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["PROVIDER_RETRY"]);
  });

  it("rotates the credential pool once for an auth failure", async () => {
    const primary = new SpyLLMProvider({
      id: "primary",
      responses: [
        { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "primary", status: 401, message: "auth failed" }) },
        { content: "rotated ok", usage: DEFAULT_SPY_USAGE },
      ],
    });
    const pool = new CredentialPool([
      { providerId: "primary-record", secretRef: "secret-a" },
      { providerId: "primary-record", secretRef: "secret-b" },
    ]);
    const events: ProviderResilienceEvent[] = [];

    const result = await callWithResilience({
      site: "planner",
      role: "planner",
      primary: selection(primary, "primary-record"),
      credentialPool: pool,
      retryState: new TurnRetryState(),
      emitEvent: (event) => events.push(event),
      invoke: (active) => active.provider.invoke({
        messages: [{ role: "user", content: "plan" }],
        modelRoute: "flagship",
        model: active.model,
      }),
    });

    expect(result.result.content).toBe("rotated ok");
    expect(primary.invokeCount).toBe(2);
    expect(events).toEqual([
      expect.objectContaining({
        type: "CREDENTIAL_ROTATED",
        payload: expect.objectContaining({ providerId: "primary-record", rotated: true }),
      }),
    ]);
  });

  it("uses a rotated provider instance when the pool has one", async () => {
    const primary = new SpyLLMProvider({
      id: "primary",
      responses: [
        { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "primary", status: 401, message: "auth failed" }) },
      ],
    });
    const rotated = new SpyLLMProvider({
      id: "primary",
      responses: [{ content: "rotated provider ok", usage: DEFAULT_SPY_USAGE }],
    });
    const pool = new CredentialPool([
      { providerId: "primary-record", secretRef: "secret-a" },
      { providerId: "primary-record", secretRef: "secret-b", provider: rotated },
    ]);

    const result = await callWithResilience({
      site: "planner",
      role: "planner",
      primary: selection(primary, "primary-record"),
      credentialPool: pool,
      retryState: new TurnRetryState(),
      invoke: (active) => active.provider.invoke({
        messages: [{ role: "user", content: "plan" }],
        modelRoute: "flagship",
        model: active.model,
      }),
    });

    expect(result.result.content).toBe("rotated provider ok");
    expect(primary.invokeCount).toBe(1);
    expect(rotated.invokeCount).toBe(1);
  });

  it("cancels a pending retry wait when aborted", async () => {
    const primary = new SpyLLMProvider({
      id: "primary",
      responses: [
        { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "primary", status: 429, message: "rate limited", retryable: true }) },
        "should not run",
      ],
    });
    const controller = new AbortController();
    const promise = callWithResilience({
      site: "planner",
      role: "planner",
      primary: selection(primary, "primary-record"),
      retryState: new TurnRetryState(),
      retryDelayMs: 50,
      abortSignal: controller.signal,
      invoke: (active) => active.provider.invoke({
        messages: [{ role: "user", content: "plan" }],
        modelRoute: "flagship",
        model: active.model,
      }),
    });

    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    expect(primary.invokeCount).toBe(1);
  });
});
