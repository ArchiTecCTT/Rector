import { z } from "zod";

import type { ContextPack } from "./contextBuilder";
import type { CompiledDag } from "./dagCompiler";
import { executeDagThroughSandbox } from "./sandboxExecutor";
import { redactString } from "../security/redaction";
import type { WorkspaceSandboxAdapter } from "../sandbox";
import type { Run } from "../store/schemas";
import {
  invokeWithBudget,
  LLMUsageSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMUsage,
} from "../providers/llm";
import { enforceMaxPerRunBudget, evaluateBudget } from "../security/budget";

const DEFAULT_MAX_SUB_GOALS = 4;
const DEFAULT_MAX_CONCURRENCY = 2;
const LIVE_DECOMPOSER_MAX_ATTEMPTS = 2;

export const SubGoalDependencySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type SubGoalDependency = z.infer<typeof SubGoalDependencySchema>;

export const SubGoalSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  dependencies: z.array(z.string().min(1)).default([]),
  expectedArtifacts: z.array(z.string().min(1)).default([]),
  validation: z.array(z.string().min(1)).default([]),
  parallelizable: z.boolean().default(true),
});
export type SubGoal = z.infer<typeof SubGoalSchema>;

export const SubGoalGraphSchema = z.object({
  subGoals: z.array(SubGoalSchema).max(12),
  dependencies: z.array(SubGoalDependencySchema).default([]),
  maxConcurrency: z.number().int().positive().max(8).default(DEFAULT_MAX_CONCURRENCY),
  trace: z.array(z.string()).default([]),
});
export type SubGoalGraph = z.infer<typeof SubGoalGraphSchema>;

export interface DecompositionOptions {
  maxSubGoals?: number;
  maxConcurrency?: number;
}

/**
 * Task Decomposition + dependency-aware stitching (Chunk 042c).
 * Deterministic by default: parse explicit bullets/numbered lists first, fall
 * back to sentence splitting, infer simple dependencies, and cap work by config.
 */
export function decomposeIntoTasks(
  distilled: string,
  context: ContextPack,
  options: DecompositionOptions = {},
): { subGoals: string[]; subGoalGraph: SubGoalGraph; suggestedDag: Partial<CompiledDag> } {
  const subGoalGraph = decomposeIntoSubGoalGraph(distilled, context, options);
  return {
    subGoals: subGoalGraph.subGoals.map((goal) => goal.goal),
    subGoalGraph,
    suggestedDag: graphToSuggestedDag(subGoalGraph),
  };
}

