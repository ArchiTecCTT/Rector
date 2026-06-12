import { z } from "zod";
import { DagNodeTypeSchema, DagSchema, validateDag, type Dag, type DagNode, type DagNodeType } from "../protocol/dag";

export const DagExecutionStatusSchema = z.enum(["SUCCESS", "FAILED", "PARTIAL", "SKIPPED"]);
export type DagExecutionStatus = z.infer<typeof DagExecutionStatusSchema>;

export const NodeExecutionStatusSchema = z.enum(["SUCCESS", "FAILED", "SKIPPED", "RETRIED"]);
export type NodeExecutionStatus = z.infer<typeof NodeExecutionStatusSchema>;

export const ExecutionErrorCodeSchema = z.enum([
  "DAG_VALIDATION_FAILED",
  "DEPENDENCY_FAILED",
  "INJECTED_FAILURE",
  "OPERATION_MAPPING_FAILED",
  "PERMISSION_DENIED",
  "SANDBOX_OPERATION_FAILED",
  "TIMEOUT",
  "VALIDATION_FAILED",
]);
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCodeSchema>;

export const DependencyFailureStrategySchema = z.enum(["SKIP_DOWNSTREAM", "FAIL_FAST"]);
export type DependencyFailureStrategy = z.infer<typeof DependencyFailureStrategySchema>;

export const ExecutionPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  retryableErrorCodes: z.array(ExecutionErrorCodeSchema).default(["INJECTED_FAILURE", "TIMEOUT"]),
  perNodeTimeoutMs: z.number().int().positive().optional(),
  dependencyFailureStrategy: DependencyFailureStrategySchema.default("SKIP_DOWNSTREAM"),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export const ExecutionErrorSchema = z.object({
  code: ExecutionErrorCodeSchema,
  message: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  details: z.record(z.unknown()).optional(),
});
export type ExecutionError = z.infer<typeof ExecutionErrorSchema>;

export const NodeExecutionResultSchema = z.object({
  nodeId: z.string().min(1),
  status: NodeExecutionStatusSchema,
  attempts: z.number().int().min(0),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  output: z.record(z.unknown()).optional(),
  error: ExecutionErrorSchema.optional(),
  dependencies: z.array(z.string().min(1)),
});
export type NodeExecutionResult = z.infer<typeof NodeExecutionResultSchema>;

export const ExecutionEventSchema = z.object({
  sequence: z.number().int().min(1),
  type: z.enum(["DAG_STARTED", "NODE_STARTED", "NODE_RETRIED", "NODE_COMPLETED", "NODE_FAILED", "NODE_SKIPPED", "DAG_COMPLETED"]),
  nodeId: z.string().min(1).optional(),
  status: z.union([DagExecutionStatusSchema, NodeExecutionStatusSchema]).optional(),
  attempt: z.number().int().min(1).optional(),
  error: ExecutionErrorSchema.optional(),
  at: z.string().datetime(),
});
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

export const DagExecutionResultSchema = z.object({
  dagId: z.string().min(1),
  runId: z.string().min(1),
  status: DagExecutionStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  nodeResults: z.array(NodeExecutionResultSchema),
  events: z.array(ExecutionEventSchema),
  error: ExecutionErrorSchema.optional(),
});
export type DagExecutionResult = z.infer<typeof DagExecutionResultSchema>;

export interface ExecutorSimulatorOptions {
  now?: () => string;
  executionPolicy?: Partial<ExecutionPolicy>;
  injectFailureNodeIds?: string[];
  injectFailureNodeTypes?: DagNodeType[];
  injectedErrorCodeByNodeId?: Partial<Record<string, ExecutionErrorCode>>;
  failAttemptsByNodeId?: Record<string, number>;
  simulatedDurationMsByNodeId?: Record<string, number>;
  simulatedDurationMsByNodeType?: Partial<Record<DagNodeType, number>>;
  simulatedOutputByNodeId?: Record<string, Record<string, unknown>>;
  validationFailuresByNodeId?: Record<string, string>;
  allowUnsafeShell?: boolean;
}

const DEFAULT_NODE_DURATION_MS = 1;
const DEFAULT_RETRY_ATTEMPTS = 1;
const SHELL_PERMISSION_PATTERN = /(^|[.:_-])shell($|[.:_-])/i;

export async function executeCompiledDag(
  compiledDag: Dag,
  options: ExecutorSimulatorOptions = {}
): Promise<DagExecutionResult> {
  return executeCompiledDagSync(compiledDag, options);
}

