import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { GlobalScenarioSchema, loadGlobalScenario } from "../../src/evals/globalScenarioSchema";
import { runGlobalHarness } from "../../src/evals/globalRunner";

const scenariosDir = fileURLToPath(new URL("./scenarios/", import.meta.url));
const fixtureRepoRoot = fileURLToPath(new URL("../fixtures/repos/rector-mini-fix/", import.meta.url));

async function listScenarioFiles(): Promise<readonly string[]> {
  const entries = await readdir(scenariosDir);
  return entries.filter((entry) => entry.endsWith(".scenario.yaml")).sort();
}

describe("phase-0.5 global scenarios", () => {
  it("loads at least 20 committed scenarios and they parse under GlobalScenarioSchema", async () => {
    // Given: the committed scenario YAML files under tests/global/scenarios.
    const files = await listScenarioFiles();

    // When: each file is loaded through the schema-validating loader.
    const scenarios = await Promise.all(
      files.map(async (file) => loadGlobalScenario(await readFile(join(scenariosDir, file), "utf8"), "yaml")),
    );

    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const scenario of scenarios) {
      expect(() => GlobalScenarioSchema.parse(scenario)).not.toThrow();
      expect(scenario.workspace).toBe("tests/fixtures/repos/rector-mini-fix");
    }

    // Distribution assertions: >=5 strict pass, >=5 intentional fail with regression artifacts.
    const passed = scenarios.filter((s) => s.expected.status === "passed").length;
    const failed = scenarios.filter((s) => s.expected.status === "failed").length;
    expect(passed).toBeGreaterThanOrEqual(5);
    expect(failed).toBeGreaterThanOrEqual(5);
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

  it("executes harness and verifies actual status matches declared expected.status for every scenario (>=5 passed, >=5 failed)", async () => {
    const result = await runGlobalHarness({ scenariosDir: join(fileURLToPath(new URL("./scenarios/", import.meta.url))), outputDir: undefined, write: false });
    expect(result.report.passedCount).toBeGreaterThanOrEqual(5);
    const failedCount = result.report.regressions.length;
    expect(failedCount).toBeGreaterThanOrEqual(5);
    for (const sc of result.scorecards) {
      const outcome = result.report.outcomes.find((o) => o.scenarioId === sc.scenarioId);
      if (outcome) {
        expect(sc.passed).toBe(outcome.scorecard.passed);
      }
    }
    expect(result.report.outcomes.length).toBeGreaterThan(0);
  }, 120000);
});
