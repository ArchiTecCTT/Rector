import crypto from "node:crypto";
import { z } from "zod";
import type { ContextPack } from "./contextBuilder";
import { arbitratePlanWithCrucible, type CrucibleDecision } from "./crucible";
import { compileAcceptedPlanToDag, type CompiledDag } from "./dagCompiler";
import { executeCompiledDag, type ExecutorSimulatorOptions } from "./executorSimulator";
import { createFakePlan, runLivePlanner, type PlannerBlocker, type PlannerOutput } from "./planner";
import { buildRepairPrompt } from "./prompts";
import { createDecisionRequest, transitionRun } from "./runStateMachine";
import { executeDagThroughSandbox } from "./sandboxExecutor";
import { reviewPlanWithSkeptic, runLiveSkeptic, type SkepticBlocker, type SkepticReview } from "./skeptic";
import {
  runLiveSynthesizer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesis,
  type BrainstemSynthesisInput,
  type BrainstemSynthesisStatus,
} from "./synthesizer";
import type { TriageResult } from "./triage";
import {
  validateAndHealExecution,
  type HealingLoopResult,
  type LiveRepairAgent,
} from "./validationHealing";
import {
  type InMemoryObservabilityTrace,
  type ObservabilitySpan,
  type ObservabilitySummary,
} from "../observability";
import { evaluateBudget, type BudgetUsage } from "../security/budget";
import { redactSecrets } from "../security/redaction";
import {
  invokeWithBudget,
  LLMUsageSchema,
  ModelRouteSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ModelRouter,
  type ModelSelection,
} from "../providers/llm";
import {
  PatchOperationSchema,
  WorkspaceSandboxAdapter,
  type CommandRunner,
  type SandboxApproval,
  type WorkspaceFs,
} from "../sandbox";
import { OrchestratorModeSchema, type OrchestratorMode } from "../deployment";
import type { RectorStore } from "../store";
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
  /**
   * External-mode safe-executor wiring (ORN-37/38). All optional and test-injectable so `npm test`
   * needs no real disk or process: `workspaceRoot` bounds every file/command operation (defaults to
   * `process.cwd()`), `fsImpl` injects an in-memory filesystem, `commandRunner` injects a
   * deterministic command runner, `allowlistedCommands` configures the `RUN_COMMAND` allowlist, and
   * `approvals` seeds explicit `SandboxApproval`s. These are ignored in local mode.
   */
  workspaceRoot?: string;
  fsImpl?: WorkspaceFs;
  commandRunner?: CommandRunner;
  allowlistedCommands?: string[];
  approvals?: SandboxApproval[];
  /**
   * Optional override for the live repair agent used by the bounded healing loop. When omitted, the
   * external runner constructs a provider-backed {@link LiveRepairAgent} from the router-selected
   * provider. Injected in tests to exercise the healing path deterministically.
   */
  repairAgent?: LiveRepairAgent;
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
  // `attempts` is the number of provider invocations a live step performed. The planner path always
  // reports >= 1, but the live skeptic/synthesizer can finish on a budget-denied preflight with zero
  // calls (attempts === 0), so the lower bound is widened to 0 (backward-compatible: >= 1 still
  // validates) to record their `ProviderCallMetadata` even on a denied step.
  attempts: z.number().int().min(0).max(2),
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
  store: RectorStore,
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
export async function runFakeChatRun(store: RectorStore, args: ChatRunArgs): Promise<ChatRunResult> {
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
  store: RectorStore,
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

  // --- SKEPTIC STEP (live, ORN-35) ---
  // runLiveSkeptic runs the budget preflight BEFORE any provider call and resolves with a
  // structured, redacted SkepticBlocker instead of throwing. On a blocker the run terminates FAILED
  // (Req 9.3) with the skeptic's ProviderCallMetadata recorded on the SKEPTIC_REVIEW event (Req 9.1).
  const skepticSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "skeptic", run: costedRun });
  const skepticResult = await observability.recordSpan("SKEPTIC_REVIEW", () =>
    runLiveSkeptic({ plannerOutput, contextPack, triage }, { provider: skepticSelection.provider, run: costedRun })
  );
  const skepticProviderCall = buildProviderCallMetadata(
    skepticSelection,
    skepticResult.provider,
    skepticResult.model,
    skepticResult.usage,
    skepticResult.attempts
  );

  if (skepticResult.status === "blocked" || !skepticResult.review) {
    const blocker: SkepticBlocker = skepticResult.blocker ?? {
      code: "SKEPTIC_INVALID",
      message: "Skeptic returned no review",
    };
    return resolveSkepticBlocker(store, args, costedRun, blocker, deps, {
      plannerOutput,
      planningProviderCall: providerCall,
      skepticProviderCall,
    });
  }

  const skepticReview = skepticResult.review;
  const crucibleDecision = await observability.recordSpan("CRUCIBLE", () =>
    arbitratePlanWithCrucible({ plannerOutput, skepticReview })
  );

  return runExternalPostPlanningPhases({
    store,
    args,
    run: costedRun,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    planningProviderCall: providerCall,
    skepticProviderCall,
    deps: { ...deps, router: deps.router },
  });
}

