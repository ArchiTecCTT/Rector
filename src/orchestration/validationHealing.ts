import { z } from "zod";
import type { Dag, DagNode } from "../protocol/dag";
import {
  DagExecutionResultSchema,
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

export const HealingLoopResultSchema = z.object({
  status: HealingLoopStatusSchema,
  attempts: z.number().int().min(0),
  failures: z.array(ValidationFailureSchema),
  actions: z.array(HealingActionSchema),
  finalExecutionResult: DagExecutionResultSchema,
});
export type HealingLoopResult = z.infer<typeof HealingLoopResultSchema>;

export type HealingExecutor = (
  compiledDag: Dag,
  options?: ExecutorSimulatorOptions
) => DagExecutionResult | Promise<DagExecutionResult>;

export interface ValidateAndHealExecutionInput {
  compiledDag: Dag;
  executionResult?: DagExecutionResult;
  executor?: HealingExecutor;
  executorOptions?: ExecutorSimulatorOptions;
  maxHealingAttempts?: number;
}

const DEFAULT_MAX_HEALING_ATTEMPTS = 2;
const SHELL_PERMISSION_PATTERN = /(^|[.:_-])shell($|[.:_-])/i;

export async function validateAndHealExecution(input: ValidateAndHealExecutionInput): Promise<HealingLoopResult> {
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

function parseResult(result: HealingLoopResult): HealingLoopResult {
  return HealingLoopResultSchema.parse(result);
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
