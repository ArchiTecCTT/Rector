import crypto from "node:crypto";
import { z } from "zod";
import type { ContextPack } from "./contextBuilder";
import { arbitratePlanWithCrucible, type CrucibleDecision } from "./crucible";
import { compileAcceptedPlanToDag, type CompiledDag } from "./dagCompiler";
import { executeCompiledDag, type ExecutorSimulatorOptions } from "./executorSimulator";
import { createFakePlan, runLivePlanner, type PlannerBlocker, type PlannerOutput } from "./planner";
import { createDecisionRequest, transitionRun } from "./runStateMachine";
import { reviewPlanWithSkeptic, type SkepticReview } from "./skeptic";
import {
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesis,
  type BrainstemSynthesisStatus,
} from "./synthesizer";
import type { TriageResult } from "./triage";
import { validateAndHealExecution, type HealingLoopResult } from "./validationHealing";
import {
  type InMemoryObservabilityTrace,
  type ObservabilitySpan,
  type ObservabilitySummary,
} from "../observability";
import { redactSecrets } from "../security/redaction";
import {
  LLMUsageSchema,
  ModelRouteSchema,
  type LLMUsage,
  type ModelRouter,
  type ModelSelection,
} from "../providers/llm";
import { OrchestratorModeSchema, type OrchestratorMode } from "../deployment";
import type { InMemoryRectorStore } from "../store/inMemoryRectorStore";
import type { Budget, Run, RunEvent } from "../store/schemas";

/**
 * Options that tune the deterministic phases shared by both runners (executor simulator behaviour
 * and the validation/healing attempt budget). These mirror the previous `createFakeChatRun`
 * options exactly so local-mode output is unchanged.
 */
export interface ChatRunOptions {
  executorOptions?: ExecutorSimulatorOptions;
  maxHealingAttempts?: number;
}

/**
 * Inputs to a single chat run, gathered by the chat endpoint before dispatch. These are identical
 * across modes; only the planner source and recorded provider/cost metadata differ in external
 * mode.
 */
export interface ChatRunArgs {
  conversationId: string;
  userMessageId: string;
  prompt: string;
  triage: TriageResult;
  contextPack: ContextPack;
  observability: InMemoryObservabilityTrace;
  options?: ChatRunOptions;
}

/**
 * Mode-aware dependencies. In `local` mode nothing else is required. In `external` mode a
 * `ModelRouter` is injected (built once per app) and `enableNetwork` gates live provider calls;
 * tests inject a mocked router so no real network or API key is ever required. `budget` configures
 * the external-mode run budget that the planner preflight enforces (defaults to
 * {@link DEFAULT_EXTERNAL_BUDGET}); it is ignored in local mode, which always uses an all-zero
 * budget.
 */
export interface ChatRunnerDeps {
  mode: OrchestratorMode;
  router?: ModelRouter;
  enableNetwork?: boolean;
  budget?: Budget;
  now?: () => string;
}

export interface ChatRunResult {
  run: Run;
  synthesis: BrainstemSynthesis;
  observabilitySummary: ObservabilitySummary;
}

/**
 * Provider/model/cost metadata recorded on the `PLANNING` run event in external mode. Carries only
 * non-secret identifiers and accumulated token/cost usage; it is passed through `redactSecrets`
 * (by `transitionRun`) before persistence and never contains an API key, header, or raw model
 * output. Local-mode events carry no provider metadata, preserving the current event shapes.
 */
export const ProviderCallMetadataSchema = z.object({
  mode: OrchestratorModeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  modelRoute: ModelRouteSchema,
  usage: LLMUsageSchema,
  attempts: z.number().int().min(1).max(2),
  repaired: z.boolean(),
});
export type ProviderCallMetadata = z.infer<typeof ProviderCallMetadataSchema>;

/**
 * Default external-mode budget. Non-trivial (`maxModelCalls >= 1`, `maxUsd > 0`) so the router can
 * select a paid provider and the planner can perform its (at most two) calls. `allowedProviders` is
 * empty so the budget does not restrict the router's chosen provider, and `approvalRequiredAboveUsd`
 * is 0 so a routine planner call is not gated behind an approval decision.
 */
