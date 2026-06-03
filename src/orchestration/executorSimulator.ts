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
  "PERMISSION_DENIED",
  "TIMEOUT",
]);
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCodeSchema>;

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
  injectFailureNodeIds?: string[];
  injectFailureNodeTypes?: DagNodeType[];
  failAttemptsByNodeId?: Record<string, number>;
  simulatedDurationMsByNodeId?: Record<string, number>;
  simulatedDurationMsByNodeType?: Partial<Record<DagNodeType, number>>;
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
      const error: ExecutionError = {
        code: "DEPENDENCY_FAILED",
        message: `Node ${node.id} skipped because dependencies did not complete: ${blockedBy.join(", ")}`,
        nodeId: node.id,
        details: { blockedBy },
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

    const result = executeNode(node, dependencies, cursorMs, options, appendEvent);
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
  appendEvent: (type: ExecutionEvent["type"], event?: Omit<ExecutionEvent, "sequence" | "type" | "at">) => void
): NodeExecutionResult {
  const durationMs = simulatedDurationMs(node, options);
  const startedAt = iso(startedAtMs);
  const completedAt = iso(startedAtMs + durationMs);
  const maxAttempts = Math.max(1, node.retryPolicy?.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS);

  appendEvent("NODE_STARTED", { nodeId: node.id });

  const permissionError = unsafeShellError(node, options);
  if (permissionError) {
    appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", error: permissionError });
    return {
      nodeId: node.id,
      status: "FAILED",
      attempts: 1,
      startedAt,
      completedAt,
      durationMs,
      error: permissionError,
      dependencies,
    };
  }

  const timeoutError = timeoutErrorFor(node, durationMs);
  if (timeoutError) {
    appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", error: timeoutError });
    return {
      nodeId: node.id,
      status: "FAILED",
      attempts: 1,
      startedAt,
      completedAt,
      durationMs,
      error: timeoutError,
      dependencies,
    };
  }

  const forcedFailureAttempts = injectedFailureAttempts(node, options, maxAttempts);
  if (forcedFailureAttempts >= maxAttempts) {
    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      appendEvent("NODE_RETRIED", { nodeId: node.id, status: "RETRIED", error: injectedFailureError(node, attempt) });
    }
    const error = injectedFailureError(node, maxAttempts);
    appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", error });
    return {
      nodeId: node.id,
      status: "FAILED",
      attempts: maxAttempts,
      startedAt,
      completedAt,
      durationMs,
      error,
      dependencies,
    };
  }

  for (let attempt = 1; attempt <= forcedFailureAttempts; attempt += 1) {
    appendEvent("NODE_RETRIED", { nodeId: node.id, status: "RETRIED", error: injectedFailureError(node, attempt) });
  }

  const attempts = forcedFailureAttempts + 1;
  const status: NodeExecutionStatus = attempts > 1 ? "RETRIED" : "SUCCESS";
  appendEvent("NODE_COMPLETED", { nodeId: node.id, status });
  return {
    nodeId: node.id,
    status,
    attempts,
    startedAt,
    completedAt,
    durationMs,
    output: {
      simulated: true,
      nodeType: node.type,
      expectedOutputs: node.expectedOutputs,
    },
    dependencies,
  };
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

function timeoutErrorFor(node: DagNode, durationMs: number): ExecutionError | undefined {
  if (node.timeoutMs === undefined || durationMs <= node.timeoutMs) return undefined;
  return {
    code: "TIMEOUT",
    message: `Node ${node.id} simulated duration ${durationMs}ms exceeded timeout ${node.timeoutMs}ms`,
    nodeId: node.id,
    details: { simulatedDurationMs: durationMs, timeoutMs: node.timeoutMs },
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

function injectedFailureError(node: DagNode, attempt: number): ExecutionError {
  return {
    code: "INJECTED_FAILURE",
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
  if (failed > 0 && skipped === 0 && succeeded === 0) return "FAILED";
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