export function decomposeIntoSubGoalGraph(
  distilled: string,
  context: ContextPack,
  options: DecompositionOptions = {},
): SubGoalGraph {
  const maxSubGoals = boundedMaxSubGoals(context, options.maxSubGoals);
  const parsed = parseCandidateSubGoals(distilled);
  const parsedItems = withSource(parsed.slice(0, maxSubGoals), parsed.source);
  const trace: string[] = [];
  if (parsedItems.source === "bullets") trace.push("parsed explicit bullet/numbered list");
  if (parsedItems.source === "sentences") trace.push("parsed sentence boundaries");
  trace.push(`capped sub-goals at ${maxSubGoals}`);

  const subGoals = parsedItems.map((goal, index) => {
    const dependencies = inferDependencies(goal, index, parsedItems);
    return SubGoalSchema.parse({
      id: `sub-${index}`,
      goal: redactString(goal),
      dependencies,
      expectedArtifacts: expectedArtifactsFor(goal),
      validation: validationFor(goal),
      parallelizable: dependencies.length === 0,
    });
  });

  const dependencies = subGoals.flatMap((goal) =>
    goal.dependencies.map((dependencyId) => ({
      from: dependencyId,
      to: goal.id,
      reason: "inferred sequential dependency",
    })),
  );

  return normalizeSubGoalGraph({
    subGoals,
    dependencies,
    maxConcurrency: boundedConcurrency(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    trace,
  });
}

export interface LiveTaskDecomposerInput {
  distilled: string;
  context: ContextPack;
  maxSubGoals?: number;
  maxConcurrency?: number;
}

export interface LiveTaskDecomposerResult {
  status: "ok" | "fallback";
  subGoalGraph: SubGoalGraph;
  usage: LLMUsage;
  provider: string;
  model: string;
  attempts: number;
  errors: string[];
}

export async function runLiveTaskDecomposer(
  input: LiveTaskDecomposerInput,
  deps: { provider: LLMProvider; run: Run },
): Promise<LiveTaskDecomposerResult> {
  const fallback = decomposeIntoSubGoalGraph(input.distilled, input.context, input);
  const model = deps.provider.metadata.models.fast ?? deps.provider.metadata.models.cheap ?? deps.provider.metadata.id;
  let totalUsage = zeroUsage();
  let messages = buildLiveDecomposerPrompt(input);
  const errors: string[] = [];

  for (let attempt = 1; attempt <= LIVE_DECOMPOSER_MAX_ATTEMPTS; attempt += 1) {
    const request: LLMRequest = {
      messages,
      modelRoute: "fast",
      task: "task-decomposer",
      responseFormat: { type: "json_object" },
      maxOutputTokens: 1600,
      temperature: 0,
    };
    const estimate = deps.provider.estimateRequest(request);
    const decision = evaluateBudget(deps.run, {
      provider: deps.provider.metadata.id,
      estimatedUsd: totalUsage.estimatedUsd + estimate.estimatedUsd,
      inputTokens: totalUsage.inputTokens + estimate.inputTokens,
      outputTokens: totalUsage.outputTokens + estimate.outputTokens,
      modelCalls: totalUsage.modelCalls + estimate.modelCalls,
    });
    const ceiling = enforceMaxPerRunBudget(deps.run, totalUsage, estimate);
    if (decision.status !== "allowed" || ceiling.status !== "allowed") {
      errors.push("budget denied live task decomposition");
      return liveFallback(fallback, totalUsage, deps.provider, model, attempt - 1, errors);
    }

    try {
      const response = await invokeWithBudget(deps.provider, request, deps.run);
      totalUsage = addUsage(totalUsage, response.usage);
      const parsed = parseLiveGraph(response.content, input);
      if (parsed.ok) {
        return {
          status: "ok",
          subGoalGraph: parsed.graph,
          usage: totalUsage,
          provider: deps.provider.metadata.id,
          model: response.model,
          attempts: attempt,
          errors,
        };
      }
      errors.push(parsed.error);
      messages = buildLiveRepairPrompt(input, response.content, parsed.error);
    } catch (error) {
      errors.push(redactString(error instanceof Error ? error.message : String(error)));
      return liveFallback(fallback, totalUsage, deps.provider, model, attempt, errors);
    }
  }

  return liveFallback(fallback, totalUsage, deps.provider, model, LIVE_DECOMPOSER_MAX_ATTEMPTS, errors);
}

export interface DecomposedSubGoalResult {
  subGoal: string;
  artifact?: string;
  command?: string;
  summary: string;
  status: string;
}

export interface ExecuteDecomposedSubGoalsDeps {
  sandbox: WorkspaceSandboxAdapter;
  run: Run;
  now?: () => string;
  maxConcurrency?: number;
  executeSubGoal?: (subGoal: SubGoal, index: number, graph: SubGoalGraph) => Promise<DecomposedSubGoalResult>;
}

/**
 * Executes sub-goals with bounded concurrency. Independent sub-goals can run in
 * parallel up to the configured cap; dependent goals wait for prerequisites.
 * Partial failures are returned explicitly and do not hide successful siblings.
 */
export async function executeDecomposedSubGoals(
  subGoalsOrGraph: string[] | SubGoalGraph,
  deps: ExecuteDecomposedSubGoalsDeps,
): Promise<DecomposedSubGoalResult[]> {
  const graph = Array.isArray(subGoalsOrGraph)
    ? graphFromSubGoalStrings(subGoalsOrGraph, deps.maxConcurrency)
    : normalizeSubGoalGraph({ ...subGoalsOrGraph, maxConcurrency: deps.maxConcurrency ?? subGoalsOrGraph.maxConcurrency });
  const maxConcurrency = boundedConcurrency(deps.maxConcurrency ?? graph.maxConcurrency);
  const resultsById = new Map<string, DecomposedSubGoalResult>();
  const pending = new Map(graph.subGoals.map((goal, index) => [goal.id, { goal, index }]));

  while (pending.size > 0) {
    const ready = [...pending.values()].filter(({ goal }) =>
      goal.dependencies.every((dependencyId) => resultsById.has(dependencyId)),
    );

    if (ready.length === 0) {
      for (const { goal } of pending.values()) {
        resultsById.set(goal.id, skippedResult(goal, "dependency cycle or unresolved dependency"));
      }
      break;
    }

    const executable = ready.filter(({ goal }) => dependenciesSucceeded(goal, resultsById));
    const skipped = ready.filter(({ goal }) => !dependenciesSucceeded(goal, resultsById));

    for (const { goal } of skipped) {
      resultsById.set(goal.id, skippedResult(goal, `dependency did not complete: ${goal.dependencies.join(", ")}`));
      pending.delete(goal.id);
    }

    const batchResults = await runBounded(executable, maxConcurrency, async ({ goal, index }) => {
      return executeOneSubGoal(goal, index, graph, deps);
    });

    for (const { goal } of executable) {
      pending.delete(goal.id);
    }
    for (const { goal, result } of batchResults) {
      resultsById.set(goal.id, result);
    }
  }

  return graph.subGoals.map((goal) => resultsById.get(goal.id) ?? skippedResult(goal, "missing result"));
}

/**
 * Stitching helper for final synthesis (citations from artifacts, commands, tests).
 */
export function stitchResults(results: DecomposedSubGoalResult[]): string {
  return results
    .map((result) => `• ${result.artifact || result.command || "result"} [${result.status}]: ${result.summary || ""}`)
    .join("\n");
}

type ParsedSubGoals = string[] & { source: "bullets" | "sentences" };

function parseCandidateSubGoals(distilled: string): ParsedSubGoals {
  const lines = distilled.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletItems = lines
    .map((line) => line.match(/^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]]\s+)(.+)$/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line && line.length > 0));

  if (bulletItems.length >= 2) {
    return withSource(cleanGoals(bulletItems), "bullets");
  }

  const sentenceItems = distilled
    .split(/[.;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 10);
  return withSource(cleanGoals(sentenceItems), "sentences");
}

