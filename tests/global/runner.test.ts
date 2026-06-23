import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GLOBAL_SCORECARD_DIMENSION_IDS,
} from "../../src/evals/scorecards";
import { GlobalScenarioSchema, type GlobalScenario } from "../../src/evals/globalScenarioSchema";
import { requiresLiveProvider, runGlobalHarness } from "../../src/evals/globalRunner";

const FIXED_NOW = () => new Date("2026-01-01T00:00:00.000Z");
const cleanAuditor = async () => ({ findingCount: 0 });

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempOutputDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rector-global-runner-"));
  tempRoots.push(root);
  return root;
}

function liveScenario(): GlobalScenario {
  return GlobalScenarioSchema.parse({
    id: "live-research-001",
    title: "Live research scenario requiring creds",
    type: "live",
    workspace: "tests/fixtures/repos/rector-mini-fix",
    userGoal: "Use a live provider to research something.",
    allowedSystems: ["research"],
    forbiddenSystems: ["coding"],
    expectedSpecialist: "research",
    successCriteria: ["live answer produced"],
    validators: ["true"],
    oracles: { mustChange: [], mustNotChange: [], mustIncludeEvidence: ["research.live"] },
    budgets: { maxToolCalls: 10, maxRuntimeMs: 600000, maxMainModelRawToolTokens: 500 },
  });
}

describe("global reliability harness runner", () => {
  it("produces one scorecard per committed scenario with all eight dimensions plus fake-path", async () => {
    // Given: the four committed offline scenarios and a real temp output directory.
    const outputDir = await tempOutputDir();

    // When: the harness runs them, writing both reports.
    const result = await runGlobalHarness({ outputDir, now: FIXED_NOW, fakePathAuditor: cleanAuditor });

    // Then: there is exactly one scorecard per scenario, each carrying all eight dimensions + fake-path.
    expect(result.scorecards.length).toBe(result.report.scenarioCount);
    expect(result.scorecards.length).toBeGreaterThanOrEqual(4);
    for (const scorecard of result.scorecards) {
      for (const dimensionId of GLOBAL_SCORECARD_DIMENSION_IDS) {
        expect(scorecard.dimensions[dimensionId].score).toBeGreaterThanOrEqual(0);
        expect(scorecard.dimensions[dimensionId].score).toBeLessThanOrEqual(1);
      }
      expect(["clean", "fakes_present", "audit_not_present"]).toContain(scorecard.fakePathStatus);
    }

    // And: both report files are written and reparse as JSON.
    expect(result.jsonPath).toBeDefined();
    const jsonText = await readFile(result.jsonPath as string, "utf8");
    const reparsed = JSON.parse(jsonText) as { schemaVersion: string; generatedAt: string };
    expect(reparsed.schemaVersion).toBe("rector.global-report.v1");
    expect(reparsed.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    const markdownText = await readFile(result.markdownPath as string, "utf8");
    expect(markdownText).toBe(result.reportMd);
  });

  it("records the real validator failure of the unfixed coding fixture and writes a replayable regression", async () => {
    // Given: the committed scenarios whose validators run the still-buggy fixture verifier (exits 1).
    const result = await runGlobalHarness({ write: false, now: FIXED_NOW, fakePathAuditor: cleanAuditor });

    // When: the coding-basic-fix scenario outcome is inspected.
    const codingOutcome = result.report.outcomes.find((outcome) => outcome.scenarioId === "coding-basic-fix-001");
    const codingRegression = result.report.regressions.find((regression) => regression.scenarioId === "coding-basic-fix-001");

    // Then: its reliability is 0 from the REAL non-zero exit and it did NOT silently pass.
    expect(codingOutcome).toBeDefined();
    expect(codingOutcome?.scorecard.passed).toBe(false);
    expect(codingOutcome?.scorecard.dimensions.reliability.score).toBe(0);
    expect(codingOutcome?.validatorRuns.some((run) => run.exitCode !== 0)).toBe(true);

    // And: a replayable regression artifact captures the failing validator command and exit.
    expect(codingRegression).toBeDefined();
    expect(codingRegression?.failedValidators.length).toBeGreaterThan(0);
    expect(codingRegression?.failedValidators[0]?.command).toContain("calculator.verify.ts");
  });

  it("skips a live scenario without creds, recording a reason and never failing the run", async () => {
    // Given: a synthetic live scenario and an environment without LIVE_EVALS=1.
    const scenario = liveScenario();
    expect(requiresLiveProvider(scenario)).toBe(true);

    // When: the harness runs with only that live scenario and no creds.
    const result = await runGlobalHarness({
      write: false,
      now: FIXED_NOW,
      scenarios: [scenario],
      env: {},
      fakePathAuditor: cleanAuditor,
    });

    // Then: the scenario is reported SKIPPED with a reason and produces no scorecard or regression.
    expect(result.report.executedCount).toBe(0);
    expect(result.report.skippedCount).toBe(1);
    expect(result.skipped[0]?.scenarioId).toBe("live-research-001");
    expect(result.skipped[0]?.reason).toContain("LIVE_EVALS");
    expect(result.scorecards.length).toBe(0);
    expect(result.report.regressions.length).toBe(0);
  });

  it("executes a live scenario when LIVE_EVALS=1 is set", async () => {
    // Given: the same live scenario but with LIVE_EVALS=1 and a trivially-passing validator.
    const scenario = liveScenario();

    // When: the harness runs with the live flag enabled.
    const result = await runGlobalHarness({
      write: false,
      now: FIXED_NOW,
      scenarios: [scenario],
      env: { LIVE_EVALS: "1" },
      fakePathAuditor: cleanAuditor,
    });

    // Then: the live scenario is executed (not skipped) and scored from its real validator exit.
    expect(result.report.skippedCount).toBe(0);
    expect(result.report.executedCount).toBe(1);
    expect(result.scorecards[0]?.scenarioId).toBe("live-research-001");
    expect(result.scorecards[0]?.dimensions.reliability.score).toBe(1);
  });

  it("reports audit_not_present when no fake-path auditor is injected", async () => {
    // Given: the committed scenarios run without an injected fake-path auditor.
    const result = await runGlobalHarness({ write: false, now: FIXED_NOW });

    // Then: the fake-path status is honestly audit_not_present rather than a fabricated clean.
    expect(result.report.fakePathStatus).toBe("audit_not_present");
    expect(result.report.fakeFindingCount).toBe(0);
  });
});
