import { appendApprovedSkillContextToPack, type ContextPack, type SkillContextCatalog } from "./contextBuilder";
import { compressContextLineage, evaluateContextPressure } from "./contextCompression";
import { approvedSkillIdsFromDecision, arbitratePlanWithCrucible } from "./crucible";

import type { ExecutorSimulatorOptions } from "./executorSimulator";
import { runExternalPostPlanningPhases } from "./externalPostPlanning";
import {
  DEFAULT_EXTERNAL_BUDGET,
  addProviderUsageToRun,
  buildProviderCallMetadata,
  phaseObservabilityPayload,
  runEvent,
  type ProviderCallMetadata,
} from "./externalRunSupport";
import {
  budgetApprovalRegistry,
  waitForBudgetApproval,
  BUDGET_APPROVAL_TIMEOUT_MS,
  type BudgetDecision as BudgetDecisionType,
} from "../security/budget";
import { rememberStableTierHashForRun, clearStableTierHashForRun, assemblePromptTiers } from "./promptTiers";
export { DEFAULT_EXTERNAL_BUDGET, ProviderCallMetadataSchema, phaseObservabilityPayload, runEvent } from "./externalRunSupport";
export type { ProviderCallMetadata } from "./externalRunSupport";
import { runLivePlanner, type LivePlannerResult, type PlannerBlocker, type PlannerOutput } from "./planner";
import { clearRunControl, createAbortSignal, registerRunControl, type RunControlState } from "./runControl";
import { createDecisionRequest, transitionRun } from "./runStateMachine";
import { reviewPlanWithSkeptic, runLiveSkeptic, type SkepticBlocker, type SkepticReview } from "./skeptic";
import { type BrainstemSynthesis, type BrainstemSynthesisStatus } from "./synthesizer";
import type { TriageResult } from "./triage";
import type { LiveRepairAgent } from "./validationHealing";
import {
  type InMemoryObservabilityTrace,
  type ObservabilitySummary,
} from "../observability";
import {
  isLiveLLMProvider,
  LLMUsageSchema,
  type LLMUsage,
  type ModelRouter,
  type ModelSelection,
} from "../providers/llm";
import { buildResilientModelRouter, type ProviderCallSite } from "../providers/failover";
import type { CredentialPool } from "../providers/credentialPool";
import {
  type CommandRunner,
  type SandboxApproval,
  type WorkspaceFs,
} from "../sandbox";
import type { OrchestratorMode } from "../deployment";
import type { RectorStore } from "../store";
import type { Budget, Run } from "../store/schemas";
import type { ModuleRegistry } from "../modules";
import type { ToolRegistry } from "../tools";
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
import { IterationBudget, type TurnBudgetConfig } from "./turnBudget";

/** Default maximum orchestration runtime: 30 minutes (M23). */
export const DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS = 30 * 60 * 1000;

/** Options that tune executor/healing behaviour for orchestrated runs. */
export interface ChatRunOptions {
  executorOptions?: ExecutorSimulatorOptions;
  maxHealingAttempts?: number;
  turnBudget?: Partial<TurnBudgetConfig>;
  /** Opt-in MCTS-style multi-path planning (external mode only). */
  deepPlanning?: boolean;
  /** Maximum wall-clock time for the orchestrated run in milliseconds. Defaults to {@link DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS}. */
  maxRuntimeMs?: number;
}

/** Inputs to a single chat run, gathered by the chat endpoint before dispatch. */
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
 * Orchestration dependencies. A configured `ModelRouter` is required for every product chat run.
 * Tests inject a spy/fake router so no real network or API key is ever required. `mode` is retained
 * for neuro module hooks and test neuro flags only — it does not select a separate product runner.
 */
