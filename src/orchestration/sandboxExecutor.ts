import { z } from "zod";

import {
  SandboxOperationKindSchema,
  SandboxExecutionStatusSchema,
  WorkspaceSandboxAdapter,
  type SandboxOperationInput,
  type SandboxOperationResult,
} from "../sandbox";
import { redactString } from "../security/redaction";
import { DagSchema, validateDag, type Dag, type DagNode } from "../protocol/dag";
import {
  DagExecutionResultSchema,
  type DagExecutionStatus,
  type ExecutionError,
  type ExecutionEvent,
  type NodeExecutionResult,
} from "./executorSimulator";

// ---------------------------------------------------------------------------
// DAG-to-sandbox execution bridge (ORN-37)
//
// This module is the ONLY bridge between the executor phase and real file /
// command I/O. It maps each DAG node to a `SandboxOperationInput` and drives it
// through `WorkspaceSandboxAdapter.operate`, which enforces workspace
// containment, the command allowlist / destructive denylist, approval gates,
// and redaction. The local `executorSimulator` remains the default for local
// (provider-free) mode; this bridge is wired into the external path only.
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on each recorded `preview`. Mirrors the Phase 1
 * `promptPreview` convention: previews are always redacted and length-bounded
 * so a run event never carries an unbounded (or secret-bearing) blob.
 */
export const EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH = 512;

/**
 * Provider-free, secret-free record of a single sandbox operation, recorded on
 * the EXECUTING / VALIDATING run-event payloads. Reuses the sandbox operation
 * kind and execution status so it stays consistent with the adapter results.
 */
export const ExecutionArtifactSchema = z.object({
  source: z.enum(["sandbox-operation", "command-stdout", "command-stderr", "patch"]),
  nodeId: z.string().min(1).optional(),
  operationId: z.string().min(1),
  operationKind: SandboxOperationKindSchema.optional(),
  status: SandboxExecutionStatusSchema,
  artifactId: z.string().min(1).optional(), // PatchArtifact.id when source === "patch"
  preview: z.string(), // redacted, truncated stdout/stderr/file preview
  truncated: z.boolean().default(false),
});
export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>;

/**
 * A `DagExecutionResult` enriched with the redacted execution artifacts the
 * bridge captured. The base shape is unchanged so the result is still a valid
 * `DagExecutionResult` and can be consumed by the healing loop unchanged; the
 * additive `artifacts` array carries the EXECUTING / VALIDATING previews.
 */
export interface SandboxDagExecutionResult extends z.infer<typeof DagExecutionResultSchema> {
  artifacts: ExecutionArtifact[];
}

export interface ExecuteDagThroughSandboxDeps {
  /** The only bridge to real I/O; enforces containment, allowlist, redaction. */
  sandbox: WorkspaceSandboxAdapter;
  now?: () => string;
  /**
   * Optional override mapping a node to a sandbox operation. Returning
   * `undefined` marks the node as a no-op (no real I/O); the default mapping is
   * {@link mapDagNodeToOperation}.
   */
  mapNodeToOperation?: (node: DagNode) => SandboxOperationInput | undefined;
}

/** Reads a structured operation hint from a node's `input` then `metadata`. */
function readOperationHint(node: DagNode): Record<string, unknown> {
  const fromInput = recordFrom(recordFrom(node.input)?.sandboxOperation) ?? recordFrom(node.input) ?? {};
  const fromMetadata = recordFrom(recordFrom(node.metadata)?.sandboxOperation) ?? {};
  // Input hints take precedence over metadata hints.
  return { ...fromMetadata, ...fromInput };
}

/** Default sandbox operation kind for a node type, when no explicit hint exists. */
function defaultOperationKind(node: DagNode): z.infer<typeof SandboxOperationKindSchema> | undefined {
  switch (node.type) {
    case "FILE_OPERATION":
      return "PROPOSE_PATCH";
    case "VALIDATION":
    case "SHELL_COMMAND":
      return "RUN_COMMAND";
    default:
      // LLM_EXECUTION / MERGE / CONDITIONAL carry no real workspace I/O.
      return undefined;
  }
}

/**
 * Maps a DAG node to a `SandboxOperationInput`, or `undefined` when the node
 * carries no real workspace I/O (and is therefore a no-op success). Explicit
 * hints on `node.input` / `node.metadata` (a `sandboxOperation` object or the
 * individual `operationKind` / `path` / `command` fields) take precedence over
 * the node-type default.
 */
