import type { PlannerInput, PlannerOutput, LivePlannerResult, PlannerRiskLevel } from "./planner";
import { createFakePlan, validatePlannerOutput } from "./planner";
import type { LLMProvider, LLMUsage } from "../providers/llm";
import type { Run } from "../store";
import { DEFAULT_PREPROCESSOR_RULES } from "../symbolic/defaultRules";
import { getSymbolicEngine } from "../symbolic";
import { redactString } from "../security/redaction";

export const DEEP_PLANNER_MAX_CANDIDATES = 4;
const DEFAULT_MAX_ESTIMATED_RUNTIME_MS = 120_000;

export type DeepPlannerCandidateSource =
  | "base-live"
  | "risk-minimized"
  | "test-first"
  | "user-speed"
  | "fallback-local";

export interface DeepPlannerScoreBreakdown {
  validationCoverage: number;
  dependencySimplicity: number;
  approvalBurden: number;
  risk: number;
  symbolicSafety: number;
  estimatedCostRuntime: number;
  sourceDiversity: number;
}

export interface DeepPlannerCandidateTrace {
  id: string;
  source: DeepPlannerCandidateSource;
  goal: string;
  score: number;
  selected: boolean;
  rejected: boolean;
  rejectionReasons: string[];
  scores: DeepPlannerScoreBreakdown;
  estimatedCostUsd: number;
  estimatedRuntimeMs: number;
  symbolicViolations: string[];
}

export interface MultiCandidatePlannerConfig {
  maxCandidates?: number;
  maxEstimatedRuntimeMs?: number;
}

export interface MultiCandidatePlannerResult {
  selectedPlan: PlannerOutput;
  selectedSource: DeepPlannerCandidateSource;
  traces: DeepPlannerCandidateTrace[];
}

interface DeepPlanCandidate {
  id: string;
  source: DeepPlannerCandidateSource;
  plan: PlannerOutput;
  order: number;
}

interface ScoredCandidate extends DeepPlanCandidate {
  trace: DeepPlannerCandidateTrace;
}

/**
 * Opt-in bounded multi-candidate planner (Chunk 042c).
 *
 * Local/provider-free behavior is preserved by the `deepPlanning=false` branch:
 * it returns the deterministic fake plan and performs zero provider calls. When
 * enabled, the live planner is invoked once, deterministic variants are scored,
 * unsafe candidates are symbolically rejected, and the best surviving candidate
 * is selected with a traceable score/rejection summary.
 */
export async function runDeepPlanner(
  input: PlannerInput & { deepPlanning?: boolean },
  deps: { provider: LLMProvider; run: Run; model?: string; abortSignal?: AbortSignal }
): Promise<LivePlannerResult> {
  const { createFakePlan, runLivePlanner } = await import("./planner");

  if (!input.deepPlanning) {
    const fallback = createFakePlan(input);
    return {
      status: "ok",
      plan: fallback,
      usage: zeroUsage(),
      provider: deps.provider.metadata.id,
      model: deps.model ?? deps.provider.metadata.models.flagship,
      attempts: 0,
    };
  }

  const base = await runLivePlanner(input, deps);
  if (base.status === "blocked" || !base.plan) {
    if (base.blocker?.code === "BUDGET_DENIED") {
      return base;
    }

    const fallback = createFakePlan(input);
    const trace = fallbackTrace(fallback, base.blocker?.message ?? "Live planner unavailable");
    return {
      status: "ok",
      plan: fallback,
      usage: base.usage,
      provider: base.provider,
      model: base.model,
      attempts: base.attempts,
      pathsExplored: trace.map(formatTraceLine),
      deepPlanningTrace: trace,
    };
  }

  const planner = createMultiCandidatePlanner({
    maxEstimatedRuntimeMs: Math.min(
      positiveNumber(deps.run.budget.maxRuntimeMs, DEFAULT_MAX_ESTIMATED_RUNTIME_MS),
      DEFAULT_MAX_ESTIMATED_RUNTIME_MS,
    ),
  });
  const result = planner.plan(input, base.plan);

  return {
    status: "ok",
    plan: result.selectedPlan,
    usage: base.usage,
    provider: base.provider,
    model: base.model,
    attempts: base.attempts,
    pathsExplored: result.traces.map(formatTraceLine),
    deepPlanningTrace: result.traces,
  };
}

