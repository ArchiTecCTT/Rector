import { DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS } from "../orchestration/chatRunner";

/** Minimum configured product orchestration wall-clock budget (1 minute). */
export const MIN_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS = 60_000;

/** Maximum configured product orchestration wall-clock budget (1 hour). */
export const MAX_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS = 3_600_000;

/**
 * Clamps orchestration `maxRuntimeMs` to product-safe bounds. Used by runtime settings parse,
 * programmatic {@link runOrchestratedChatRun} options, and API-fed chat runs.
 */
export function normalizeProductOrchestrationMaxRuntimeMs(
  value: unknown,
  fallback: number = DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS,
): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : Math.trunc(fallback);
  return Math.min(
    Math.max(candidate, MIN_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS),
    MAX_PRODUCT_ORCHESTRATION_MAX_RUNTIME_MS,
  );
}