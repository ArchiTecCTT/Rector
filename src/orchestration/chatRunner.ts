import type { ContextPack } from "./contextBuilder";
import { arbitratePlanWithCrucible, type CrucibleDecision } from "./crucible";
import { compileAcceptedPlanToDag, type CompiledDag } from "./dagCompiler";
import { executeCompiledDag, type ExecutorSimulatorOptions } from "./executorSimulator";
import { runExternalPostPlanningPhases } from "./externalPostPlanning";
import {
  DEFAULT_EXTERNAL_BUDGET,
  addProviderUsageToRun,
  buildProviderCallMetadata,
  phaseObservabilityPayload,
  runEvent,
  type ProviderCallMetadata,
} from "./externalRunSupport";
export { DEFAULT_EXTERNAL_BUDGET, ProviderCallMetadataSchema, phaseObservabilityPayload, runEvent } from "./externalRunSupport";
export type { ProviderCallMetadata } from "./externalRunSupport";
import { createFakePlan, runLivePlanner, type LivePlannerResult, type PlannerBlocker, type PlannerOutput } from "./planner";
import { createDecisionRequest, transitionRun } from "./runStateMachine";
import { reviewPlanWithSkeptic, runLiveSkeptic, type SkepticBlocker, type SkepticReview } from "./skeptic";
import {
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesis,
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
  type ObservabilitySummary,
} from "../observability";
import {
  type ModelRouter,
  type ModelSelection,
} from "../providers/llm";
import {
  type CommandRunner,
  type SandboxApproval,
  type WorkspaceFs,
} from "../sandbox";
import type { OrchestratorMode } from "../deployment";
import type { RectorStore } from "../store";
import type { Budget, Run } from "../store/schemas";
import type { ModuleRegistry } from "../modules";
import {
  executePreprocessorPassthrough,
  executePreprocessorPhase,
  NEURO_PREPROCESS_MODULE_ID,
} from "../modules/builtin/neuro-preprocess";
import {
  executePlanningPhase,
  preparePlanningPhase,
  NEURO_PLANNING_MODULE_ID,
} from "../modules/builtin/neuro-planning";
import { resolveNeuroFeatureFlags, type NeuroFeatureFlags } from "../modules/featureFlags";

/**
 * Options that tune the deterministic phases shared by both runners (executor simulator behaviour
 * and the validation/healing attempt budget). These mirror the previous `createFakeChatRun`
 * options exactly so local-mode output is unchanged.
 */
export interface ChatRunOptions {
  executorOptions?: ExecutorSimulatorOptions;
  maxHealingAttempts?: number;
  /** Opt-in MCTS-style multi-path planning (external mode only). */
  deepPlanning?: boolean;
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
  /** Optional module registry (Chunk 038+). Local baseline ignores external-only hooks. */
  moduleRegistry?: ModuleRegistry;
  neuroFlags?: Partial<NeuroFeatureFlags>;
}

