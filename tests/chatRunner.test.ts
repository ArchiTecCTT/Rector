/**
 * Task 6.2 — Property 1: Local mode output is unchanged (regression baseline).
 *
 * Validates Requirements 3.1 and 3.2 (ORN-33 mode-aware runner; the provider-free
 * local path is preserved exactly). For arbitrary prompts, dispatching through
 * `runChat(store, args, { mode: "local" })` must:
 *   - visit the deterministic phase sequence
 *     (TRIAGE → CONTEXT_BUILDING → PLANNING → SKEPTIC_REVIEW → CRUCIBLE →
 *      DAG_COMPILATION → EXECUTING → VALIDATING → SYNTHESIZING → DONE),
 *   - keep `costEstimate.usd === 0`,
 *   - record zero model calls (`actualCost.modelCalls` unset/0 and the
 *     observability summary's `modelCallCount === 0`),
 * and must be structurally equivalent to calling `runFakeChatRun` directly.
 *
 * Everything is in-memory and provider-free: no API key and no network are used.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  runChat,
  runFakeChatRun,
  type ChatRunArgs,
} from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import { arbPrompt, makeContextPack } from "./support/byokArbitraries";

/** The deterministic phase sequence the local brainstem run must transition through. */
const DETERMINISTIC_PHASES = [
  "TRIAGE",
  "CONTEXT_BUILDING",
  "PLANNING",
  "SKEPTIC_REVIEW",
  "CRUCIBLE",
  "DAG_COMPILATION",
  "EXECUTING",
  "VALIDATING",
  "SYNTHESIZING",
  "DONE",
] as const;

const PHASE_SET = new Set<string>(DETERMINISTIC_PHASES);

/**
 * Builds a fresh, schema-valid `ChatRunArgs` for the prompt by seeding a
 * conversation + user message into a store, then deriving triage/context/trace
 * exactly as the chat endpoint does in local mode.
 */
async function buildArgs(store: InMemoryRectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "chatRunner regression",
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

/** Extracts the ordered list of deterministic phases recorded in the run's events. */
async function recordedPhaseSequence(store: InMemoryRectorStore, runId: string): Promise<string[]> {
  const events = await store.listEvents(runId);
  return events.map((event) => event.phase).filter((phase) => PHASE_SET.has(phase));
}

describe("Property 1: local mode output is unchanged (regression baseline)", () => {
  it("preserves the deterministic phase sequence and zero cost for arbitrary prompts", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, prompt);

        const { run, observabilitySummary } = await runChat(store, args, { mode: "local" });

        // Same phases visited, in the deterministic order.
        const phases = await recordedPhaseSequence(store, run.id);
        expect(phases).toEqual([...DETERMINISTIC_PHASES]);

        // Run reaches DONE and completes.
        expect(run.phase).toBe("DONE");
        expect(run.status).toBe("completed");

        // All-zero budget/cost: zero cost estimate and zero model calls.
        expect(run.costEstimate.usd).toBe(0);
        // The fake run records actualCost as { usd: 0 } without a modelCalls field;
        // an unset count means zero model calls (Property 1: "zero model calls").
        expect(run.actualCost?.modelCalls ?? 0).toBe(0);
        // The observability trace is the authoritative provider-call signal.
        expect(observabilitySummary.modelCallCount).toBe(0);
        expect(observabilitySummary.estimatedCostUsd).toBe(0);
      }),
      { numRuns: 30 },
    );
  });

  it("dispatches local mode to runFakeChatRun (structurally equivalent output)", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        // Two independent stores so run/event ids and trace ids do not collide.
        const storeA = new InMemoryRectorStore();
        const storeB = new InMemoryRectorStore();

        const viaDispatcher = await runChat(storeA, await buildArgs(storeA, prompt), { mode: "local" });
        const viaDirect = await runFakeChatRun(storeB, await buildArgs(storeB, prompt));

        // Identical phase sequences.
        const phasesA = await recordedPhaseSequence(storeA, viaDispatcher.run.id);
        const phasesB = await recordedPhaseSequence(storeB, viaDirect.run.id);
        expect(phasesA).toEqual(phasesB);
        expect(phasesA).toEqual([...DETERMINISTIC_PHASES]);

        // Identical, deterministic synthesis structure (volatile ids excluded).
        expect(viaDispatcher.synthesis.status).toBe(viaDirect.synthesis.status);
        expect(viaDispatcher.synthesis.route).toBe(viaDirect.synthesis.route);

        // Both paths are provider-free.
        expect(viaDispatcher.run.costEstimate.usd).toBe(0);
        expect(viaDirect.run.costEstimate.usd).toBe(0);
        expect(viaDispatcher.observabilitySummary.modelCallCount).toBe(0);
        expect(viaDirect.observabilitySummary.modelCallCount).toBe(0);
      }),
      { numRuns: 20 },
    );
  });

  it("local mode requires no router dependency", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Explain the Rector vertical slice.");

    // No router supplied: local dispatch must succeed without any provider wiring.
    const result = await runChat(store, args, { mode: "local" });
    expect(result.run.phase).toBe("DONE");
    expect(result.run.actualCost?.modelCalls ?? 0).toBe(0);
  });
});

