import type { ContextPack } from "./contextBuilder";
import type { CrucibleDecision } from "./crucible";
import type { CompiledDag } from "./dagCompiler";
import type { DagExecutionResult } from "./executorSimulator";
import type { PlannerOutput } from "./planner";
import type { SkepticReview } from "./skeptic";
import type { TriageResult } from "./triage";
import type { HealingLoopResult, HealingLoopStatus } from "./validationHealing";
import type { ObservabilitySummary } from "../observability";

export type BrainstemSynthesisStatus = HealingLoopStatus | "SKIPPED" | "BLOCKED";

export interface BrainstemSynthesisInput {
  traceId: string;
  triage: TriageResult;
  contextPack: ContextPack;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  compiledDag?: CompiledDag;
  executionResult?: DagExecutionResult;
  validationHealingResult?: HealingLoopResult;
  observabilitySummary?: ObservabilitySummary;
}

export interface BrainstemSynthesis {
  status: BrainstemSynthesisStatus;
  route: string;
  traceId: string;
  evidence: string[];
  /**
   * Count of provider calls made while producing this synthesis. Relaxed from the literal `0`
   * (Phase 1) to a non-negative integer (additive, backward-compatible) so the live synthesizer
   * (ORN-36) can record real provider usage. Local/provider-free and deterministic-fallback paths
   * keep reporting `0`.
   */
  providerCalls: number;
  observability?: ObservabilitySummary;
  response: string;
}

export function synthesizeChatBrainstemResponse(input: BrainstemSynthesisInput): BrainstemSynthesis {
  const status = synthesisStatus(input);
  const evidence = synthesisEvidence(input);
  const observed = input.observabilitySummary
    ? `Observed: ${input.observabilitySummary.spanCount} spans, ${input.observabilitySummary.durationMs}ms, provider calls: ${input.observabilitySummary.modelCallCount}, provider cost: $${input.observabilitySummary.estimatedCostUsd}.`
    : "Observed: pending.";
  const response = [
    `Status: ${status}.`,
    `Route: ${input.triage.route}.`,
    `Trace: ${input.traceId}.`,
    `Evidence: ${evidence.join("; ")}.`,
    observed,
    "Local mode: provider calls: 0, API keys: not required.",
  ].join(" ");

  return {
    status,
    route: input.triage.route,
    traceId: input.traceId,
    evidence,
    providerCalls: 0,
    observability: input.observabilitySummary,
    response,
  };
}

function synthesisStatus(input: BrainstemSynthesisInput): BrainstemSynthesisStatus {
  if (input.validationHealingResult) return input.validationHealingResult.status;

  switch (input.crucibleDecision.verdict) {
    case "ACCEPTED":
      return input.executionResult?.status === "FAILED" ? "FAILED" : "SKIPPED";
    case "BLOCKED":
      return "BLOCKED";
    case "NEEDS_REVISION":
    case "ESCALATED":
      return "NEEDS_DECISION";
  }
}

function synthesisEvidence(input: BrainstemSynthesisInput): string[] {
  const execution = input.executionResult;
  const validation = input.validationHealingResult;
  const completedNodes = execution?.nodeResults.filter((result) => result.status === "SUCCESS" || result.status === "RETRIED").length ?? 0;
  const totalNodes = execution?.nodeResults.length ?? input.compiledDag?.nodes.length ?? 0;

  const evidence = [
    `triage ${input.triage.route}/${input.triage.complexity}`,
    `context ${input.contextPack.id}`,
    `plan ${input.plannerOutput.tasks.length} tasks`,
    `skeptic ${input.skepticReview.verdict} (${input.skepticReview.findings.length} findings)`,
    `crucible ${input.crucibleDecision.verdict}`,
    input.compiledDag ? `dag ${input.compiledDag.nodes.length} nodes` : "dag skipped",
    execution ? `execution ${execution.status} (${completedNodes}/${totalNodes} nodes)` : "execution skipped",
    validation ? `validation ${validation.status}` : "validation skipped",
  ];

  if (validation && validation.attempts > 0) {
    evidence.push(`healing ${validation.status} after ${validation.attempts} ${validation.attempts === 1 ? "attempt" : "attempts"}`);
  }

  return evidence;
}
