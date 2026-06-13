import { z } from "zod";
import type { CrucibleDecision } from "./crucible";
import { compileAcceptedPlanToDag, type CompiledDag } from "./dagCompiler";
import { runLiveDirectAnswer, type LiveDirectAnswerFallback } from "./liveDirectAnswer";
import type { PlannerOutput } from "./planner";
import { buildRepairPrompt } from "./prompts";
import { createDecisionRequest, transitionRun } from "./runStateMachine";
import { executeDagThroughSandbox, type ExecutionArtifact, type SandboxDagExecutionResult } from "./sandboxExecutor";
import type { SkepticReview } from "./skeptic";
import { executeDecomposedSubGoals, stitchResults, type SubGoalGraph } from "./taskDecomposer";
import {
  runLiveSynthesizer,
  synthesizeChatBrainstemResponse,
  type BrainstemSynthesis,
  type BrainstemSynthesisInput,
} from "./synthesizer";
import { validateAndHealExecution, type HealingLoopResult, type LiveRepairAgent } from "./validationHealing";
import type { ChatRunArgs, ChatRunOptions, ChatRunnerDeps, ChatRunResult } from "./chatRunner";
import { enforceMaxPerRunBudget, evaluateBudget, type BudgetUsage } from "../security/budget";
import {
  invokeWithBudget,
  isLiveLLMProvider,
  LLMUsageSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ModelRouter,
  type ModelSelection,
} from "../providers/llm";
import { PatchOperationSchema, WorkspaceSandboxAdapter, type SandboxApproval } from "../sandbox";
import type { RectorStore } from "../store";
import type { Run } from "../store/schemas";
import type { ToolEventSinkInput } from "../tools";
import type { PreprocessorOutput } from "./preprocessor";
import { TRIAGE_ROUTES } from "./triage";
import {
  addProviderUsageToRun,
  buildProviderCallMetadata,
  committedRunNumber,
  phaseObservabilityPayload,
  runEvent,
  type ProviderCallMetadata,
} from "./externalRunSupport";

export interface ExternalPostPlanningParams {
  store: RectorStore;
  args: ChatRunArgs;
  run: Run;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  planningProviderCall: ProviderCallMetadata;
  skepticProviderCall: ProviderCallMetadata;
  deps: ChatRunnerDeps;
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
  toolEvents: ToolEventSinkInput[];
}