export interface ChatRunResult {
  run: Run;
  synthesis: BrainstemSynthesis;
  observabilitySummary: ObservabilitySummary;
}

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

  let activeContextPack = contextPack;
  if (deps.moduleRegistry) {
    const hookResult = await deps.moduleRegistry.invokeOnExternalRunStart(
      {
        store,
        run,
        prompt,
        triage,
        contextPack: activeContextPack,
        router: deps.router,
      },
      deps.mode,
    );
    if (hookResult.contextPack) {
      activeContextPack = hookResult.contextPack;
    }
  }

  const neuroFlags = resolveNeuroFeatureFlags(deps.neuroFlags);
  const preprocessEnabled =
    neuroFlags.preprocessor &&
    (!deps.moduleRegistry || deps.moduleRegistry.isEnabled(NEURO_PREPROCESS_MODULE_ID));

  const prepPhase = preprocessEnabled
    ? await executePreprocessorPhase({
        store,
        run,
        prompt,
        contextPack: activeContextPack,
        triage,
        router: deps.router,
        recordSpan: (name, fn) => observability.recordSpan(name, fn),
        addProviderUsage: (currentRun, usage, providerId) =>
          addProviderUsageToRun(store, currentRun, usage, providerId),
      })
    : executePreprocessorPassthrough(run, prompt);

  const budgetRun = prepPhase.budgetRun;
  const preprocessorOutput = prepPhase.preprocessorOutput;
  const effectiveMessageContent = prepPhase.effectiveMessageContent;

  const planningEnabled =
    !deps.moduleRegistry || deps.moduleRegistry.isEnabled(NEURO_PLANNING_MODULE_ID);
  const planningPrep = planningEnabled
    ? preparePlanningPhase({
        triage,
        contextPack: activeContextPack,
        effectiveMessageContent,
        deepPlanning: options.deepPlanning === true,
        router: deps.router,
        budgetRun,
        flags: neuroFlags,
        recordSpan: (name, fn) => observability.recordSpan(name, fn),
      })
    : { subGoals: [] as string[], plannerContextPack: activeContextPack };

  const { subGoals, subGoalGraph, plannerContextPack } = planningPrep;

  const plannerResult: LivePlannerResult = planningEnabled
    ? await executePlanningPhase(
        {
          triage,
          contextPack: activeContextPack,
          effectiveMessageContent,
          deepPlanning: options.deepPlanning === true,
          router: deps.router,
          budgetRun,
          flags: neuroFlags,
          recordSpan: (name, fn) => observability.recordSpan(name, fn),
        },
        planningPrep,
      )
    : await observability.recordSpan("PLANNING", () => {
        const selection = deps.router.select({
          capability: "flagship",
          task: "planner",
          run: budgetRun,
        });
        return runLivePlanner(
          { triage, contextPack: plannerContextPack, messageContent: effectiveMessageContent },
          {
            provider: selection.provider,
            run: budgetRun,
            model: selection.model,
          },
        );
      });

  if (plannerResult.status === "blocked" || !plannerResult.plan) {
    const blocker = plannerResult.blocker ?? {
      code: "PLANNER_INVALID" as const,
      message: "Planner returned no plan",
    };
    return resolvePlannerBlocker(store, args, budgetRun, blocker, deps);
  }

  const plannerOutput = plannerResult.plan;

  // Map the accumulated provider usage into the run's cost/token fields so every later provider
  // preflight sees the committed spend from earlier live steps (planner → skeptic → repair → synth).
  // Recorded as both estimate and actual because BYOK currently commits usage after each response.
  const usage = plannerResult.usage;
  const costedRun = await addProviderUsageToRun(store, budgetRun, usage, plannerResult.provider);

  // Provider/model/cost metadata recorded on the PLANNING event (Req 3.5).
  const plannerSelection = deps.router.select({
    capability: "flagship",
    task: "planner",
    run: budgetRun,
  });
  const providerCall = buildProviderCallMetadata(
    plannerSelection,
    plannerResult.provider,
    plannerResult.model,
    usage,
    plannerResult.attempts,
  );

  // --- SKEPTIC STEP (live, ORN-35) ---
  // runLiveSkeptic runs the budget preflight BEFORE any provider call and resolves with a
  // structured, redacted SkepticBlocker instead of throwing. On a blocker the run terminates FAILED
  // (Req 9.3) with the skeptic's ProviderCallMetadata recorded on the SKEPTIC_REVIEW event (Req 9.1).
  const skepticSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "skeptic", run: costedRun });
  const skepticResult = await observability.recordSpan("SKEPTIC_REVIEW", () =>
    runLiveSkeptic(
      { plannerOutput, contextPack, triage },
      { provider: skepticSelection.provider, run: costedRun, model: skepticSelection.model },
    )
  );
  const skepticProviderCall = buildProviderCallMetadata(
    skepticSelection,
    skepticResult.provider,
    skepticResult.model,
    skepticResult.usage,
    skepticResult.attempts
  );
  const skepticCostedRun = await addProviderUsageToRun(store, costedRun, skepticResult.usage, skepticResult.provider);

  if (skepticResult.status === "blocked" || !skepticResult.review) {
    const blocker: SkepticBlocker = skepticResult.blocker ?? {
      code: "SKEPTIC_INVALID",
      message: "Skeptic returned no review",
    };
    return resolveSkepticBlocker(store, args, skepticCostedRun, blocker, deps, {
      plannerOutput,
      planningProviderCall: providerCall,
      skepticProviderCall,
    });
  }

  const skepticReview = skepticResult.review;
  const crucibleDecision = await observability.recordSpan("CRUCIBLE", () =>
    arbitratePlanWithCrucible({ plannerOutput, skepticReview })
  );

  const enrichedArgs =
    subGoals.length > 0 ? { ...args, contextPack: plannerContextPack } : args;

  return runExternalPostPlanningPhases({
    store,
    args: enrichedArgs,
    run: skepticCostedRun,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    planningProviderCall: providerCall,
    skepticProviderCall,
    deps: { ...deps, router: deps.router },
    preprocessorOutput,
    subGoals,
    subGoalGraph,
    pathsExplored: plannerResult.pathsExplored,
  });
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