export function createMultiCandidatePlanner(config: MultiCandidatePlannerConfig = {}): {
  plan(input: PlannerInput, basePlan: PlannerOutput): MultiCandidatePlannerResult;
} {
  return {
    plan(input: PlannerInput, basePlan: PlannerOutput): MultiCandidatePlannerResult {
      const candidates = generateCandidates(input, basePlan).slice(0, config.maxCandidates ?? DEEP_PLANNER_MAX_CANDIDATES);
      const scored = candidates.map((candidate) => scoreCandidate(candidate, config));
      const selected = selectBestCandidate(scored, input, basePlan);
      const traces = scored.map((candidate) => ({
        ...candidate.trace,
        selected: candidate.id === selected.id,
      }));
      if (!traces.some((trace) => trace.selected)) {
        traces.push({ ...selected.trace, selected: true });
      }

      return {
        selectedPlan: selected.plan,
        selectedSource: selected.source,
        traces,
      };
    },
  };
}

export function scoreDeepPlanCandidate(
  candidate: { source: DeepPlannerCandidateSource; plan: PlannerOutput },
  config: MultiCandidatePlannerConfig = {},
): DeepPlannerCandidateTrace {
  return scoreCandidate(
    { id: candidate.source, source: candidate.source, plan: candidate.plan, order: 0 },
    config,
  ).trace;
}

function generateCandidates(input: PlannerInput, basePlan: PlannerOutput): DeepPlanCandidate[] {
  const raw: Array<Omit<DeepPlanCandidate, "id" | "order">> = [
    { source: "base-live", plan: basePlan },
    { source: "risk-minimized", plan: createRiskMinimizedVariant(basePlan) },
    { source: "test-first", plan: createTestFirstVariant(basePlan) },
  ];

  if (isSafeForSpeedVariant(basePlan)) {
    raw.push({ source: "user-speed", plan: createUserSpeedVariant(basePlan) });
  }

  // Preserve deterministic source order while removing exact duplicate variants.
  const seen = new Set<string>();
  const candidates: DeepPlanCandidate[] = [];
  for (const item of raw) {
    const stableKey = stablePlanKey(item.plan);
    if (seen.has(stableKey)) continue;
    seen.add(stableKey);
    candidates.push({ ...item, id: `${item.source}-${candidates.length + 1}`, order: candidates.length });
  }

  if (candidates.length === 0) {
    candidates.push({ id: "base-live-1", source: "base-live", plan: basePlan, order: 0 });
  }

  return candidates;
}

function createRiskMinimizedVariant(plan: PlannerOutput): PlannerOutput {
  const tasks = plan.tasks.map((task) => {
    const riskRequiresApproval = task.risk === "high" || task.risk === "destructive";
    return {
      ...task,
      title: sanitizeUnsafeWritePathMentions(task.title),
      description: sanitizeUnsafeWritePathMentions(task.description),
      approvalRequired: task.approvalRequired || riskRequiresApproval,
      validation: uniqueStrings([
        ...task.validation,
        "Risk boundaries are checked before execution",
        "Unsafe write paths are avoided or explicitly escalated",
      ]),
    };
  });

  return validatePlannerOutput({
    ...plan,
    goal: `${plan.goal} (risk-minimized)`,
    assumptions: uniqueStrings([
      ...plan.assumptions,
      "Risk-minimized candidate keeps work source-scoped and escalation-friendly.",
    ]),
    tasks,
    approvalGates: ensureApprovalGates(plan.approvalGates, tasks),
    validation: {
      summary: `${plan.validation.summary}; risk-minimized candidate validates safety boundaries`,
      checks: uniqueStrings([
        ...plan.validation.checks,
        "Confirm unsafe write paths were not selected",
        "Confirm approval gates cover high-risk tasks",
      ]),
    },
  });
}

