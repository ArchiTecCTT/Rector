import type { Run } from "../store/schemas";

/** Structured JSON roles that must not silently fall back to provider default output caps in live harness. */
export const STRUCTURED_JSON_ROLES = ["planner", "skeptic", "synthesizer", "repair"] as const;
export type StructuredJsonRole = (typeof STRUCTURED_JSON_ROLES)[number];

/** Matches {@link LLMRequestSchema} upper bound for `maxOutputTokens`. */
export const STRUCTURED_ROLE_MAX_OUTPUT_TOKENS_CEILING = 128_000;

/** Default cap for live harness strict roles when no scenario/env override applies. */
export const DEFAULT_LIVE_HARNESS_STRUCTURED_ROLE_MAX_OUTPUT_TOKENS = 4_096;

const HARNESS_ENV_KEYS: Record<StructuredJsonRole, string> = {
  planner: "RECTOR_LIVE_HARNESS_PLANNER_MAX_OUTPUT_TOKENS",
  skeptic: "RECTOR_LIVE_HARNESS_SKEPTIC_MAX_OUTPUT_TOKENS",
  synthesizer: "RECTOR_LIVE_HARNESS_SYNTH_MAX_OUTPUT_TOKENS",
  repair: "RECTOR_LIVE_HARNESS_REPAIR_MAX_OUTPUT_TOKENS",
};

/**
 * Per-role output caps for structured JSON orchestration steps. When attached to a chat run (live
 * harness), every strict-role provider request receives an explicit `maxOutputTokens` instead of the
 * provider's conservative default (512 on OpenAI-compatible adapters).
 */
export interface StructuredRoleOutputCapPolicy {
  planner?: number;
  skeptic?: number;
  synthesizer?: number;
  repair?: number;
  /** Fallback when a role-specific cap is omitted inside an opted-in policy. */
  defaultCap?: number;
}

export interface HarnessScenarioOutputCapSource {
  readonly maxOutputTokens: number;
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** Operator overrides for live harness strict-role caps (optional). */
export function readHarnessStructuredRoleEnvCaps(): Partial<Record<StructuredJsonRole, number>> {
  const caps: Partial<Record<StructuredJsonRole, number>> = {};
  for (const role of STRUCTURED_JSON_ROLES) {
    const value = parsePositiveIntEnv(HARNESS_ENV_KEYS[role]);
    if (value !== undefined) {
      caps[role] = value;
    }
  }
  return caps;
}

/**
 * Clamps a structured-role cap to schema and run-budget ceilings. Returns a positive integer.
 */
export function clampStructuredRoleMaxOutputTokens(
  requested: number,
  runBudgetMaxOutputTokens?: number,
): number {
  let cap = Math.min(Math.max(1, Math.floor(requested)), STRUCTURED_ROLE_MAX_OUTPUT_TOKENS_CEILING);
  if (runBudgetMaxOutputTokens !== undefined && Number.isFinite(runBudgetMaxOutputTokens)) {
    const budgetCap = Math.max(1, Math.floor(runBudgetMaxOutputTokens));
    cap = Math.min(cap, budgetCap);
  }
  return cap;
}

/**
 * Resolves the `maxOutputTokens` for a structured JSON role. When `policy` is omitted (normal product
 * chat), returns `undefined` so callers keep provider defaults. When `policy` is present, always
 * returns an explicit positive cap.
 */
export function resolveStructuredRoleMaxOutputTokens(
  role: StructuredJsonRole,
  policy: StructuredRoleOutputCapPolicy | undefined,
  run?: Pick<Run, "budget">,
): number | undefined {
  if (!policy) return undefined;
  const roleCap = policy[role];
  const fallback =
    policy.defaultCap ?? DEFAULT_LIVE_HARNESS_STRUCTURED_ROLE_MAX_OUTPUT_TOKENS;
  const requested = roleCap ?? fallback;
  return clampStructuredRoleMaxOutputTokens(requested, run?.budget.maxOutputTokens);
}

/**
 * Builds a harness policy: env overrides beat scenario caps, which beat the 4096 harness default.
 */
export function structuredRoleOutputCapPolicyForHarnessScenario(
  scenario: HarnessScenarioOutputCapSource,
): StructuredRoleOutputCapPolicy {
  const env = readHarnessStructuredRoleEnvCaps();
  const scenarioCap = clampStructuredRoleMaxOutputTokens(scenario.maxOutputTokens);
  const pick = (role: StructuredJsonRole): number => {
    const envCap = env[role];
    if (envCap !== undefined) {
      return clampStructuredRoleMaxOutputTokens(envCap);
    }
    return scenarioCap;
  };
  const repairEnv = env.repair;
  const repairFallback = env.planner ?? scenarioCap;
  return {
    planner: pick("planner"),
    skeptic: pick("skeptic"),
    synthesizer: pick("synthesizer"),
    repair:
      repairEnv !== undefined
        ? clampStructuredRoleMaxOutputTokens(repairEnv)
        : clampStructuredRoleMaxOutputTokens(repairFallback),
    defaultCap: DEFAULT_LIVE_HARNESS_STRUCTURED_ROLE_MAX_OUTPUT_TOKENS,
  };
}

export function applyStructuredRoleMaxOutputTokens(
  role: StructuredJsonRole,
  policy: StructuredRoleOutputCapPolicy | undefined,
  run: Pick<Run, "budget"> | undefined,
): { maxOutputTokens?: number } {
  const maxOutputTokens = resolveStructuredRoleMaxOutputTokens(role, policy, run);
  return maxOutputTokens === undefined ? {} : { maxOutputTokens };
}