export function mapDagNodeToOperation(node: DagNode): SandboxOperationInput | undefined {
  const hint = readOperationHint(node);
  const explicitKind = SandboxOperationKindSchema.safeParse(hint.operationKind ?? hint.kind);
  const kind = explicitKind.success ? explicitKind.data : defaultOperationKind(node);
  if (!kind) return undefined;

  const approvalId = stringOrUndefined(hint.approvalId);

  if (kind === "READ_FILE" || kind === "LIST_DIR") {
    const path = stringOrUndefined(hint.path) ?? firstSafePath(node.expectedOutputs);
    if (!path) return undefined;
    return { kind, path, approvalId };
  }

  if (kind === "PROPOSE_PATCH") {
    const path = stringOrUndefined(hint.path) ?? firstSafePath(node.expectedOutputs);
    if (!path) return undefined;
    const operation = parsePatchOperation(hint.operation);
    return {
      kind,
      path,
      operation,
      content: stringOrUndefined(hint.content) ?? "",
      approvalId,
    };
  }

  // RUN_COMMAND
  const command = stringOrUndefined(hint.command);
  if (!command) return undefined;
  const args = Array.isArray(hint.args) ? hint.args.map((value) => String(value)) : [];
  const timeoutMs = node.timeoutMs ?? numberOrUndefined(hint.timeoutMs);
  const shell = hint.shell === true || hint.kind === "shell" || node.type === "SHELL_COMMAND";
  return {
    kind,
    command,
    args,
    timeoutMs,
    approvalId,
    metadata: shell ? { kind: "shell" } : {},
  };
}

/**
 * Executes a compiled DAG by driving each node's mapped sandbox operation
 * through {@link WorkspaceSandboxAdapter.operate}. Denied / needs-approval /
 * failed operations surface as structured node results — never thrown errors —
 * and every captured stream/file/patch is recorded as a redacted, length-bounded
 * {@link ExecutionArtifact}. Network access never occurs.
 */
export async function executeDagThroughSandbox(
  compiledDag: Dag,
  deps: ExecuteDagThroughSandboxDeps,
  options: { now?: () => string } = {},
): Promise<SandboxDagExecutionResult> {
  const now = options.now ?? deps.now ?? (() => new Date().toISOString());
  const mapNode = deps.mapNodeToOperation ?? mapDagNodeToOperation;
  const events: ExecutionEvent[] = [];
  const artifacts: ExecutionArtifact[] = [];
  const startedAt = safeNow(now);
  let sequence = 1;

  const appendEvent = (
    type: ExecutionEvent["type"],
    event: Omit<ExecutionEvent, "sequence" | "type" | "at"> = {},
  ): void => {
    events.push({ sequence, type, at: safeNow(now), ...event });
    sequence += 1;
  };

  appendEvent("DAG_STARTED");

  // Validate the DAG first so a malformed DAG surfaces as a structured FAILED
  // result (mirroring the simulator) rather than throwing.
  const parsed = DagSchema.safeParse(compiledDag);
  const validation = parsed.success ? validateDag(parsed.data) : undefined;
  if (!parsed.success || (validation && !validation.valid)) {
    const error: ExecutionError = {
      code: "DAG_VALIDATION_FAILED",
      message: parsed.success
        ? validation?.errors.join("; ") || "DAG validation failed"
        : parsed.error.issues.map((issue) => issue.message).join("; ") || "DAG validation failed",
    };
    appendEvent("DAG_COMPLETED", { status: "FAILED", error });
    const completedAt = safeNow(now);
    return buildResult(compiledDag, "FAILED", startedAt, completedAt, [], events, artifacts, error);
  }

  const dag = parsed.data;
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
      const at = safeNow(now);
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

    appendEvent("NODE_STARTED", { nodeId: node.id });
    const result = await executeNodeThroughSandbox(node, dependencies, deps.sandbox, mapNode, now, artifacts, resultsByNode);
    nodeResults.push(result);
    resultsByNode.set(node.id, result);
    if (result.status === "FAILED") {
      appendEvent("NODE_FAILED", { nodeId: node.id, status: "FAILED", error: result.error });
    } else {
      appendEvent("NODE_COMPLETED", { nodeId: node.id, status: result.status });
    }
  }

  const status = dagStatus(nodeResults);
  appendEvent("DAG_COMPLETED", { status });
  const completedAt = safeNow(now);
  return buildResult(compiledDag, status, startedAt, completedAt, nodeResults, events, artifacts);
}

