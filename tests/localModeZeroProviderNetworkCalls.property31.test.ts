/**
 * Task 13.2 — Local-mode zero outbound provider network calls.
 *
 * Feature: cloud-capable-transition, Property 31: Local mode performs zero outbound provider network calls
 *
 * **Property 31: Local mode performs zero outbound provider network calls**
 * **Validates: Requirements 9.1, 2.15, 4.3**
 *
 * For any run in Local_Mode, the system performs zero outbound provider network calls across
 * orchestration, discovery, and synthesis. This test drives the full chat/orchestration path
 * (`runChat(store, args, { mode: "local" })`) over arbitrary prompts (which span every triage
 * route) and asserts that two independent counting doubles never fire:
 *
 *   1. A counting `fetch` double installed on `globalThis.fetch` for the duration of the test.
 *      Any outbound HTTP egress from orchestration, discovery, or synthesis would increment the
 *      counter (and throw). The Local_Mode path must leave it at exactly zero across every
 *      iteration.
 *   2. A counting provider double (`SpyLLMProvider`) wired through a `ModelRouter` and supplied via
 *      the runner deps. Local_Mode runs the deterministic, provider-free path and must never select
 *      or invoke this provider — so its `invokeCount` stays zero.
 *
 * The run is fully hermetic: an in-memory `RectorStore`, in-memory observability trace, and no real
 * disk or network. The counting fetch double is the network tripwire; the counting provider double
 * is the provider-call tripwire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { runChat, type ChatRunArgs } from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import type { ModelRouter, ModelSelection } from "../src/providers/llm";
import { arbPrompt, makeContextPack, SpyLLMProvider } from "./support/byokArbitraries";

/**
 * Builds a fresh, schema-valid `ChatRunArgs` for the prompt by seeding a conversation + user
 * message into the store, then deriving triage/context/trace exactly as the chat endpoint does in
 * local mode.
 */
async function buildArgs(store: InMemoryRectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "local-mode zero-network property",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const observability = createInMemoryObservabilityTrace({ provider: "local" });

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
  };
}

/** A single-provider router around the counting spy; if Local_Mode ever selected it, it would fire. */
function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "tripwire router — must never be consulted in local mode",
      };
    },
  };
}

describe("Property 31: Local mode performs zero outbound provider network calls", () => {
  // Feature: cloud-capable-transition, Property 31: Local mode performs zero outbound provider network calls
  // Validates: Requirements 9.1, 2.15, 4.3.

  let originalFetch: typeof globalThis.fetch;
  let fetchTripwire: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Counting fetch double: records every call and throws so any accidental egress is impossible
    // to silently succeed. Local_Mode must never reach it.
    fetchTripwire = vi.fn(() => {
      throw new Error("Local_Mode must never perform an outbound provider network call");
    });
    globalThis.fetch = fetchTripwire as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("makes zero fetch and zero provider calls for arbitrary prompts across all routes", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, prompt);

        // A counting provider double wired through a router and offered to the runner. The
        // deterministic Local_Mode path must ignore it entirely.
        const provider = new SpyLLMProvider();
        const fetchCallsBefore = fetchTripwire.mock.calls.length;

        const { run, synthesis, observabilitySummary } = await runChat(store, args, {
          mode: "local",
          router: spyRouter(provider),
          enableNetwork: true,
        });

        // The run completed the deterministic pipeline.
        expect(run.phase).toBe("DONE");
        expect(run.status).toBe("completed");

        // Network tripwire: no outbound fetch occurred during this run.
        expect(fetchTripwire.mock.calls.length).toBe(fetchCallsBefore);

        // Provider tripwire: the offered provider was never selected or invoked.
        expect(provider.invokeCount).toBe(0);
        expect(provider.estimateCount).toBe(0);

        // Corroborating provider-free signals from the run and synthesis.
        expect(synthesis.providerCalls).toBe(0);
        expect(observabilitySummary.modelCallCount).toBe(0);
        expect(run.costEstimate.usd).toBe(0);
      }),
      { numRuns: 120 },
    );

    // Across the entire property run the network tripwire never fired once.
    expect(fetchTripwire).not.toHaveBeenCalled();
  });
});
