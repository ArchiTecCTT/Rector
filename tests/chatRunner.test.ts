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

  // Req 8.1 / 8.4: the deterministic synthesis preserves the Phase 1 output field
  // set exactly. For arbitrary prompts the local-mode synthesis must expose the
  // same key set as the deterministic `synthesizeChatBrainstemResponse` and report
  // `providerCalls === 0` (provider-free).
  it("preserves the deterministic synthesis output field set for arbitrary prompts", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        const store = new InMemoryRectorStore();
        const { synthesis } = await runChat(store, await buildArgs(store, prompt), { mode: "local" });

        // Exact Phase 1 BrainstemSynthesis field set (no fields added or dropped).
        expect(new Set(Object.keys(synthesis))).toEqual(
          new Set(["status", "route", "traceId", "evidence", "providerCalls", "observability", "response"]),
        );

        // Field types match the Phase 1 baseline contract.
        expect(typeof synthesis.status).toBe("string");
        expect(typeof synthesis.route).toBe("string");
        expect(typeof synthesis.traceId).toBe("string");
        expect(Array.isArray(synthesis.evidence)).toBe(true);
        expect(typeof synthesis.response).toBe("string");

        // Provider-free: the deterministic synthesizer always reports zero calls.
        expect(synthesis.providerCalls).toBe(0);
      }),
      { numRuns: 30 },
    );
  });

  // Req 27.3: for every route OTHER than NEEDS_CLARIFICATION and DIRECT_ANSWER the
  // synthesis response string preserves the legacy section ordering exactly:
  // Status -> Route -> Trace -> Evidence -> Observed -> the deterministic
  // "Local mode: provider calls: 0" marker, which is always last. The two
  // route-aware target routes (ORN-57/ORN-58) intentionally replace this string
  // with a short, prose-free reply, so they are asserted to carry no internal trace
  // prose instead.
  it("preserves the deterministic response section ordering for non-target routes", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        const store = new InMemoryRectorStore();
        const { synthesis } = await runChat(store, await buildArgs(store, prompt), { mode: "local" });

        const response = synthesis.response;

        if (synthesis.route === "NEEDS_CLARIFICATION" || synthesis.route === "DIRECT_ANSWER") {
          // Route-aware reply: no internal trace prose leaks into the chat answer.
          expect(response).not.toContain("Status:");
          expect(response).not.toContain("Route:");
          expect(response).not.toContain("Trace:");
          expect(response).not.toContain("Evidence:");
          return;
        }

        const statusAt = response.indexOf("Status: ");
        const routeAt = response.indexOf("Route: ");
        const traceAt = response.indexOf("Trace: ");
        const evidenceAt = response.indexOf("Evidence: ");
        const observedAt = response.indexOf("Observed: ");
        const localMarker = "Local mode: provider calls: 0, API keys: not required.";
        const localAt = response.indexOf(localMarker);

        // Every legacy section is present.
        expect(statusAt).toBeGreaterThanOrEqual(0);
        expect(routeAt).toBeGreaterThan(statusAt);
        expect(traceAt).toBeGreaterThan(routeAt);
        expect(evidenceAt).toBeGreaterThan(traceAt);
        expect(observedAt).toBeGreaterThan(evidenceAt);
        expect(localAt).toBeGreaterThan(observedAt);

        // The provider-free marker is the deterministic final section, and the
        // Observed line reports zero provider calls in local mode.
        expect(response.endsWith(localMarker)).toBe(true);
        expect(response).toContain("provider calls: 0");
      }),
      { numRuns: 30 },
    );
  });

  // Req 8.3 / 8.5: local mode makes exactly 0 provider calls and 0 outbound
  // network requests. With no router wired, any attempted provider/network call
  // would surface as a thrown error; the run instead completes provider-free with
  // zero recorded model calls and zero estimated cost across both the run's
  // authoritative fields and the observability trace.
  it("makes zero provider and outbound network calls for arbitrary prompts", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), async (prompt) => {
        const store = new InMemoryRectorStore();
        // Deliberately omit any router/budget: a local run must never reach for one.
        const { run, observabilitySummary, synthesis } = await runChat(store, await buildArgs(store, prompt), {
          mode: "local",
        });

        expect(run.phase).toBe("DONE");
        expect(run.status).toBe("completed");

        // Zero provider calls: authoritative run fields and the observability trace agree.
        expect(run.actualCost?.modelCalls ?? 0).toBe(0);
        expect((run.costEstimate as { modelCalls?: number }).modelCalls ?? 0).toBe(0);
        expect(observabilitySummary.modelCallCount).toBe(0);
        expect(synthesis.providerCalls).toBe(0);

        // Zero cost: no network request could have been billed.
        expect(run.costEstimate.usd).toBe(0);
        expect(observabilitySummary.estimatedCostUsd).toBe(0);
      }),
      { numRuns: 30 },
    );
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
  generousBudget,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";