interface ExternalValidationPhaseResult {
  validationHealingResult?: HealingLoopResult;
  toolEvents: ToolEventSinkInput[];
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
export async function runExternalPostPlanningPhases(params: ExternalPostPlanningParams): Promise<ChatRunResult> {
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

  if (shouldBlockCodeEditWithoutSandbox(args, deps, compiledDag)) {
    return resolveCodeEditWithoutSandbox(store, args, run, deps, {
      plannerOutput,
      skepticReview,
      crucibleDecision,
      planningProviderCall: params.planningProviderCall,
      skepticProviderCall: params.skepticProviderCall,
      dagCompilationPayload,
    });
  }

  // The safe workspace executor is the ONLY bridge to real file/command I/O. A shared mutable
  // approvals array lets the live repair agent auto-register a FILE_WRITE approval for its proposed
  // path before the healing loop applies the patch through the sandbox (containment + denylist are
  // still enforced by the executor).
  const approvals: SandboxApproval[] = [...(deps.approvals ?? [])];
  const sandbox = createExternalSandbox(deps, approvals);
  let budgetRun = run;
  const repairAgent = createExternalRepairAgent({ store, deps, approvals, getRun: () => budgetRun, setRun: (next) => { budgetRun = next; } });

  const executionPhase = await runExternalExecutionPhase({
    store,
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

  const validationPhase = await runExternalValidationPhase({
    store,
    args,
    deps,
    sandbox,
    compiledDag,
    executionResult,
    repairAgent,
    budgetRun,
    options,
  });
  const { validationHealingResult } = validationPhase;
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
    executionToolEvents: executionPhase.toolEvents,
    validationToolEvents: validationPhase.toolEvents,
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

function dagRequiresRealSandbox(compiledDag: CompiledDag): boolean {
  return compiledDag.nodes.some((node) => node.type === "FILE_OPERATION" || node.type === "SHELL_COMMAND");
}

function hasExplicitSandboxWiring(deps: ChatRunnerDeps): boolean {
  return deps.fsImpl !== undefined || deps.commandRunner !== undefined || (deps.approvals?.length ?? 0) > 0;
}

function shouldBlockCodeEditWithoutSandbox(
  args: ChatRunArgs,
  deps: ChatRunnerDeps,
  compiledDag?: CompiledDag,
): boolean {
  return (
    args.triage.route === TRIAGE_ROUTES.CODE_EDIT &&
    deps.sandboxConfigured !== true &&
    !hasExplicitSandboxWiring(deps) &&
    compiledDag !== undefined &&
    dagRequiresRealSandbox(compiledDag)
  );
}

async function resolveCodeEditWithoutSandbox(
  store: RectorStore,
  args: ChatRunArgs,
  run: Run,
  deps: ChatRunnerDeps,
  extras: {
    plannerOutput: PlannerOutput;
    skepticReview: SkepticReview;
    crucibleDecision: CrucibleDecision;
    planningProviderCall: ProviderCallMetadata;
    skepticProviderCall: ProviderCallMetadata;
    dagCompilationPayload: Record<string, unknown>;
  },
): Promise<ChatRunResult> {
  const { observability } = args;
  const traceId = observability.traceId;
  const message =
    "CODE_EDIT requires a configured sandbox (E2B). No real sandbox is configured; file execution is not simulated as success.";

  let current = run;
  for (const phase of ["TRIAGE", "CONTEXT_BUILDING", "PLANNING", "SKEPTIC_REVIEW", "CRUCIBLE", "DAG_COMPILATION"] as const) {
    const result = await transitionRun(store, current.id, phase, {
      traceId,
      now: deps.now,
      payload: {
        source: "external-orchestrator",
        note: "External brainstem run advanced",
        ...(phase === "TRIAGE" ? { triage: args.triage } : {}),
        ...(phase === "CONTEXT_BUILDING" ? { contextPack: args.contextPack } : {}),
        ...(phase === "PLANNING" ? { plannerOutput: extras.plannerOutput, providerCall: extras.planningProviderCall } : {}),
        ...(phase === "SKEPTIC_REVIEW" ? { skepticReview: extras.skepticReview, providerCall: extras.skepticProviderCall } : {}),
        ...(phase === "CRUCIBLE" ? { crucibleDecision: extras.crucibleDecision } : {}),
        ...(phase === "DAG_COMPILATION" ? extras.dagCompilationPayload : {}),
        observability: phaseObservabilityPayload(observability, phase),
      },
    });
    current = result.run;
  }

  const synthesis = synthesizeChatBrainstemResponse({
    traceId,
    triage: args.triage,
    contextPack: args.contextPack,
    plannerOutput: extras.plannerOutput,
    skepticReview: extras.skepticReview,
    crucibleDecision: extras.crucibleDecision,
    observabilitySummary: observability.getSummary(),
  });

  const decision = await createDecisionRequest(
    store,
    current.id,
    { reason: "SANDBOX_NOT_CONFIGURED", message, route: args.triage.route },
    {
      traceId,
      now: deps.now,
      payload: {
        source: "external-orchestrator",
        note: "CODE_EDIT blocked: sandbox not configured",
        blocker: { code: "SANDBOX_NOT_CONFIGURED", message },
        synthesis,
        observability: phaseObservabilityPayload(observability, "NEEDS_DECISION"),
      },
    },
  );

  return { run: decision.run, synthesis, observabilitySummary: observability.getSummary() };
}

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
  deps: ChatRunnerDeps;
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
  store: RectorStore;
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
  const toolEvents: ToolEventSinkInput[] = [];
  const executionResult = await observability.recordSpan("EXECUTING", () =>
    compiledDag
      ? executeDagThroughSandbox(compiledDag, {
          sandbox,
          toolRegistry: deps.toolRegistry,
          conversationId: args.conversationId,
          budget: budgetRun.budget,
          appendRunEvent: (event) => {
            toolEvents.push(event);
          },
          now: deps.now,
        })
      : undefined
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
  return { executionResult, decomposedResults, executionArtifacts, executionPayload, toolEvents };
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
  store: RectorStore;
  args: ChatRunArgs;
  deps: ChatRunnerDeps;
  sandbox: WorkspaceSandboxAdapter;
  compiledDag?: CompiledDag;
  executionResult?: SandboxDagExecutionResult;
  repairAgent: LiveRepairAgent;
  budgetRun: Run;
  options: ChatRunOptions;
}): Promise<ExternalValidationPhaseResult> {
  const { args, deps, sandbox, compiledDag, executionResult, repairAgent, budgetRun, options } = input;
  const toolEvents: ToolEventSinkInput[] = [];
  const validationHealingResult = await args.observability.recordSpan("VALIDATING", () =>
    compiledDag && executionResult
      ? validateAndHealExecution({
          compiledDag,
          executionResult,
          executor: (dag) =>
            executeDagThroughSandbox(dag, {
              sandbox,
              toolRegistry: deps.toolRegistry,
              conversationId: args.conversationId,
              toolEventPhase: "VALIDATING",
              budget: budgetRun.budget,
              appendRunEvent: (event) => {
                toolEvents.push(event);
              },
              now: deps.now,
            }),
          executorOptions: options.executorOptions,
          maxHealingAttempts: options.maxHealingAttempts,
          repairAgent,
          sandbox,
          contextPack: args.contextPack,
          run: budgetRun,
        })
      : undefined
  );
  return { validationHealingResult, toolEvents };
}

function shouldProceedToSynthesis(healingStatus: HealingLoopResult["status"] | undefined): boolean {
  return healingStatus === undefined || healingStatus === "VALIDATED" || healingStatus === "HEALED";
}

async function runExternalSynthesisPhase(input: {
  store: RectorStore;
  args: ChatRunArgs;
  deps: ChatRunnerDeps;
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
  deps: ChatRunnerDeps;
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
  deps: ChatRunnerDeps;
  budgetRun: Run;
  synthInput: BrainstemSynthesisInput;
}): Promise<ExternalSynthesisPhaseResult> {
  const { store, args, deps, synthInput } = input;
  let { budgetRun } = input;
  const synthSelection: ModelSelection = deps.router.select({ capability: "flagship", task: "synthesizer", run: budgetRun });

  if (!isLiveLLMProvider(synthSelection.provider)) {
    await args.observability.recordSpan("DONE", () => undefined);
    return { synthesis: synthesizeChatBrainstemResponse(synthInput), budgetRun };
  }

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
  executionToolEvents: ToolEventSinkInput[];
  validationToolEvents: ToolEventSinkInput[];
}): Promise<Run> {
  const { params } = input;
  let current = params.run;
  for (const phase of EXTERNAL_PREFIX_PHASES) {
    const result = await transitionRun(params.store, current.id, phase, externalPrefixTransitionInput(phase, input));
    current = result.run;
    if (phase === "EXECUTING") {
      await appendDeferredToolEvents(params.store, current, input.executionToolEvents);
    }
    if (phase === "VALIDATING") {
      await appendDeferredToolEvents(params.store, current, input.validationToolEvents);
    }
  }
  return finishExternalPostPlanningRun(current, input);
}

async function appendDeferredToolEvents(
  store: RectorStore,
  run: Run,
  events: ToolEventSinkInput[],
): Promise<void> {
  for (const event of events) {
    await store.appendEvent(runEvent(run, event.type, event.phase, event.payload));
  }
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
