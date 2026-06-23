import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const GLOBAL_SCENARIO_SCHEMA_VERSION = "rector.global-scenario.v1";

const NonEmptyTextSchema = z.string().min(1);
const NonNegativeIntSchema = z.number().int().nonnegative();

const GlobalScenarioOraclesSchema = z
  .object({
    mustChange: z.array(NonEmptyTextSchema),
    mustNotChange: z.array(NonEmptyTextSchema),
    mustIncludeEvidence: z.array(NonEmptyTextSchema),
  })
  .strict();

const GlobalScenarioBudgetsSchema = z
  .object({
    maxToolCalls: NonNegativeIntSchema,
    maxRuntimeMs: NonNegativeIntSchema,
    maxMainModelRawToolTokens: NonNegativeIntSchema,
  })
  .strict();

export const GlobalScenarioSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_SCENARIO_SCHEMA_VERSION).default(GLOBAL_SCENARIO_SCHEMA_VERSION),
    id: NonEmptyTextSchema,
    title: NonEmptyTextSchema,
    type: NonEmptyTextSchema,
    workspace: NonEmptyTextSchema,
    userGoal: NonEmptyTextSchema,
    allowedSystems: z.array(NonEmptyTextSchema),
    forbiddenSystems: z.array(NonEmptyTextSchema),
    expectedSpecialist: NonEmptyTextSchema,
    successCriteria: z.array(NonEmptyTextSchema),
    validators: z.array(NonEmptyTextSchema),
    oracles: GlobalScenarioOraclesSchema,
    budgets: GlobalScenarioBudgetsSchema,
  })
  .strict();

export type GlobalScenario = Readonly<z.infer<typeof GlobalScenarioSchema>>;
export type GlobalScenarioOracles = GlobalScenario["oracles"];
export type GlobalScenarioBudgets = GlobalScenario["budgets"];

export type GlobalScenarioFormat = "yaml" | "json";

/**
 * Parses and validates a global reliability scenario from text.
 *
 * YAML is a strict superset of JSON, so the `yaml` package parses both. We always route through it
 * (the `js-yaml` package is not available in this repo) and treat `format` as an explicit hint only;
 * the parsed value is validated by {@link GlobalScenarioSchema}, which throws a ZodError naming the
 * offending field on any shape mismatch.
 */
export function loadGlobalScenario(text: string, format: GlobalScenarioFormat = "yaml"): GlobalScenario {
  const raw: unknown = format === "json" ? JSON.parse(text) : parseYaml(text);
  return GlobalScenarioSchema.parse(raw);
}