import { PlannerOutputSchema } from "../src/orchestration/planner";

/** The PLANNING-event payload key the external runner writes its metadata to. */
const PROVIDER_CALL_KEY = "providerCall";

/**
 * A deterministic, schema-valid plan whose single task compiles to a
 * NON-FILE-OPERATION DAG node. The task text contains no "edit"/"file"/"code
 * change" trigger, so the DAG compiler maps it to an `LLM_EXECUTION` node, and
 * its per-task validation node is a `VALIDATION` node with no command — both
 * map to no-op successes in the safe executor. The DAG therefore executes
 * cleanly (status VALIDATED) with no real workspace I/O, so a successful
 * skeptic + synthesizer drive the run all the way to DONE.
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

// Prompts that triage to a "heavy" route (PLAN_ONLY / CODE_EDIT / RESEARCH / LONG_RUNNING) — i.e. NOT
// DIRECT_ANSWER. The full-pipeline cost-reflection property below drives planner -> skeptic ->
// synthesizer (three flagship calls) and reflects every call's token/cost usage into the run. The
// DIRECT_ANSWER route now takes the lightweight cheap-model path (ORN-58, runLiveDirectAnswer), whose
// contract surfaces only USD + model-call cost (not token counts), so it is intentionally excluded
// here and covered by the dedicated direct-answer tests instead.
const HEAVY_ROUTE_PROMPTS = [
  "Create an implementation plan for adding login, but do not edit files.",
  "Fix the TypeScript bug in src/api/server.ts and update tests.",
  "Add pagination to the /users endpoint and update the tests.",
  "Research current options for vector databases and compare sources.",
  "Refactor the budget module and add tests.",
] as const;

const arbHeavyRoutePrompt = (): fc.Arbitrary<string> => fc.constantFrom(...HEAVY_ROUTE_PROMPTS);

describe("Property 7: external mode records provider/model/cost on the PLANNING event", () => {
  // Validates: Requirements 3.4, 4.9 (PLANNING metadata + usage reflection) and the Phase 2 wiring
  // (9.1/9.2/9.7/9.8): a full external run now drives planner -> live skeptic -> crucible -> DAG ->
  // safe executor -> bounded healing -> live synthesizer, so three provider calls are made.
  it("records schema-shaped ProviderCallMetadata and reflects reported usage into run cost/token fields", async () => {
    await fc.assert(
      fc.asyncProperty(arbHeavyRoutePrompt(), arbReportedUsage(), async (prompt, reported) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, prompt);

        // The spy scripts the three live steps in order: (a) the planner plan with arbitrary positive
        // usage on its response, (b) a SOUND/empty skeptic draft (so the crucible ACCEPTS), and (c) a
        // synthesizer draft with one evidence citation (the DAG carried execution evidence). A small
        // fixed estimate keeps every budget preflight permissive.
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [
            {
              content: JSON.stringify({
                distilledContext: prompt,
                proposedToolCalls: [],
                entities: [],
                intent: "Explain",
                constraints: [],
              }),
            },
            { content: planToJson(NON_FILE_OPERATION_PLAN), usage: reported },
            { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
            {
              content: synthesisDraftToJson({
                response: "Completed the task; see cited evidence for details.",
                citations: [
                  { kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" },
                ],
              }),
            },
          ],
        });
        const router = spyRouter(provider);

        const { run } = await runChat(store, args, {
          mode: "external",
          router,
          // maxUsd is raised above the arbitrary planner cost so the skeptic/synthesizer preflights
          // (which see the planner's committed cost) are not denied; the run must reach DONE.
          budget: generousBudget({ maxUsd: 10_000 }),
        });

        // The run completed the full external pipeline: preprocessor + planner + live skeptic + live synthesizer.
        expect(run.phase).toBe("DONE");
        expect(run.status).toBe("completed");
        expect(provider.invokeCount).toBe(4);

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

        // --- (2) Run cost/token fields reflect cumulative live-step usage. ---
        const expectedUsd = reported.estimatedUsd + DEFAULT_SPY_USAGE.estimatedUsd * 2;
        const expectedModelCalls = reported.modelCalls + DEFAULT_SPY_USAGE.modelCalls * 2;
        const expectedInputTokens = reported.inputTokens + DEFAULT_SPY_USAGE.inputTokens * 2;
        const expectedOutputTokens = reported.outputTokens + DEFAULT_SPY_USAGE.outputTokens * 2;
        expect((run.costEstimate as { usd: number }).usd).toBeCloseTo(expectedUsd, 12);
        expect((run.costEstimate as { modelCalls?: number }).modelCalls).toBe(expectedModelCalls);
        expect((run.actualCost as { usd: number }).usd).toBeCloseTo(expectedUsd, 12);
        expect((run.actualCost as { modelCalls?: number }).modelCalls).toBe(expectedModelCalls);
        expect((run.tokenEstimate as { input: number }).input).toBe(expectedInputTokens);
        expect((run.tokenEstimate as { output: number }).output).toBe(expectedOutputTokens);
        expect((run.actualTokens as { input: number }).input).toBe(expectedInputTokens);
        expect((run.actualTokens as { output: number }).output).toBe(expectedOutputTokens);

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

/**
 * Task 9.2 — Control-plane recording and refusal (external chat runner).
 *
 * Validates Requirements 9.1–9.8 against `runExternalChatRun` (wired in task 9.1):
 *   - 9.1 / 9.2: `ProviderCallMetadata` is recorded on the SKEPTIC_REVIEW and
 *     SYNTHESIZING events whether the live step succeeds, blocks, or falls back.
 *   - 9.3 / 9.4: a live skeptic blocker terminates the run FAILED, without an
 *     unhandled throw, and the redacted blocker is recorded on SKEPTIC_REVIEW.
 *   - 9.5: a live synthesizer provider failure resolves to a deterministic
 *     fallback answer (run still reaches DONE), without an unhandled throw.
 *   - 9.6 / 9.7: a healing NEEDS_DECISION outcome terminates the run
 *     NEEDS_DECISION with the healing result and execution artifacts preserved.
 *   - 9.6 / 9.8: a healing FAILED outcome terminates the run FAILED with the
 *     final execution result preserved.
 *
 * Everything is in-memory and mock-only: the router returns a scripted spy
 * provider, the workspace filesystem is injected via `fsImpl`, and the live
 * repair agent is injected — so no API key, real network, or real disk is used.
 */