export const DEFAULT_EXTERNAL_BUDGET: Budget = {
  maxUsd: 1,
  maxInputTokens: 200_000,
  maxOutputTokens: 64_000,
  maxModelCalls: 4,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: [],
  approvalRequiredAboveUsd: 0,
};

/**
 * Dispatches a chat run by orchestration mode.
 *
 * - `local` (default): the deterministic, provider-free path (`runFakeChatRun`) whose outputs are
 *   byte-for-byte identical to the previous `createFakeChatRun` behaviour.
 * - `external`: the BYOK path (`runExternalChatRun`) that swaps only the planner step and records
 *   provider/cost metadata. A configured `ModelRouter` is required (built once at app init).
 */
export async function runChat(
  store: InMemoryRectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps
): Promise<ChatRunResult> {
  if (deps.mode === "external") {
    if (!deps.router) {
      throw new Error("External orchestration mode requires a configured ModelRouter (built at app init).");
    }
    return runExternalChatRun(store, args, { ...deps, router: deps.router });
  }
  return runFakeChatRun(store, args);
}

/**
 * Deterministic, provider-free chat run. Produces the same phase sequence, all-zero budget/cost,
 * and `createFakePlan` plan source as the original `createFakeChatRun`. The symbolic control plane
 * remains fully in charge: every phase is local and no network call occurs.
 */
