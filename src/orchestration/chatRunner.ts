import crypto from "node:crypto";
import { z } from "zod";
import type { ContextPack } from "./contextBuilder";
import { arbitratePlanWithCrucible, type CrucibleDecision } from "./crucible";
import { compileAcceptedPlanToDag, type CompiledDag } from "./dagCompiler";
import { executeCompiledDag, type ExecutorSimulatorOptions } from "./executorSimulator";
import { runLiveDirectAnswer, type LiveDirectAnswerFallback } from "./liveDirectAnswer";
import { createFakePlan, runLivePlanner, type LivePlannerResult, type PlannerBlocker, type PlannerOutput } from "./planner";
import type { PreprocessorOutput } from "./preprocessor";
import { buildRepairPrompt } from "./prompts";
import { createDecisionRequest, transitionRun } from "./runStateMachine";
import { executeDagThroughSandbox, type ExecutionArtifact, type SandboxDagExecutionResult } from "./sandboxExecutor";
import { executeDecomposedSubGoals, stitchResults, type SubGoalGraph } from "./taskDecomposer";
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
import { enforceMaxPerRunBudget, evaluateBudget, type BudgetUsage } from "../security/budget";
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
  /** Preprocessor result from the neuro-symbolic Step 1 layer (already redacted). */
  preprocessorOutput?: PreprocessorOutput;
  /** Sub-goals from task decomposition (external high-complexity only). */
  subGoals?: string[];
  /** Dependency-aware sub-goal graph from task decomposition. */
  subGoalGraph?: SubGoalGraph;
  /** Deep-planner bounded candidate paths explored (trace drawer observability). */
  pathsExplored?: string[];
}

interface ExternalExecutionPhaseResult {
  executionResult?: SandboxDagExecutionResult;
  decomposedResults?: string;
  executionArtifacts: ExecutionArtifact[];
  executionPayload: Record<string, unknown>;
}

interface ExternalSynthesisPhaseResult {
  synthesis: BrainstemSynthesis;
  synthProviderCall?: ProviderCallMetadata;
  directAnswerFallback?: LiveDirectAnswerFallback;
  budgetRun: Run;
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
  const {
    store,
    args,
    run,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    deps,
    preprocessorOutput,
    subGoals = [],
    subGoalGraph,
    pathsExplored,
  } = params;
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
  const sandbox = createExternalSandbox(deps, approvals);
  let budgetRun = run;
  const repairAgent = createExternalRepairAgent({ store, deps, approvals, getRun: () => budgetRun, setRun: (next) => { budgetRun = next; } });

  const executionPhase = await runExternalExecutionPhase({
    args,
    deps,
    sandbox,
    budgetRun,
    compiledDag,
    crucibleDecision,
    subGoals,
    subGoalGraph,
  });
  const { executionResult, decomposedResults, executionArtifacts, executionPayload } = executionPhase;

  const validationHealingResult = await runExternalValidationPhase({
    args,
    deps,
    sandbox,
    compiledDag,
    executionResult,
    repairAgent,
    budgetRun,
    options,
  });
  const validationPayload = validationHealingResult
    ? { validationHealingResult }
    : { skippedReason: "Execution skipped or missing; validation and healing skipped" };

  const healingStatus = validationHealingResult?.status;
  const proceedToSynthesis = shouldProceedToSynthesis(healingStatus);
  const synthesisPhase = await runExternalSynthesisPhase({
    store,
    args,
    deps,
    budgetRun,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    compiledDag,
    executionResult,
    validationHealingResult,
    decomposedResults,
    proceedToSynthesis,
  });
  budgetRun = synthesisPhase.budgetRun;
  const { synthesis, synthProviderCall, directAnswerFallback } = synthesisPhase;

  const current = await transitionExternalPostPlanningRun({
    params,
    dagCompilationPayload,
    executionPayload,
    validationPayload,
    validationHealingResult,
    healingStatus,
    proceedToSynthesis,
    synthesis,
    synthProviderCall,
    directAnswerFallback,
    decomposedResults,
    executionArtifacts,
  });