export function executeCompiledDagSync(compiledDag: Dag, options: ExecutorSimulatorOptions = {}): DagExecutionResult {
  const parsed = DagSchema.safeParse(compiledDag);
  const startedAtMs = initialTimeMs(options.now);
  const events: ExecutionEvent[] = [];
  let cursorMs = startedAtMs;
  let sequence = 1;

  const appendEvent = (
    type: ExecutionEvent["type"],
    event: Omit<ExecutionEvent, "sequence" | "type" | "at"> = {}
  ): void => {
    events.push({ sequence, type, at: iso(cursorMs), ...event });
    sequence += 1;
  };

  appendEvent("DAG_STARTED");

  if (!parsed.success) {
    const error: ExecutionError = {
      code: "DAG_VALIDATION_FAILED",
      message: parsed.error.issues.map((issue) => issue.message).join("; ") || "DAG validation failed",
    };
    appendEvent("DAG_COMPLETED", { status: "FAILED", error });
    return DagExecutionResultSchema.parse({
      dagId: compiledDag.id,
      runId: compiledDag.runId,
      status: "FAILED",
      startedAt: iso(startedAtMs),
      completedAt: iso(cursorMs),
      durationMs: cursorMs - startedAtMs,
      nodeResults: [],
      events,
      error,
    });
  }

  const dag = parsed.data;
  const validation = validateDag(dag);
  if (!validation.valid) {
    const error: ExecutionError = {
      code: "DAG_VALIDATION_FAILED",
      message: validation.errors.join("; ") || "DAG validation failed",
    };
    appendEvent("DAG_COMPLETED", { status: "FAILED", error });
    return DagExecutionResultSchema.parse({
      dagId: dag.id,
      runId: dag.runId,
      status: "FAILED",
      startedAt: iso(startedAtMs),
      completedAt: iso(cursorMs),
      durationMs: cursorMs - startedAtMs,
      nodeResults: [],
      events,
      error,
    });
  }

  const dependenciesByNode = dependencyMap(dag);
  const orderedNodes = topologicalNodes(dag.nodes, dependenciesByNode);
  const resultsByNode = new Map<string, NodeExecutionResult>();
  const nodeResults: NodeExecutionResult[] = [];

  for (const node of orderedNodes) {
    const dependencies = [...(dependenciesByNode.get(node.id) ?? [])].sort();
    const blockedBy = dependencies.filter((dependencyId) => {
      const result = resultsByNode.get(dependencyId);
      return result?.status === "FAILED" || result?.status === "SKIPPED";
    });

    if (blockedBy.length > 0) {
      const at = iso(cursorMs);
      const policy = resolveExecutionPolicy(node, options);
      const error: ExecutionError = {
        code: "DEPENDENCY_FAILED",
        message: `Node ${node.id} skipped because dependencies did not complete: ${blockedBy.join(", ")}`,
        nodeId: node.id,
        details: { blockedBy, dependencyFailureStrategy: policy.dependencyFailureStrategy },
      };
      const result: NodeExecutionResult = {
        nodeId: node.id,
        status: "SKIPPED",
        attempts: 0,
        startedAt: at,
        completedAt: at,
        durationMs: 0,
        error,
        dependencies,
      };
      nodeResults.push(result);
      resultsByNode.set(node.id, result);
      appendEvent("NODE_SKIPPED", { nodeId: node.id, status: "SKIPPED", error });
      continue;
    }

    const result = executeNode(node, dependencies, cursorMs, options, resultsByNode, appendEvent);
    cursorMs += result.durationMs;
    nodeResults.push(result);
    resultsByNode.set(node.id, result);
  }

  const status = dagStatus(nodeResults);
  appendEvent("DAG_COMPLETED", { status });

  return DagExecutionResultSchema.parse({
    dagId: dag.id,
    runId: dag.runId,
    status,
    startedAt: iso(startedAtMs),
    completedAt: iso(cursorMs),
    durationMs: cursorMs - startedAtMs,
    nodeResults,
    events,
  });
}