function createTestFirstVariant(plan: PlannerOutput): PlannerOutput {
  return validatePlannerOutput({
    ...plan,
    goal: `${plan.goal} (test-first)`,
    assumptions: uniqueStrings([
      ...plan.assumptions,
      "Test-first candidate identifies validation before completing implementation work.",
    ]),
    tasks: plan.tasks.map((task) => ({
      ...task,
      validation: uniqueStrings([
        "Relevant tests or checks are identified before the task is considered complete",
        ...task.validation,
      ]),
    })),
    validation: {
      summary: `${plan.validation.summary}; test-first candidate increases validation coverage`,
      checks: uniqueStrings([
        "Relevant tests are identified before changes are finalized",
        ...plan.validation.checks,
      ]),
    },
  });
}

function createUserSpeedVariant(plan: PlannerOutput): PlannerOutput {
  return validatePlannerOutput({
    ...plan,
    goal: `${plan.goal} (speed path)`,
    assumptions: uniqueStrings([
      ...plan.assumptions,
      "Speed candidate is only generated for low-risk, no-approval plans.",
    ]),
    validation: {
      summary: `${plan.validation.summary}; speed candidate keeps the shortest safe path`,
      checks: plan.validation.checks.slice(0, Math.max(1, Math.min(2, plan.validation.checks.length))),
    },
  });
}

function ensureApprovalGates(
  gates: PlannerOutput["approvalGates"],
  tasks: PlannerOutput["tasks"],
): PlannerOutput["approvalGates"] {
  const requiredTaskIds = tasks
    .filter((task) => task.approvalRequired || task.risk === "high" || task.risk === "destructive")
    .map((task) => task.id);
  if (requiredTaskIds.length === 0) return gates;

  const covered = new Set(gates.filter((gate) => gate.required).flatMap((gate) => gate.taskIds));
  const missing = requiredTaskIds.filter((taskId) => !covered.has(taskId));
  if (missing.length === 0) return gates;

  return [
    ...gates,
    {
      id: "gate.deep-planner-risk-minimized",
      type: "approval" as const,
      reason: "Risk-minimized deep planner candidate requires approval for high-risk tasks.",
      required: true,
      taskIds: missing,
    },
  ];
}

function isSafeForSpeedVariant(plan: PlannerOutput): boolean {
  return (
    plan.riskLevel === "low" &&
    plan.approvalGates.every((gate) => !gate.required) &&
    plan.tasks.every((task) => !task.approvalRequired && task.risk === "low")
  );
}

function scoreCandidate(candidate: DeepPlanCandidate, config: MultiCandidatePlannerConfig): ScoredCandidate {
  const symbolicViolations = findSymbolicViolations(candidate.plan);
  const estimatedRuntimeMs = estimateRuntimeMs(candidate.plan);
  const estimatedCostUsd = estimateCostUsd(candidate.plan);
  const rejectionReasons: string[] = [];
  const maxRuntimeMs = config.maxEstimatedRuntimeMs ?? DEFAULT_MAX_ESTIMATED_RUNTIME_MS;

  if (symbolicViolations.length > 0) {
    rejectionReasons.push(`symbolic rule violations: ${symbolicViolations.join(", ")}`);
  }
  if (estimatedRuntimeMs > maxRuntimeMs) {
    rejectionReasons.push(`estimated runtime ${estimatedRuntimeMs}ms exceeds cap ${maxRuntimeMs}ms`);
  }

  const scores: DeepPlannerScoreBreakdown = {
    validationCoverage: validationCoverageScore(candidate.plan),
    dependencySimplicity: dependencySimplicityScore(candidate.plan),
    approvalBurden: approvalBurdenScore(candidate.plan),
    risk: riskScore(candidate.plan.riskLevel),
    symbolicSafety: Math.max(0, 20 - symbolicViolations.length * 20),
    estimatedCostRuntime: estimatedCostRuntimeScore(estimatedCostUsd, estimatedRuntimeMs),
    sourceDiversity: sourceDiversityScore(candidate.source),
  };

  const rawScore = Object.values(scores).reduce((sum, value) => sum + value, 0);
  const rejected = rejectionReasons.length > 0;
  const score = rejected ? rawScore - 1_000 : rawScore;

  return {
    ...candidate,
    trace: {
      id: candidate.id,
      source: candidate.source,
      goal: redactString(candidate.plan.goal),
      score: roundScore(score),
      selected: false,
      rejected,
      rejectionReasons: rejectionReasons.map(redactString),
      scores,
      estimatedCostUsd,
      estimatedRuntimeMs,
      symbolicViolations: symbolicViolations.map(redactString),
    },
  };
}

