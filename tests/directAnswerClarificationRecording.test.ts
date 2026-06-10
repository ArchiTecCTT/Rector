/**
 * Task 4.4 — Unit tests for direct-answer and clarification event recording.
 *
 * Validates Requirements 4.1, 8.4, 9.1, 9.2, 9.3 against the event recording wired into
 * `runChat` / `runExternalChatRun` / `runExternalPostPlanningPhases` (task 4.2):
 *
 *   - DIRECT_ANSWER (External_Mode): the SYNTHESIZING run event records the Triage_Route, the run
 *     id (every event carries it), the provider call attempt (`ProviderCallMetadata`), the
 *     accumulated cost (reflected into the run's cost/token fields), and — when the cheap-model
 *     call falls back — the fallback status (Req 8.4, 9.1, 9.2, 9.3).
 *   - NEEDS_CLARIFICATION (Local_Mode): the run records the route, run id, and trace id on its
 *     events while making zero provider / network calls (Req 4.1, 27.2).
 *
 * Everything is in-memory and mock-only: the router returns a scripted `SpyLLMProvider`, so no API
 * key and no network are used. Local_Mode needs no router at all.
 */
import { describe, it, expect } from "vitest";

import { runChat, type ChatRunArgs } from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createInMemoryObservabilityTrace } from "../src/observability";
import { PlannerOutputSchema } from "../src/orchestration/planner";
import type { ModelRouter, ModelRouterInput, ModelSelection } from "../src/providers/llm";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  generousBudget,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
} from "./support/byokArbitraries";

/** The deterministic phase sequence a local brainstem run transitions through. */
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

/** The PLANNING/SYNTHESIZING-event payload key the runner writes its provider metadata to. */
const PROVIDER_CALL_KEY = "providerCall";

/**
 * A deterministic, schema-valid plan whose single task compiles to a NON-FILE-OPERATION DAG node
 * (an `LLM_EXECUTION` node with a no-command `VALIDATION` node), so the DAG executes cleanly
 * (status VALIDATED) with no real workspace I/O and the run reaches DONE.
 */
const NON_FILE_OPERATION_PLAN = PlannerOutputSchema.parse({
  goal: "Answer the user question from available conversation context",
  assumptions: ["User expects a concise synthesis, not changes."],
  tasks: [
    {
      id: "answer.synthesize",
      title: "Synthesize direct answer",
      description: "Use available conversation context to produce a concise response.",
      dependencies: [],
      expectedArtifacts: ["Assistant answer"],
      validation: ["Answer addresses the stated question"],
      risk: "low",
      approvalRequired: false,
    },
  ],
  dependencies: [],
  validation: { summary: "Direct answer plan stays non-executing", checks: ["Confirm response is grounded in context"] },
  riskLevel: "low",
  approvalGates: [],
});

/** Scripted skeptic draft that yields a SOUND review so the crucible ACCEPTS. */
const SOUND_SKEPTIC_DRAFT = skepticDraftToJson({ verdict: "SOUND", findings: [] });

/**
 * Builds a fresh, schema-valid `ChatRunArgs` for the prompt by seeding a conversation + user message
 * into the store, then deriving triage/context/trace exactly as the chat endpoint does.
 */
async function buildArgs(store: InMemoryRectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "direct-answer / clarification recording",
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

/**
 * A single-provider router that honors the requested `capability` so the cheap-model direct-answer
 * step selects the `cheap` route (and the planner/skeptic select `flagship`). The spy provider's
 * model map is identical across routes, so only `modelRoute` differs.
 */
function capabilityRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(input: ModelRouterInput = {}): ModelSelection {
      const modelRoute = input.capability ?? "flagship";
      const model = provider.metadata.models[modelRoute] ?? provider.metadata.models.flagship;
      return { provider, modelRoute, model, reason: `test router selected ${modelRoute}` };
    },
  };
}

/** Finds the first event of `phase` whose payload carries a `providerCall`. */
function findProviderCallEvent(
  events: Array<{ phase: string; payload: unknown }>,
  phase: string,
): Record<string, unknown> | undefined {
  const event = events.find(
    (candidate) => candidate.phase === phase && (candidate.payload as Record<string, unknown>)[PROVIDER_CALL_KEY] !== undefined,
  );
  return event ? ((event.payload as Record<string, unknown>)[PROVIDER_CALL_KEY] as Record<string, unknown>) : undefined;
}