export interface ChatRunnerDeps {
  mode?: OrchestratorMode;
  router: ModelRouter;
  enableNetwork?: boolean;
  budget?: Budget;
  /**
   * True when a real external sandbox (E2B) is configured. When false, CODE_EDIT routes end in
   * NEEDS_DECISION rather than simulated file-operation success.
   */
  sandboxConfigured?: boolean;
  now?: () => string;
  /**
   * Safe-executor wiring (ORN-37/38). All optional and test-injectable so `npm test` needs no real
   * disk or process.
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
  /** Optional module registry (Chunk 038+). */
  moduleRegistry?: ModuleRegistry;
  /** Central tool dispatch registry (Chunk 047b). */
  toolRegistry?: ToolRegistry;
  neuroFlags?: Partial<NeuroFeatureFlags>;
  contextCompressionEnabled?: boolean;
  contextCompressionMaxGeneration?: number;
  providerResilienceEnabled?: boolean;
  providerRetryDelayMs?: number;
  credentialPool?: CredentialPool;
  /** Procedural memory catalog. Planner requests are policy-gated by crucible before injection. */
  skillsCatalog?: SkillContextCatalog;
}

export interface ChatRunResult {
  run: Run;
  synthesis: BrainstemSynthesis;
  observabilitySummary: ObservabilitySummary;
}

const ZERO_PROVIDER_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

/**
 * Dispatches every product chat run through the unified orchestrated pipeline.
 * A configured `ModelRouter` is required.
 */
export async function runChat(
  store: RectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps
): Promise<ChatRunResult> {
  if (!deps.router) {
    throw new Error("Orchestration requires configured router");
  }
  return runOrchestratedChatRun(store, args, deps);
}

/**
 * Unified orchestrated chat run (ORN-33 / Phase 4). The planner uses {@link runLivePlanner} against a
 * router-selected provider; live skeptic/synthesizer steps run when the selected provider is not the
 * deterministic fake. Provider/model/cost metadata is recorded on PLANNING and downstream events.
 *
 * On a planner blocker the run is driven to a terminal/decision phase via the run state machine —
 * `FAILED` for `PLANNER_INVALID` or `NEEDS_DECISION` for `BUDGET_DENIED`/`PROVIDER_ERROR`. No
 * exception ever propagates past this function for a budget/provider/validation failure.
 */