/**
 * Task 6.4 — Property 7: External mode records provider/model/cost on the
 * PLANNING event.
 *
 * Validates Requirements 3.4 (ORN-33 records `ProviderCallMetadata` conforming
 * to `ProviderCallMetadataSchema` on the PLANNING run event) and 4.9 (ORN-34
 * accumulates the provider usage that is then reflected into the run's
 * cost/token fields).
 *
 * For arbitrary prompts and arbitrary positive token counts reported by a
 * mocked provider, a successful external run via
 * `runChat(store, args, { mode: "external", router, budget })` must:
 *   (1) list a PLANNING event whose payload carries a `providerCall` object
 *       holding the provider/model/route identifiers and a usage record; that
 *       recorded metadata must be schema-shaped (`ProviderCallMetadataSchema`);
 *   (2) reflect the reported usage into the run's authoritative cost/token
 *       fields (`costEstimate`/`actualCost` USD + model calls, and
 *       `tokenEstimate`/`actualTokens` input + output);
 *   (3) leak no secret material into the recorded provider metadata.
 *
 * Redaction note: every event payload passes through the security redaction
 * boundary (`redactSecrets`, applied by the run state machine). That boundary
 * redacts any field whose key contains "token", so the persisted
 * `providerCall.usage.{inputTokens,outputTokens,totalTokens}` are `[REDACTED]`
 * on the event. The authoritative token counts are preserved un-redacted on the
 * run's `tokenEstimate`/`actualTokens`. The schema-shape assertion therefore
 * reunites the surviving identifiers from the event with the authoritative token
 * counts from the run and confirms the pair validates — which is exactly the
 * metadata the runner built (via `ProviderCallMetadataSchema.parse`) before
 * persistence.
 *
 * Everything is in-memory and mock-only: the router returns a scripted spy
 * provider, so no API key and no network are used.
 */
import { ProviderCallMetadataSchema } from "../src/orchestration/chatRunner";
import type { LLMUsage, ModelRouter, ModelSelection } from "../src/providers/llm";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbValidPlan,
  generousBudget,
  planToJson,
} from "./support/byokArbitraries";

/** The PLANNING-event payload key the external runner writes its metadata to. */
const PROVIDER_CALL_KEY = "providerCall";

/**
 * Arbitrary positive usage the spy provider reports on its response. These are
 * the counts the runner must reflect into the run's cost/token fields. The spy
 * keeps a small fixed `estimateRequest` so the budget preflight always allows
 * the call; the recorded usage comes from the response, not the estimate, so
 * these counts are free to be large.
 */
const arbReportedUsage = (): fc.Arbitrary<Pick<LLMUsage, "inputTokens" | "outputTokens" | "estimatedUsd" | "modelCalls">> =>
  fc.record({
    inputTokens: fc.integer({ min: 1, max: 500_000 }),
    outputTokens: fc.integer({ min: 1, max: 500_000 }),
    estimatedUsd: fc.double({ min: 0.0001, max: 100, noNaN: true }),
    modelCalls: fc.integer({ min: 1, max: 5 }),
  });

/** A single-provider router that always selects the given spy on the flagship route. */
function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "test router selects the scripted spy provider",
      };
    },
  };
}

