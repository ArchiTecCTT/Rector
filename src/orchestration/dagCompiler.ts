import { z } from "zod";
import { DagSchema, type Dag, type DagEdge, type DagNode, type DagValidationResult, validateDag } from "../protocol/dag";
import { CrucibleDecisionSchema, type CrucibleDecision } from "./crucible";
import { PlannerOutputSchema, type PlannerOutput, type PlannerRiskLevel, type PlannerTask } from "./planner";

const COMPILER_VERSION = "0.1.0-alpha.chunk-12";
const UNSAFE_SHELL_PERMISSION = "unsafe.shell";
const DENIED_TOOL_PERMISSIONS = [UNSAFE_SHELL_PERMISSION, "shell", "shell.command"] as const;
const SAFE_FAKE_PERMISSION = "fake.local";

export const DagCompilerInputSchema = z.object({
  runId: z.string().min(1),
  crucibleDecision: CrucibleDecisionSchema,
  budgetPolicy: z.record(z.unknown()).optional(),
});
export type DagCompilerInput = z.infer<typeof DagCompilerInputSchema> & {
  now?: () => string;
};

export const CompiledDagSchema = DagSchema;
export type CompiledDag = z.infer<typeof CompiledDagSchema>;

export function compileAcceptedPlanToDag(input: DagCompilerInput): CompiledDag {
  const parsed = DagCompilerInputSchema.parse(input);
  const decision = parsed.crucibleDecision;

  if (decision.verdict !== "ACCEPTED") {
    throw new Error(`DAG compilation requires an ACCEPTED Crucible decision; received ${decision.verdict}`);
  }

  if (!decision.acceptedPlan) {
    throw new Error("DAG compilation requires acceptedPlan when Crucible verdict is ACCEPTED");
  }

  const plan = PlannerOutputSchema.parse(decision.acceptedPlan);
  const taskNodeIds = taskNodeMap(plan);
  const validationNodeIds = validationNodeMap(plan);
  const dependencyMap = dependencyTaskMap(plan);
  const orderedTasks = topologicalTasks(plan.tasks, dependencyMap);
  const nodes: DagNode[] = [];
  const edges: DagEdge[] = [];

  for (const task of orderedTasks) {
    const taskNodeId = taskNodeIds[task.id];
    const dependsOn = [...(dependencyMap.get(task.id) ?? [])].map((taskId) => taskNodeIds[taskId]);
    nodes.push(taskDagNode(task, taskNodeId, dependsOn));
    for (const dependencyNodeId of dependsOn) {
      edges.push({ from: dependencyNodeId, to: taskNodeId });
    }
  }

  for (const task of orderedTasks) {
    const taskNodeId = taskNodeIds[task.id];
    const validationNodeId = validationNodeIds[task.id];
    nodes.push(validationDagNode(task, validationNodeId, taskNodeId));
    edges.push({ from: taskNodeId, to: validationNodeId });
  }

  const createdAt = input.now?.() ?? new Date().toISOString();
  const compiledDag: CompiledDag = {
    id: `dag-${parsed.runId}`,
    runId: parsed.runId,
    version: "0.1.0",
    nodes,
    edges: uniqueEdges(edges),
    validationPolicy: {
      mode: "per-task-validation",
      requiredValidationNodeIds: Object.values(validationNodeIds),
      taskValidationCoverage: Object.fromEntries(
        plan.tasks.map((task) => [taskNodeIds[task.id], validationNodeIds[task.id]])
      ),
      planLevelChecks: plan.validation.checks,
    },
    budgetPolicy: {
      mode: "local-fake",
      maxUsd: 0,
      maxModelCalls: 0,
      maxRuntimeMs: timeoutForPlan(plan),
      approvalRequiredAboveUsd: 0,
      riskLevel: plan.riskLevel,
      approvalGateIds: plan.approvalGates.map((gate) => gate.id),
      ...(parsed.budgetPolicy ?? {}),
    },
    metadata: {
      compiler: "dagCompiler",
      compilerVersion: COMPILER_VERSION,
      crucibleVerdict: decision.verdict,
      crucibleRound: decision.round,
      plannerTaskToDagNode: taskNodeIds,
      validationNodeByPlannerTask: validationNodeIds,
      toolPolicy: safeToolPolicy(),
    },
    createdAt,
  };

  assertValidCompiledDag(compiledDag);
  return compiledDag;
}