export async function runOrchestratedChatRun(
  store: RectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps
): Promise<ChatRunResult> {
  const { conversationId, prompt, triage, observability } = args;
  const options = args.options ?? {};
  const traceId = observability.traceId;
  const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS;

  // M23: Orchestration timeout guard. We set up a timer that marks the run as
  // timed out and aborts the run control. The inner orchestration may catch the
  // AbortError and return a non-FAILED result (e.g. NEEDS_DECISION from a
  // provider error blocker), so we check the timedOut flag after the inner
  // function returns and override with FAILED if the timeout was the cause.
  const runControl = registerRunControl(`timeout-pending`);
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    runControl.abortController.abort(new DOMException("Orchestration timeout exceeded", "AbortError"));
  }, maxRuntimeMs);

  try {
    const result = await runOrchestratedChatRunInner(store, args, deps, runControl);
    // The inner orchestration completed — but if the timeout fired (causing the
    // inner code to abort and return a non-FAILED result), override with FAILED.
    if (timedOut) {
      return await orchestrationTimeoutResult(store, args, deps, maxRuntimeMs, result.run.id);
    }
    return result;
  } catch (error) {
    // If the timeout caused the error, convert to a FAILED result
    if (timedOut || (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError")) {
      // Find the run for this conversation to get the ID
      const runs = await store.listRuns(conversationId);
      const runId = runs.length > 0 ? runs[runs.length - 1].id : undefined;
      return await orchestrationTimeoutResult(store, args, deps, maxRuntimeMs, runId);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    clearRunControl(runControl.runId ?? "timeout-pending");
  }
}

/** Handles the orchestration timeout: transitions run to FAILED and returns a timeout result. */
async function orchestrationTimeoutResult(
  store: RectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps,
  maxRuntimeMs: number,
  knownRunId?: string
): Promise<ChatRunResult> {
  const { conversationId, triage, observability } = args;
  const traceId = observability.traceId;

  // Find the run — either from the known ID or by listing runs for the conversation
  let currentRun: Run | undefined;
  if (knownRunId) {
    currentRun = await store.getRun(knownRunId);
  }
  if (!currentRun) {
    const runs = await store.listRuns(conversationId);
    currentRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
  }
  let failedRun: Run | undefined;
  if (currentRun && currentRun.status !== "failed" && currentRun.status !== "aborted") {
    try {
      const transitionResult = await transitionRun(store, currentRun.id, "FAILED", {
        traceId,
        now: deps.now,
        lastError: "Orchestration timeout exceeded",
        decision: { reason: "timeout", approved: false },
        payload: {
          source: "orchestration-timeout",
          maxRuntimeMs,
          note: `Orchestration exceeded ${maxRuntimeMs}ms wall-clock limit`,
        },
      });
      failedRun = transitionResult.run;
    } catch {
      // Best-effort transition — the run may already be terminal
    }
  }
  // If transition didn't work, fetch the latest version from the store
  if (!failedRun && knownRunId) {
    failedRun = await store.getRun(knownRunId);
  }
  if (!failedRun) {
    const runs = await store.listRuns(conversationId);
    failedRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
  }
  if (!failedRun) {
    throw new Error("Orchestration timeout: could not find run to transition");
  }
  const observabilitySummary = observability.getSummary();
  const synthesis: BrainstemSynthesis = {
    status: "FAILED",
    route: triage.route,
    traceId,
    evidence: ["orchestration timeout exceeded"],
    providerCalls: 0,
    observability: observabilitySummary,
    response: `Status: FAILED. Route: ${triage.route}. Trace: ${traceId}. Orchestration timeout exceeded (${maxRuntimeMs}ms).`,
  };
  return { run: failedRun, synthesis, observabilitySummary };
}

/**
 * Handle a `NEEDS_DECISION` result from budget evaluation by:
 * 1. Creating a budget approval request in the registry
 * 2. Emitting a `BUDGET_APPROVAL_REQUESTED` SSE event via the store
 * 3. Polling for a decision with a 5-minute timeout
 * 4. Returning `"approved"` or `"denied"`/`"timeout"`
 *
 * If approved: the caller proceeds. If denied or timeout: the caller fails with a budget exceeded error.
 */
export async function handleBudgetApprovalNeeded(
  store: RectorStore,
  run: Run,
  decision: BudgetDecisionType,
  traceId: string,
  timeoutMs: number = BUDGET_APPROVAL_TIMEOUT_MS,
): Promise<"approved" | "denied" | "timeout"> {
  // 1. Create approval request in registry
  const approvalId = budgetApprovalRegistry.createApproval(
    run.id,
    decision.reasons,
    decision.usage,
  );

  // 2. Emit BUDGET_APPROVAL_REQUESTED SSE event
  await store.appendEvent(
    runEvent(run, "BUDGET_APPROVAL_REQUESTED", run.phase, {
      approvalId,
      reasons: decision.reasons,
      estimatedUsd: decision.usage.estimatedUsd,
      source: "budget-approval-flow",
    }),
  );

  // 3. Poll for decision with timeout
  const result = await waitForBudgetApproval(approvalId, timeoutMs);

  return result;
}
async function runOrchestratedChatRunInner(
  store: RectorStore,
  args: ChatRunArgs,
  deps: ChatRunnerDeps,
  outerRunControl: RunControlState
): Promise<ChatRunResult> {
  const { conversationId, userMessageId, prompt, triage, contextPack, observability } = args;
  const options = args.options ?? {};
  const traceId = observability.traceId;
  const budget = deps.budget ?? DEFAULT_EXTERNAL_BUDGET;

  // The run is created first so its budget is available to the planner preflight.
  let run = await store.createRun({
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

  const activeRouter = buildResilientModelRouter({
    inner: deps.router,
    credentialPool: deps.credentialPool,
    providerResilienceEnabled: deps.providerResilienceEnabled,
    retryDelayMs: deps.providerRetryDelayMs,
    emitEvent: async (event) => {
      await store.appendEvent(
        runEvent(run, event.type, phaseForProviderCallSite(event.site), {
          source: "provider-resilience",
          ...event.payload,
        }),
      );
    },
  });
  const activeDeps: ChatRunnerDeps = { ...deps, router: activeRouter };

  // Register the run control under the real run ID, reusing the outer controller
  // (which may already have a timeout abort wired to it).
  outerRunControl.runId = run.id;
  const runControl = registerRunControl(run.id, outerRunControl);
  const abortSignal = createAbortSignal(runControl);
  const turnBudget = new IterationBudget(options.turnBudget);

  let activeContextPack = contextPack;
  const pressure = evaluateContextPressure(activeContextPack, activeContextPack.contextBudget?.tierBudget);
  await store.appendEvent(
    runEvent(run, "CONTEXT_BUDGET_EVALUATED", "CHAT_RECEIVED", {
      tier: pressure.tier,
      usedChars: pressure.usedChars,
      capChars: pressure.capChars,
      exceeded: pressure.exceeded,
    })
  );
  const contextCompressionEnabled = deps.contextCompressionEnabled ?? true;
  const maxCompressionGeneration = deps.contextCompressionMaxGeneration ?? 3;
  const generation = activeContextPack.conversationRef.id === conversationId
    ? ((await store.getConversation(conversationId))?.compressionGeneration ?? 0)
    : 0;
  if (activeContextPack.compressionRecommended === true && contextCompressionEnabled && generation < maxCompressionGeneration) {
    const compression = await compressContextLineage({
      conversationId,
      runId: run.id,
      contextPack: activeContextPack,
      store,
      now: deps.now,
      tierBudget: activeContextPack.contextBudget?.tierBudget,
    });
    activeContextPack = compression.newContextPack;
    run = (await store.updateRun(run.id, {
      conversationId: compression.childConversationId,
      contextCompressionApplied: true,
    })) ?? run;
  }
  const initialTiers = assemblePromptTiers({
    stable: { role: "run", systemRules: "Rector stable run contract." },
    context: { contextPack: activeContextPack },
    volatile: { phase: "CONTEXT_BUILDING", task: "run" },
    tierBudget: activeContextPack.contextBudget?.tierBudget,
  });
  rememberStableTierHashForRun(run.id, initialTiers.stableHash);
  if (deps.moduleRegistry) {
    const hookResult = await deps.moduleRegistry.invokeOnExternalRunStart(
      {
        store,
        run,
        prompt,
        triage,
        contextPack: activeContextPack,
        router: activeDeps.router,
      },
      activeDeps.mode ?? "external",
    );
    if (hookResult.contextPack) {
      activeContextPack = hookResult.contextPack;
    }
  }
  const activeArgs: ChatRunArgs = { ...args, conversationId: run.conversationId, contextPack: activeContextPack };

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
        router: activeDeps.router,
        recordSpan: (name, fn) => observability.recordSpan(name, fn),
        addProviderUsage: (currentRun, usage, providerId) =>
          addProviderUsageToRun(store, currentRun, usage, providerId),
        abortSignal,
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
        router: activeDeps.router,
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
          router: activeDeps.router,
          budgetRun,
          flags: neuroFlags,
          recordSpan: (name, fn) => observability.recordSpan(name, fn),
          abortSignal,
        },
        planningPrep,
      )
    : await observability.recordSpan("PLANNING", () => {
        const selection = activeDeps.router.select({
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
            abortSignal,
          },
        );
      });

  if (plannerResult.status === "blocked" || !plannerResult.plan) {
    const blocker = plannerResult.blocker ?? {
      code: "PLANNER_INVALID" as const,
      message: "Planner returned no plan",
    };
    const result = await resolvePlannerBlocker(store, activeArgs, budgetRun, blocker, deps);
    clearRunControl(run.id);
    clearStableTierHashForRun(run.id);
    return result;
  }

  const plannerOutput = plannerResult.plan;

  // Map the accumulated provider usage into the run's cost/token fields so every later provider
  // preflight sees the committed spend from earlier live steps (planner → skeptic → repair → synth).
  // Recorded as both estimate and actual because BYOK currently commits usage after each response.
  const usage = plannerResult.usage;
  const costedRun = await addProviderUsageToRun(store, budgetRun, usage, plannerResult.provider);

  // Provider/model/cost metadata recorded on the PLANNING event (Req 3.5).
  const plannerSelection = activeDeps.router.select({
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

  // --- SKEPTIC STEP (ORN-35): live when router selects a non-fake provider; deterministic otherwise.
  const skepticSelection: ModelSelection = activeDeps.router.select({ capability: "flagship", task: "skeptic", run: costedRun });
  let skepticReview: SkepticReview;
  let skepticProviderCall: ProviderCallMetadata;
  let skepticCostedRun = costedRun;

  if (isLiveLLMProvider(skepticSelection.provider)) {
    const skepticResult = await observability.recordSpan("SKEPTIC_REVIEW", () =>
      runLiveSkeptic(
        { plannerOutput, contextPack: activeContextPack, triage },
        { provider: skepticSelection.provider, run: costedRun, model: skepticSelection.model, abortSignal },
      )
    );
    skepticProviderCall = buildProviderCallMetadata(
      skepticSelection,
      skepticResult.provider,
      skepticResult.model,
      skepticResult.usage,
      skepticResult.attempts
    );
    skepticCostedRun = await addProviderUsageToRun(store, costedRun, skepticResult.usage, skepticResult.provider);

    if (skepticResult.status === "blocked" || !skepticResult.review) {
      const blocker: SkepticBlocker = skepticResult.blocker ?? {
        code: "SKEPTIC_INVALID",
        message: "Skeptic returned no review",
      };
      const result = await resolveSkepticBlocker(store, activeArgs, skepticCostedRun, blocker, activeDeps, {
        plannerOutput,
        planningProviderCall: providerCall,
        skepticProviderCall,
      });
      clearRunControl(run.id);
      clearStableTierHashForRun(run.id);
      return result;
    }
    skepticReview = skepticResult.review;
  } else {
    skepticReview = await observability.recordSpan("SKEPTIC_REVIEW", () =>
      reviewPlanWithSkeptic(plannerOutput, activeContextPack)
    );
    skepticProviderCall = buildProviderCallMetadata(
      skepticSelection,
      skepticSelection.provider.metadata.id,
      skepticSelection.model,
      ZERO_PROVIDER_USAGE,
      0
    );
  }
  const crucibleDecision = await observability.recordSpan("CRUCIBLE", () =>
    arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      contextPack: activeContextPack,
      skillsCatalog: deps.skillsCatalog,
      skillPolicy: {
        allowlistedCommands: deps.allowlistedCommands,
      },
    })
  );
  if ((crucibleDecision.trace?.skillActivation ?? []).length > 0) {
    await store.appendEvent(
      runEvent(skepticCostedRun, "SKILL_ACTIVATION_DECIDED", "CRUCIBLE", {
        source: "crucible-skill-policy",
        skillActivation: crucibleDecision.trace?.skillActivation ?? [],
      })
    );
  }

  const postCrucibleBaseContext = subGoals.length > 0 ? plannerContextPack : activeContextPack;
  const approvedSkillContextPack = appendApprovedSkillContextToPack(postCrucibleBaseContext, {
    skillsCatalog: deps.skillsCatalog,
    approvedSkillIds: approvedSkillIdsFromDecision(crucibleDecision),
    maxSkillContextChars: postCrucibleBaseContext.contextBudget?.maxSkillContextChars,
    maxSkillPartialChars: postCrucibleBaseContext.contextBudget?.maxSkillPartialChars,
  });
  const enrichedArgs = { ...activeArgs, contextPack: approvedSkillContextPack };

  try {
    return await runExternalPostPlanningPhases({
      store,
      args: enrichedArgs,
      run: skepticCostedRun,
      plannerOutput,
      skepticReview,
      crucibleDecision,
      planningProviderCall: providerCall,
      skepticProviderCall,
      deps: activeDeps,
      preprocessorOutput,
      subGoals,
      subGoalGraph,
      pathsExplored: plannerResult.pathsExplored,
      runControl,
      abortSignal,
      turnBudget,
    });
  } finally {
    clearStableTierHashForRun(run.id);
    clearRunControl(run.id);
  }
}

function phaseForProviderCallSite(site: ProviderCallSite): Run["phase"] {
  switch (site) {
    case "planner":
      return "PLANNING";
    case "skeptic":
      return "SKEPTIC_REVIEW";
    case "synthesizer":
      return "SYNTHESIZING";
    case "repair":
      return "HEALING";
    case "triage":
      return "TRIAGE";
  }
}

/**
 * @deprecated Use {@link runOrchestratedChatRun}. Temporary alias for tests migrating off the old name.
 */
export const runExternalChatRun = runOrchestratedChatRun;

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