function executeNode(
  node: DagNode,
  dependencies: string[],
  startedAtMs: number,
  options: ExecutorSimulatorOptions,
  resultsByNode: Map<string, NodeExecutionResult>,
  appendEvent: (type: ExecutionEvent["type"], event?: Omit<ExecutionEvent, "sequence" | "type" | "at">) => void
): NodeExecutionResult {
  const policy = resolveExecutionPolicy(node, options);
  const perAttemptDurationMs = simulatedDurationMs(node, options);
  const startedAt = iso(startedAtMs);

  appendEvent("NODE_STARTED", { nodeId: node.id, attempt: 1 });

  const permissionError = unsafeShellError(node, options);
  if (permissionError) {
    return failedNodeResult(node, dependencies, startedAtMs, perAttemptDurationMs, permissionError, policy, appendEvent);
  }

  const timeoutError = timeoutErrorFor(node, perAttemptDurationMs, policy);
  if (timeoutError) {
    return failedNodeResult(node, dependencies, startedAtMs, perAttemptDurationMs, timeoutError, policy, appendEvent);
  }

  const forcedFailureAttempts = injectedFailureAttempts(node, options, policy.maxAttempts);
  if (forcedFailureAttempts > 0) {
    const firstError = injectedFailureError(node, 1, options);
    const retryable = isRetryableExecutionError(firstError, policy);
    if (!retryable) {
      appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", attempt: 1, error: firstError });
      return {
        nodeId: node.id,
        status: "FAILED",
        attempts: 1,
        startedAt,
        completedAt: iso(startedAtMs + perAttemptDurationMs),
        durationMs: perAttemptDurationMs,
        error: firstError,
        dependencies,
      };
    }

    const boundedFailureAttempts = Math.min(forcedFailureAttempts, policy.maxAttempts);
    if (boundedFailureAttempts >= policy.maxAttempts) {
      for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
        appendEvent("NODE_RETRIED", {
          nodeId: node.id,
          status: "RETRIED",
          attempt,
          error: injectedFailureError(node, attempt, options),
        });
      }
      const error = injectedFailureError(node, policy.maxAttempts, options);
      appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", attempt: policy.maxAttempts, error });
      return {
        nodeId: node.id,
        status: "FAILED",
        attempts: policy.maxAttempts,
        startedAt,
        completedAt: iso(startedAtMs + perAttemptDurationMs * policy.maxAttempts),
        durationMs: perAttemptDurationMs * policy.maxAttempts,
        error,
        dependencies,
      };
    }

    for (let attempt = 1; attempt <= boundedFailureAttempts; attempt += 1) {
      appendEvent("NODE_RETRIED", {
        nodeId: node.id,
        status: "RETRIED",
        attempt,
        error: injectedFailureError(node, attempt, options),
      });
    }

    const attempts = boundedFailureAttempts + 1;
    const status: NodeExecutionStatus = "RETRIED";
    appendEvent("NODE_COMPLETED", { nodeId: node.id, status, attempt: attempts });
    return successfulNodeResult(node, dependencies, startedAtMs, perAttemptDurationMs, attempts, status, options, resultsByNode);
  }

  const validationError = validationErrorFor(node, dependencies, resultsByNode, options);
  if (validationError) {
    return failedNodeResult(node, dependencies, startedAtMs, perAttemptDurationMs, validationError, policy, appendEvent);
  }

  appendEvent("NODE_COMPLETED", { nodeId: node.id, status: "SUCCESS", attempt: 1 });
  return successfulNodeResult(node, dependencies, startedAtMs, perAttemptDurationMs, 1, "SUCCESS", options, resultsByNode);
}

function successfulNodeResult(
  node: DagNode,
  dependencies: string[],
  startedAtMs: number,
  perAttemptDurationMs: number,
  attempts: number,
  status: NodeExecutionStatus,
  options: ExecutorSimulatorOptions,
  resultsByNode: Map<string, NodeExecutionResult>,
): NodeExecutionResult {
  const durationMs = perAttemptDurationMs * attempts;
  return {
    nodeId: node.id,
    status,
    attempts,
    startedAt: iso(startedAtMs),
    completedAt: iso(startedAtMs + durationMs),
    durationMs,
    output: simulatedOutputFor(node, dependencies, options, resultsByNode),
    dependencies,
  };
}

function failedNodeResult(
  node: DagNode,
  dependencies: string[],
  startedAtMs: number,
  perAttemptDurationMs: number,
  error: ExecutionError,
  policy: ExecutionPolicy,
  appendEvent: (type: ExecutionEvent["type"], event?: Omit<ExecutionEvent, "sequence" | "type" | "at">) => void,
): NodeExecutionResult {
  const retryable = isRetryableExecutionError(error, policy);
  const attempts = retryable ? policy.maxAttempts : 1;

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    appendEvent("NODE_RETRIED", { nodeId: node.id, status: "RETRIED", attempt, error: { ...error, details: { ...(error.details ?? {}), attempt } } });
  }

  const finalError = attempts === 1 ? error : { ...error, details: { ...(error.details ?? {}), attempt: attempts } };
  appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", attempt: attempts, error: finalError });

  const durationMs = perAttemptDurationMs * attempts;
  return {
    nodeId: node.id,
    status: "FAILED",
    attempts,
    startedAt: iso(startedAtMs),
    completedAt: iso(startedAtMs + durationMs),
    durationMs,
    error: finalError,
    dependencies,
  };
}