  return { run: current, synthesis, observabilitySummary: observability.getSummary() };
}

const EXTERNAL_PREFIX_PHASES = [
  "TRIAGE",
  "CONTEXT_BUILDING",
  "PLANNING",
  "SKEPTIC_REVIEW",
  "CRUCIBLE",
  "DAG_COMPILATION",
  "EXECUTING",
  "VALIDATING",
] as const;

type ExternalPrefixPhase = typeof EXTERNAL_PREFIX_PHASES[number];
type ExternalCompletionPhase = "SYNTHESIZING" | "DONE";

function createExternalSandbox(deps: ChatRunnerDeps, approvals: SandboxApproval[]): WorkspaceSandboxAdapter {
  return new WorkspaceSandboxAdapter({
    workspaceRoot: deps.workspaceRoot ?? process.cwd(),
    allowlistedCommands: deps.allowlistedCommands ?? [],
    approvals,
    fsImpl: deps.fsImpl,
    commandRunner: deps.commandRunner,
    now: deps.now,
  });
}

function createExternalRepairAgent(input: {
  store: RectorStore;
  deps: ChatRunnerDeps & { router: ModelRouter };
  approvals: SandboxApproval[];
  getRun(): Run;
  setRun(run: Run): void;
}): LiveRepairAgent {
  const { store, deps, approvals, getRun, setRun } = input;
  const repairSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "repair", run: getRun() });
  return deps.repairAgent ?? createLiveRepairAgent({
    provider: repairSelection.provider,
    model: repairSelection.model,
    approvals,
    getRun,
    commitUsage: async (usage, provider) => {
      setRun(await addProviderUsageToRun(store, getRun(), usage, provider));
    },
  });
}

async function runExternalExecutionPhase(input: {
  args: ChatRunArgs;
  deps: ChatRunnerDeps;
  sandbox: WorkspaceSandboxAdapter;
  budgetRun: Run;
  compiledDag?: CompiledDag;
  crucibleDecision: CrucibleDecision;
  subGoals: string[];
  subGoalGraph?: SubGoalGraph;
}): Promise<ExternalExecutionPhaseResult> {
  const { args, deps, sandbox, budgetRun, compiledDag, crucibleDecision, subGoals, subGoalGraph } = input;
  const { observability } = args;
  const executionResult = await observability.recordSpan("EXECUTING", () =>
    compiledDag ? executeDagThroughSandbox(compiledDag, { sandbox, now: deps.now }) : undefined
  );
  const decomposedResults = await runExternalDecomposedExecution({
    args,
    deps,
    sandbox,
    budgetRun,
    crucibleDecision,
    subGoals,
    subGoalGraph,
  });
  const executionArtifacts = executionResult?.artifacts ?? [];
  const executionPayload = executionResult
    ? { executionResult, executionArtifacts }
    : { skippedReason: "Execution skipped because no compiled DAG exists" };
  return { executionResult, decomposedResults, executionArtifacts, executionPayload };
}

async function runExternalDecomposedExecution(input: {
  args: ChatRunArgs;
  deps: ChatRunnerDeps;
  sandbox: WorkspaceSandboxAdapter;
  budgetRun: Run;
  crucibleDecision: CrucibleDecision;
  subGoals: string[];
  subGoalGraph?: SubGoalGraph;
}): Promise<string | undefined> {
  const { args, deps, sandbox, budgetRun, crucibleDecision, subGoals, subGoalGraph } = input;
  if (!shouldRunDecomposedExecution(args, crucibleDecision, subGoals)) return undefined;
  const decomposed = await args.observability.recordSpan("EXECUTING", () =>
    executeDecomposedSubGoals(subGoalGraph ?? subGoals, { sandbox, run: budgetRun, now: deps.now })
  );
  return stitchResults(decomposed);
}

