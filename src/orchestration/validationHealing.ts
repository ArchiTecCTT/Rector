import { z } from "zod";
import type { Dag, DagNode } from "../protocol/dag";
import type { PatchOperation, WorkspaceSandboxAdapter } from "../sandbox";
import { redactString } from "../security/redaction";
import type { Run } from "../store";
import type { ContextPack } from "./contextBuilder";
import { DEFAULT_PREPROCESSOR_RULES } from "../symbolic/defaultRules";
import { getSymbolicEngine } from "../symbolic/symbolicEngine";
import {
  DagExecutionResultSchema,
  DagExecutionStatusSchema,
  executeCompiledDag,
  type DagExecutionResult,
  type ExecutionError,
  type ExecutorSimulatorOptions,
  type NodeExecutionResult,
} from "./executorSimulator";

export const ValidationFailureClassificationSchema = z.enum([
  "TRANSIENT",
  "PERMISSION",
  "TIMEOUT",
  "DEPENDENCY",
  "VALIDATION",
  "UNKNOWN",
]);
export type ValidationFailureClassification = z.infer<typeof ValidationFailureClassificationSchema>;

export const HealingActionTypeSchema = z.enum([
  "RETRY_NODE",
  "MARK_SKIPPED",
  "REQUEST_DECISION",
  "FAIL_RUN",
  "NOOP",
  "APPLY_PATCH",
]);
export type HealingActionType = z.infer<typeof HealingActionTypeSchema>;

export const ValidationFailureSchema = z.object({
  nodeId: z.string().min(1).optional(),
  classification: ValidationFailureClassificationSchema,
  errorCode: z.string().min(1).optional(),
  message: z.string().min(1),
  rootCauseNodeId: z.string().min(1).optional(),
  rootCauseClassification: ValidationFailureClassificationSchema.optional(),
  dependencyChain: z.array(z.string().min(1)).optional(),
  details: z.record(z.unknown()).optional(),
});
export type ValidationFailure = z.infer<typeof ValidationFailureSchema>;

export const HealingActionSchema = z.object({
  type: HealingActionTypeSchema,
  nodeId: z.string().min(1).optional(),
  attempt: z.number().int().min(0).optional(),
  classification: ValidationFailureClassificationSchema.optional(),
  reason: z.string().min(1),
});
export type HealingAction = z.infer<typeof HealingActionSchema>;

export const HealingLoopStatusSchema = z.enum(["VALIDATED", "HEALED", "NEEDS_DECISION", "FAILED"]);
export type HealingLoopStatus = z.infer<typeof HealingLoopStatusSchema>;

export const HealingRoundRecordSchema = z.object({
  round: z.number().int().min(1),
  failureClassification: ValidationFailureClassificationSchema,
  nodeId: z.string().min(1).optional(),
  repairApplied: z.boolean(),
  patchArtifactId: z.string().min(1).optional(),
  revalidationStatus: DagExecutionStatusSchema,
  explanation: z.string().min(1),
});
export type HealingRoundRecord = z.infer<typeof HealingRoundRecordSchema>;

export const HealingLoopResultSchema = z.object({
  status: HealingLoopStatusSchema,
  attempts: z.number().int().min(0),
  failures: z.array(ValidationFailureSchema),
  actions: z.array(HealingActionSchema),
  finalExecutionResult: DagExecutionResultSchema,
  rounds: z.array(HealingRoundRecordSchema).default([]),
});
export type HealingLoopResult = z.infer<typeof HealingLoopResultSchema>;

export type HealingExecutor = (
  compiledDag: Dag,
  options?: ExecutorSimulatorOptions
) => DagExecutionResult | Promise<DagExecutionResult>;

/**
 * A repair patch proposed by a {@link LiveRepairAgent}. The agent never touches
 * disk itself; the proposal is applied only through the safe executor.
 */
export interface RepairPatchProposal {
  path: string;
  operation: PatchOperation;
  content: string;
  rationale: string;
}

/**
 * Proposes a patch from already-redacted failed output. Returns `undefined`
 * when no safe repair is available.
 */
export type LiveRepairAgent = (input: {
  failure: ValidationFailure;
  failedOutput: string;
  contextPack: ContextPack;
  run: Run;
  symbolicHints?: string[];
}) => Promise<RepairPatchProposal | undefined>;