import nodePath from "node:path";
import { createWorkspaceFs, makeNoRepairAgent } from "./support/byokArbitraries";
import type { SandboxApproval, WorkspaceFs } from "../src/sandbox";

/** Absolute, host-appropriate workspace root for the file-operation fixtures. */
const CHAT_RUNNER_WORKSPACE_ROOT = nodePath.resolve("chat-runner-fixture-root");

/**
 * A deterministic, schema-valid plan whose single task compiles to a
 * `FILE_OPERATION` DAG node (its title contains "edit"/"file"), mapped by the
 * safe executor to a `PROPOSE_PATCH` against the safe relative path
 * `src/app.ts`. With no matching `FILE_WRITE` approval the patch resolves to
 * `NEEDS_APPROVAL` → a `PERMISSION` failure → healing `NEEDS_DECISION`. With an
 * approval but a write-failing `fsImpl` it surfaces as a non-permission failure
 * the repair agent cannot resolve → healing `FAILED`.
 */
const FILE_OPERATION_PLAN = PlannerOutputSchema.parse({
  goal: "Edit the application source file to fix a defect",
  assumptions: ["The defect is isolated to a single source file."],
  tasks: [
    {
      id: "edit.source",
      title: "Edit source file src/app.ts",
      description: "Apply a small code change to the source file to fix the defect.",
      dependencies: [],
      expectedArtifacts: ["src/app.ts"],
      validation: ["The edited file compiles"],
      risk: "low",
      approvalRequired: false,
    },
  ],
  dependencies: [],
  validation: { summary: "Single-file edit plan", checks: ["Confirm the change compiles"] },
  riskLevel: "low",
  approvalGates: [],
});

