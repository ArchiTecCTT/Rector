import type { DiscoveredLiveProvider } from "./liveProviderDiscovery";
import type { ZaiHarnessScenario } from "./harnessScenarios";
import {
  STRUCTURED_JSON_ROLES,
  resolveStructuredRoleMaxOutputTokens,
  structuredRoleOutputCapPolicyForHarnessScenario,
  type StructuredJsonRole,
} from "../orchestration/structuredRoleOutputCaps";
import { LLMUsageSchema, type LLMRequest, type LLMUsage } from "../providers/llm";

const ZERO_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

/**
 * Structured JSON roles reserved in harness scenario token preflight: initial planner, skeptic, and
 * synthesizer calls plus one repair reserve (possible structured repair during the run).
 */
export const HARNESS_PREFLIGHT_STRUCTURED_ROLES: readonly StructuredJsonRole[] = STRUCTURED_JSON_ROLES;

function addUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  });
}

/** Token preflight for a single harness scenario (initial strict roles + one repair reserve). */
export function estimateScenarioPreflight(
  selected: DiscoveredLiveProvider,
  scenario: ZaiHarnessScenario,
  options?: { harnessId?: "zai" | "regolo" },
): LLMUsage {
  const harnessId = options?.harnessId ?? "zai";
  const structuredRoleOutputCaps = structuredRoleOutputCapPolicyForHarnessScenario(scenario);
  const baseMessages: LLMRequest["messages"] = [
    { role: "system", content: "Estimate this non-mutating Rector harness smoke prompt." },
    { role: "user", content: scenario.prompt },
  ];
  let total = ZERO_USAGE;
  for (const role of HARNESS_PREFLIGHT_STRUCTURED_ROLES) {
    const maxOutputTokens = resolveStructuredRoleMaxOutputTokens(role, structuredRoleOutputCaps);
    const estimate = selected.provider.estimateRequest({
      task: `${harnessId}-harness-smoke:${scenario.id}:preflight:${role}`,
      route: "HARNESS_PREFLIGHT",
      modelRoute: selected.route,
      model: selected.modelId,
      maxOutputTokens,
      temperature: 0,
      messages: baseMessages,
      metadata: { scenarioId: scenario.id, nonMutating: true, structuredRole: role },
    });
    total = addUsage(total, estimate);
  }
  return total;
}