function shouldRunDecomposedExecution(args: ChatRunArgs, crucibleDecision: CrucibleDecision, subGoals: string[]): boolean {
  return args.triage.complexity === "high" && crucibleDecision.verdict === "ACCEPTED" && subGoals.length > 1;
}

async function runExternalValidationPhase(input: {
  args: ChatRunArgs;
  deps: ChatRunnerDeps;
  sandbox: WorkspaceSandboxAdapter;
  compiledDag?: CompiledDag;
  executionResult?: SandboxDagExecutionResult;
  repairAgent: LiveRepairAgent;
  budgetRun: Run;
  options: ChatRunOptions;
}): Promise<HealingLoopResult | undefined> {
  const { args, deps, sandbox, compiledDag, executionResult, repairAgent, budgetRun, options } = input;
  return args.observability.recordSpan("VALIDATING", () =>
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
          run: budgetRun,
        })
      : undefined
  );
}

function shouldProceedToSynthesis(healingStatus: HealingLoopResult["status"] | undefined): boolean {
  return healingStatus === undefined || healingStatus === "VALIDATED" || healingStatus === "HEALED";
}

async function runExternalSynthesisPhase(input: {
  store: RectorStore;
  args: ChatRunArgs;
  deps: ChatRunnerDeps & { router: ModelRouter };
  budgetRun: Run;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  compiledDag?: CompiledDag;
  executionResult?: SandboxDagExecutionResult;
  validationHealingResult?: HealingLoopResult;
  decomposedResults?: string;
  proceedToSynthesis: boolean;
}): Promise<ExternalSynthesisPhaseResult> {
  const synthInput = buildExternalSynthesisInput(input);
  if (!input.proceedToSynthesis) {
    return { synthesis: synthesizeChatBrainstemResponse(synthInput), budgetRun: input.budgetRun };
  }
  return input.args.triage.route === "DIRECT_ANSWER"
    ? runExternalDirectAnswerSynthesis({ ...input, synthInput })
    : runExternalFlagshipSynthesis({ ...input, synthInput });
}

function buildExternalSynthesisInput(input: {
  args: ChatRunArgs;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  compiledDag?: CompiledDag;
  executionResult?: SandboxDagExecutionResult;
  validationHealingResult?: HealingLoopResult;
  decomposedResults?: string;
}): BrainstemSynthesisInput {
  const { args } = input;
  return {
    traceId: args.observability.traceId,
    triage: args.triage,
    contextPack: args.contextPack,
    plannerOutput: input.plannerOutput,
    skepticReview: input.skepticReview,
    crucibleDecision: input.crucibleDecision,
    compiledDag: input.compiledDag,
    executionResult: input.executionResult,
    validationHealingResult: input.validationHealingResult,
    observabilitySummary: args.observability.getSummary(),
    decomposedResults: input.decomposedResults,
  };
}

async function runExternalDirectAnswerSynthesis(input: {
  store: RectorStore;
  args: ChatRunArgs;
  deps: ChatRunnerDeps & { router: ModelRouter };
  budgetRun: Run;
  synthInput: BrainstemSynthesisInput;
}): Promise<ExternalSynthesisPhaseResult> {
  const { store, args, deps, synthInput } = input;
  let { budgetRun } = input;
  const directSelection: ModelSelection = deps.router.select({ capability: "cheap", task: "direct-answer", run: budgetRun });
  const directResult = await args.observability.recordSpan("SYNTHESIZING", () =>
    runLiveDirectAnswer(synthInput, { provider: directSelection.provider, run: budgetRun, model: directSelection.model })
  );
  const base = synthesizeChatBrainstemResponse(synthInput);
  const synthesis = { ...base, response: directResult.response, providerCalls: directResult.providerCalls };
  const directUsage: LLMUsage = LLMUsageSchema.parse({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: directResult.cost?.estimatedUsd ?? 0,
    modelCalls: directResult.cost?.modelCalls ?? 0,
  });
  const synthProviderCall = buildProviderCallMetadata(
    directSelection,
    directSelection.provider.metadata.id,
    directSelection.model,
    directUsage,
    directResult.providerCalls
  );
  if (directResult.providerCalls > 0) {
    budgetRun = await addProviderUsageToRun(store, budgetRun, directUsage, directSelection.provider.metadata.id);
  }
  await args.observability.recordSpan("DONE", () => undefined);
  return { synthesis, synthProviderCall, directAnswerFallback: directResult.fallback, budgetRun };
}