export interface ValidateAndHealExecutionInput {
  compiledDag: Dag;
  executionResult?: DagExecutionResult;
  executor?: HealingExecutor;
  executorOptions?: ExecutorSimulatorOptions;
  maxHealingAttempts?: number;
  repairAgent?: LiveRepairAgent;
  sandbox?: WorkspaceSandboxAdapter;
  contextPack?: ContextPack;
  run?: Run;
}

const DEFAULT_MAX_HEALING_ATTEMPTS = 2;
const MIN_LIVE_HEALING_ATTEMPTS = 1;
const MAX_LIVE_HEALING_ATTEMPTS = 10;
const SHELL_PERMISSION_PATTERN = /(^|[.:_-])shell($|[.:_-])/i;

export async function validateAndHealExecution(input: ValidateAndHealExecutionInput): Promise<HealingLoopResult> {
  // Live-repair path (ORN-38): only when BOTH a repair agent and a safe executor
  // are provided. Otherwise fall through to the byte-for-byte unchanged Phase 1
  // deterministic retry behaviour below.
  if (input.repairAgent && input.sandbox) {
    return healWithLiveRepair(input, input.repairAgent, input.sandbox);
  }

  const maxHealingAttempts = boundedAttempts(input.maxHealingAttempts ?? DEFAULT_MAX_HEALING_ATTEMPTS);
  const executor = input.executor ?? executeCompiledDag;
  let current = input.executionResult ?? (await executor(input.compiledDag, input.executorOptions));
  let attempts = 0;
  const actions: HealingAction[] = [];
  const observedFailures: ValidationFailure[] = [];

  if (current.status === "SUCCESS") {
    return parseResult({ status: "VALIDATED", attempts, failures: [], actions, finalExecutionResult: current });
  }

  while (true) {
    const failures = classifyExecutionFailures(input.compiledDag, current);
    appendFailures(observedFailures, failures);

    if (current.status === "SUCCESS" || (current.status === "SKIPPED" && failures.length === 0)) {
      return parseResult({ status: attempts > 0 ? "HEALED" : "VALIDATED", attempts, failures: observedFailures, actions, finalExecutionResult: current });
    }

    const decisionFailures = rootActionableFailures(failures).filter(
      (failure) => failure.classification === "PERMISSION" || isUnsafeToAutoHeal(input.compiledDag, failure.nodeId)
    );
    if (decisionFailures.length > 0) {
      for (const failure of decisionFailures) {
        actions.push({
          type: "REQUEST_DECISION",
          nodeId: failure.nodeId,
          classification: failure.classification,
          reason: `Failure on ${failure.nodeId ?? "DAG"} requires a human decision and will not be auto-healed`,
        });
      }
      return parseResult({ status: "NEEDS_DECISION", attempts, failures: observedFailures, actions, finalExecutionResult: current });
    }

    const retryFailures = rootActionableFailures(failures).filter(isRetryableFailure);
    const nonRetryableFailures = rootActionableFailures(failures).filter((failure) => !isRetryableFailure(failure));
    if (retryFailures.length === 0 || nonRetryableFailures.length > 0) {
      for (const failure of nonRetryableFailures.length > 0 ? nonRetryableFailures : failures) {
        actions.push({
          type: "FAIL_RUN",
          nodeId: failure.nodeId,
          classification: failure.classification,
          reason: `Failure on ${failure.nodeId ?? "DAG"} is not safely healable`,
        });
      }
      return parseResult({ status: "FAILED", attempts, failures: observedFailures, actions, finalExecutionResult: current });
    }

    if (attempts >= maxHealingAttempts) {
      for (const failure of retryFailures) {
        actions.push({
          type: "FAIL_RUN",
          nodeId: failure.nodeId,
          classification: failure.classification,
          reason: `Max healing attempts (${maxHealingAttempts}) exhausted for ${failure.nodeId ?? "DAG"}`,
        });
      }
      return parseResult({ status: "FAILED", attempts, failures: observedFailures, actions, finalExecutionResult: current });
    }

    attempts += 1;
    for (const failure of retryFailures) {
      actions.push({
        type: "RETRY_NODE",
        nodeId: failure.nodeId,
        attempt: attempts,
        classification: failure.classification,
        reason: `Retrying safe ${failure.classification.toLowerCase()} failure for ${failure.nodeId ?? "DAG"}`,
      });
    }

    const nextOptions = healingOptions(input.compiledDag, input.executorOptions, retryFailures);
    current = await executor(input.compiledDag, nextOptions);
  }
}