async function executeNodeThroughSandbox(
  node: DagNode,
  dependencies: string[],
  sandbox: WorkspaceSandboxAdapter,
  mapNode: (node: DagNode) => SandboxOperationInput | undefined,
  now: () => string,
  artifacts: ExecutionArtifact[],
  resultsByNode: Map<string, NodeExecutionResult>,
): Promise<NodeExecutionResult> {
  const operation = mapNode(node);

  // Nodes with no workspace I/O (LLM_EXECUTION / MERGE / CONDITIONAL, or any node
  // the mapping declined) are recorded as no-op successes — no sandbox call.
  if (!operation) {
    const at = safeNow(now);
    const validationResult = !hasExplicitSandboxOperationHint(node)
      ? validationNodeResultWithoutSandbox(node, dependencies, resultsByNode, at)
      : undefined;
    if (validationResult) return validationResult;

    const mappingError = mapNode === mapDagNodeToOperation ? operationMappingErrorFor(node) : undefined;
    if (mappingError) {
      return {
        nodeId: node.id,
        status: "FAILED",
        attempts: 1,
        startedAt: at,
        completedAt: at,
        durationMs: 0,
        output: { sandbox: false, noop: false, nodeType: node.type, preview: previewFrom(mappingError.message) },
        error: mappingError,
        dependencies,
      };
    }

    return {
      nodeId: node.id,
      status: "SUCCESS",
      attempts: 1,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
      output: { sandbox: false, noop: true, nodeType: node.type, expectedOutputs: node.expectedOutputs },
      dependencies,
    };
  }

  let operationResult: SandboxOperationResult;
  try {
    operationResult = await sandbox.operate(operation);
  } catch (error) {
    // The sandbox is contracted never to throw for policy denials; a thrown
    // error here is unexpected, so surface it as a structured node failure
    // rather than letting it escape the bridge.
    const at = safeNow(now);
    const message = redactString(stringifyError(error));
    return {
      nodeId: node.id,
      status: "FAILED",
      attempts: 1,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
      output: { sandbox: true, nodeType: node.type, preview: previewFrom(message) },
      error: {
        code: "SANDBOX_OPERATION_FAILED",
        message: `Sandbox operation for node ${node.id} failed unexpectedly`,
        nodeId: node.id,
        details: { message: previewFrom(message) },
      },
      dependencies,
    };
  }

  recordArtifacts(node.id, operationResult, artifacts);
  return nodeResultFromOperation(node, dependencies, operationResult);
}

/** Records the redacted, length-bounded artifacts for one sandbox operation. */
function recordArtifacts(nodeId: string, result: SandboxOperationResult, artifacts: ExecutionArtifact[]): void {
  const operationId = operationIdFor(nodeId, result.kind);
  const operationPreviewRecord = normalizePreview(operationPreview(result));
  artifacts.push(
    ExecutionArtifactSchema.parse({
      source: "sandbox-operation",
      nodeId,
      operationId,
      operationKind: result.kind,
      status: result.status,
      preview: operationPreviewRecord.preview,
      truncated: operationPreviewRecord.truncated,
    }),
  );

  if (result.kind === "RUN_COMMAND") {
    const stdout = normalizePreview(result.stdout);
    const stderr = normalizePreview(result.stderr);
    artifacts.push(
      ExecutionArtifactSchema.parse({
        source: "command-stdout",
        nodeId,
        operationId,
        operationKind: result.kind,
        status: result.status,
        preview: stdout.preview,
        truncated: stdout.truncated,
      }),
    );
    artifacts.push(
      ExecutionArtifactSchema.parse({
        source: "command-stderr",
        nodeId,
        operationId,
        operationKind: result.kind,
        status: result.status,
        preview: stderr.preview,
        truncated: stderr.truncated,
      }),
    );
  }

  if (result.kind === "PROPOSE_PATCH") {
    const patch = result.artifacts[0];
    const preview = normalizePreview(patch?.unifiedDiff ?? operationPreview(result));
    artifacts.push(
      ExecutionArtifactSchema.parse({
        source: "patch",
        nodeId,
        operationId,
        operationKind: result.kind,
        status: result.status,
        artifactId: patch?.id,
        preview: preview.preview,
        truncated: preview.truncated,
      }),
    );
  }
}