function withSource(items: string[], source: ParsedSubGoals["source"]): ParsedSubGoals {
  const output = items as ParsedSubGoals;
  output.source = source;
  return output;
}

function cleanGoals(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const goal = item.replace(/\s+/g, " ").trim();
    const key = goal.toLowerCase();
    if (goal.length <= 10 || seen.has(key)) continue;
    seen.add(key);
    output.push(goal);
  }
  return output;
}

function inferDependencies(goal: string, index: number, allGoals: string[]): string[] {
  if (index === 0) return [];
  const lower = goal.toLowerCase();
  if (/\b(in parallel|independently|meanwhile)\b/.test(lower)) return [];
  if (/^(then|next|after|afterwards|once|finally|validate|test|verify|deploy|document)\b/.test(lower)) {
    return [`sub-${index - 1}`];
  }
  if (/\b(after|once|following)\b/.test(lower)) return [`sub-${index - 1}`];

  const previous = allGoals[index - 1]?.toLowerCase() ?? "";
  if (/\b(inspect|review|design|plan)\b/.test(previous) && /\b(update|implement|fix|change|write)\b/.test(lower)) {
    return [`sub-${index - 1}`];
  }
  if (/\b(update|implement|fix|change|write)\b/.test(previous) && /\b(test|validate|verify)\b/.test(lower)) {
    return [`sub-${index - 1}`];
  }
  return [];
}

function expectedArtifactsFor(goal: string): string[] {
  const lower = goal.toLowerCase();
  if (/\b(test|validate|verify)\b/.test(lower)) return ["Validation evidence"];
  if (/\b(doc|docs|documentation|readme)\b/.test(lower)) return ["Documentation update"];
  if (/\b(inspect|review|audit|analyze)\b/.test(lower)) return ["Inspection notes"];
  if (/\b(code|implement|update|fix|refactor|change)\b/.test(lower)) return ["Updated source files"];
  return ["Sub-goal result"];
}

function validationFor(goal: string): string[] {
  const checks = [`Confirm sub-goal completed: ${redactString(goal).slice(0, 80)}`];
  if (/\b(test|validate|verify)\b/i.test(goal)) checks.push("Relevant checks pass or failures are reported");
  if (/\b(update|fix|implement|code|refactor)\b/i.test(goal)) checks.push("Changes stay within requested scope");
  return checks;
}