async function runExternalFlagshipSynthesis(input: {
  store: RectorStore;
  args: ChatRunArgs;
  deps: ChatRunnerDeps & { router: ModelRouter };
  budgetRun: Run;
  synthInput: BrainstemSynthesisInput;
}): Promise<ExternalSynthesisPhaseResult> {
  const { store, args, deps, synthInput } = input;
  let { budgetRun } = input;
  const synthSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "synthesizer", run: budgetRun });
  const synthResult = await args.observability.recordSpan("SYNTHESIZING", () =>
    runLiveSynthesizer(synthInput, { provider: synthSelection.provider, run: budgetRun, model: synthSelection.model })
  );
  const synthProviderCall = buildProviderCallMetadata(
    synthSelection,
    synthResult.provider,
    synthResult.model,
    synthResult.usage,
    synthResult.attempts
  );
  budgetRun = await addProviderUsageToRun(store, budgetRun, synthResult.usage, synthResult.provider);
  await args.observability.recordSpan("DONE", () => undefined);
  return { synthesis: synthResult.synthesis, synthProviderCall, budgetRun };
}

async function transitionExternalPostPlanningRun(input: {
  params: ExternalPostPlanningParams;
  dagCompilationPayload: Record<string, unknown>;
  executionPayload: Record<string, unknown>;
  validationPayload: Record<string, unknown>;
  validationHealingResult?: HealingLoopResult;
  healingStatus?: HealingLoopResult["status"];
  proceedToSynthesis: boolean;
  synthesis: BrainstemSynthesis;
  synthProviderCall?: ProviderCallMetadata;
  directAnswerFallback?: LiveDirectAnswerFallback;
  decomposedResults?: string;
  executionArtifacts: ExecutionArtifact[];
}): Promise<Run> {
  const { params } = input;
  let current = params.run;
  for (const phase of EXTERNAL_PREFIX_PHASES) {
    const result = await transitionRun(params.store, current.id, phase, externalPrefixTransitionInput(phase, input));
    current = result.run;
  }
  return finishExternalPostPlanningRun(current, input);
}

function externalPrefixTransitionInput(phase: ExternalPrefixPhase, input: Parameters<typeof transitionExternalPostPlanningRun>[0]) {
  const { params, validationHealingResult } = input;
  return {
    traceId: params.args.observability.traceId,
    now: params.deps.now,
    payload: externalPrefixPayload(phase, input),
    ...(phase === "VALIDATING" && validationHealingResult
      ? {
          validationAttempts: validationHealingResult.attempts + 1,
          healingAttempts: validationHealingResult.attempts,
        }
      : {}),
  };
}

function externalPrefixPayload(phase: ExternalPrefixPhase, input: Parameters<typeof transitionExternalPostPlanningRun>[0]) {
  const { params } = input;
  const base = externalPhasePayloadBase(params, phase, "External brainstem run advanced");
  switch (phase) {
    case "TRIAGE":
      return { ...base, triage: params.args.triage };
    case "CONTEXT_BUILDING":
      return { ...base, contextPack: params.args.contextPack };
    case "PLANNING":
      return externalPlanningPayload(base, params);
    case "SKEPTIC_REVIEW":
      return { ...base, skepticReview: params.skepticReview, providerCall: params.skepticProviderCall };
    case "CRUCIBLE":
      return { ...base, crucibleDecision: params.crucibleDecision };
    case "DAG_COMPILATION":
      return { ...base, ...input.dagCompilationPayload };
    case "EXECUTING":
      return { ...base, ...input.executionPayload };
    case "VALIDATING":
      return { ...base, ...input.validationPayload };
  }
}

