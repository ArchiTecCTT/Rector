import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  GLOBAL_SCENARIO_SCHEMA_VERSION,
  GlobalScenarioSchema,
  loadGlobalScenario,
} from "../../src/evals/globalScenarioSchema";

const SCENARIO_YAML = `schemaVersion: rector.global-scenario.v1
id: coding-memory-patch-001
title: Patch the memory promotion bug
type: coding
workspace: fixtures/repos/rector-mini-bug
userGoal: Fix the failing memory promotion path so the targeted test passes.
allowedSystems: [coding]
forbiddenSystems: [research, writing, design]
expectedSpecialist: coding
successCriteria:
  - targeted test passes
validators:
  - npm test -- memoryPromotion.test.ts
oracles:
  mustChange:
    - src/memory/promotion.ts
  mustNotChange:
    - src/protocol/events.ts
  mustIncludeEvidence:
    - cartographer.grounding
budgets:
  maxToolCalls: 30
  maxRuntimeMs: 900000
  maxMainModelRawToolTokens: 1000
`;

describe("GlobalScenarioSchema", () => {
  it("round-trips a real inline scenario yaml into a typed object", () => {
    // Given: a scenario authored in the plan's exact YAML format.
    // When: it is loaded through the YAML path.
    const scenario = loadGlobalScenario(SCENARIO_YAML, "yaml");

    // Then: every field is parsed with the declared types and defaults.
    expect(scenario.schemaVersion).toBe(GLOBAL_SCENARIO_SCHEMA_VERSION);
    expect(scenario.id).toBe("coding-memory-patch-001");
    expect(scenario.type).toBe("coding");
    expect(scenario.allowedSystems).toEqual(["coding"]);
    expect(scenario.forbiddenSystems).toEqual(["research", "writing", "design"]);
    expect(scenario.expectedSpecialist).toBe("coding");
    expect(scenario.successCriteria).toEqual(["targeted test passes"]);
    expect(scenario.validators).toEqual(["npm test -- memoryPromotion.test.ts"]);
    expect(scenario.oracles.mustChange).toEqual(["src/memory/promotion.ts"]);
    expect(scenario.oracles.mustNotChange).toEqual(["src/protocol/events.ts"]);
    expect(scenario.oracles.mustIncludeEvidence).toEqual(["cartographer.grounding"]);
    expect(scenario.budgets.maxToolCalls).toBe(30);
    expect(scenario.budgets.maxRuntimeMs).toBe(900000);
    expect(scenario.budgets.maxMainModelRawToolTokens).toBe(1000);
  });

  it("defaults the schemaVersion when omitted from valid input", () => {
    // Given: a parsed scenario object that omits the optional schemaVersion literal.
    const withoutVersion = {
      id: "coding-001",
      title: "Title",
      type: "coding",
      workspace: "fixtures/repos/rector-mini-bug",
      userGoal: "Do the thing.",
      allowedSystems: ["coding"],
      forbiddenSystems: [],
      expectedSpecialist: "coding",
      successCriteria: ["passes"],
      validators: ["npm test"],
      oracles: { mustChange: [], mustNotChange: [], mustIncludeEvidence: [] },
      budgets: { maxToolCalls: 0, maxRuntimeMs: 0, maxMainModelRawToolTokens: 0 },
    };

    // When: the object is validated.
    const scenario = GlobalScenarioSchema.parse(withoutVersion);

    // Then: the canonical schema version is applied and empty system arrays are accepted.
    expect(scenario.schemaVersion).toBe(GLOBAL_SCENARIO_SCHEMA_VERSION);
    expect(scenario.forbiddenSystems).toEqual([]);
  });

  it("rejects a scenario missing oracles with a clear field path", () => {
    // Given: an otherwise-valid scenario yaml with the oracles block removed.
    const missingOracles = SCENARIO_YAML.replace(
      /oracles:\n( {2}.*\n| {4}.*\n)+/,
      "",
    );

    // When: it is loaded.
    const act = () => loadGlobalScenario(missingOracles, "yaml");

    // Then: a ZodError flags the missing oracles field by path.
    expect(act).toThrow(ZodError);
    try {
      act();
    } catch (error) {
      const zodError = error as ZodError;
      expect(zodError.issues.some((issue) => issue.path.join(".") === "oracles")).toBe(true);
    }
  });

  it("throws a ZodError naming budgets.maxToolCalls when it is a string", () => {
    // Given: a scenario whose maxToolCalls budget is a string instead of an integer.
    const stringBudget = SCENARIO_YAML.replace("maxToolCalls: 30", 'maxToolCalls: "30"');

    // When: it is loaded.
    const act = () => loadGlobalScenario(stringBudget, "yaml");

    // Then: the ZodError identifies the offending nested field.
    expect(act).toThrow(ZodError);
    try {
      act();
    } catch (error) {
      const zodError = error as ZodError;
      expect(zodError.issues.some((issue) => issue.path.join(".") === "budgets.maxToolCalls")).toBe(true);
    }
  });

  it("loads an equivalent scenario from JSON input", () => {
    // Given: the same scenario serialized as JSON.
    const jsonText = JSON.stringify({
      schemaVersion: GLOBAL_SCENARIO_SCHEMA_VERSION,
      id: "coding-memory-patch-001",
      title: "Patch the memory promotion bug",
      type: "coding",
      workspace: "fixtures/repos/rector-mini-bug",
      userGoal: "Fix the failing memory promotion path.",
      allowedSystems: ["coding"],
      forbiddenSystems: ["research"],
      expectedSpecialist: "coding",
      successCriteria: ["targeted test passes"],
      validators: ["npm test -- memoryPromotion.test.ts"],
      oracles: {
        mustChange: ["src/memory/promotion.ts"],
        mustNotChange: ["src/protocol/events.ts"],
        mustIncludeEvidence: ["cartographer.grounding"],
      },
      budgets: { maxToolCalls: 30, maxRuntimeMs: 900000, maxMainModelRawToolTokens: 1000 },
    });

    // When: it is loaded through the JSON path.
    const scenario = loadGlobalScenario(jsonText, "json");

    // Then: the JSON-sourced scenario validates identically to the YAML one.
    expect(scenario.id).toBe("coding-memory-patch-001");
    expect(scenario.budgets.maxRuntimeMs).toBe(900000);
  });
});
