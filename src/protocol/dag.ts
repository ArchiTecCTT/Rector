import { z } from "zod";

export const DAG_NODE_TYPES = [
  "LLM_EXECUTION",
  "VALIDATION",
  "FILE_OPERATION",
  "SHELL_COMMAND",
  "MERGE",
  "CONDITIONAL",
] as const;

export const DagNodeTypeSchema = z.enum(DAG_NODE_TYPES);
export type DagNodeType = z.infer<typeof DagNodeTypeSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1, { message: "retryPolicy.maxAttempts must be a positive integer" }),
  backoffMs: z.number().int().min(0, { message: "retryPolicy.backoffMs must be a non-negative integer" }).default(0),
  maxBackoffMs: z.number().int().min(0, { message: "retryPolicy.maxBackoffMs must be a non-negative integer" }).optional(),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const DagEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type DagEdge = z.infer<typeof DagEdgeSchema>;

export const DagNodeSchema = z.object({
  id: z.string().min(1),
  type: DagNodeTypeSchema,
  label: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).default([]),
  provider: z.string().min(1).optional(),
  toolPermissions: z.array(z.string().min(1)).default([]),
  input: z.record(z.unknown()).optional(),
  expectedOutputs: z.array(z.string().min(1)).default([]),
  retryPolicy: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().positive({ message: "timeoutMs must be a positive integer" }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type DagNode = z.infer<typeof DagNodeSchema>;

export const DagSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  version: z.string().min(1),
  nodes: z.array(DagNodeSchema),
  edges: z.array(DagEdgeSchema).default([]),
  validationPolicy: z.record(z.unknown()).optional(),
  budgetPolicy: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export type Dag = z.infer<typeof DagSchema>;

export type DagValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateDag(value: unknown): DagValidationResult {
  const parsed = DagSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      }),
    };
  }

  const dag = parsed.data;
  const errors: string[] = [];
  const nodeIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const node of dag.nodes) {
    if (nodeIds.has(node.id)) {
      duplicateIds.add(node.id);
    }
    nodeIds.add(node.id);
    validateNodeRuntimePolicy(node, errors);
  }

  for (const duplicateId of duplicateIds) {
    errors.push(`Duplicate node id: ${duplicateId}`);
  }

  const dependenciesByNode = new Map<string, Set<string>>();
  for (const node of dag.nodes) {
    dependenciesByNode.set(node.id, new Set(node.dependsOn));
  }

  for (const edge of dag.edges) {
    if (edge.from === edge.to) {
      errors.push(`Edge cannot be a self-loop: ${edge.from} -> ${edge.to}`);
      continue;
    }

    if (!nodeIds.has(edge.from)) {
      errors.push(`Edge references missing dependency: ${edge.from}`);
      continue;
    }

    if (!nodeIds.has(edge.to)) {
      errors.push(`Edge references missing node: ${edge.to}`);
      continue;
    }

    dependenciesByNode.get(edge.to)?.add(edge.from);
  }

  for (const [nodeId, dependencies] of dependenciesByNode.entries()) {
    for (const dependencyId of dependencies) {
      if (!nodeIds.has(dependencyId)) {
        errors.push(`Node ${nodeId} has missing dependency: ${dependencyId}`);
      }
    }
  }

  if (hasCycle(dependenciesByNode)) {
    errors.push("Cycle detected in DAG dependencies");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateNodeRuntimePolicy(node: DagNode, errors: string[]): void {
  if (node.timeoutMs !== undefined && node.timeoutMs <= 0) {
    errors.push(`Node ${node.id} timeoutMs must be a positive integer`);
  }

  const retryPolicy = node.retryPolicy;
  if (!retryPolicy) {
    return;
  }

  if (retryPolicy.maxAttempts <= 0) {
    errors.push(`Node ${node.id} retryPolicy.maxAttempts must be a positive integer`);
  }

  if (retryPolicy.backoffMs < 0) {
    errors.push(`Node ${node.id} retryPolicy.backoffMs must be a non-negative integer`);
  }

  if (retryPolicy.maxBackoffMs !== undefined && retryPolicy.maxBackoffMs < 0) {
    errors.push(`Node ${node.id} retryPolicy.maxBackoffMs must be a non-negative integer`);
  }

  if (
    retryPolicy.maxBackoffMs !== undefined &&
    retryPolicy.maxBackoffMs < retryPolicy.backoffMs
  ) {
    errors.push(`Node ${node.id} retryPolicy.maxBackoffMs must be greater than or equal to backoffMs`);
  }
}

function hasCycle(dependenciesByNode: Map<string, Set<string>>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string): boolean => {
    if (visited.has(nodeId)) {
      return false;
    }

    if (visiting.has(nodeId)) {
      return true;
    }

    visiting.add(nodeId);

    for (const dependencyId of dependenciesByNode.get(nodeId) ?? []) {
      if (!dependenciesByNode.has(dependencyId)) {
        continue;
      }

      if (visit(dependencyId)) {
        return true;
      }
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const nodeId of dependenciesByNode.keys()) {
    if (visit(nodeId)) {
      return true;
    }
  }

  return false;
}
