/** Default orchestration wall-clock budget for live Z.ai / Regolo harness scenarios. */
export const DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS = 120_000;

/** Hard upper bound for operator `RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` overrides (no unbounded live runs). */
export const MAX_LIVE_HARNESS_MAX_RUNTIME_MS = 600_000;

/** Minimum accepted override (guards typo env values). */
export const MIN_LIVE_HARNESS_MAX_RUNTIME_MS = 30_000;

const RUNTIME_ENV_KEY = "RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS";

/**
 * Resolves live harness orchestration timeout from operator env.
 * Defaults to {@link DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS}; clamps to
 * [{@link MIN_LIVE_HARNESS_MAX_RUNTIME_MS}, {@link MAX_LIVE_HARNESS_MAX_RUNTIME_MS}].
 */
export function resolveLiveHarnessMaxRuntimeMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[RUNTIME_ENV_KEY]?.trim();
  if (!raw) return DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIVE_HARNESS_MAX_RUNTIME_MS;
  }
  return Math.min(Math.max(parsed, MIN_LIVE_HARNESS_MAX_RUNTIME_MS), MAX_LIVE_HARNESS_MAX_RUNTIME_MS);
}