/** Finds the first event of `phase` (any payload). */
function findEvent(
  events: Array<{ phase: string; payload: unknown }>,
  phase: string,
): Record<string, unknown> | undefined {
  const event = events.find((candidate) => candidate.phase === phase);
  return event ? (event.payload as Record<string, unknown>) : undefined;
}

describe("Task 4.4: direct-answer event recording (External_Mode)", () => {
  // Req 9.1 / 9.2: a successful DIRECT_ANSWER turn records the route + run id and the cheap-model
  // provider call (provider id, model, accumulated cost) on the SYNTHESIZING event, and reflects the
  // accumulated cost into the run's cost/token fields. No fallback status is recorded.
  it("records route, provider call, and accumulated cost for a successful cheap-model direct answer", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "What is Rector?");
    expect(args.triage.route).toBe("DIRECT_ANSWER");

    // The spy scripts the three live steps in order: planner plan, SOUND skeptic draft, then the
    // cheap-model direct answer carrying an explicit USD + model-call cost.
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "What is Rector?",
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(NON_FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
        { content: "Rector is a local-first BYOK orchestration agent.", usage: { estimatedUsd: 0.02, modelCalls: 1 } },
      ],
    });

    const { run, synthesis } = await runChat(store, args, {
      mode: "external",
      router: capabilityRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
    });

    expect(run.phase).toBe("DONE");
    expect(run.status).toBe("completed");
    // preprocessor + planner + skeptic + cheap direct answer.
    expect(provider.invokeCount).toBe(4);
    // The user-facing reply is the cheap-model answer, not internal trace prose.
    expect(synthesis.response).toBe("Rector is a local-first BYOK orchestration agent.");

    const events = await store.listEvents(run.id);

    // --- Req 9.1: route + run id recorded on the SYNTHESIZING event. ---
    const synthPayload = findEvent(events, "SYNTHESIZING");
    expect(synthPayload).toBeDefined();
    expect(synthPayload!.route).toBe("DIRECT_ANSWER");
    expect(run.route).toBe("DIRECT_ANSWER");
    // Every recorded event carries the run id (Req 9.1).
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect((event as { runId: string }).runId).toBe(run.id);
    }

    // --- Req 9.2: provider id, model, and route recorded for the cheap-model call. ---
    const synthCall = findProviderCallEvent(events, "SYNTHESIZING");
    expect(synthCall).toBeDefined();
    expect(synthCall!.mode).toBe("external");
    expect(synthCall!.provider).toBe(provider.metadata.id);
    expect(synthCall!.model).toBe(provider.metadata.models.cheap);
    expect(synthCall!.modelRoute).toBe("cheap");
    // A real cheap-model call was attempted (attempts === providerCalls === 1).
    expect(synthCall!.attempts).toBe(1);
    expect(synthCall!.repaired).toBe(false);
    // The cheap call's surviving (non-token-named) usage equals the scripted cost.
    expect((synthCall!.usage as { estimatedUsd: number }).estimatedUsd).toBe(0.02);
    expect((synthCall!.usage as { modelCalls: number }).modelCalls).toBe(1);

    // --- Req 9.2: accumulated cost reflected into the run's cost fields. ---
    // planner (0.01) + skeptic (0.01) + cheap direct answer (0.02) = 0.04, three model calls.
    expect((run.actualCost as { usd: number }).usd).toBeCloseTo(0.04, 12);
    expect((run.actualCost as { modelCalls?: number }).modelCalls).toBe(3);
    expect((run.costEstimate as { usd: number }).usd).toBeCloseTo(0.04, 12);
    expect((run.costEstimate as { modelCalls?: number }).modelCalls).toBe(3);

    // --- A successful direct answer records NO fallback status. ---
    expect(synthPayload!.fallback).toBeUndefined();

    // No bearer/authorization material leaks into the recorded events.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/Bearer\s+\S/);
    expect(serialized).not.toMatch(/authorization/i);
  });

  // Req 8.4 / 9.3: when the cheap-model call fails, the DIRECT_ANSWER turn falls back to the
  // deterministic local text, records the fallback status and a zero-attempt provider call on the
  // SYNTHESIZING event, and the failed step contributes no cost (only planner + skeptic spend).
  it("records the fallback status and a zero-attempt provider call when the cheap model errors", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "What is Rector?");
    expect(args.triage.route).toBe("DIRECT_ANSWER");

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "What is Rector?",
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(NON_FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
        { error: new Error("transport failure: connection reset xyz") },
      ],
    });

    const { run, synthesis } = await runChat(store, args, {
      mode: "external",
      router: capabilityRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
    });

    // The run still reaches DONE: the deterministic fallback text is a usable answer (Req 8.1).
    expect(run.phase).toBe("DONE");
    expect(run.status).toBe("completed");
    // preprocessor + planner + skeptic + the (failing) cheap-model attempt.
    expect(provider.invokeCount).toBe(4);
    // No raw provider error body survives into the user-facing reply.
    expect(synthesis.response).not.toContain("connection reset");

    const events = await store.listEvents(run.id);

    // --- Req 9.3: route + fallback status recorded on the SYNTHESIZING event. ---
    const synthPayload = findEvent(events, "SYNTHESIZING");
    expect(synthPayload).toBeDefined();
    expect(synthPayload!.route).toBe("DIRECT_ANSWER");
    expect(synthPayload!.fallback).toBe("provider_error");

    // --- Req 8.4: a zero-attempt provider call is still recorded for the failed step. ---
    const synthCall = findProviderCallEvent(events, "SYNTHESIZING");
    expect(synthCall).toBeDefined();
    expect(synthCall!.attempts).toBe(0);
    expect(synthCall!.repaired).toBe(false);
    expect(synthesis.providerCalls).toBe(0);

    // --- The failed cheap call adds no cost: only planner (0.01) + skeptic (0.01) = 0.02. ---
    expect((run.actualCost as { usd: number }).usd).toBeCloseTo(0.02, 12);
    expect((run.actualCost as { modelCalls?: number }).modelCalls).toBe(2);

    // No raw provider body leaks into any recorded event.
    expect(JSON.stringify(events)).not.toContain("connection reset");
  });
});

