import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  REGRESSION_HARDENING_THRESHOLD,
  runRegressionCase,
  type RegressionCaseDefinition,
  type RegressionScenario,
} from "../src/benchmark";
import {
  WorkspaceSandboxAdapter,
  type SandboxApproval,
} from "../src/sandbox";
import type { BenchmarkRunContext, BenchmarkTaskOutcome } from "../src/benchmark";

/**
 * Feature: productization-alpha, Task 11.3 — Regression-case template for fixed failure modes.
 *
 * Requirement 5.1: when a failure mode appears in two or more `Benchmark_Result` records within a
 * single benchmark cycle, the `Prompt_Set` is updated so the regression case for that failure mode
 * passes on the next benchmark run.
 * Requirement 5.4: when a failure mode is fixed in the `Prompt_Set`, the test suite includes a
 * regression case that reproduces that failure mode and asserts the corrected behavior.
 *
 * These tests exercise the reusable `runRegressionCase` scaffold with a concrete, deterministic
 * failure mode and also verify the scaffold is a genuine guard (it does not report success unless
 * the failure is actually reproduced and the fix actually passes). Everything runs against the
 * existing benchmark harness with deterministic doubles and zero network/provider calls.
 *
 * Validates: Requirements 5.1, 5.4
 */

/**
 * The concrete failure mode used as the worked example: the agent proposes a workspace file-write
 * patch *without* the required approval. The safe sandbox returns `NEEDS_APPROVAL` and never writes
 * the file, so the task fails. The hardened behavior accompanies the same patch with the required
 * approval, so the sandbox applies it and the task passes. This mirrors the approval-gate invariant
 * carried in the live planner/repair prompts.
 */
const TARGET_PATH = "src/generated.ts";
const PATCH_CONTENT = "export const generated = () => 7;\n";

async function setupFixture(workspaceDir: string): Promise<void> {
  await nodeFs.mkdir(nodePath.join(workspaceDir, "src"), { recursive: true });
  await nodeFs.writeFile(
    nodePath.join(workspaceDir, "README.md"),
    "# Regression fixture\n",
    "utf8",
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await nodeFs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Proposes the file-write patch, optionally carrying the required approval. */
async function proposePatch(
  context: BenchmarkRunContext,
  withApproval: boolean,
): Promise<BenchmarkTaskOutcome> {
  const approvals: SandboxApproval[] = withApproval
    ? [
        {
          id: "approval-regression",
          scope: "FILE_WRITE",
          target: TARGET_PATH,
          approvedBy: "regression-case",
        },
      ]
    : [];
  const adapter = new WorkspaceSandboxAdapter({
    workspaceRoot: context.workspaceDir,
    approvals,
    now: context.now,
  });

  const result = await adapter.operate({
    kind: "PROPOSE_PATCH",
    path: TARGET_PATH,
    operation: "add",
    content: PATCH_CONTENT,
  });

  const written = await fileExists(nodePath.join(context.workspaceDir, TARGET_PATH));
  return {
    passed: result.status === "SUCCEEDED" && written,
    patch: result.artifacts[0]?.unifiedDiff,
    commands: [],
    costEstimateUsd: 0,
    logs: [`status=${result.status}`, `file-written=${written}`],
  };
}

/** Pre-hardening scenario: omits the approval, so the file-write is gated and the task fails. */
const reproduceMissingApproval: RegressionScenario = {
  setupFixture,
  run: (context) => proposePatch(context, false),
};

/** Post-hardening scenario: includes the required approval, so the patch applies and the task passes. */
const fixWithApproval: RegressionScenario = {
  setupFixture,
  run: (context) => proposePatch(context, true),
};

const missingApprovalGateCase: RegressionCaseDefinition = {
  failureModeId: "missing-approval-gate",
  description: "Agent proposed a workspace file-write patch without the required approval gate.",
  reproduceFailure: reproduceMissingApproval,
  applyFix: fixWithApproval,
};

describe("benchmark regression-case scaffold (productization-alpha task 11.3)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "rector-regression-"));
  });

  afterEach(async () => {
    await nodeFs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reproduces the failure mode and asserts the corrected behavior (Req 5.1, 5.4)", async () => {
    const report = await runRegressionCase(missingApprovalGateCase, {
      now: () => "2024-01-01T00:00:00.000Z",
      tmpRoot,
    });

    // Req 5.4: the failure mode is genuinely reproduced before the fix.
    expect(report.failureReproduced).toBe(true);
    expect(report.reproducedFailureCount).toBe(report.failureSummary.totalTasks);
    // Req 5.1: the failure recurs across two or more records within the single failure cycle.
    expect(report.qualifiesForHardening).toBe(true);
    expect(report.reproducedFailureCount).toBeGreaterThanOrEqual(REGRESSION_HARDENING_THRESHOLD);
    // Req 5.1/5.4: the hardened behavior passes on the next benchmark run.
    expect(report.correctedBehaviorPasses).toBe(true);
    expect(report.fixedSummary.countsByStatus.passed).toBe(report.fixedSummary.totalTasks);
    // The case is a valid regression guard overall.
    expect(report.passed).toBe(true);
  });

  it("makes zero provider/network calls and keeps output under the temporary root", async () => {
    const report = await runRegressionCase(missingApprovalGateCase, { tmpRoot });

    for (const summary of [report.failureSummary, report.fixedSummary]) {
      expect(summary.mode).toBe("deterministic");
      expect(nodePath.resolve(summary.outputRoot).startsWith(nodePath.resolve(tmpRoot))).toBe(true);
      for (const result of summary.results) {
        expect(result.costEstimateUsd).toBe(0);
        expect(result.commands).toEqual([]);
        expect(nodePath.resolve(result.outputDir).startsWith(nodePath.resolve(tmpRoot))).toBe(true);
      }
    }
  });

  it("does not report success when the failure scenario fails to reproduce the bug", async () => {
    // A miswired case whose "failure" scenario actually passes must not be accepted as a guard.
    const miswired: RegressionCaseDefinition = {
      ...missingApprovalGateCase,
      failureModeId: "miswired-no-repro",
      reproduceFailure: fixWithApproval, // passes, so the failure mode is NOT reproduced
    };

    const report = await runRegressionCase(miswired, { tmpRoot });

    expect(report.failureReproduced).toBe(false);
    expect(report.qualifiesForHardening).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("does not report success when the fix scenario still fails (Req 5.1)", async () => {
    // A case whose "fix" still triggers the failure mode must not be accepted as corrected.
    const unfixed: RegressionCaseDefinition = {
      ...missingApprovalGateCase,
      failureModeId: "unfixed-fix",
      applyFix: reproduceMissingApproval, // still gated, so the corrected behavior fails
    };

    const report = await runRegressionCase(unfixed, { tmpRoot });

    expect(report.failureReproduced).toBe(true);
    expect(report.correctedBehaviorPasses).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("rejects an occurrences count below the Req 5.1 hardening threshold", async () => {
    await expect(
      runRegressionCase({ ...missingApprovalGateCase, occurrences: 1 }, { tmpRoot }),
    ).rejects.toThrow(/at least 2/);
  });
});