describe("Property 7: external mode records provider/model/cost on the PLANNING event", () => {
  // Validates: Requirements 3.4, 4.9.
  it("records schema-shaped ProviderCallMetadata and reflects reported usage into run cost/token fields", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbValidPlan(), arbReportedUsage(), async (prompt, plan, reported) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, prompt);

        // Spy returns a valid plan with arbitrary positive usage on its response.
        // A small fixed estimate keeps the budget preflight permissive.
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [{ content: planToJson(plan), usage: reported }],
        });
        const router = spyRouter(provider);

        const { run } = await runChat(store, args, {
          mode: "external",
          router,
          budget: generousBudget(),
        });

        // The run completed the external pipeline (single committed provider call).
        expect(run.phase).toBe("DONE");
        expect(run.status).toBe("completed");
        expect(provider.invokeCount).toBe(1);

        // --- (1) PLANNING event carries the provider-call metadata. ---
        const events = await store.listEvents(run.id);
        const planningEvent = events.find(
          (event) => event.phase === "PLANNING" && (event.payload as Record<string, unknown>)[PROVIDER_CALL_KEY] !== undefined,
        );
        expect(planningEvent).toBeDefined();

        const providerCall = (planningEvent!.payload as Record<string, unknown>)[PROVIDER_CALL_KEY] as {
          mode: string;
          provider: string;
          model: string;
          modelRoute: string;
          usage: { estimatedUsd: number; modelCalls: number };
          attempts: number;
          repaired: boolean;
        };

        // Identifier fields survive redaction and identify the selected provider.
        expect(providerCall.mode).toBe("external");
        expect(providerCall.provider).toBe(provider.metadata.id);
        expect(providerCall.model).toBe(provider.metadata.models.flagship);
        expect(providerCall.modelRoute).toBe("flagship");
        expect(providerCall.attempts).toBe(1);
        expect(providerCall.repaired).toBe(false);

        // Surviving (non-token-named) usage fields equal the reported usage.
        expect(providerCall.usage.estimatedUsd).toBe(reported.estimatedUsd);
        expect(providerCall.usage.modelCalls).toBe(reported.modelCalls);

        // The recorded metadata is schema-shaped: reunite the surviving
        // identifiers with the authoritative (un-redacted) token counts the run
        // preserved, and confirm the pair validates against the schema.
        const reunited = {
          ...providerCall,
          usage: {
            inputTokens: (run.tokenEstimate as { input: number }).input,
            outputTokens: (run.tokenEstimate as { output: number }).output,
            totalTokens:
              (run.tokenEstimate as { input: number }).input + (run.tokenEstimate as { output: number }).output,
            estimatedUsd: providerCall.usage.estimatedUsd,
            modelCalls: providerCall.usage.modelCalls,
          },
        };
        expect(ProviderCallMetadataSchema.safeParse(reunited).success).toBe(true);

        // --- (2) Run cost/token fields reflect the reported usage. ---
        expect((run.costEstimate as { usd: number }).usd).toBe(reported.estimatedUsd);
        expect((run.costEstimate as { modelCalls?: number }).modelCalls).toBe(reported.modelCalls);
        expect((run.actualCost as { usd: number }).usd).toBe(reported.estimatedUsd);
        expect((run.actualCost as { modelCalls?: number }).modelCalls).toBe(reported.modelCalls);
        expect((run.tokenEstimate as { input: number }).input).toBe(reported.inputTokens);
        expect((run.tokenEstimate as { output: number }).output).toBe(reported.outputTokens);
        expect((run.actualTokens as { input: number }).input).toBe(reported.inputTokens);
        expect((run.actualTokens as { output: number }).output).toBe(reported.outputTokens);

        // --- (3) No secret leakage in the recorded provider metadata. ---
        // The security redaction boundary ran over the event payload: the
        // token-named numeric fields are redacted, proving the boundary applies
        // to recorded provider metadata. No auth/bearer material is present.
        const serializedEvents = JSON.stringify(events);
        expect(serializedEvents).not.toMatch(/Bearer\s+\S/);
        expect(serializedEvents).not.toMatch(/authorization/i);
        const persistedUsage = providerCall.usage as unknown as Record<string, unknown>;
        expect(persistedUsage.inputTokens).toBe("[REDACTED]");
        expect(persistedUsage.outputTokens).toBe("[REDACTED]");
      }),
      { numRuns: 40 },
    );
  });
});