/**
 * Bounded live-repair healing path (ORN-38). Engaged only when a {@link LiveRepairAgent}
 * and a {@link WorkspaceSandboxAdapter} are both provided. On a safe-to-auto-heal failure it
 * redacts the failed output, asks the repair agent for a patch proposal, applies the proposal
 * ONLY through `sandbox.operate({ kind: "PROPOSE_PATCH", ... })` (never via direct file writes
 * or a shell), re-runs validation, and records exactly one {@link HealingRoundRecord} per round.
 *
 * Terminal outcomes:
 *  - `HEALED`        — re-validation passed after an applied patch (artifacts preserved).
 *  - `VALIDATED`     — execution already succeeded with no healing needed.
 *  - `NEEDS_DECISION`— a PERMISSION / otherwise-unsafe failure that must not be auto-healed.
 *  - `FAILED`        — the healing bound was reached, or no safe repair proposal was available;
 *                      the final execution result and all artifacts are preserved alongside a
 *                      redacted explanation.
 *
 * The loop never exceeds `maxHealingAttempts` rounds (clamped to 1..10) and never throws.
 */
async function healWithLiveRepair(
  input: ValidateAndHealExecutionInput,
  repairAgent: LiveRepairAgent,
  sandbox: WorkspaceSandboxAdapter,
): Promise<HealingLoopResult> {
  const maxHealingAttempts = boundedLiveAttempts(input.maxHealingAttempts ?? DEFAULT_MAX_HEALING_ATTEMPTS);
  const executor = input.executor ?? executeCompiledDag;
  let current = input.executionResult ?? (await executor(input.compiledDag, input.executorOptions));
  let attempts = 0;
  const actions: HealingAction[] = [];
  const observedFailures: ValidationFailure[] = [];
  const rounds: HealingRoundRecord[] = [];

  if (current.status === "SUCCESS") {
    return parseResult({ status: "VALIDATED", attempts, failures: [], actions, finalExecutionResult: current, rounds });
  }

  for (;;) {
    const failures = classifyExecutionFailures(input.compiledDag, current);
    appendFailures(observedFailures, failures);

    if (current.status === "SUCCESS" || (current.status === "SKIPPED" && failures.length === 0)) {
      return parseResult({
        status: attempts > 0 ? "HEALED" : "VALIDATED",
        attempts,
        failures: observedFailures,
        actions,
        finalExecutionResult: current,
        rounds,
      });
    }

    const actionable = rootActionableFailures(failures);

    // PERMISSION / otherwise-unsafe failures are never auto-healed (req 5.8).
    const decisionFailures = actionable.filter(
      (failure) => failure.classification === "PERMISSION" || isUnsafeToAutoHeal(input.compiledDag, failure.nodeId),
    );
    if (decisionFailures.length > 0) {
      for (const failure of decisionFailures) {
        actions.push({
          type: "REQUEST_DECISION",
          nodeId: failure.nodeId,
          classification: failure.classification,
          reason: `Failure on ${failure.nodeId ?? "DAG"} requires a human decision and will not be auto-healed`,
        });
      }
      return parseResult({ status: "NEEDS_DECISION", attempts, failures: observedFailures, actions, finalExecutionResult: current, rounds });
    }

    // Bound check BEFORE starting a new round so rounds.length <= maxHealingAttempts (req 5.1).
    if (attempts >= maxHealingAttempts) {
      for (const failure of actionable.length > 0 ? actionable : failures) {
        actions.push({
          type: "FAIL_RUN",
          nodeId: failure.nodeId,
          classification: failure.classification,
          reason: `Max healing attempts (${maxHealingAttempts}) exhausted for ${failure.nodeId ?? "DAG"}`,
        });
      }
      return parseResult({ status: "FAILED", attempts, failures: observedFailures, actions, finalExecutionResult: current, rounds });
    }

    const target = actionable[0] ?? failures[0];
    attempts += 1;

    const failedOutput = redactString(extractFailedOutput(current, target));
    const symbolicHints = collectSymbolicHealingHints(target, failedOutput);
    const proposal = await safeProposeRepair(repairAgent, {
      failure: target,
      failedOutput,
      contextPack: input.contextPack as ContextPack,
      run: input.run as Run,
      symbolicHints,
    });

    let repairApplied = false;
    let patchArtifactId: string | undefined;
    let roundExplanation: string;

    if (proposal) {
      const patchResult = await sandbox.operate({
        kind: "PROPOSE_PATCH",
        path: proposal.path,
        operation: proposal.operation,
        content: proposal.content,
        approvalId: `approval:file-write:${proposal.path}`,
        metadata: { healingRound: attempts },
      });
      patchArtifactId = patchResult.artifacts[0]?.id;
      repairApplied = patchResult.status === "SUCCEEDED";

      actions.push({
        type: "APPLY_PATCH",
        nodeId: target.nodeId,
        attempt: attempts,
        classification: target.classification,
        reason: repairApplied
          ? `Applied repair patch for ${target.nodeId ?? "DAG"} via the safe executor`
          : `Repair patch for ${target.nodeId ?? "DAG"} was not applied (${patchResult.status})`,
      });

      // Re-run validation only after a patch was actually applied (req 5.4).
      if (repairApplied) {
        current = await executor(input.compiledDag, input.executorOptions);
      }

      roundExplanation = redactString(
        repairApplied
          ? `Round ${attempts}: applied patch to ${proposal.path}; re-validation status ${current.status}. ${proposal.rationale}`
          : `Round ${attempts}: patch proposal for ${proposal.path} was not applied (${patchResult.status}).`,
      );
    } else {
      actions.push({
        type: "FAIL_RUN",
        nodeId: target.nodeId,
        classification: target.classification,
        reason: `No safe repair proposal available for ${target.nodeId ?? "DAG"}`,
      });
      roundExplanation = redactString(
        `Round ${attempts}: repair agent returned no safe patch for ${target.nodeId ?? "DAG"} (${target.classification}).`,
      );
    }

    rounds.push(
      HealingRoundRecordSchema.parse({
        round: attempts,
        failureClassification: target.classification,
        nodeId: target.nodeId,
        repairApplied,
        patchArtifactId: repairApplied ? patchArtifactId : undefined,
        revalidationStatus: current.status,
        explanation: roundExplanation,
      }),
    );

    // No proposal means no progress is possible; terminate as FAILED (req 5.9).
    if (!proposal) {
      return parseResult({ status: "FAILED", attempts, failures: observedFailures, actions, finalExecutionResult: current, rounds });
    }
  }
}