function resolveExecutionPolicy(node: DagNode, options: ExecutorSimulatorOptions): ExecutionPolicy {
  const parsed = ExecutionPolicySchema.parse(options.executionPolicy ?? {});
  return {
    ...parsed,
    maxAttempts: Math.max(1, node.retryPolicy?.maxAttempts ?? parsed.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS),
    retryableErrorCodes: [...parsed.retryableErrorCodes],
  };
}

function isRetryableExecutionError(error: ExecutionError, policy: ExecutionPolicy): boolean {
  return policy.retryableErrorCodes.includes(error.code);
}

function simulatedOutputFor(
  node: DagNode,
  dependencies: string[],
  options: ExecutorSimulatorOptions,
  resultsByNode: Map<string, NodeExecutionResult>,
): Record<string, unknown> {
  const override = options.simulatedOutputByNodeId?.[node.id] ?? {};
  const base: Record<string, unknown> = {
    simulated: true,
    nodeType: node.type,
    expectedOutputs: node.expectedOutputs,
  };

  if (node.type === "VALIDATION") {
    base.validation = {
      passed: true,
      inspectedDependencies: dependencies,
      upstreamStatuses: Object.fromEntries(
        dependencies.map((dependencyId) => [dependencyId, resultsByNode.get(dependencyId)?.status ?? "MISSING"]),
      ),
    };
  }

  return { ...base, ...override };
}

function validationErrorFor(
  node: DagNode,
  dependencies: string[],
  resultsByNode: Map<string, NodeExecutionResult>,
  options: ExecutorSimulatorOptions,
): ExecutionError | undefined {
  if (node.type !== "VALIDATION") return undefined;

  const explicitFailure = options.validationFailuresByNodeId?.[node.id] ?? explicitValidationFailureMessage(node);
  if (explicitFailure) {
    return {
      code: "VALIDATION_FAILED",
      message: `Validation node ${node.id} failed: ${explicitFailure}`,
      nodeId: node.id,
      details: { reason: explicitFailure },
    };
  }

  const input = recordFrom(node.input);
  const targetNodeIds = validationTargetNodeIds(input, dependencies);
  if (targetNodeIds.length === 0) {
    return {
      code: "VALIDATION_FAILED",
      message: `Validation node ${node.id} has no upstream node to inspect`,
      nodeId: node.id,
      details: { dependencies },
    };
  }

  const expectedArtifacts = stringArrayFrom(input?.expectedArtifacts);
  for (const targetNodeId of targetNodeIds) {
    const upstream = resultsByNode.get(targetNodeId);
    if (!upstream || (upstream.status !== "SUCCESS" && upstream.status !== "RETRIED")) {
      return {
        code: "VALIDATION_FAILED",
        message: `Validation node ${node.id} could not inspect successful output from ${targetNodeId}`,
        nodeId: node.id,
        details: { targetNodeId, upstreamStatus: upstream?.status ?? "MISSING" },
      };
    }

    if (expectedArtifacts.length === 0) continue;
    const upstreamOutput = recordFrom(upstream.output);
    const upstreamArtifacts = new Set([
      ...stringArrayFrom(upstreamOutput?.expectedOutputs),
      ...stringArrayFrom(upstreamOutput?.artifacts),
    ]);
    const missing = expectedArtifacts.filter((artifact) => !upstreamArtifacts.has(artifact));
    if (missing.length > 0) {
      return {
        code: "VALIDATION_FAILED",
        message: `Validation node ${node.id} missing expected artifact(s) from ${targetNodeId}: ${missing.join(", ")}`,
        nodeId: node.id,
        details: { targetNodeId, missing, expectedArtifacts },
      };
    }
  }

  return undefined;
}

function explicitValidationFailureMessage(node: DagNode): string | undefined {
  const input = recordFrom(node.input);
  const metadata = recordFrom(node.metadata);
  const value = input?.validationFailure ?? input?.validationShouldFail ?? metadata?.validationFailure ?? metadata?.validationShouldFail;
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (value === true) return "validationShouldFail was set";
  return undefined;
}

function validationTargetNodeIds(input: Record<string, unknown> | undefined, dependencies: string[]): string[] {
  const targetNodeId = input?.targetNodeId;
  if (typeof targetNodeId === "string" && targetNodeId.length > 0) return [targetNodeId];
  const targetNodeIds = stringArrayFrom(input?.targetNodeIds);
  return targetNodeIds.length > 0 ? targetNodeIds : dependencies;
}

