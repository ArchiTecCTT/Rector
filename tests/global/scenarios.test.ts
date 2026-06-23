import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GlobalScenarioSchema, loadGlobalScenario } from "../../src/evals/globalScenarioSchema";

const scenariosDir = new URL("./scenarios/", import.meta.url).pathname;
const fixtureRepoRoot = new URL("../fixtures/repos/rector-mini-fix/", import.meta.url).pathname;

const EXPECTED_SCENARIO_IDS = [
  "coding-basic-fix-001",
  "memory-boundary-001",
  "fake-purge-001",
  "delegation-routing-001",
] as const;

async function listScenarioFiles(): Promise<readonly string[]> {
  const entries = await readdir(scenariosDir);
  return entries.filter((entry) => entry.endsWith(".scenario.yaml")).sort();
}

describe("phase-0.5 global scenarios", () => {
  it("loads exactly the four committed scenarios and they parse under GlobalScenarioSchema", async () => {
    // Given: the committed scenario YAML files under tests/global/scenarios.
    const files = await listScenarioFiles();

    // When: each file is loaded through the schema-validating loader.
    const scenarios = await Promise.all(
      files.map(async (file) => loadGlobalScenario(await readFile(join(scenariosDir, file), "utf8"), "yaml")),
    );

    // Then: all four expected scenario ids are present and schema-valid.
    expect(files.length).toBe(EXPECTED_SCENARIO_IDS.length);
    const ids = scenarios.map((scenario) => scenario.id).sort();
    expect(ids).toEqual([...EXPECTED_SCENARIO_IDS].sort());
    for (const scenario of scenarios) {
      expect(() => GlobalScenarioSchema.parse(scenario)).not.toThrow();
      expect(scenario.workspace).toBe("tests/fixtures/repos/rector-mini-fix");
    }
  });

  it("keeps each scenario internally consistent with its declared systems", async () => {
    // Given: the parsed scenarios.
    const files = await listScenarioFiles();
    const scenarios = await Promise.all(
      files.map(async (file) => loadGlobalScenario(await readFile(join(scenariosDir, file), "utf8"), "yaml")),
    );

    for (const scenario of scenarios) {
      // Then: the expected specialist is allowed and never simultaneously forbidden.
      expect(scenario.allowedSystems).toContain(scenario.expectedSpecialist);
      expect(scenario.forbiddenSystems).not.toContain(scenario.expectedSpecialist);
      expect(scenario.validators.length).toBeGreaterThan(0);
      expect(scenario.successCriteria.length).toBeGreaterThan(0);
    }
  });

  it("references real fixture-repo files that exist on disk", async () => {
    // Given: the committed fixture repo and its standalone verifier.
    const repoEntries = await readdir(join(fixtureRepoRoot, "src"));

    // Then: the buggy source and its verifier both exist for scenarios to target.
    expect(repoEntries).toContain("calculator.ts");
    expect(repoEntries).toContain("calculator.verify.ts");
    const source = await readFile(join(fixtureRepoRoot, "src", "calculator.ts"), "utf8");
    expect(source).toContain("return a - b;");
  });
});