/** Collects symbolic suggest:* hints from failure facts for the repair prompt. */
export function collectSymbolicHealingHints(failure: ValidationFailure, failedOutput: string): string[] {
  const engine = getSymbolicEngine();
  const facts = buildHealingSymbolicFacts(failure, failedOutput);
  const evaluation = engine.evaluate(DEFAULT_PREPROCESSOR_RULES, facts);
  return [
    ...new Set(
      evaluation.actions
        .filter((action) => action.startsWith("suggest:"))
        .map((action) => redactString(action.slice("suggest:".length)))
    ),
  ];
}

function buildHealingSymbolicFacts(failure: ValidationFailure, failedOutput: string): Record<string, unknown> {
  const details = recordFrom(failure.details) ?? {};
  const path = String(details.path ?? extractPathHint(failedOutput) ?? "");
  const tool = String(details.tool ?? (path ? "write_file" : ""));
  return {
    tool,
    args: { path },
    classification: failure.classification,
    nodeId: failure.nodeId,
  };
}

function extractPathHint(text: string): string | undefined {
  const match = text.match(/\b((?:src\/|\.\/)?[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|json|md))\b/);
  return match?.[1];
}

/** Invokes the repair agent without letting a thrown error escape the healing loop (req 9.6). */
async function safeProposeRepair(
  repairAgent: LiveRepairAgent,
  input: {
    failure: ValidationFailure;
    failedOutput: string;
    contextPack: ContextPack;
    run: Run;
    symbolicHints?: string[];
  },
): Promise<RepairPatchProposal | undefined> {
  try {
    return await repairAgent(input);
  } catch {
    return undefined;
  }
}

/**
 * Collects the failed command output for a failure into a single string for the repair prompt.
 * The caller redacts the result before it crosses any trust boundary.
 */
function extractFailedOutput(executionResult: DagExecutionResult, failure: ValidationFailure): string {
  const parts: string[] = [];
  if (failure.message) parts.push(failure.message);

  const node = failure.nodeId
    ? executionResult.nodeResults.find((result) => result.nodeId === failure.nodeId)
    : undefined;
  if (node?.error?.message) parts.push(node.error.message);

  const output = recordFrom(node?.output);
  if (typeof output?.stdout === "string") parts.push(output.stdout);
  if (typeof output?.stderr === "string") parts.push(output.stderr);

  if (executionResult.error?.message) parts.push(executionResult.error.message);

  return parts.join("\n");
}