function selectBestCandidate(scored: ScoredCandidate[], input: PlannerInput, _basePlan: PlannerOutput): ScoredCandidate {
  const eligible = scored.filter((candidate) => !candidate.trace.rejected);
  if (eligible.length === 0) {
    const fallbackPlan = createFakePlan(input);
    const fallbackTrace = scoreDeepPlanCandidate({ source: "fallback-local", plan: fallbackPlan });
    return {
      id: "fallback-local-1",
      source: "fallback-local",
      plan: fallbackPlan,
      order: scored.length,
      trace: {
        ...fallbackTrace,
        id: "fallback-local-1",
        rejected: false,
        selected: true,
        rejectionReasons: ["all live deep-planner candidates were rejected; selected deterministic local fallback"],
      },
    };
  }

  return [...eligible].sort((left, right) => {
    if (right.trace.score !== left.trace.score) return right.trace.score - left.trace.score;
    const sourceDelta = sourcePriority(left.source) - sourcePriority(right.source);
    if (sourceDelta !== 0) return sourceDelta;
    return left.order - right.order;
  })[0];
}

function validationCoverageScore(plan: PlannerOutput): number {
  const taskChecks = plan.tasks.reduce((sum, task) => sum + task.validation.length, 0);
  const planChecks = plan.validation.checks.length;
  const perTaskCoverage = plan.tasks.length === 0 ? 8 : Math.min(18, Math.round((taskChecks / plan.tasks.length) * 4));
  return Math.min(28, perTaskCoverage + Math.min(10, planChecks * 2));
}

function dependencySimplicityScore(plan: PlannerOutput): number {
  const dependencyRefs = plan.tasks.reduce((sum, task) => sum + task.dependencies.length, 0) + plan.dependencies.length;
  return Math.max(0, 22 - dependencyRefs * 3 - Math.max(0, plan.tasks.length - 4));
}

function approvalBurdenScore(plan: PlannerOutput): number {
  const requiredGates = plan.approvalGates.filter((gate) => gate.required).length;
  const approvalTasks = plan.tasks.filter((task) => task.approvalRequired).length;
  return Math.max(0, 18 - requiredGates * 5 - approvalTasks * 3);
}

function riskScore(risk: PlannerRiskLevel): number {
  switch (risk) {
    case "low":
      return 22;
    case "medium":
      return 14;
    case "high":
      return 4;
    case "destructive":
      return -18;
  }
}

function estimatedCostRuntimeScore(estimatedCostUsd: number, estimatedRuntimeMs: number): number {
  const runtimePenalty = Math.ceil(estimatedRuntimeMs / 30_000);
  const costPenalty = Math.ceil(estimatedCostUsd * 100);
  return Math.max(0, 12 - runtimePenalty - costPenalty);
}

function sourceDiversityScore(source: DeepPlannerCandidateSource): number {
  switch (source) {
    case "test-first":
      return 4;
    case "risk-minimized":
      return 3;
    case "base-live":
      return 2;
    case "user-speed":
      return 1;
    case "fallback-local":
      return 0;
  }
}

function sourcePriority(source: DeepPlannerCandidateSource): number {
  switch (source) {
    case "test-first":
      return 0;
    case "risk-minimized":
      return 1;
    case "base-live":
      return 2;
    case "user-speed":
      return 3;
    case "fallback-local":
      return 4;
  }
}