function boundedMaxSubGoals(context: ContextPack, configured?: number): number {
  const base = configured ?? DEFAULT_MAX_SUB_GOALS;
  const riskCap = context.triage.riskFlags.includes("destructive_change") ? 3 : DEFAULT_MAX_SUB_GOALS;
  return Math.max(1, Math.min(8, base, riskCap));
}

function boundedConcurrency(value: number): number {
  return Math.max(1, Math.min(8, Math.trunc(value)));
}

function normalizeSubGoalGraph(input: SubGoalGraph): SubGoalGraph {
  const ids = new Set<string>();
  const subGoals = input.subGoals.map((goal, index) => {
    const fallbackId = `sub-${index}`;
    const id = goal.id && !ids.has(goal.id) ? goal.id : fallbackId;
    ids.add(id);
    return SubGoalSchema.parse({
      ...goal,
      id,
      goal: redactString(goal.goal),
      dependencies: unique(goal.dependencies).filter((dependencyId) => dependencyId !== id),
      expectedArtifacts: goal.expectedArtifacts.length > 0 ? goal.expectedArtifacts.map(redactString) : expectedArtifactsFor(goal.goal),
      validation: goal.validation.length > 0 ? goal.validation.map(redactString) : validationFor(goal.goal),
      parallelizable: goal.dependencies.length === 0,
    });
  });
  const validIds = new Set(subGoals.map((goal) => goal.id));
  const dependencies = uniqueDependencies([
    ...input.dependencies,
    ...subGoals.flatMap((goal) => goal.dependencies.map((dependencyId) => ({ from: dependencyId, to: goal.id }))),
  ]).filter((dependency) => validIds.has(dependency.from) && validIds.has(dependency.to) && dependency.from !== dependency.to);

  return SubGoalGraphSchema.parse({
    subGoals: subGoals.map((goal) => ({
      ...goal,
      dependencies: dependencies.filter((dependency) => dependency.to === goal.id).map((dependency) => dependency.from),
      parallelizable: dependencies.every((dependency) => dependency.to !== goal.id),
    })),
    dependencies,
    maxConcurrency: boundedConcurrency(input.maxConcurrency),
    trace: input.trace.map(redactString),
  });
}

function graphFromSubGoalStrings(subGoals: string[], maxConcurrency?: number): SubGoalGraph {
  return normalizeSubGoalGraph({
    subGoals: subGoals.map((goal, index) => ({
      id: `sub-${index}`,
      goal,
      dependencies: [],
      expectedArtifacts: expectedArtifactsFor(goal),
      validation: validationFor(goal),
      parallelizable: true,
    })),
    dependencies: [],
    maxConcurrency: boundedConcurrency(maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    trace: ["legacy string[] input converted to SubGoalGraph"],
  });
}

function graphToSuggestedDag(graph: SubGoalGraph): Partial<CompiledDag> {
  return {
    nodes: graph.subGoals.map((goal) => ({
      id: goal.id,
      type: "task",
      description: goal.goal,
      dependsOn: goal.dependencies,
      expectedOutputs: goal.expectedArtifacts,
      metadata: { validation: goal.validation, decomposed: true },
    })),
    edges: graph.dependencies.map((dependency) => ({ from: dependency.from, to: dependency.to })),
  } as any;
}

function dependenciesSucceeded(goal: SubGoal, resultsById: Map<string, DecomposedSubGoalResult>): boolean {
  return goal.dependencies.every((dependencyId) => resultsById.get(dependencyId)?.status === "SUCCESS");
}

async function executeOneSubGoal(
  subGoal: SubGoal,
  index: number,
  graph: SubGoalGraph,
  deps: ExecuteDecomposedSubGoalsDeps,
): Promise<DecomposedSubGoalResult> {
  if (deps.executeSubGoal) {
    try {
      return await deps.executeSubGoal(subGoal, index, graph);
    } catch (error) {
      return {
        subGoal: redactString(subGoal.goal),
        artifact: `sub-goal-${index}`,
        summary: redactString(`failed: ${error instanceof Error ? error.message : String(error)}`),
        status: "FAILED",
      };
    }
  }

  const nowFn = deps.now ?? (() => new Date().toISOString());
  const dag: CompiledDag = {
    id: `subdag-${deps.run.id}-${index}`,
    runId: deps.run.id,
    version: "0.1.0",
    nodes: [
      {
        id: `sub-node-${index}`,
        type: "LLM_EXECUTION",
        label: redactString(subGoal.goal.slice(0, 120)),
        dependsOn: [],
        toolPermissions: [],
        expectedOutputs: subGoal.expectedArtifacts,
        input: { subGoal: redactString(subGoal.goal), validation: subGoal.validation },
        metadata: { decomposed: true, subGoalIndex: index, subGoalId: subGoal.id },
      },
    ],
    edges: [],
    createdAt: nowFn(),
  };

  const result = await executeDagThroughSandbox(dag, { sandbox: deps.sandbox, now: nowFn });
  const nodeResult = result.nodeResults[0];
  const summary =
    nodeResult?.status === "SUCCESS"
      ? `completed (${result.status})`
      : `failed: ${nodeResult?.error?.message ?? result.status}`;

  return {
    subGoal: redactString(subGoal.goal),
    artifact: `sub-goal-${index}`,
    summary: redactString(summary),
    status: result.status,
  };
}

function skippedResult(goal: SubGoal, reason: string): DecomposedSubGoalResult {
  return {
    subGoal: redactString(goal.goal),
    artifact: goal.id,
    summary: redactString(`skipped: ${reason}`),
    status: "SKIPPED",
  };
}

async function runBounded<T extends { goal: SubGoal; index: number }>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T) => Promise<DecomposedSubGoalResult>,
): Promise<Array<{ goal: SubGoal; result: DecomposedSubGoalResult }>> {
  const results: Array<{ goal: SubGoal; result: DecomposedSubGoalResult }> = [];
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = items[nextIndex];
      nextIndex += 1;
      const result = await worker(current);
      results.push({ goal: current.goal, result });
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runWorker()));
  return results;
}