function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function dependencyMap(dag: Dag): Map<string, Set<string>> {
  const dependencies = new Map(dag.nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  for (const edge of dag.edges) {
    dependencies.get(edge.to)?.add(edge.from);
  }
  return dependencies;
}

function topologicalNodes(nodes: DagNode[], dependencies: Map<string, Set<string>>): DagNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const remaining = new Map([...dependencies.entries()].map(([nodeId, deps]) => [nodeId, new Set(deps)]));
  const ordered: DagNode[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([nodeId]) => nodeId)
      .sort();

    if (ready.length === 0) {
      return nodes;
    }

    for (const nodeId of ready) {
      const node = nodeById.get(nodeId);
      if (node) ordered.push(node);
      remaining.delete(nodeId);
      for (const dependenciesForNode of remaining.values()) {
        dependenciesForNode.delete(nodeId);
      }
    }
  }

  return ordered;
}

function unsafeShellError(node: DagNode, options: ExecutorSimulatorOptions): ExecutionError | undefined {
  if (options.allowUnsafeShell === true) return undefined;

  const permissions = node.toolPermissions.map((permission) => permission.toLowerCase());
  const hasShellPermission = permissions.some((permission) => SHELL_PERMISSION_PATTERN.test(permission));
  const toolPolicy = recordFrom(node.metadata?.toolPolicy);
  const allowUnsafeShell = toolPolicy?.allowUnsafeShell === true;

  if (node.type !== "SHELL_COMMAND" && !hasShellPermission && !allowUnsafeShell) {
    return undefined;
  }

  return {
    code: "PERMISSION_DENIED",
    message: `Node ${node.id} denied unsafe shell execution by default`,
    nodeId: node.id,
    details: { nodeType: node.type, toolPermissions: node.toolPermissions, allowUnsafeShell },
  };
}

function timeoutErrorFor(node: DagNode, durationMs: number, policy: ExecutionPolicy): ExecutionError | undefined {
  const timeoutMs = node.timeoutMs ?? policy.perNodeTimeoutMs;
  if (timeoutMs === undefined || durationMs <= timeoutMs) return undefined;
  return {
    code: "TIMEOUT",
    message: `Node ${node.id} simulated duration ${durationMs}ms exceeded timeout ${timeoutMs}ms`,
    nodeId: node.id,
    details: { simulatedDurationMs: durationMs, timeoutMs },
  };
}

function injectedFailureAttempts(node: DagNode, options: ExecutorSimulatorOptions, maxAttempts: number): number {
  const configuredAttempts = options.failAttemptsByNodeId?.[node.id];
  if (configuredAttempts !== undefined) {
    return Math.max(0, Math.min(maxAttempts, Math.floor(configuredAttempts)));
  }

  if (options.injectFailureNodeIds?.includes(node.id)) {
    return maxAttempts;
  }

  if (options.injectFailureNodeTypes?.includes(node.type)) {
    return maxAttempts;
  }

  return 0;
}

function injectedFailureError(node: DagNode, attempt: number, options: ExecutorSimulatorOptions): ExecutionError {
  const code = options.injectedErrorCodeByNodeId?.[node.id] ?? "INJECTED_FAILURE";
  return {
    code,
    message: `Injected fake failure for node ${node.id} on attempt ${attempt}`,
    nodeId: node.id,
    details: { attempt, nodeType: node.type },
  };
}

function simulatedDurationMs(node: DagNode, options: ExecutorSimulatorOptions): number {
  const byNodeId = options.simulatedDurationMsByNodeId?.[node.id];
  if (byNodeId !== undefined) return nonNegativeInteger(byNodeId);

  const byNodeType = options.simulatedDurationMsByNodeType?.[node.type];
  if (byNodeType !== undefined) return nonNegativeInteger(byNodeType);

  return DEFAULT_NODE_DURATION_MS;
}

function dagStatus(results: NodeExecutionResult[]): DagExecutionStatus {
  if (results.length === 0) return "SKIPPED";

  const failed = results.filter((result) => result.status === "FAILED").length;
  const skipped = results.filter((result) => result.status === "SKIPPED").length;
  const succeeded = results.filter((result) => result.status === "SUCCESS" || result.status === "RETRIED").length;

  if (failed === 0 && skipped === 0) return "SUCCESS";
  if (failed === 0 && succeeded === 0 && skipped > 0) return "SKIPPED";
  if (failed > 0 && succeeded === 0) return "FAILED";
  return "PARTIAL";
}

function initialTimeMs(now: (() => string) | undefined): number {
  const value = now?.() ?? new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NODE_DURATION_MS;
  return Math.max(0, Math.floor(value));
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export { DagNodeTypeSchema };
