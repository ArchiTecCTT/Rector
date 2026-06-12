import crypto from "node:crypto";
import { z } from "zod";
import type {
  InMemoryObservabilityTrace,
  ObservabilitySpan,
  ObservabilitySummary,
} from "../observability";
import { OrchestratorModeSchema } from "../deployment";
import {
  LLMUsageSchema,
  ModelRouteSchema,
  type LLMUsage,
  type ModelSelection,
} from "../providers/llm";
import { redactSecrets } from "../security/redaction";
import type { RectorStore } from "../store";
import type { Budget, Run, RunEvent } from "../store/schemas";

/**
 * Provider/model/cost metadata recorded on live external-mode phase events. Carries only non-secret
 * identifiers and accumulated token/cost usage; event persistence redacts again before storage.
 */
export const ProviderCallMetadataSchema = z.object({
  mode: OrchestratorModeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  modelRoute: ModelRouteSchema,
  usage: LLMUsageSchema,
  // `attempts` can be zero when a live step is denied at budget preflight before provider calls.
  attempts: z.number().int().min(0).max(2),
  repaired: z.boolean(),
});
export type ProviderCallMetadata = z.infer<typeof ProviderCallMetadataSchema>;

/** Default external-mode budget for BYOK orchestration. */
export const DEFAULT_EXTERNAL_BUDGET: Budget = {
  maxUsd: 1,
  maxInputTokens: 200_000,
  maxOutputTokens: 64_000,
  maxModelCalls: 4,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: [],
  approvalRequiredAboveUsd: 0,
};

export function phaseObservabilityPayload(
  observability: InMemoryObservabilityTrace,
  phase: string,
): { traceId: string; span?: ObservabilitySpan; summary: ObservabilitySummary } {
  return {
    traceId: observability.traceId,
    span: observability.getLastSpanForPhase(phase),
    summary: observability.getSummary(),
  };
}

export function runEvent(
  run: Run,
  type: RunEvent["type"],
  phase: RunEvent["phase"],
  payload: Record<string, unknown>,
): RunEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    runId: run.id,
    type,
    phase,
    payload: redactSecrets(payload),
    traceId: run.traceId,
    createdAt: new Date().toISOString(),
  };
}

export function committedRunNumber(primary: unknown, fallback: unknown): number {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return 0;
}

export async function addProviderUsageToRun(
  store: RectorStore,
  run: Run,
  usage: LLMUsage,
  provider: string,
): Promise<Run> {
  const current = (await store.getRun(run.id)) ?? run;
  const costUsd = committedRunNumber(current.actualCost?.usd, current.costEstimate.usd) + usage.estimatedUsd;
  const modelCalls = committedRunNumber(current.actualCost?.modelCalls, current.costEstimate.modelCalls) + usage.modelCalls;
  const inputTokens = committedRunNumber(current.actualTokens?.input, current.tokenEstimate.input) + usage.inputTokens;
  const outputTokens = committedRunNumber(current.actualTokens?.output, current.tokenEstimate.output) + usage.outputTokens;

  const updated = await store.updateRun(current.id, {
    costEstimate: { ...current.costEstimate, usd: costUsd, modelCalls, provider },
    actualCost: { ...(current.actualCost ?? {}), usd: costUsd, modelCalls, provider },
    tokenEstimate: { ...current.tokenEstimate, input: inputTokens, output: outputTokens },
    actualTokens: { ...(current.actualTokens ?? {}), input: inputTokens, output: outputTokens },
  });

  return updated ?? current;
}

export function buildProviderCallMetadata(
  selection: ModelSelection,
  provider: string,
  model: string,
  usage: LLMUsage,
  attempts: number,
): ProviderCallMetadata {
  return ProviderCallMetadataSchema.parse({
    mode: "external",
    provider,
    model,
    modelRoute: selection.modelRoute,
    usage,
    attempts,
    repaired: attempts > 1,
  });
}