/** Maps a sandbox operation result onto a node execution result. */
function nodeResultFromOperation(
  node: DagNode,
  dependencies: string[],
  result: SandboxOperationResult,
): NodeExecutionResult {
  const startedAt = result.startedAt;
  const completedAt = result.completedAt;
  const durationMs = durationMsBetween(startedAt, completedAt);
  const preview = normalizePreview(operationPreview(result));
  const baseOutput: Record<string, unknown> = {
    sandbox: true,
    nodeType: node.type,
    operationId: operationIdFor(node.id, result.kind),
    operationKind: result.kind,
    sandboxStatus: result.status,
    preview: preview.preview,
    previewTruncated: preview.truncated,
    expectedOutputs: node.expectedOutputs,
    artifacts: result.artifacts.map((artifact) => artifact.id),
  };

  if (result.status === "SUCCEEDED") {
    return {
      nodeId: node.id,
      status: "SUCCESS",
      attempts: 1,
      startedAt,
      completedAt,
      durationMs,
      output: baseOutput,
      dependencies,
    };
  }

  // DENIED / NEEDS_APPROVAL / FAILED all surface as a structured node failure.
  const error = executionErrorFromResult(node.id, result);
  return {
    nodeId: node.id,
    status: "FAILED",
    attempts: 1,
    startedAt,
    completedAt,
    durationMs,
    output: { ...baseOutput, denialReason: result.denialReason },
    error,
    dependencies,
  };
}

/**
 * Maps a non-success sandbox result to an executor `ExecutionError`. Policy
 * denials and approval gates map to `PERMISSION_DENIED` (a human decision is
 * required); a command timeout maps to `TIMEOUT`. A plain command failure
 * (non-zero exit) carries no executor error code (so it classifies as UNKNOWN),
 * but its redacted preview is preserved on the node output.
 */
function executionErrorFromResult(nodeId: string, result: SandboxOperationResult): ExecutionError | undefined {
  if (result.denialReason === "COMMAND_TIMEOUT") {
    return {
      code: "TIMEOUT",
      message: `Sandbox operation for node ${nodeId} timed out`,
      nodeId,
      details: { denialReason: result.denialReason },
    };
  }

  if (result.status === "DENIED" || result.status === "NEEDS_APPROVAL") {
    return {
      code: "PERMISSION_DENIED",
      message: `Sandbox operation for node ${nodeId} was ${result.status.toLowerCase()}${
        result.denialReason ? ` (${result.denialReason})` : ""
      }`,
      nodeId,
      details: { denialReason: result.denialReason, status: result.status },
    };
  }

  // status === "FAILED": leave the executor error undefined so the healing loop
  // classifies it as UNKNOWN; the redacted preview is preserved on the output.
  return undefined;
}

function validationNodeResultWithoutSandbox(
  node: DagNode,
  dependencies: string[],
  resultsByNode: Map<string, NodeExecutionResult>,
  at: string,
): NodeExecutionResult | undefined {
  if (node.type !== "VALIDATION") return undefined;

  const input = recordFrom(node.input);
  const targetNodeIds = validationTargetNodeIds(input, dependencies);
  const error = validateUpstreamOutputsForNode(node, targetNodeIds, resultsByNode);
  if (error) {
    return {
      nodeId: node.id,
      status: "FAILED",
      attempts: 1,
      startedAt: at,
      completedAt: at,
      durationMs: 0,
      output: { sandbox: false, noop: false, nodeType: node.type, validation: { passed: false, inspectedDependencies: targetNodeIds } },
      error,
      dependencies,
    };
  }

  return {
    nodeId: node.id,
    status: "SUCCESS",
    attempts: 1,
    startedAt: at,
    completedAt: at,
    durationMs: 0,
    output: { sandbox: false, noop: true, nodeType: node.type, validation: { passed: true, inspectedDependencies: targetNodeIds } },
    dependencies,
  };
}