interface ExternalPostPlanningParams {
  store: RectorStore;
  args: ChatRunArgs;
  run: Run;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  planningProviderCall: ProviderCallMetadata;
  skepticProviderCall: ProviderCallMetadata;
  deps: ChatRunnerDeps & { router: ModelRouter };
}

/**
 * Runs the external post-planning phase sequence (ORN-37/38). Unlike the deterministic
 * {@link runPostPlanningPhases} (kept byte-for-byte for local mode), this path drives the
 * EXECUTING / VALIDATING / HEALING phases through the safe workspace executor
 * ({@link executeDagThroughSandbox} + {@link WorkspaceSandboxAdapter}) and the bounded live healing
 * loop ({@link validateAndHealExecution} with a live {@link LiveRepairAgent}), and produces the final
 * answer via {@link runLiveSynthesizer}. `ProviderCallMetadata` is recorded on the SKEPTIC_REVIEW and
 * SYNTHESIZING events; a healing `NEEDS_DECISION`/`FAILED` outcome maps to the matching run status
 * with all artifacts preserved (Req 9.7/9.8). Every payload is passed through `redactSecrets` (by
 * `transitionRun`) before persistence. No exception escapes for a live-step failure.
 */
async function runExternalPostPlanningPhases(params: ExternalPostPlanningParams): Promise<ChatRunResult> {
  const { store, args, run, plannerOutput, skepticReview, crucibleDecision, deps } = params;
  const { observability } = args;
  const options = args.options ?? {};
  const traceId = observability.traceId;

  // DAG compilation (only when the crucible accepted the plan).
  const compiledDag: CompiledDag | undefined = await observability.recordSpan("DAG_COMPILATION", () =>
    crucibleDecision.verdict === "ACCEPTED"
      ? compileAcceptedPlanToDag({ runId: run.id, crucibleDecision, budgetPolicy: run.budget })
      : undefined
  );
  const dagCompilationPayload = compiledDag
    ? { compiledDag }
    : { skippedReason: `Crucible verdict ${crucibleDecision.verdict} is not ACCEPTED` };

  // The safe workspace executor is the ONLY bridge to real file/command I/O. A shared mutable
  // approvals array lets the live repair agent auto-register a FILE_WRITE approval for its proposed
  // path before the healing loop applies the patch through the sandbox (containment + denylist are
  // still enforced by the executor).
  const approvals: SandboxApproval[] = [...(deps.approvals ?? [])];
  const sandbox = new WorkspaceSandboxAdapter({
    workspaceRoot: deps.workspaceRoot ?? process.cwd(),
    allowlistedCommands: deps.allowlistedCommands ?? [],
    approvals,
    fsImpl: deps.fsImpl,
    commandRunner: deps.commandRunner,
    now: deps.now,
  });
  const repairSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "repair", run });
  const repairAgent: LiveRepairAgent =
    deps.repairAgent ?? createLiveRepairAgent({ provider: repairSelection.provider, approvals });

  // EXECUTING — dispatch the DAG through the safe executor.
  const executionResult = await observability.recordSpan("EXECUTING", () =>
    compiledDag ? executeDagThroughSandbox(compiledDag, { sandbox, now: deps.now }) : undefined
  );
  const executionArtifacts = executionResult?.artifacts ?? [];
  const executionPayload = executionResult
    ? { executionResult, executionArtifacts }
    : { skippedReason: "Execution skipped because no compiled DAG exists" };

  // VALIDATING + HEALING — bounded live repair over real failures (patches applied only via sandbox).
  const validationHealingResult: HealingLoopResult | undefined = await observability.recordSpan("VALIDATING", () =>
    compiledDag && executionResult
      ? validateAndHealExecution({
          compiledDag,
          executionResult,
          executor: (dag) => executeDagThroughSandbox(dag, { sandbox, now: deps.now }),
          executorOptions: options.executorOptions,
          maxHealingAttempts: options.maxHealingAttempts,
          repairAgent,
          sandbox,
          contextPack: args.contextPack,
          run,
        })
      : undefined
  );
  const validationPayload = validationHealingResult
    ? { validationHealingResult }
    : { skippedReason: "Execution skipped or missing; validation and healing skipped" };

  const healingStatus = validationHealingResult?.status;
  // A NEEDS_DECISION / FAILED healing outcome terminates the run before synthesis (Req 9.7/9.8).
  const proceedToSynthesis = healingStatus === undefined || healingStatus === "VALIDATED" || healingStatus === "HEALED";

  const synthInput: BrainstemSynthesisInput = {
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
  };

  let synthesis: BrainstemSynthesis;
  let synthProviderCall: ProviderCallMetadata | undefined;

  if (proceedToSynthesis) {
    // SYNTHESIZING — live, evidence-cited answer with deterministic fallback (ORN-36).
    const synthSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "synthesizer", run });
    const synthResult = await observability.recordSpan("SYNTHESIZING", () =>
      runLiveSynthesizer(synthInput, { provider: synthSelection.provider, run })
    );
    synthesis = synthResult.synthesis;
    synthProviderCall = buildProviderCallMetadata(
      synthSelection,
      synthResult.provider,
      synthResult.model,
      synthResult.usage,
      synthResult.attempts
    );
    await observability.recordSpan("DONE", () => undefined);
  } else {
    // Terminal NEEDS_DECISION / FAILED: return the deterministic synthesis (status derived from the
    // healing result), which never hides failed validation output.
    synthesis = synthesizeChatBrainstemResponse(synthInput);
  }

  // --- Phase transitions (TRIAGE … VALIDATING), then branch on the healing outcome. ---
  const prefixPhases = [
    "TRIAGE",
    "CONTEXT_BUILDING",
    "PLANNING",
    "SKEPTIC_REVIEW",
    "CRUCIBLE",
    "DAG_COMPILATION",
    "EXECUTING",
    "VALIDATING",
  ] as const;

  let current = run;
  for (const phase of prefixPhases) {
    const result = await transitionRun(store, current.id, phase, {
      traceId,
      now: deps.now,
      payload: {
        source: "external-orchestrator",
        note: "External brainstem run advanced",
        ...(phase === "TRIAGE" ? { triage: args.triage } : {}),
        ...(phase === "CONTEXT_BUILDING" ? { contextPack: args.contextPack } : {}),
        ...(phase === "PLANNING" ? { plannerOutput, providerCall: params.planningProviderCall } : {}),
        ...(phase === "SKEPTIC_REVIEW" ? { skepticReview, providerCall: params.skepticProviderCall } : {}),
        ...(phase === "CRUCIBLE" ? { crucibleDecision } : {}),
        ...(phase === "DAG_COMPILATION" ? dagCompilationPayload : {}),
        ...(phase === "EXECUTING" ? executionPayload : {}),
        ...(phase === "VALIDATING" ? validationPayload : {}),
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

  if (proceedToSynthesis) {
    for (const phase of ["SYNTHESIZING", "DONE"] as const) {
      const result = await transitionRun(store, current.id, phase, {
        traceId,
        now: deps.now,
        payload: {
          source: "external-orchestrator",
          note: `External brainstem run ${phase === "DONE" ? "completed" : "advanced"}`,
          ...(phase === "SYNTHESIZING" ? { synthesis, providerCall: synthProviderCall } : {}),
          observability: phaseObservabilityPayload(observability, phase),
        },
      });
      current = result.run;
    }
  } else if (healingStatus === "NEEDS_DECISION") {
    // Req 9.7: healing NEEDS_DECISION → run NEEDS_DECISION, all artifacts preserved.
    const decision = await createDecisionRequest(
      store,
      current.id,
      { reason: "HEALING_NEEDS_DECISION", message: "Healing requires an operator decision", validationHealingResult },
      {
        traceId,
        now: deps.now,
        payload: {
          source: "external-orchestrator",
          note: "Healing requires an operator decision",
          validationHealingResult,
          executionArtifacts,
          synthesis,
          observability: phaseObservabilityPayload(observability, "NEEDS_DECISION"),
        },
      }
    );
    current = decision.run;
  } else {
    // Req 9.8: healing FAILED → run FAILED, final execution result and all artifacts preserved.
    const failed = await transitionRun(store, current.id, "FAILED", {
      traceId,
      now: deps.now,
      lastError: "Healing failed to resolve execution failures within the bound",
      payload: {
        source: "external-orchestrator",
        note: "Healing exhausted; run failed with artifacts preserved",
        validationHealingResult,
        executionArtifacts,
        synthesis,
        observability: phaseObservabilityPayload(observability, "FAILED"),
      },
    });
    current = failed.run;
  }

  return { run: current, synthesis, observabilitySummary: observability.getSummary() };
}

/**
 * Drives a live skeptic blocker to the terminal `FAILED` phase without throwing (Req 9.3). Advances
 * the run through TRIAGE → CONTEXT_BUILDING → PLANNING → SKEPTIC_REVIEW (recording the planner and
 * skeptic `ProviderCallMetadata` and the redacted blocker) so the state machine permits the terminal
 * transition, then transitions to `FAILED`. Mirrors {@link resolvePlannerBlocker}.
 */
async function resolveSkepticBlocker(
  store: RectorStore,
  args: ChatRunArgs,
  run: Run,
  blocker: SkepticBlocker,
  deps: ChatRunnerDeps,
  extras: { plannerOutput: PlannerOutput; planningProviderCall: ProviderCallMetadata; skepticProviderCall: ProviderCallMetadata }
): Promise<ChatRunResult> {
  const { observability } = args;
  const traceId = observability.traceId;

  let current = run;
  for (const phase of ["TRIAGE", "CONTEXT_BUILDING", "PLANNING", "SKEPTIC_REVIEW"] as const) {
    const result = await transitionRun(store, current.id, phase, {
      traceId,
      now: deps.now,
      payload: {
        source: "external-orchestrator",
        note: "External brainstem run advanced",
        ...(phase === "TRIAGE" ? { triage: args.triage } : {}),
        ...(phase === "CONTEXT_BUILDING" ? { contextPack: args.contextPack } : {}),
        ...(phase === "PLANNING" ? { plannerOutput: extras.plannerOutput, providerCall: extras.planningProviderCall } : {}),
        ...(phase === "SKEPTIC_REVIEW" ? { providerCall: extras.skepticProviderCall, blocker } : {}),
        observability: phaseObservabilityPayload(observability, phase),
      },
    });
    current = result.run;
  }

  const failed = await transitionRun(store, current.id, "FAILED", {
    traceId,
    now: deps.now,
    lastError: blocker.message,
    payload: {
      source: "external-orchestrator",
      note: "Skeptic review blocked the run",
      blocker,
      observability: phaseObservabilityPayload(observability, "FAILED"),
    },
  });
  current = failed.run;

  const synthesis = buildBlockedSynthesis(args, blocker, "FAILED", observability.getSummary());
  return { run: current, synthesis, observabilitySummary: observability.getSummary() };
}

/** Safe relative path predicate for repair targets (no absolute, drive, leading slash, or `..`/`.`). */
function isSafeRelativeWorkspacePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * The patch proposal a provider-backed {@link LiveRepairAgent} must produce. The `path` is bounded to
 * a safe relative path so the proposal can be applied through the safe executor (which re-enforces
 * containment) without risking a thrown artifact-validation error.
 */
const RepairPatchProposalSchema = z.object({
  path: z.string().min(1).refine(isSafeRelativeWorkspacePath, "path must be a safe relative file path"),
  operation: PatchOperationSchema,
  content: z.string(),
  rationale: z.string().min(1),
});

function buildRepairPreflightUsage(provider: LLMProvider, estimate: LLMUsage, run: Run): BudgetUsage {
  return {
    provider: provider.metadata.id,
    estimatedUsd: committedRunNumber(run.actualCost?.usd, run.costEstimate.usd) + estimate.estimatedUsd,
    inputTokens: committedRunNumber(run.actualTokens?.input, run.tokenEstimate.input) + estimate.inputTokens,
    outputTokens: committedRunNumber(run.actualTokens?.output, run.tokenEstimate.output) + estimate.outputTokens,
    modelCalls: committedRunNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + estimate.modelCalls,
    runtimeMs: committedRunNumber(run.actualCost?.runtimeMs, run.costEstimate.runtimeMs),
    healingAttempts: run.healingAttempts,
  };
}

function committedRunNumber(primary: unknown, fallback: unknown): number {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return 0;
}

/**
 * Builds a provider-backed {@link LiveRepairAgent}. The agent runs a budget preflight before any
 * provider call, asks the router-selected provider for a {@link RepairPatchProposalSchema} patch from
 * the already-redacted failed output, and returns `undefined` on any budget / provider / parse /
 * validation failure (never throws). When a valid proposal is produced it auto-registers a
 * FILE_WRITE `SandboxApproval` for the proposed in-workspace path on the shared `approvals` array, so
 * the bounded healing loop can apply the patch through the safe executor and reach HEALED. The safe
 * executor still enforces workspace containment, the allowlist, and the destructive denylist.
 */
function createLiveRepairAgent(deps: { provider: LLMProvider; approvals: SandboxApproval[] }): LiveRepairAgent {
  return async ({ failure, failedOutput, contextPack, run }) => {
    try {
      const messages = buildRepairPrompt({
        classification: failure.classification,
        failedOutput,
        nodeId: failure.nodeId,
        contextPack,
      });
      const request: LLMRequest = {
        messages,
        modelRoute: "flagship",
        responseFormat: { type: "json_object" },
        task: "repair",
      };

      // Budget preflight BEFORE any provider call.
      const estimate = deps.provider.estimateRequest(request);
      const decision = evaluateBudget(run, buildRepairPreflightUsage(deps.provider, estimate, run));
      if (decision.status !== "allowed") return undefined;

      let response: LLMResponse;
      try {
        response = await invokeWithBudget(deps.provider, request, run);
      } catch {
        return undefined;
      }

      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(response.content) as unknown;
      } catch {
        return undefined;
      }

      const validated = RepairPatchProposalSchema.safeParse(parsedContent);
      if (!validated.success) return undefined;
      const proposal = validated.data;

      // Auto-register the FILE_WRITE approval for the proposed path (scoped to repair targets).
      if (!deps.approvals.some((approval) => approval.scope === "FILE_WRITE" && approval.target === proposal.path)) {
        deps.approvals.push({
          id: `approval:file-write:${proposal.path}`,
          scope: "FILE_WRITE",
          target: proposal.path,
          approvedBy: "external-runner",
        });
      }

      return proposal;
    } catch {
      return undefined;
    }
  };
}

interface PostPlanningParams {
  store: RectorStore;
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
  store: RectorStore,
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
  blocker: { code: string; message: string },
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