export function classifyExecutionFailures(compiledDag: Dag, executionResult: DagExecutionResult): ValidationFailure[] {
  const byNodeId = new Map(executionResult.nodeResults.map((result) => [result.nodeId, result]));
  const failures: ValidationFailure[] = [];

  if (executionResult.error) {
    failures.push(failureFromError(executionResult.error));
  }

  for (const nodeResult of executionResult.nodeResults) {
    if (nodeResult.status !== "FAILED" && nodeResult.status !== "SKIPPED") continue;
    const failure = failureFromNodeResult(nodeResult);
    if (failure.classification === "DEPENDENCY") {
      const rootCause = resolveRootCause(nodeResult, byNodeId);
      if (rootCause) {
        failure.rootCauseNodeId = rootCause.nodeId;
        failure.rootCauseClassification = classifyError(rootCause.error);
        failure.dependencyChain = rootCause.chain;
      }
    }
    failures.push(failure);
  }

  return failures;
}

function failureFromError(error: ExecutionError): ValidationFailure {
  return {
    nodeId: error.nodeId,
    classification: classifyError(error),
    errorCode: error.code,
    message: error.message,
    details: error.details,
  };
}

function failureFromNodeResult(nodeResult: NodeExecutionResult): ValidationFailure {
  if (nodeResult.error) {
    return failureFromError({ ...nodeResult.error, nodeId: nodeResult.error.nodeId ?? nodeResult.nodeId });
  }

  return {
    nodeId: nodeResult.nodeId,
    classification: nodeResult.status === "SKIPPED" ? "DEPENDENCY" : "UNKNOWN",
    message: `Node ${nodeResult.nodeId} ended with ${nodeResult.status} without an execution error`,
  };
}

function classifyError(error: ExecutionError | undefined): ValidationFailureClassification {
  switch (error?.code) {
    case "INJECTED_FAILURE":
      return "TRANSIENT";
    case "PERMISSION_DENIED":
      return "PERMISSION";
    case "TIMEOUT":
      return "TIMEOUT";
    case "DEPENDENCY_FAILED":
      return "DEPENDENCY";
    case "DAG_VALIDATION_FAILED":
      return "VALIDATION";
    default:
      return "UNKNOWN";
  }
}

function resolveRootCause(
  nodeResult: NodeExecutionResult,
  byNodeId: Map<string, NodeExecutionResult>
): { nodeId: string; error?: ExecutionError; chain: string[] } | undefined {
  const visited = new Set<string>();
  const blockedBy = blockedByFrom(nodeResult);

  for (const dependencyId of blockedBy) {
    const root = walkRootCause(dependencyId, byNodeId, visited, [nodeResult.nodeId]);
    if (root) return root;
  }

  return undefined;
}

function walkRootCause(
  nodeId: string,
  byNodeId: Map<string, NodeExecutionResult>,
  visited: Set<string>,
  chain: string[]
): { nodeId: string; error?: ExecutionError; chain: string[] } | undefined {
  if (visited.has(nodeId)) return undefined;
  visited.add(nodeId);

  const result = byNodeId.get(nodeId);
  if (!result) return { nodeId, chain: [...chain, nodeId] };

  const classification = classifyError(result.error);
  if (classification !== "DEPENDENCY") {
    return { nodeId: result.nodeId, error: result.error, chain: [...chain, result.nodeId] };
  }

  for (const dependencyId of blockedByFrom(result)) {
    const root = walkRootCause(dependencyId, byNodeId, visited, [...chain, result.nodeId]);
    if (root) return root;
  }

  return { nodeId: result.nodeId, error: result.error, chain: [...chain, result.nodeId] };
}

function blockedByFrom(nodeResult: NodeExecutionResult): string[] {
  const blockedBy = nodeResult.error?.details?.blockedBy;
  if (!Array.isArray(blockedBy)) return nodeResult.dependencies;
  return blockedBy.map((value) => String(value)).filter(Boolean);
}

