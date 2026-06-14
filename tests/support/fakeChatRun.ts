/**
 * Test-only deterministic chat runner (Phase 4: not exported from product `chatRunner`).
 *
 * Preserves the provider-free `runFakeChatRun` harness for regression baselines and
 * performance scripts. Product chat always flows through `runOrchestratedChatRun`.
 */
import type { ContextPack } from "../../src/orchestration/contextBuilder";
import { arbitratePlanWithCrucible, type CrucibleDecision } from "../../src/orchestration/crucible";
import { compileAcceptedPlanToDag, type CompiledDag } from "../../src/orchestration/dagCompiler";
import { executeCompiledDag, type ExecutorSimulatorOptions } from "../../src/orchestration/executorSimulator";
import { phaseObservabilityPayload, runEvent } from "../../src/orchestration/externalRunSupport";
import { createFakePlan, type PlannerOutput } from "../../src/orchestration/planner";
import { transitionRun } from "../../src/orchestration/runStateMachine";
import { reviewPlanWithSkeptic, type SkepticReview } from "../../src/orchestration/skeptic";
import {
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesis,
} from "../../src/orchestration/synthesizer";
import type { TriageResult } from "../../src/orchestration/triage";
import {
  validateAndHealExecution,
  type HealingLoopResult,
} from "../../src/orchestration/validationHealing";
import type { InMemoryObservabilityTrace, ObservabilitySummary } from "../../src/observability";
import type { RectorStore } from "../../src/store";
import type { Run } from "../../src/store/schemas";

export interface FakeChatRunArgs {
  conversationId: string;
  userMessageId: string;
  prompt: string;
  triage: TriageResult;
  contextPack: ContextPack;
  observability: InMemoryObservabilityTrace;
  options?: {
    executorOptions?: ExecutorSimulatorOptions;
    maxHealingAttempts?: number;
  };
}

export interface FakeChatRunResult {
  run: Run;
  synthesis: BrainstemSynthesis;
  observabilitySummary: ObservabilitySummary;
}

/**
 * Deterministic, provider-free chat run for tests and benchmarks only.
 */
export async function runFakeChatRun(store: RectorStore, args: FakeChatRunArgs): Promise<FakeChatRunResult> {
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

interface PostPlanningParams {
  store: RectorStore;
  args: FakeChatRunArgs;
  run: Run;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  source: string;
  noteLabel: string;
  planningExtraPayload?: Record<string, unknown>;
  now?: () => string;
}

async function runPostPlanningPhases(params: PostPlanningParams): Promise<FakeChatRunResult> {
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
    compiledDag
      ? executeCompiledDag(compiledDag, {
          ...options.executorOptions,
          blockSimulatedWorkspaceOps: args.triage.route === "CODE_EDIT",
        })
      : undefined
  );
  const executionPayload = executionResult
    ? { executionResult }
    : { skippedReason: "Execution skipped because no compiled DAG exists" };
  const validationHealingResult: HealingLoopResult | undefined = await observability.recordSpan("VALIDATING", () =>
    compiledDag && executionResult
      ? validateAndHealExecution({
          compiledDag,
          executionResult,
          executorOptions: {
            ...options.executorOptions,
            blockSimulatedWorkspaceOps: args.triage.route === "CODE_EDIT",
          },
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