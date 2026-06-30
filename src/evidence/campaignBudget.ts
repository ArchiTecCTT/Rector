export const CAMPAIGN_BUDGET_SCHEMA_VERSION = "rector.campaign-budget.v1";
export const DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT = 100_000;

export const CAMPAIGN_BUDGET_SOURCES = ["provider_smoke", "phase2f_shadow", "harness_smoke"] as const;
export type CampaignBudgetSource = (typeof CAMPAIGN_BUDGET_SOURCES)[number];

export interface CampaignBudgetUsage {
  source: CampaignBudgetSource;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface CampaignBudgetTotals {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface CampaignBudgetLimits {
  maxTotalTokens: number;
  maxModelCalls?: number;
  maxEstimatedUsd?: number;
}

export type CampaignBudgetStatus = "within_budget" | "over_budget";

export interface CampaignBudgetRollup {
  schemaVersion: typeof CAMPAIGN_BUDGET_SCHEMA_VERSION;
  generatedAt: string;
  limits: CampaignBudgetLimits;
  sources: Record<CampaignBudgetSource, CampaignBudgetTotals>;
  total: CampaignBudgetTotals;
  withinTokenBudget: boolean;
  overTokenBudgetBy: number;
  withinModelCallBudget: boolean;
  overModelCallBudgetBy: number;
  withinEstimatedUsdBudget: boolean;
  overEstimatedUsdBudgetBy: number;
  status: CampaignBudgetStatus;
}

export interface AggregateCampaignBudgetOptions {
  now?: () => Date;
  generatedAt?: string | Date;
  limits?: Partial<CampaignBudgetLimits>;
}

export function aggregateCampaignBudget(
  usageEntries: readonly CampaignBudgetUsage[],
  options: AggregateCampaignBudgetOptions = {},
): CampaignBudgetRollup {
  const limits: CampaignBudgetLimits = {
    maxTotalTokens: DEFAULT_ZAI_CAMPAIGN_TOKEN_LIMIT,
    ...options.limits,
  };
  assertNonNegativeFinite(limits.maxTotalTokens, "limits.maxTotalTokens");
  if (limits.maxModelCalls !== undefined) {
    assertNonNegativeFinite(limits.maxModelCalls, "limits.maxModelCalls");
    if (!Number.isInteger(limits.maxModelCalls)) {
      throw new Error("limits.maxModelCalls must be an integer.");
    }
  }
  if (limits.maxEstimatedUsd !== undefined) {
    assertNonNegativeFinite(limits.maxEstimatedUsd, "limits.maxEstimatedUsd");
  }

  const sources = emptySourceTotals();
  for (const entry of usageEntries) {
    const totals = normalizeUsage(entry);
    const current = sources[entry.source];
    sources[entry.source] = addTotals(current, totals);
  }

  const total = CAMPAIGN_BUDGET_SOURCES.reduce(
    (sum, source) => addTotals(sum, sources[source]),
    zeroTotals(),
  );
  const overTokenBudgetBy = Math.max(0, total.totalTokens - limits.maxTotalTokens);
  const withinTokenBudget = overTokenBudgetBy === 0;

  const overModelCallBudgetBy =
    limits.maxModelCalls === undefined ? 0 : Math.max(0, total.modelCalls - limits.maxModelCalls);
  const withinModelCallBudget = overModelCallBudgetBy === 0;

  const overEstimatedUsdBudgetBy =
    limits.maxEstimatedUsd === undefined ? 0 : Math.max(0, roundUsd(total.estimatedCostUsd - limits.maxEstimatedUsd));
  const withinEstimatedUsdBudget = overEstimatedUsdBudgetBy === 0;

  const withinBudget = withinTokenBudget && withinModelCallBudget && withinEstimatedUsdBudget;

  return {
    schemaVersion: CAMPAIGN_BUDGET_SCHEMA_VERSION,
    generatedAt: timestamp(options),
    limits,
    sources,
    total,
    withinTokenBudget,
    overTokenBudgetBy,
    withinModelCallBudget,
    overModelCallBudgetBy,
    withinEstimatedUsdBudget,
    overEstimatedUsdBudgetBy,
    status: withinBudget ? "within_budget" : "over_budget",
  };
}

function emptySourceTotals(): Record<CampaignBudgetSource, CampaignBudgetTotals> {
  return {
    provider_smoke: zeroTotals(),
    phase2f_shadow: zeroTotals(),
    harness_smoke: zeroTotals(),
  };
}

function normalizeUsage(entry: CampaignBudgetUsage): CampaignBudgetTotals {
  if (!CAMPAIGN_BUDGET_SOURCES.includes(entry.source)) {
    throw new Error(`Unknown campaign budget source: ${String(entry.source)}`);
  }

  const modelCalls = nonNegativeInteger(entry.modelCalls ?? 0, `${entry.source}.modelCalls`);
  const inputTokens = nonNegativeInteger(entry.inputTokens ?? 0, `${entry.source}.inputTokens`);
  const outputTokens = nonNegativeInteger(entry.outputTokens ?? 0, `${entry.source}.outputTokens`);
  const reportedInputOutput = entry.inputTokens !== undefined || entry.outputTokens !== undefined;
  const totalTokens = nonNegativeInteger(
    entry.totalTokens ?? inputTokens + outputTokens,
    `${entry.source}.totalTokens`,
  );
  if (entry.totalTokens !== undefined && reportedInputOutput && totalTokens < inputTokens + outputTokens) {
    throw new Error(
      `${entry.source}.totalTokens must be at least inputTokens + outputTokens when token breakdown is reported.`,
    );
  }
  const estimatedCostUsd = nonNegativeNumber(entry.estimatedCostUsd ?? 0, `${entry.source}.estimatedCostUsd`);

  return { modelCalls, inputTokens, outputTokens, totalTokens, estimatedCostUsd };
}

function addTotals(left: CampaignBudgetTotals, right: CampaignBudgetTotals): CampaignBudgetTotals {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCostUsd: roundUsd(left.estimatedCostUsd + right.estimatedCostUsd),
  };
}

function zeroTotals(): CampaignBudgetTotals {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
}

function timestamp(options: AggregateCampaignBudgetOptions): string {
  if (options.generatedAt instanceof Date) return options.generatedAt.toISOString();
  if (typeof options.generatedAt === "string") return options.generatedAt;
  return (options.now?.() ?? new Date()).toISOString();
}

function nonNegativeInteger(value: number, label: string): number {
  assertNonNegativeFinite(value, label);
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value;
}

function nonNegativeNumber(value: number, label: string): number {
  assertNonNegativeFinite(value, label);
  return value;
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