function estimateRuntimeMs(plan: PlannerOutput): number {
  const taskRuntime = plan.tasks.reduce((sum, task) => {
    const riskMultiplier = task.risk === "high" || task.risk === "destructive" ? 2 : task.risk === "medium" ? 1.5 : 1;
    return sum + Math.round(12_000 * riskMultiplier);
  }, 0);
  return taskRuntime + plan.dependencies.length * 2_000 + plan.approvalGates.filter((gate) => gate.required).length * 5_000;
}

function estimateCostUsd(plan: PlannerOutput): number {
  // Candidate generation after the base live plan is deterministic and makes no additional model calls;
  // this lightweight estimate is a complexity penalty used only for ranking.
  const riskPenalty = plan.riskLevel === "high" || plan.riskLevel === "destructive" ? 0.02 : plan.riskLevel === "medium" ? 0.01 : 0;
  return Number((plan.tasks.length * 0.002 + riskPenalty).toFixed(4));
}

function findSymbolicViolations(plan: PlannerOutput): string[] {
  const engine = getSymbolicEngine();
  const violations: string[] = [];
  for (const task of plan.tasks) {
    const text = `${task.title} ${task.description}`;
    for (const path of extractWritePaths(text)) {
      const evaluation = engine.evaluate(DEFAULT_PREPROCESSOR_RULES, {
        tool: "write_file",
        args: { path },
      });
      if (evaluation.blocked) {
        const ruleIds = evaluation.matched.map((rule) => rule.id).join(",");
        violations.push(`${path}: ${ruleIds || "blocked"}`);
      }
    }
  }
  return uniqueStrings(violations);
}

function extractWritePaths(text: string): string[] {
  const matches = text.match(/\b(?:write|edit|patch|update)\s+(?:to\s+)?((?:src\/|\.\/)?[\w./-]+\.\w+)\b/gi) ?? [];
  return uniqueStrings(
    matches
      .map((match) => match.replace(/^(?:write|edit|patch|update)\s+(?:to\s+)?/i, ""))
      .filter(Boolean),
  );
}

function sanitizeUnsafeWritePathMentions(text: string): string {
  return text.replace(
    /\b(write|edit|patch|update)\s+(?:to\s+)?((?:src\/|\.\/)?[\w./-]+\.\w+)\b/gi,
    (_match, verb: string, path: string) => {
      const normalized = String(path).replace(/^\.\//, "");
      return normalized.startsWith("src/") ? `${verb} ${normalized}` : `${verb} safe source-scoped files`;
    },
  );
}

function fallbackTrace(plan: PlannerOutput, reason: string): DeepPlannerCandidateTrace[] {
  const trace = scoreDeepPlanCandidate({ source: "fallback-local", plan });
  return [
    {
      ...trace,
      selected: true,
      rejectionReasons: [`live planner fallback: ${redactString(reason)}`],
    },
  ];
}

function formatTraceLine(trace: DeepPlannerCandidateTrace): string {
  const status = trace.selected ? "selected" : trace.rejected ? "rejected" : "accepted";
  const reason = trace.rejectionReasons.length > 0 ? ` reason=${trace.rejectionReasons.join("; ")}` : "";
  const goal = redactString(trace.goal).replace(/\s+/g, " ").slice(0, 180);
  return `${trace.source} score=${trace.score.toFixed(1)} ${status}${reason} goal=${goal}`;
}

function stablePlanKey(plan: PlannerOutput): string {
  return JSON.stringify({
    goal: plan.goal,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      dependencies: task.dependencies,
      validation: task.validation,
      risk: task.risk,
      approvalRequired: task.approvalRequired,
    })),
    dependencies: plan.dependencies,
    validation: plan.validation,
    riskLevel: plan.riskLevel,
    approvalGates: plan.approvalGates,
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function zeroUsage(): LLMUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    modelCalls: 0,
  };
}