export async function runFakeChatRun(store: InMemoryRectorStore, args: ChatRunArgs): Promise<ChatRunResult> {
  const { conversationId, userMessageId, prompt, triage, contextPack, observability } = args;
  const options = args.options ?? {};
  const traceId = observability.traceId;

  const plannerOutput = await observability.recordSpan("PLANNING", () =>
    createFakePlan({ triage, contextPack, messageContent: prompt })
  );
  const skepticReview = await observability.recordSpan("SKEPTIC_REVIEW", () =>
    reviewPlanWithSkeptic(plannerOutput, contextPack)
  );
  const crucibleDecision = await observability.recordSpan("CRUCIBLE", () =>
    arbitratePlanWithCrucible({ plannerOutput, skepticReview })
  );

  const run = await store.createRun({
    conversationId,
    userMessageId,
    status: "running",
    phase: "CHAT_RECEIVED",
    route: triage.route,
    complexity: triage.complexity,
    budget: {
      maxUsd: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxModelCalls: 0,
      maxRuntimeMs: 1000,
      maxHealingAttempts: options.maxHealingAttempts ?? 2,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId,
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
  });

  await store.appendEvent(
    runEvent(run, "RUN_CREATED", "CHAT_RECEIVED", {
      source: "chat-api",
      promptPreview: prompt.slice(0, 120),
      triage: {
        route: triage.route,
        confidence: triage.confidence,
        complexity: triage.complexity,
        riskFlags: triage.riskFlags,
      },
      observability: phaseObservabilityPayload(observability, "CHAT_RECEIVED"),
    })
  );

  // Skeptic → crucible → DAG → executor → validation → synthesis are deterministic and shared with
  // external mode; only the planner source above differs.
  return runPostPlanningPhases({
    store,
    args,
    run,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    source: "fake-orchestrator",
    noteLabel: "Local",
  });
}

/**
 * BYOK external chat run (ORN-33). Differs from {@link runFakeChatRun} in exactly two ways: the
 * planner step uses {@link runLivePlanner} against a router-selected provider, and the resulting
 * provider/model/cost metadata is recorded on the `PLANNING` event and mapped into the run's
 * cost/token fields. Every other phase (skeptic → crucible → DAG → executor → validation →
 * synthesis) is the deterministic shared sequence.
 *
 * On a planner blocker the run is driven to a terminal/decision phase via the run state machine —
 * `FAILED` for `PLANNER_INVALID` (deterministic refusal of unsafe/malformed output) or
 * `NEEDS_DECISION` for `BUDGET_DENIED`/`PROVIDER_ERROR` (operator can adjust budget/keys). No
 * exception ever propagates past this function for a budget/provider/validation failure.
 */
export async function runExternalChatRun(
  store: InMemoryRectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps & { router: ModelRouter }
): Promise<ChatRunResult> {
  const { conversationId, userMessageId, prompt, triage, contextPack, observability } = args;
  const options = args.options ?? {};
  const traceId = observability.traceId;
  const budget = deps.budget ?? DEFAULT_EXTERNAL_BUDGET;

  // The run is created first so its budget is available to the planner preflight.
  const run = await store.createRun({
    conversationId,
    userMessageId,
    status: "running",
    phase: "CHAT_RECEIVED",
    route: triage.route,
    complexity: triage.complexity,
    budget: {
      ...budget,
      maxHealingAttempts: options.maxHealingAttempts ?? budget.maxHealingAttempts,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId,
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
  });

  await store.appendEvent(
    runEvent(run, "RUN_CREATED", "CHAT_RECEIVED", {
      source: "chat-api",
      mode: "external",
      promptPreview: prompt.slice(0, 120),
      triage: {
        route: triage.route,
        confidence: triage.confidence,
        complexity: triage.complexity,
        riskFlags: triage.riskFlags,
      },
      observability: phaseObservabilityPayload(observability, "CHAT_RECEIVED"),
    })
  );

  // Deterministic provider selection; a zero budget or no configured provider falls back to the
  // fake provider (still safe), so selection itself never throws.
  const selection: ModelSelection = deps.router.select({ capability: "flagship", task: "planner", run });

  // --- PLANNER STEP (the only divergence from local mode) ---
  // runLivePlanner runs the budget preflight BEFORE any provider call (Req 3.3/3.4) and resolves
  // with a structured, redacted blocker instead of throwing on budget/provider/validation failure.
  const plannerResult = await observability.recordSpan("PLANNING", () =>
    runLivePlanner(
      { triage, contextPack, messageContent: prompt },
      { provider: selection.provider, run }
    )
  );

  if (plannerResult.status === "blocked" || !plannerResult.plan) {
    const blocker = plannerResult.blocker ?? {
      code: "PLANNER_INVALID" as const,
      message: "Planner returned no plan",
    };
    return resolvePlannerBlocker(store, args, run, blocker, deps);
  }

  const plannerOutput = plannerResult.plan;

  // Map the accumulated provider usage into the run's cost/token fields so the budget gate and the
  // cost dashboard (future phase) observe real usage (Req 3.6). Recorded as both estimate and
  // actual since Phase 1 has a single committed provider call per run.
  const usage = plannerResult.usage;
  const updatedRun = await store.updateRun(run.id, {
    costEstimate: { usd: usage.estimatedUsd, modelCalls: usage.modelCalls, provider: plannerResult.provider },
    actualCost: { usd: usage.estimatedUsd, modelCalls: usage.modelCalls, provider: plannerResult.provider },
    tokenEstimate: { input: usage.inputTokens, output: usage.outputTokens },
    actualTokens: { input: usage.inputTokens, output: usage.outputTokens },
  });
  const costedRun = updatedRun ?? run;

  // Provider/model/cost metadata recorded on the PLANNING event (Req 3.5).
  const providerCall = buildProviderCallMetadata(selection, plannerResult.provider, plannerResult.model, usage, plannerResult.attempts);

  const skepticReview = await observability.recordSpan("SKEPTIC_REVIEW", () =>
    reviewPlanWithSkeptic(plannerOutput, contextPack)
  );
  const crucibleDecision = await observability.recordSpan("CRUCIBLE", () =>
    arbitratePlanWithCrucible({ plannerOutput, skepticReview })
  );

  return runPostPlanningPhases({
    store,
    args,
    run: costedRun,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    source: "external-orchestrator",
    noteLabel: "External",
    planningExtraPayload: { providerCall },
    now: deps.now,
  });
}

interface PostPlanningParams {
  store: InMemoryRectorStore;
  args: ChatRunArgs;
  run: Run;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  source: string;
  noteLabel: string;
  planningExtraPayload?: Record<string, unknown>;
  now?: () => string;
}

/**
 * Runs the deterministic post-planning phase sequence shared by both runners: DAG compilation,
 * execution, validation/healing, synthesis, and the run state-machine transitions
 * (TRIAGE → … → DONE). Behaviour is identical regardless of how `plannerOutput` was obtained; the
 * only mode-specific input is `planningExtraPayload` (the external provider metadata recorded on
 * the `PLANNING` event) and the `source`/`noteLabel` event annotations.
 */
async function runPostPlanningPhases(params: PostPlanningParams): Promise<ChatRunResult> {
  const { store, args, run, plannerOutput, skepticReview, crucibleDecision } = params;
  const { observability } = args;
  const options = args.options ?? {};
  const traceId = observability.traceId;
  const planningExtra = params.planningExtraPayload ?? {};

  const compiledDag: CompiledDag | undefined = await observability.recordSpan("DAG_COMPILATION", () =>
    crucibleDecision.verdict === "ACCEPTED"
      ? compileAcceptedPlanToDag({
          runId: run.id,
          crucibleDecision,
          budgetPolicy: run.budget,
        })
      : undefined
  );

  const dagCompilationPayload = compiledDag
    ? { compiledDag }
    : { skippedReason: `Crucible verdict ${crucibleDecision.verdict} is not ACCEPTED` };
  const executionResult = await observability.recordSpan("EXECUTING", () =>
    compiledDag ? executeCompiledDag(compiledDag, options.executorOptions) : undefined
  );
  const executionPayload = executionResult
    ? { executionResult }
    : { skippedReason: "Execution skipped because no compiled DAG exists" };
  const validationHealingResult: HealingLoopResult | undefined = await observability.recordSpan("VALIDATING", () =>
    compiledDag && executionResult
      ? validateAndHealExecution({
          compiledDag,
          executionResult,
          executorOptions: options.executorOptions,
          maxHealingAttempts: options.maxHealingAttempts,
        })
      : undefined
  );
  const validationPayload = validationHealingResult
    ? { validationHealingResult }
    : { skippedReason: "Execution skipped or missing; validation and healing skipped" };
  const synthesis = await observability.recordSpan("SYNTHESIZING", () =>
    synthesizeChatBrainstemResponse({
      traceId,
      triage: args.triage,
      contextPack: args.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
      compiledDag,
      executionResult,
      validationHealingResult,
      observabilitySummary: observability.getSummary(),
    })
  );
  await observability.recordSpan("DONE", () => undefined);

  const phases = [
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

  let current = run;
  for (const phase of phases) {
    const result = await transitionRun(store, current.id, phase, {
      traceId,
      now: params.now,
      payload: {
        source: params.source,
        note: `${params.noteLabel} brainstem run ${phase === "DONE" ? "completed" : "advanced"}`,
        ...(phase === "TRIAGE" ? { triage: args.triage } : {}),
        ...(phase === "CONTEXT_BUILDING" ? { contextPack: args.contextPack } : {}),
        ...(phase === "PLANNING" ? { plannerOutput, ...planningExtra } : {}),
        ...(phase === "SKEPTIC_REVIEW" ? { skepticReview } : {}),
        ...(phase === "CRUCIBLE" ? { crucibleDecision } : {}),
        ...(phase === "DAG_COMPILATION" ? dagCompilationPayload : {}),
        ...(phase === "EXECUTING" ? executionPayload : {}),
        ...(phase === "VALIDATING" ? validationPayload : {}),
        ...(phase === "SYNTHESIZING" ? { synthesis } : {}),
        observability: phaseObservabilityPayload(observability, phase),
      },
      ...(phase === "VALIDATING" && validationHealingResult
        ? {
            validationAttempts: validationHealingResult.attempts + 1,
            healingAttempts: validationHealingResult.attempts,
          }
        : {}),
    });
    current = result.run;
  }

  return { run: current, synthesis, observabilitySummary: observability.getSummary() };
}

/**
 * Drives a planner blocker to a terminal/decision phase without throwing (Req 3.7). Advances the
 * run through the pre-planning phases (TRIAGE → CONTEXT_BUILDING) so the state machine permits the
 * terminal transition, then transitions to `FAILED` for `PLANNER_INVALID` or `NEEDS_DECISION` for
 * `BUDGET_DENIED`/`PROVIDER_ERROR`. The blocker is already redacted by the live planner.
 */
async function resolvePlannerBlocker(
  store: InMemoryRectorStore,
  args: ChatRunArgs,
  run: Run,
  blocker: PlannerBlocker,
  deps: ChatRunnerDeps
): Promise<ChatRunResult> {
  const { observability } = args;
  const traceId = observability.traceId;

  let current = run;
  for (const phase of ["TRIAGE", "CONTEXT_BUILDING"] as const) {
    const result = await transitionRun(store, current.id, phase, {
      traceId,
      now: deps.now,
      payload: {
        source: "external-orchestrator",
        note: "External brainstem run advanced",
        ...(phase === "TRIAGE" ? { triage: args.triage } : {}),
        ...(phase === "CONTEXT_BUILDING" ? { contextPack: args.contextPack } : {}),
        observability: phaseObservabilityPayload(observability, phase),
      },
    });
    current = result.run;
  }

  const isPlannerInvalid = blocker.code === "PLANNER_INVALID";
  if (isPlannerInvalid) {
    const failed = await transitionRun(store, current.id, "FAILED", {
      traceId,
      now: deps.now,
      lastError: blocker.message,
      payload: {
        source: "external-orchestrator",
        note: "Planner output rejected after repair",
        blocker,
        observability: phaseObservabilityPayload(observability, "FAILED"),
      },
    });
    current = failed.run;
  } else {
    const decision = await createDecisionRequest(
      store,
      current.id,
      { reason: blocker.code, message: blocker.message, blocker },
      {
        traceId,
        now: deps.now,
        payload: {
          source: "external-orchestrator",
          note: "Planner requires an operator decision",
          blocker,
          observability: phaseObservabilityPayload(observability, "NEEDS_DECISION"),
        },
      }
    );
    current = decision.run;
  }

  const status: BrainstemSynthesisStatus = isPlannerInvalid ? "FAILED" : "NEEDS_DECISION";
  const synthesis = buildBlockedSynthesis(args, blocker, status, observability.getSummary());
  return { run: current, synthesis, observabilitySummary: observability.getSummary() };
}

function buildProviderCallMetadata(
  selection: ModelSelection,
  provider: string,
  model: string,
  usage: LLMUsage,
  attempts: number
): ProviderCallMetadata {
  return ProviderCallMetadataSchema.parse({
    mode: "external",
    provider,
    model,
    modelRoute: selection.modelRoute,
    usage,
    attempts,
    repaired: attempts > 1,
  });
}

/**
 * Builds a deterministic synthesis for a blocked external run. `providerCalls` is the literal `0`
 * required by `BrainstemSynthesis` (the authoritative provider-call count lives in the run's cost
 * metadata and the PLANNING `ProviderCallMetadata`). The blocker message is already redacted.
 */
function buildBlockedSynthesis(
  args: ChatRunArgs,
  blocker: PlannerBlocker,
  status: BrainstemSynthesisStatus,
  observabilitySummary: ObservabilitySummary
): BrainstemSynthesis {
  const route = args.triage.route;
  const evidence = [`triage ${args.triage.route}/${args.triage.complexity}`, `planner blocked ${blocker.code}`];
  return {
    status,
    route,
    traceId: observabilitySummary.traceId,
    evidence,
    providerCalls: 0,
    observability: observabilitySummary,
    response: [
      `Status: ${status}.`,
      `Route: ${route}.`,
      `Trace: ${observabilitySummary.traceId}.`,
      `Planner blocked (${blocker.code}): ${blocker.message}`,
    ].join(" "),
  };
}

export function phaseObservabilityPayload(
  observability: InMemoryObservabilityTrace,
  phase: string
): { traceId: string; span?: ObservabilitySpan; summary: ObservabilitySummary } {
  return {
    traceId: observability.traceId,
    span: observability.getLastSpanForPhase(phase),
    summary: observability.getSummary(),
  };
}

export function runEvent(
  run: Run,
  type: RunEvent["type"],
  phase: RunEvent["phase"],
  payload: Record<string, unknown>
): RunEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    runId: run.id,
    type,
    phase,
    payload: redactSecrets(payload),
    traceId: run.traceId,
    createdAt: new Date().toISOString(),
  };
}
