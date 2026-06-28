import { describe, expect, it } from "vitest";

import { globalHarnessResultToFacts, globalScenarioToFacts, RectorFactSchema } from "../../src/facts";
import type { GlobalScenario } from "../../src/evals/globalScenarioSchema";
import type { Scorecard } from "../../src/evals/scorecards";

const OPTIONS = { runId: "run-global", createdAt: "2026-06-28T00:00:00.000Z" };

const scenario: GlobalScenario = {
  schemaVersion: "rector.global-scenario.v1",
  id: "scenario-live-skip",
  title: "Live scenario skips offline",
  type: "live",
  workspace: "tests/fixtures/repos/rector-mini-fix",
  userGoal: "Fix the calculator",
  allowedSystems: ["coding-basic-fix"],
  forbiddenSystems: ["memory-writer"],
  expectedSpecialist: "coding-basic-fix",
  successCriteria: ["tests pass"],
  validators: [{ id: "validator-vitest", cmd: "npm", args: ["test"], cwd: ".", timeoutMs: 30_000, expectedExitCode: 0 }],
  oracles: { mustChange: ["src/calculator.ts"], mustNotChange: ["package.json"], mustIncludeEvidence: ["test-output"] },
  budgets: { maxToolCalls: 5, maxRuntimeMs: 60_000, maxMainModelRawToolTokens: 10_000 },
  setup: { copyWorkspaceToTemp: false, fixtures: [] },
  operation: { kind: "validator_only" },
  expected: { status: "skipped", changedPaths: ["src/calculator.ts"], unchangedPaths: ["package.json"], evidenceRefs: ["test-output"] },
};

function expectValidFacts(facts: readonly unknown[]) {
  for (const fact of facts) expect(RectorFactSchema.safeParse(fact).success).toBe(true);
}

describe("global harness fact adapter", () => {
  it("preserves scenario ids, validator ids, expected status, and safe path constraints", () => {
    const facts = globalScenarioToFacts(scenario, OPTIONS);

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.kind === "capability_request" && fact.requestId === "scenario-live-skip")).toBe(true);
    expect(facts.some((fact) => fact.kind === "validation_obligation" && fact.obligationId === "validator-vitest" && fact.validator === "npm" && fact.requiredEvidence.includes("arg0:test"))).toBe(true);
    expect(facts.some((fact) => fact.kind === "capability_call" && fact.callId === "scenario-live-skip:expected:skipped" && fact.status === "skipped")).toBe(true);
    expect(facts.some((fact) => fact.kind === "task_constraint" && fact.constraint.includes("expected.changedPaths:src/calculator.ts"))).toBe(true);
  });

  it("emits skipped actual status facts instead of dropping skipped live scenarios", () => {
    const facts = globalHarnessResultToFacts({ scenario, actualStatus: "skipped", options: OPTIONS });

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.kind === "capability_call" && fact.callId === "scenario-live-skip:actual:skipped" && fact.status === "skipped")).toBe(true);
    expect(facts.some((fact) => fact.kind === "capability_warning" && fact.warning.includes("skipped"))).toBe(true);
  });

  it("represents scorecard failures without marking validation_linked", () => {
    const scorecard: Scorecard = {
      schemaVersion: "rector.global-scorecard.v1",
      scenarioId: scenario.id,
      dimensions: {
        reliability: { score: 0.2 },
        accuracy: { score: 0.3 },
        safety: { score: 1 },
        cost_efficiency: { score: 1 },
        memory_correctness: { score: 1 },
        delegation_quality: { score: 0.5 },
        evidence_quality: { score: 0.1 },
        simplicity: { score: 1 },
      },
      fakePathStatus: "clean",
      passed: false,
    };

    const facts = globalHarnessResultToFacts({ scenario, scorecard, actualStatus: "failed", options: OPTIONS });

    expectValidFacts(facts);
    expect(facts.some((fact) => fact.kind === "capability_call" && fact.callId === "scenario-live-skip:actual:failed" && fact.status === "failed")).toBe(true);
    expect(facts.some((fact) => fact.kind === "capability_failure" && fact.capabilityId === "global_scorecard:scenario-live-skip")).toBe(true);
    expect(facts.every((fact) => fact.trust.level !== "validation_linked")).toBe(true);
  });

  it("attaches regression artifact refs to failed scorecard failure evidence", () => {
    const scorecard: Scorecard = {
      schemaVersion: "rector.global-scorecard.v1",
      scenarioId: scenario.id,
      dimensions: {
        reliability: { score: 0 },
        accuracy: { score: 0 },
        safety: { score: 1 },
        cost_efficiency: { score: 1 },
        memory_correctness: { score: 1 },
        delegation_quality: { score: 1 },
        evidence_quality: { score: 0 },
        simplicity: { score: 1 },
      },
      fakePathStatus: "clean",
      passed: false,
    };
    const artifactUri = ".omo/evidence/regression/scenario-live-skip.json";

    const facts = globalHarnessResultToFacts({
      scenario,
      scorecard,
      actualStatus: "failed",
      regressionArtifactRefs: [artifactUri],
      options: OPTIONS,
    });

    expectValidFacts(facts);
    expect(facts.some((fact) =>
      fact.kind === "capability_failure"
      && fact.capabilityId === "global_scorecard:scenario-live-skip"
      && fact.evidence.length === 1
      && fact.evidence[0]?.refType === "artifact"
      && fact.evidence[0].uri === artifactUri,
    )).toBe(true);
  });
});