describe("Task 4.4: clarification event recording (Local_Mode)", () => {
  // Req 4.1: a NEEDS_CLARIFICATION turn records the route, run id, and trace id on its events while
  // making zero provider / network calls (Local_Mode, Req 27.2).
  it("records route, run id, and trace id with zero provider calls", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Hello");
    expect(args.triage.route).toBe("NEEDS_CLARIFICATION");

    // Local_Mode: no router is wired, so any provider/network reach would throw.
    const { run, observabilitySummary } = await runChat(store, args, { mode: "local" });

    expect(run.phase).toBe("DONE");
    expect(run.status).toBe("completed");

    // --- Req 4.1: route recorded on the run and on the RUN_CREATED event triage payload. ---
    expect(run.route).toBe("NEEDS_CLARIFICATION");
    const createdPayload = findEvent(await store.listEvents(run.id), "CHAT_RECEIVED");
    expect(createdPayload).toBeDefined();
    expect((createdPayload!.triage as { route: string }).route).toBe("NEEDS_CLARIFICATION");

    const events = await store.listEvents(run.id);

    // --- Req 4.1: run id and trace id recorded on every event. ---
    expect(run.traceId.length).toBeGreaterThan(0);
    for (const event of events) {
      expect((event as { runId: string }).runId).toBe(run.id);
      expect((event as { traceId: string }).traceId).toBe(run.traceId);
    }

    // --- Req 4.1: the internal phase events remain recorded for the trace surfaces. ---
    const recordedPhases = events.map((event) => event.phase).filter((phase) => PHASE_SET.has(phase));
    expect(recordedPhases).toEqual([...DETERMINISTIC_PHASES]);

    // --- Req 27.2: Local_Mode makes zero provider / network calls. ---
    expect(run.costEstimate.usd).toBe(0);
    expect(run.actualCost?.modelCalls ?? 0).toBe(0);
    expect(observabilitySummary.modelCallCount).toBe(0);
    expect(observabilitySummary.estimatedCostUsd).toBe(0);
  });
});