/** Scripted skeptic draft that yields a SOUND review so the crucible ACCEPTS. */
const SOUND_SKEPTIC_DRAFT = skepticDraftToJson({ verdict: "SOUND", findings: [] });

/** Scripted synthesizer draft with one execution-evidence citation. */
const CITED_SYNTHESIS_DRAFT = synthesisDraftToJson({
  response: "Completed the task; see cited evidence for details.",
  citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" }],
});

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

describe("Task 9.2: external control-plane recording and refusal", () => {
  // Req 9.1 / 9.2: a fully successful external run records ProviderCallMetadata on
  // BOTH the SKEPTIC_REVIEW and SYNTHESIZING events (alongside the PLANNING event).
  it("records ProviderCallMetadata on the SKEPTIC_REVIEW and SYNTHESIZING events", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Explain the deterministic orchestration pipeline.");

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Explain deterministic orchestration pipeline.",
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(NON_FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
        { content: CITED_SYNTHESIS_DRAFT },
      ],
    });

    const { run } = await runChat(store, args, {
      mode: "external",
      router: spyRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
    });

    expect(run.phase).toBe("DONE");
    expect(run.status).toBe("completed");
    expect(provider.invokeCount).toBe(4);

    const events = await store.listEvents(run.id);

    // SKEPTIC_REVIEW carries the skeptic's provider/model/cost metadata (Req 9.1).
    const skepticCall = findProviderCallEvent(events, "SKEPTIC_REVIEW");
    expect(skepticCall).toBeDefined();
    expect(skepticCall!.mode).toBe("external");
    expect(skepticCall!.provider).toBe(provider.metadata.id);
    expect(skepticCall!.model).toBe(provider.metadata.models.flagship);
    expect(skepticCall!.modelRoute).toBe("flagship");

    // SYNTHESIZING carries the synthesizer's provider/model/cost metadata (Req 9.2).
    const synthCall = findProviderCallEvent(events, "SYNTHESIZING");
    expect(synthCall).toBeDefined();
    expect(synthCall!.mode).toBe("external");
    expect(synthCall!.provider).toBe(provider.metadata.id);
    expect(synthCall!.model).toBe(provider.metadata.models.flagship);
    expect(synthCall!.modelRoute).toBe("flagship");
  });

  it("denies the synthesizer when planner plus skeptic usage exhausts max calls/cost", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Explain the deterministic orchestration pipeline.");

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Explain deterministic orchestration pipeline.",
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(NON_FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
        { content: CITED_SYNTHESIS_DRAFT },
      ],
    });

    const { run } = await runChat(store, args, {
      mode: "external",
      router: spyRouter(provider),
      budget: generousBudget({ maxUsd: 0.02, maxModelCalls: 2 }),
    });

    expect(run.phase).toBe("DONE");
    expect(run.status).toBe("completed");
    expect(provider.invokeCount).toBe(3);
    expect((run.actualCost as { usd: number }).usd).toBeCloseTo(0.02, 12);
    expect((run.actualCost as { modelCalls?: number }).modelCalls).toBe(2);

    const events = await store.listEvents(run.id);
    const synthCall = findProviderCallEvent(events, "SYNTHESIZING");
    expect(synthCall).toBeDefined();
    expect(synthCall!.attempts).toBe(0);
    expect((synthCall!.usage as Record<string, unknown>).modelCalls).toBe(0);
  });

  // Req 9.3 / 9.4: a live skeptic blocker terminates the run FAILED — without an
  // unhandled throw — and records the redacted blocker plus ProviderCallMetadata
  // on the SKEPTIC_REVIEW event.
  it("terminates the run FAILED when the live skeptic returns a blocker, without throwing", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Add pagination to the /users endpoint and update the tests.");

    // Planner succeeds; the skeptic provider call throws → PROVIDER_ERROR blocker.
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Explain deterministic orchestration pipeline.",
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(NON_FILE_OPERATION_PLAN) },
        { error: new Error("skeptic upstream returned 503") },
      ],
    });

    const result = await runChat(store, args, {
      mode: "external",
      router: spyRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
    });

    // Req 9.3: terminal FAILED rather than an unhandled error.
    expect(result.run.phase).toBe("FAILED");
    expect(result.run.status).toBe("failed");
    // Skeptic was invoked once (preprocessor #1, planner #2, skeptic #3); the synthesizer never ran.
    expect(provider.invokeCount).toBe(3);

    const events = await store.listEvents(result.run.id);

    // The SKEPTIC_REVIEW event carries the (redacted) blocker and the skeptic metadata (Req 9.1/9.4).
    const skepticEvent = events.find(
      (event) => event.phase === "SKEPTIC_REVIEW" && (event.payload as Record<string, unknown>).blocker !== undefined,
    );
    expect(skepticEvent).toBeDefined();
    const blocker = (skepticEvent!.payload as Record<string, unknown>).blocker as { code: string; message: string };
    expect(blocker.code).toBe("PROVIDER_ERROR");
    expect((skepticEvent!.payload as Record<string, unknown>)[PROVIDER_CALL_KEY]).toBeDefined();

    // No SYNTHESIZING provider metadata was recorded because the run never synthesized.
    expect(findProviderCallEvent(events, "SYNTHESIZING")).toBeUndefined();
  });

  // Req 9.5: a live synthesizer provider failure resolves to the deterministic
  // fallback answer (run still reaches DONE), without an unhandled throw.
  it("falls back to a deterministic synthesis when the synthesizer provider fails, without throwing", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "What is Rector and how does it work?");

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Explain deterministic orchestration pipeline.",
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(NON_FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
        { error: new Error("synthesizer upstream returned 500") },
      ],
    });

    const { run, synthesis } = await runChat(store, args, {
      mode: "external",
      router: spyRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
    });

    // The synthesizer failure was absorbed into a fallback: the run still completes.
    expect(run.phase).toBe("DONE");
    expect(run.status).toBe("completed");
    expect(provider.invokeCount).toBe(4);
    expect(synthesis).toBeDefined();
    expect(synthesis.response.length).toBeGreaterThan(0);

    // ProviderCallMetadata is still recorded on SYNTHESIZING even on a fallback (Req 9.2).
    const events = await store.listEvents(run.id);
    expect(findProviderCallEvent(events, "SYNTHESIZING")).toBeDefined();
  });

  // Req 9.6 / 9.7: a healing NEEDS_DECISION outcome terminates the run
  // NEEDS_DECISION with the healing result and execution artifacts preserved.
  it("terminates the run NEEDS_DECISION when healing requires a decision, preserving artifacts", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Fix the TypeScript bug in src/app.ts and update tests.");

    // Planner emits a FILE_OPERATION plan; the skeptic is SOUND so the crucible
    // ACCEPTS and the DAG compiles. With NO approval, the PROPOSE_PATCH resolves
    // to NEEDS_APPROVAL → a PERMISSION failure → healing NEEDS_DECISION (the
    // injected repair agent is never consulted for a permission failure).
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Fix the TypeScript bug in src/app.ts and update tests.",
            proposedToolCalls: [],
            entities: [],
            intent: "Fix",
            constraints: [],
          }),
        },
        { content: planToJson(FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
      ],
    });
    const noRepair = makeNoRepairAgent();

    const { run } = await runChat(store, args, {
      mode: "external",
      router: spyRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
      workspaceRoot: CHAT_RUNNER_WORKSPACE_ROOT,
      fsImpl: createWorkspaceFs({ root: CHAT_RUNNER_WORKSPACE_ROOT }),
      allowlistedCommands: [],
      approvals: [],
      repairAgent: noRepair.agent,
    });

    // Req 9.7: terminal NEEDS_DECISION, no synthesizer call.
    expect(run.phase).toBe("NEEDS_DECISION");
    expect(run.status).toBe("needs_decision");
    expect(provider.invokeCount).toBe(3);

    const events = await store.listEvents(run.id);
    const decisionPayload = findEvent(events, "NEEDS_DECISION");
    expect(decisionPayload).toBeDefined();

    // The healing result is preserved and reports the decision outcome (Req 9.7).
    const healing = decisionPayload!.validationHealingResult as { status: string } | undefined;
    expect(healing?.status).toBe("NEEDS_DECISION");

    // Execution artifacts are preserved on the terminal event (Req 9.7).
    const artifacts = decisionPayload!.executionArtifacts;
    expect(Array.isArray(artifacts)).toBe(true);
    expect((artifacts as unknown[]).length).toBeGreaterThan(0);
  });

  // Req 9.6 / 9.8: a healing FAILED outcome terminates the run FAILED with the
  // final execution result and node results preserved.
  it("terminates the run FAILED when healing exhausts, preserving the final execution result", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildArgs(store, "Fix the TypeScript bug in src/app.ts and update tests.");

    // An approved PROPOSE_PATCH whose underlying write throws surfaces as a
    // non-permission node failure; the no-repair agent offers no safe patch, so
    // the bounded healing loop terminates FAILED (req 5.9) → run FAILED.
    const baseFs = createWorkspaceFs({ root: CHAT_RUNNER_WORKSPACE_ROOT });
    const writeFailingFs: WorkspaceFs = {
      realpathSync: (path) => baseFs.realpathSync(path),
      readFileSync: (path) => baseFs.readFileSync(path),
      readdirSync: (path) => baseFs.readdirSync(path),
      writeFileSync: () => {
        throw new Error("workspace disk write failed (injected)");
      },
    };
    const approvals: SandboxApproval[] = [
      { id: "approval:file-write:src/app.ts", scope: "FILE_WRITE", target: "src/app.ts", approvedBy: "test" },
    ];

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: "Fix the TypeScript bug in src/app.ts and update tests.",
            proposedToolCalls: [],
            entities: [],
            intent: "Fix",
            constraints: [],
          }),
        },
        { content: planToJson(FILE_OPERATION_PLAN) },
        { content: SOUND_SKEPTIC_DRAFT },
      ],
    });
    const noRepair = makeNoRepairAgent();

    const { run } = await runChat(store, args, {
      mode: "external",
      router: spyRouter(provider),
      budget: generousBudget({ maxUsd: 10_000 }),
      workspaceRoot: CHAT_RUNNER_WORKSPACE_ROOT,
      fsImpl: writeFailingFs,
      allowlistedCommands: [],
      approvals,
      repairAgent: noRepair.agent,
    });

    // Req 9.8: terminal FAILED, no synthesizer call.
    expect(run.phase).toBe("FAILED");
    expect(run.status).toBe("failed");
    expect(provider.invokeCount).toBe(3);

    const events = await store.listEvents(run.id);
    const failedPayload = findEvent(events, "FAILED");
    expect(failedPayload).toBeDefined();

    // The healing result and the final execution result (with node results) are
    // preserved on the terminal FAILED event (Req 9.8).
    const healing = failedPayload!.validationHealingResult as
      | { status: string; finalExecutionResult: { status: string; nodeResults: unknown[] } }
      | undefined;
    expect(healing?.status).toBe("FAILED");
    expect(healing?.finalExecutionResult.status).toBe("FAILED");
    expect(Array.isArray(healing?.finalExecutionResult.nodeResults)).toBe(true);
    expect((healing!.finalExecutionResult.nodeResults as unknown[]).length).toBeGreaterThan(0);
    // The execution-artifacts array is present on the terminal event (preserved, even when empty).
    expect(Array.isArray(failedPayload!.executionArtifacts)).toBe(true);
  });
});