export function assertValidCompiledDag(value: unknown): asserts value is CompiledDag {
  const result = validateCompiledDag(value);
  if (!result.valid) {
    throw new Error(`Compiled DAG validation failed: ${result.errors.join("; ")}`);
  }
}

export function validateCompiledDag(value: unknown): DagValidationResult {
  const baseResult = validateDag(value);
  const errors = [...baseResult.errors];
  const parsed = DagSchema.safeParse(value);

  if (!parsed.success) {
    return { valid: false, errors };
  }

  const dag = parsed.data;
  const validationNodes = dag.nodes.filter((node) => node.type === "VALIDATION");
  const edgeCoverage = new Map<string, Set<string>>();

  for (const edge of dag.edges) {
    if (!edgeCoverage.has(edge.from)) edgeCoverage.set(edge.from, new Set());
    edgeCoverage.get(edge.from)?.add(edge.to);
  }

  for (const node of dag.nodes) {
    validateUnsafeShellDenied(node, errors);

    if (isPlannerTaskNode(node)) {
      const hasValidationCoverage = validationNodes.some(
        (validationNode) =>
          validationNode.dependsOn.includes(node.id) || edgeCoverage.get(node.id)?.has(validationNode.id)
      );

      if (!hasValidationCoverage) {
        errors.push(`Task node ${node.id} lacks validation coverage`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function taskNodeMap(plan: PlannerOutput): Record<string, string> {
  return Object.fromEntries(plan.tasks.map((task) => [task.id, `task:${task.id}`]));
}

function validationNodeMap(plan: PlannerOutput): Record<string, string> {
  return Object.fromEntries(plan.tasks.map((task) => [task.id, `validate:${task.id}`]));
}

function dependencyTaskMap(plan: PlannerOutput): Map<string, Set<string>> {
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const dependencies = new Map<string, Set<string>>();

  for (const task of plan.tasks) {
    dependencies.set(task.id, new Set(task.dependencies));
  }

  for (const dependency of plan.dependencies) {
    if (!dependencies.has(dependency.to)) dependencies.set(dependency.to, new Set());
    dependencies.get(dependency.to)?.add(dependency.from);
  }

  for (const [taskId, dependencyIds] of dependencies.entries()) {
    for (const dependencyId of dependencyIds) {
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Planner task ${taskId} references missing dependency: ${dependencyId}`);
      }
    }
  }

  return dependencies;
}

function topologicalTasks(tasks: PlannerTask[], dependencies: Map<string, Set<string>>): PlannerTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remaining = new Map<string, Set<string>>(
    tasks.map((task) => [task.id, new Set(dependencies.get(task.id) ?? [])])
  );
  const ordered: PlannerTask[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencyIds]) => dependencyIds.size === 0)
      .map(([taskId]) => taskId)
      .sort();

    if (ready.length === 0) {
      throw new Error("Planner task dependency cycle detected during DAG compilation");
    }

    for (const taskId of ready) {
      const task = byId.get(taskId);
      if (task) ordered.push(task);
      remaining.delete(taskId);
      for (const dependencyIds of remaining.values()) {
        dependencyIds.delete(taskId);
      }
    }
  }

  return ordered;
}

function taskDagNode(task: PlannerTask, id: string, dependsOn: string[]): DagNode {
  const type = nodeTypeForTask(task);
  return {
    id,
    type,
    label: task.title,
    dependsOn,
    toolPermissions: toolPermissionsFor(type),
    input: {
      plannerTaskId: task.id,
      title: task.title,
      description: task.description,
      expectedArtifacts: task.expectedArtifacts,
      approvalRequired: task.approvalRequired,
      risk: task.risk,
    },
    expectedOutputs: task.expectedArtifacts,
    retryPolicy: retryPolicyFor(task.risk),
    timeoutMs: timeoutForRisk(task.risk),
    metadata: {
      kind: "planner-task",
      plannerTaskId: task.id,
      risk: task.risk,
      approvalRequired: task.approvalRequired,
      toolPolicy: safeToolPolicy(),
    },
  };
}

function validationDagNode(task: PlannerTask, id: string, taskNodeId: string): DagNode {
  return {
    id,
    type: "VALIDATION",
    label: `Validate ${task.title}`,
    dependsOn: [taskNodeId],
    toolPermissions: [SAFE_FAKE_PERMISSION, "local.validation"],
    input: {
      plannerTaskId: task.id,
      targetNodeId: taskNodeId,
      checks: task.validation,
      expectedArtifacts: task.expectedArtifacts,
    },
    expectedOutputs: [`Validation result for ${task.id}`],
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    timeoutMs: 15_000,
    metadata: {
      kind: "task-validation",
      plannerTaskId: task.id,
      targetNodeId: taskNodeId,
      toolPolicy: safeToolPolicy(),
    },
  };
}

function nodeTypeForTask(task: PlannerTask): DagNode["type"] {
  const text = `${task.id} ${task.title} ${task.description}`.toLowerCase();
  if (text.includes("edit") || text.includes("file") || text.includes("code change")) {
    return "FILE_OPERATION";
  }
  return "LLM_EXECUTION";
}

function toolPermissionsFor(type: DagNode["type"]): string[] {
  switch (type) {
    case "FILE_OPERATION":
      return [SAFE_FAKE_PERMISSION, "local.file.proposed-write"];
    case "VALIDATION":
      return [SAFE_FAKE_PERMISSION, "local.validation"];
    default:
      return [SAFE_FAKE_PERMISSION];
  }
}

function retryPolicyFor(risk: PlannerRiskLevel): DagNode["retryPolicy"] {
  if (risk === "high" || risk === "destructive") {
    return { maxAttempts: 1, backoffMs: 0 };
  }
  if (risk === "medium") {
    return { maxAttempts: 2, backoffMs: 100, maxBackoffMs: 500 };
  }
  return { maxAttempts: 2, backoffMs: 50, maxBackoffMs: 250 };
}

function timeoutForRisk(risk: PlannerRiskLevel): number {
  switch (risk) {
    case "destructive":
    case "high":
      return 120_000;
    case "medium":
      return 60_000;
    case "low":
      return 30_000;
  }
}

function timeoutForPlan(plan: PlannerOutput): number {
  const taskTimeouts = plan.tasks.reduce((sum, task) => sum + timeoutForRisk(task.risk) + 15_000, 0);
  return Math.max(1_000, taskTimeouts);
}

function safeToolPolicy(): Record<string, unknown> {
  return {
    default: "deny",
    allowed: [SAFE_FAKE_PERMISSION, "local.file.proposed-write", "local.validation"],
    denied: [...DENIED_TOOL_PERMISSIONS],
    allowUnsafeShell: false,
  };
}

function uniqueEdges(edges: DagEdge[]): DagEdge[] {
  const seen = new Set<string>();
  const unique: DagEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}

function validateUnsafeShellDenied(node: DagNode, errors: string[]): void {
  const permissions = node.toolPermissions.map((permission) => permission.toLowerCase());
  const toolPolicy = recordFrom(node.metadata?.toolPolicy);
  const denied = Array.isArray(toolPolicy?.denied)
    ? toolPolicy.denied.map((permission) => String(permission).toLowerCase())
    : [];
  const allowUnsafeShell = toolPolicy?.allowUnsafeShell === true;

  if (node.type === "SHELL_COMMAND" || permissions.some((permission) => permission.includes("shell")) || allowUnsafeShell) {
    errors.push(`Node ${node.id} unsafe shell permission is denied by default`);
  }

  if (!denied.includes(UNSAFE_SHELL_PERMISSION)) {
    errors.push(`Node ${node.id} must explicitly deny unsafe shell permission by default`);
  }
}

function isPlannerTaskNode(node: DagNode): boolean {
  return recordFrom(node.metadata)?.kind === "planner-task";
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