function rootActionableFailures(failures: ValidationFailure[]): ValidationFailure[] {
  const dependencyRootIds = new Set(
    failures
      .filter((failure) => failure.classification === "DEPENDENCY" && failure.rootCauseNodeId)
      .map((failure) => failure.rootCauseNodeId as string)
  );
  const directByNode = new Map(failures.filter((failure) => failure.nodeId).map((failure) => [failure.nodeId as string, failure]));
  const roots: ValidationFailure[] = [];

  for (const rootId of dependencyRootIds) {
    const direct = directByNode.get(rootId);
    if (direct) roots.push(direct);
  }

  for (const failure of failures) {
    if (failure.classification === "DEPENDENCY") continue;
    if (failure.nodeId && roots.some((root) => root.nodeId === failure.nodeId)) continue;
    roots.push(failure);
  }

  return roots;
}

function isRetryableFailure(failure: ValidationFailure): boolean {
  return failure.classification === "TRANSIENT" || failure.classification === "TIMEOUT";
}

function isUnsafeToAutoHeal(compiledDag: Dag, nodeId: string | undefined): boolean {
  if (!nodeId) return false;
  const node = compiledDag.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return false;
  if (node.type === "SHELL_COMMAND") return true;
  if (node.toolPermissions.some((permission) => SHELL_PERMISSION_PATTERN.test(permission.toLowerCase()))) return true;

  const metadata = recordFrom(node.metadata);
  if (metadata?.approvalRequired === true || metadata?.risk === "destructive" || metadata?.risk === "high") return true;

  const input = recordFrom(node.input);
  if (input?.approvalRequired === true || input?.risk === "destructive" || input?.risk === "high") return true;

  return false;
}

function healingOptions(
  compiledDag: Dag,
  originalOptions: ExecutorSimulatorOptions | undefined,
  failures: ValidationFailure[]
): ExecutorSimulatorOptions {
  const retryNodeIds = new Set(failures.map((failure) => failure.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)));
  const retryNodeTypes = new Set(
    compiledDag.nodes.filter((node) => retryNodeIds.has(node.id)).map((node) => node.type)
  );
  const next: ExecutorSimulatorOptions = {
    ...(originalOptions ?? {}),
    injectFailureNodeIds: (originalOptions?.injectFailureNodeIds ?? []).filter((nodeId) => !retryNodeIds.has(nodeId)),
    injectFailureNodeTypes: (originalOptions?.injectFailureNodeTypes ?? []).filter((nodeType) => !retryNodeTypes.has(nodeType)),
    failAttemptsByNodeId: withoutKeys(originalOptions?.failAttemptsByNodeId, retryNodeIds),
    simulatedDurationMsByNodeId: { ...(originalOptions?.simulatedDurationMsByNodeId ?? {}) },
    simulatedDurationMsByNodeType: { ...(originalOptions?.simulatedDurationMsByNodeType ?? {}) },
  };

  for (const failure of failures) {
    if (failure.classification !== "TIMEOUT" || !failure.nodeId) continue;
    const node = compiledDag.nodes.find((candidate) => candidate.id === failure.nodeId);
    clampTimeoutSimulation(next, node);
  }

  return next;
}

function clampTimeoutSimulation(options: ExecutorSimulatorOptions, node: DagNode | undefined): void {
  if (!node?.timeoutMs) return;
  const safeDuration = Math.max(0, node.timeoutMs);
  if (options.simulatedDurationMsByNodeId?.[node.id] !== undefined) {
    options.simulatedDurationMsByNodeId[node.id] = safeDuration;
  }
  if (options.simulatedDurationMsByNodeType?.[node.type] !== undefined) {
    options.simulatedDurationMsByNodeType[node.type] = safeDuration;
  }
}

function withoutKeys<T>(record: Record<string, T> | undefined, keys: Set<string>): Record<string, T> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)));
}

function appendFailures(target: ValidationFailure[], failures: ValidationFailure[]): void {
  target.push(...failures);
}

function boundedAttempts(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_HEALING_ATTEMPTS;
  return Math.max(0, Math.floor(value));
}

/**
 * Clamps the configured healing bound to the inclusive 1..10 range required by the
 * live-repair loop (req 5.1). A non-finite value falls back to the default.
 */
function boundedLiveAttempts(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_HEALING_ATTEMPTS;
  return Math.min(MAX_LIVE_HEALING_ATTEMPTS, Math.max(MIN_LIVE_HEALING_ATTEMPTS, Math.floor(value)));
}

function parseResult(result: z.input<typeof HealingLoopResultSchema>): HealingLoopResult {
  return HealingLoopResultSchema.parse(result);
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