function validateUpstreamOutputsForNode(
  node: DagNode,
  targetNodeIds: string[],
  resultsByNode: Map<string, NodeExecutionResult>,
): ExecutionError | undefined {
  if (targetNodeIds.length === 0) {
    return {
      code: "VALIDATION_FAILED",
      message: `Validation node ${node.id} has no upstream node to inspect`,
      nodeId: node.id,
      details: { targetNodeIds },
    };
  }

  const input = recordFrom(node.input);
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
    const output = recordFrom(upstream.output);
    const upstreamArtifacts = new Set([
      ...stringArrayFrom(output?.expectedOutputs),
      ...stringArrayFrom(output?.artifacts),
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

function operationMappingErrorFor(node: DagNode): ExecutionError | undefined {
  const hasHint = hasExplicitSandboxOperationHint(node);
  const defaultKind = defaultOperationKind(node);

  if (!hasHint && defaultKind === undefined) return undefined;

  return {
    code: "OPERATION_MAPPING_FAILED",
    message: `Node ${node.id} could not be mapped to an unambiguous sandbox operation`,
    nodeId: node.id,
    details: {
      nodeType: node.type,
      hasSandboxHint: hasHint,
      defaultOperationKind: defaultKind,
      expectedOutputs: node.expectedOutputs,
    },
  };
}

function operationPreview(result: SandboxOperationResult): string {
  if (result.status === "DENIED") {
    return `denied: ${result.denialReason ?? "DENIED"}`;
  }
  if (result.status === "NEEDS_APPROVAL") {
    return `needs approval: ${result.denialReason ?? "NEEDS_APPROVAL"}`;
  }
  if (result.kind === "READ_FILE") {
    return result.fileContent ?? "";
  }
  if (result.kind === "LIST_DIR") {
    return (result.entries ?? []).join("\n");
  }
  if (result.kind === "PROPOSE_PATCH") {
    return result.artifacts[0]?.unifiedDiff ?? "";
  }
  // RUN_COMMAND
  return result.stderr && result.status === "FAILED" ? result.stderr : result.stdout;
}

function operationIdFor(nodeId: string, kind: z.infer<typeof SandboxOperationKindSchema>): string {
  return `${nodeId}:${kind}`;
}

/** Redacts and truncates a preview string to the artifact preview bound. */
function normalizePreview(value: string): { preview: string; truncated: boolean } {
  const redacted = redactString(value ?? "");
  if (redacted.length <= EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH) return { preview: redacted, truncated: false };
  return { preview: redacted.slice(0, EXECUTION_ARTIFACT_PREVIEW_MAX_LENGTH), truncated: true };
}

function previewFrom(value: string): string {
  return normalizePreview(value).preview;
}

function buildResult(
  compiledDag: Dag,
  status: DagExecutionStatus,
  startedAt: string,
  completedAt: string,
  nodeResults: NodeExecutionResult[],
  events: ExecutionEvent[],
  artifacts: ExecutionArtifact[],
  error?: ExecutionError,
): SandboxDagExecutionResult {
  const execution = DagExecutionResultSchema.parse({
    dagId: compiledDag.id,
    runId: compiledDag.runId,
    status,
    startedAt,
    completedAt,
    durationMs: durationMsBetween(startedAt, completedAt),
    nodeResults,
    events,
    error,
  });
  return { ...execution, artifacts };
}

// ---------------------------------------------------------------------------
// Local helpers (mirroring executorSimulator dependency/topology handling)
// ---------------------------------------------------------------------------

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
      .filter(([, deps]) => deps.size === 0)
      .map(([nodeId]) => nodeId)
      .sort();

    if (ready.length === 0) {
      return nodes; // cyclic / unresolved; fall back to declared order.
    }

    for (const nodeId of ready) {
      const node = nodeById.get(nodeId);
      if (node) ordered.push(node);
      remaining.delete(nodeId);
      for (const deps of remaining.values()) {
        deps.delete(nodeId);
      }
    }
  }

  return ordered;
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

function durationMsBetween(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, Math.floor(duration)) : 0;
}

function safeNow(now: () => string): string {
  const value = now();
  return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasExplicitSandboxOperationHint(node: DagNode): boolean {
  const input = recordFrom(node.input);
  const metadata = recordFrom(node.metadata);
  return hasSandboxOperationFields(input) || hasSandboxOperationFields(metadata);
}

function hasSandboxOperationFields(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  if (recordFrom(value.sandboxOperation)) return true;
  if (SandboxOperationKindSchema.safeParse(value.operationKind).success) return true;
  if (SandboxOperationKindSchema.safeParse(value.kind).success) return true;
  return ["path", "command", "content", "operation"].some((field) => value[field] !== undefined);
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

function parsePatchOperation(value: unknown): "add" | "update" | "delete" {
  return value === "add" || value === "delete" ? value : "update";
}

function firstSafePath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => isSafeRelativePath(candidate));
}

function isSafeRelativePath(path: string | undefined): path is string {
  if (!path) return false;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