function buildLiveDecomposerPrompt(input: LiveTaskDecomposerInput): LLMRequest["messages"] {
  return [
    {
      role: "system",
      content:
        "Return only JSON for a dependency-aware SubGoalGraph: {subGoals:[{id,goal,dependencies,expectedArtifacts,validation,parallelizable}],dependencies:[{from,to,reason}],maxConcurrency,trace}. Keep it bounded and safe.",
    },
    {
      role: "user",
      content: redactString(JSON.stringify({
        intent: input.distilled,
        contextSummary: input.context.userIntentSummary,
        maxSubGoals: boundedMaxSubGoals(input.context, input.maxSubGoals),
        maxConcurrency: input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      })),
    },
  ];
}

function buildLiveRepairPrompt(input: LiveTaskDecomposerInput, previous: string, error: string): LLMRequest["messages"] {
  return [
    ...buildLiveDecomposerPrompt(input),
    {
      role: "user",
      content: redactString(`Previous decomposition was invalid: ${error}. Return repaired JSON only. Previous preview: ${previous.slice(0, 800)}`),
    },
  ];
}

function parseLiveGraph(
  content: string,
  input: LiveTaskDecomposerInput,
): { ok: true; graph: SubGoalGraph } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(content) as unknown;
    const result = SubGoalGraphSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ") };
    }
    const maxSubGoals = boundedMaxSubGoals(input.context, input.maxSubGoals);
    const normalized = normalizeSubGoalGraph({
      ...result.data,
      subGoals: result.data.subGoals.slice(0, maxSubGoals),
      maxConcurrency: boundedConcurrency(input.maxConcurrency ?? result.data.maxConcurrency),
      trace: [...result.data.trace, "live decomposition schema validated", `capped sub-goals at ${maxSubGoals}`],
    });
    return { ok: true, graph: normalized };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function liveFallback(
  subGoalGraph: SubGoalGraph,
  usage: LLMUsage,
  provider: LLMProvider,
  model: string,
  attempts: number,
  errors: string[],
): LiveTaskDecomposerResult {
  return {
    status: "fallback",
    subGoalGraph,
    usage,
    provider: provider.metadata.id,
    model,
    attempts,
    errors: errors.map(redactString),
  };
}

function zeroUsage(): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    modelCalls: 0,
  });
}

function addUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueDependencies(values: SubGoalDependency[]): SubGoalDependency[] {
  const seen = new Set<string>();
  const output: SubGoalDependency[] = [];
  for (const value of values) {
    const parsed = SubGoalDependencySchema.safeParse(value);
    if (!parsed.success) continue;
    const key = `${parsed.data.from}->${parsed.data.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(parsed.data);
  }
  return output;
}