function externalPlanningPayload(base: Record<string, unknown>, params: ExternalPostPlanningParams): Record<string, unknown> {
  return {
    ...base,
    plannerOutput: params.plannerOutput,
    providerCall: params.planningProviderCall,
    // Chunk 26: preprocessor result is attached for observability and downstream stages.
    // It is already redacted inside the preprocessor.
    preprocessor: {
      distilledContext: params.preprocessorOutput?.distilledContext,
      proposedToolCalls: params.preprocessorOutput?.proposedToolCalls ?? [],
      intent: params.preprocessorOutput?.intent,
      entities: params.preprocessorOutput?.entities ?? [],
      constraints: params.preprocessorOutput?.constraints ?? [],
    },
    ...(params.pathsExplored?.length ? { pathsExplored: params.pathsExplored } : {}),
  };
}

async function finishExternalPostPlanningRun(
  current: Run,
  input: Parameters<typeof transitionExternalPostPlanningRun>[0],
): Promise<Run> {
  if (input.proceedToSynthesis) return transitionExternalSynthesisDone(current, input);
  if (input.healingStatus === "NEEDS_DECISION") return transitionExternalNeedsDecision(current, input);
  return transitionExternalFailed(current, input);
}

async function transitionExternalSynthesisDone(
  current: Run,
  input: Parameters<typeof transitionExternalPostPlanningRun>[0],
): Promise<Run> {
  const { params } = input;
  let next = current;
  for (const phase of ["SYNTHESIZING", "DONE"] as const) {
    const result = await transitionRun(params.store, next.id, phase, {
      traceId: params.args.observability.traceId,
      now: params.deps.now,
      payload: externalCompletionPayload(phase, input),
    });
    next = result.run;
  }
  return next;
}

function externalCompletionPayload(
  phase: ExternalCompletionPhase,
  input: Parameters<typeof transitionExternalPostPlanningRun>[0],
): Record<string, unknown> {
  const note = `External brainstem run ${phase === "DONE" ? "completed" : "advanced"}`;
  const base = externalPhasePayloadBase(input.params, phase, note);
  return phase === "SYNTHESIZING" ? { ...base, ...externalSynthesisPayload(input) } : base;
}

function externalSynthesisPayload(input: Parameters<typeof transitionExternalPostPlanningRun>[0]): Record<string, unknown> {
  const routePayload = input.params.args.triage.route === "DIRECT_ANSWER"
    ? { route: input.params.args.triage.route, ...(input.directAnswerFallback ? { fallback: input.directAnswerFallback } : {}) }
    : {};
  return {
    synthesis: input.synthesis,
    providerCall: input.synthProviderCall,
    ...(input.decomposedResults ? { decomposedResults: input.decomposedResults } : {}),
    ...routePayload,
  };
}

async function transitionExternalNeedsDecision(
  current: Run,
  input: Parameters<typeof transitionExternalPostPlanningRun>[0],
): Promise<Run> {
  const { params } = input;
  const decision = await createDecisionRequest(
    params.store,
    current.id,
    { reason: "HEALING_NEEDS_DECISION", message: "Healing requires an operator decision", validationHealingResult: input.validationHealingResult },
    {
      traceId: params.args.observability.traceId,
      now: params.deps.now,
      payload: {
        source: "external-orchestrator",
        note: "Healing requires an operator decision",
        validationHealingResult: input.validationHealingResult,
        executionArtifacts: input.executionArtifacts,
        synthesis: input.synthesis,
        observability: phaseObservabilityPayload(params.args.observability, "NEEDS_DECISION"),
      },
    }
  );
  return decision.run;
}

