import { z } from "zod";

export const GLOBAL_SCORECARD_SCHEMA_VERSION = "rector.global-scorecard.v1";

/**
 * The eight global reliability dimensions, in the stable order they are rendered. Keeping this as a
 * frozen tuple guarantees the Markdown/JSON renderers emit rows in a deterministic, byte-identical
 * sequence regardless of the order keys happen to arrive in the parsed object.
 */
export const GLOBAL_SCORECARD_DIMENSION_IDS = [
  "reliability",
  "accuracy",
  "safety",
  "cost_efficiency",
  "memory_correctness",
  "delegation_quality",
  "evidence_quality",
  "simplicity",
] as const;

export type GlobalScorecardDimensionId = (typeof GLOBAL_SCORECARD_DIMENSION_IDS)[number];

export const FAKE_PATH_STATUSES = ["clean", "fakes_present", "audit_not_present"] as const;
export type FakePathStatus = (typeof FAKE_PATH_STATUSES)[number];

const DimensionScoreSchema = z
  .object({
    score: z.number().min(0).max(1),
    notes: z.string().min(1).optional(),
  })
  .strict();

const DimensionsSchema = z
  .object({
    reliability: DimensionScoreSchema,
    accuracy: DimensionScoreSchema,
    safety: DimensionScoreSchema,
    cost_efficiency: DimensionScoreSchema,
    memory_correctness: DimensionScoreSchema,
    delegation_quality: DimensionScoreSchema,
    evidence_quality: DimensionScoreSchema,
    simplicity: DimensionScoreSchema,
  })
  .strict();

export const ScorecardSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_SCORECARD_SCHEMA_VERSION).default(GLOBAL_SCORECARD_SCHEMA_VERSION),
    scenarioId: z.string().min(1),
    dimensions: DimensionsSchema,
    fakePathStatus: z.enum(FAKE_PATH_STATUSES),
    fakeFindingCount: z.number().int().nonnegative().optional(),
    passed: z.boolean(),
  })
  .strict();

export type Scorecard = Readonly<z.infer<typeof ScorecardSchema>>;
export type ScorecardDimensionScore = Readonly<z.infer<typeof DimensionScoreSchema>>;

function formatScore(value: number): string {
  return value.toFixed(4);
}

/**
 * Renders a provided scorecard as deterministic Markdown. Dimensions are emitted in the fixed
 * {@link GLOBAL_SCORECARD_DIMENSION_IDS} order and there is no clock/randomness, so identical input
 * always yields byte-identical output (asserted by the determinism-lock test).
 */
export function renderScorecardMarkdown(scorecard: Scorecard): string {
  const parsed = ScorecardSchema.parse(scorecard);
  const lines: string[] = [];
  lines.push("# Global Reliability Scorecard");
  lines.push("");
  lines.push(`- Schema: \`${parsed.schemaVersion}\``);
  lines.push(`- Scenario: \`${parsed.scenarioId}\``);
  lines.push(`- Passed: **${parsed.passed ? "true" : "false"}**`);
  lines.push("");
  lines.push("## Dimensions");
  lines.push("");
  lines.push("| dimension | score | notes |");
  lines.push("| --- | --- | --- |");
  for (const id of GLOBAL_SCORECARD_DIMENSION_IDS) {
    const dimension = parsed.dimensions[id];
    lines.push(`| ${id} | ${formatScore(dimension.score)} | ${dimension.notes ?? ""} |`);
  }
  lines.push("");
  lines.push("## Fake-path Audit");
  lines.push("");
  lines.push("| status | findings |");
  lines.push("| --- | --- |");
  const findings = parsed.fakeFindingCount === undefined ? "n/a" : String(parsed.fakeFindingCount);
  lines.push(`| ${parsed.fakePathStatus} | ${findings} |`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * Renders a provided scorecard as deterministic JSON with a stable top-level and dimension key order
 * (dimensions follow {@link GLOBAL_SCORECARD_DIMENSION_IDS}), so identical input is byte-identical.
 */
export function renderScorecardJson(scorecard: Scorecard): string {
  const parsed = ScorecardSchema.parse(scorecard);
  const orderedDimensions: Record<string, ScorecardDimensionScore> = {};
  for (const id of GLOBAL_SCORECARD_DIMENSION_IDS) {
    orderedDimensions[id] = parsed.dimensions[id];
  }
  const ordered = {
    schemaVersion: parsed.schemaVersion,
    scenarioId: parsed.scenarioId,
    dimensions: orderedDimensions,
    fakePathStatus: parsed.fakePathStatus,
    ...(parsed.fakeFindingCount === undefined ? {} : { fakeFindingCount: parsed.fakeFindingCount }),
    passed: parsed.passed,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