async function transitionExternalFailed(
  current: Run,
  input: Parameters<typeof transitionExternalPostPlanningRun>[0],
): Promise<Run> {
  const { params } = input;
  const failed = await transitionRun(params.store, current.id, "FAILED", {
    traceId: params.args.observability.traceId,
    now: params.deps.now,
    lastError: "Healing failed to resolve execution failures within the bound",
    payload: {
      source: "external-orchestrator",
      note: "Healing exhausted; run failed with artifacts preserved",
      validationHealingResult: input.validationHealingResult,
      executionArtifacts: input.executionArtifacts,
      synthesis: input.synthesis,
      observability: phaseObservabilityPayload(params.args.observability, "FAILED"),
    },
  });
  return failed.run;
}

function externalPhasePayloadBase(params: ExternalPostPlanningParams, phase: string, note: string): Record<string, unknown> {
  return {
    source: "external-orchestrator",
    note,
    observability: phaseObservabilityPayload(params.args.observability, phase),
  };
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
function createLiveRepairAgent(deps: {
  provider: LLMProvider;
  model?: string;
  approvals: SandboxApproval[];
  getRun?: () => Run;
  commitUsage?: (usage: LLMUsage, provider: string) => Promise<void>;
}): LiveRepairAgent {
  return async ({ failure, failedOutput, contextPack, run, symbolicHints }) => {
    try {
      const messages = buildRepairPrompt({
        classification: failure.classification,
        failedOutput,
        nodeId: failure.nodeId,
        contextPack,
        symbolicHints,
      });
      const request: LLMRequest = {
        messages,
        modelRoute: "flagship",
        ...(deps.model ? { model: deps.model } : {}),
        responseFormat: { type: "json_object" },
        task: "repair",
      };

      // Budget preflight BEFORE any provider call. Use the latest committed run usage so repeated
      // repair attempts are counted cumulatively with planner/skeptic and prior repair calls.
      const currentRun = deps.getRun?.() ?? run;
      const estimate = deps.provider.estimateRequest(request);
      const decision = evaluateBudget(currentRun, buildRepairPreflightUsage(deps.provider, estimate, currentRun));
      // Req 3.4: layer the EXPLICIT per-run ceiling onto the existing preflight. `enforceMaxPerRunBudget`
      // projects the accumulated run cost so far (the committed run cost) plus this repair call's
      // estimate and denies BEFORE any provider.invoke when the projection would breach the run's
      // per-run ceiling. Either gate denying blocks the call (no network I/O on denial).
      const ceiling = enforceMaxPerRunBudget(
        currentRun,
        {
          estimatedUsd: committedRunNumber(currentRun.actualCost?.usd, currentRun.costEstimate.usd),
          modelCalls: committedRunNumber(currentRun.actualCost?.modelCalls, currentRun.costEstimate.modelCalls),
        },
        estimate
      );
      if (decision.status !== "allowed" || ceiling.status !== "allowed") return undefined;

      let response: LLMResponse;
      try {
        response = await invokeWithBudget(deps.provider, request, currentRun);
      } catch {
        return undefined;
      }

      await deps.commitUsage?.(response.usage, response.provider);

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

async function addProviderUsageToRun(
  store: RectorStore,
  run: Run,
  usage: LLMUsage,
  provider: string
): Promise<Run> {
  const current = (await store.getRun(run.id)) ?? run;
  const costUsd = committedRunNumber(current.actualCost?.usd, current.costEstimate.usd) + usage.estimatedUsd;
  const modelCalls = committedRunNumber(current.actualCost?.modelCalls, current.costEstimate.modelCalls) + usage.modelCalls;
  const inputTokens = committedRunNumber(current.actualTokens?.input, current.tokenEstimate.input) + usage.inputTokens;
  const outputTokens = committedRunNumber(current.actualTokens?.output, current.tokenEstimate.output) + usage.outputTokens;

  const updated = await store.updateRun(current.id, {
    costEstimate: { ...current.costEstimate, usd: costUsd, modelCalls, provider },
    actualCost: { ...(current.actualCost ?? {}), usd: costUsd, modelCalls, provider },
    tokenEstimate: { ...current.tokenEstimate, input: inputTokens, output: outputTokens },
    actualTokens: { ...(current.actualTokens ?? {}), input: inputTokens, output: outputTokens },
  });

  return updated ?? current;
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
