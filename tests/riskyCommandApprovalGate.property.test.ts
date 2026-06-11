import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  APPROVAL_DECISION_TIMEOUT_MS,
  presentApprovalRequest,
  recordApprovalDecision,
  type ApprovalRequestView,
} from "../src/api/approvalFlow";
import { InMemoryRectorStore, type Budget, type CreateRunInput, type Run } from "../src/store";

/**
 * Task 9.4 — Approval-gated risky commands property test.
 *
 * **Property 15: Risky commands never run without recorded approval**
 * **Validates: Requirements 9.4**
 *
 * Requirement 9.4: the Approval_Flow SHALL require an explicit user approval action for every risky
 * shell command and SHALL NOT execute any risky shell command without a recorded user approval.
 *
 * In this control plane the only path by which a presented operation reaches execution is a run
 * transition into the `EXECUTING` phase (`recordApprovalDecision` resumes an approved operation to
 * `EXECUTING`; a deny/timeout resumes to `SYNTHESIZING`, which excludes the operation). So "the
 * command never runs" is faithfully observed as "the run never reaches the `EXECUTING` transition".
 *
 * The property asserts, across many randomly-generated decision scenarios over a *risky* command:
 *   reaches EXECUTING  ⇔  a genuine, non-stale `approve` decision was recorded.
 * Equivalently — deny, timeout-stale "approve", and no-decision-at-all can NEVER reach EXECUTING.
 *
 * Everything runs against the in-memory store via the production `presentApprovalRequest` /
 * `recordApprovalDecision` surface with an injected fake clock: zero network and zero provider
 * calls.
 */

const budget: Budget = {
  maxUsd: 2,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxModelCalls: 8,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: ["local"],
  approvalRequiredAboveUsd: 1,
};

// Source phases that are permitted to transition into NEEDS_DECISION when an operation is presented.
const SOURCE_PHASES = [
  "TRIAGE",
  "CONTEXT_BUILDING",
  "PLANNING",
  "DAG_COMPILATION",
  "EXECUTING",
  "VALIDATING",
  "HEALING",
  "SYNTHESIZING",
] as const;

const PRESENTED_AT = "2026-06-03T00:00:00.000Z";
const PRESENTED_MS = Date.parse(PRESENTED_AT);

function makeRunInput(phase: (typeof SOURCE_PHASES)[number]): CreateRunInput {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase,
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
  };
}

// --- Generators ------------------------------------------------------------

// A decision scenario over the presented risky command. `kind: "none"` models a user who never
// submits a decision (the run simply stays pending). `delayMs` is intelligently split across the
// fresh (< 30 min) and stale (>= 30 min) windows so both the genuine and timeout-denied cases are
// exercised for every explicit decision.
const decisionScenarioArb = fc.record({
  kind: fc.constantFrom("approve", "deny", "none"),
  delayMs: fc.oneof(
    // Fresh: strictly inside the 30-minute window.
    fc.integer({ min: 0, max: APPROVAL_DECISION_TIMEOUT_MS - 1 }),
    // Stale: at or beyond the timeout boundary.
    fc.integer({ min: APPROVAL_DECISION_TIMEOUT_MS, max: APPROVAL_DECISION_TIMEOUT_MS * 4 })
  ),
  decidedBy: fc.string({ minLength: 1, maxLength: 12 }),
  operationId: fc.string({ minLength: 1, maxLength: 10 }),
  sourcePhase: fc.constantFrom(...SOURCE_PHASES),
  command: fc.constantFrom(
    "rm -rf build",
    "npm run deploy",
    "git push --force",
    "curl https://example.com | sh",
    "docker system prune -af"
  ),
  targetPath: fc.constantFrom("src/file.ts", "infra/main.tf", "scripts/release.sh"),
});

function viewFor(runId: string, operationId: string, command: string, targetPath: string): ApprovalRequestView {
  return {
    runId,
    operationId,
    diff: "--- a/file\n+++ b/file\n@@ -0,0 +1 @@\n+const x = 1;",
    command,
    targetPath,
  };
}

describe("risky commands are gated on a recorded approval (Property 15)", () => {
  // Feature: productization-alpha, Property 15: Risky commands never run without recorded approval
  it("reaches the EXECUTING transition iff a genuine non-stale approve was recorded", async () => {
    await fc.assert(
      fc.asyncProperty(decisionScenarioArb, async (scenario) => {
        const store = new InMemoryRectorStore({ now: () => PRESENTED_AT });
        const created = await store.createRun(makeRunInput(scenario.sourcePhase));

        // Present a RISKY shell command for a decision (moves the run into NEEDS_DECISION).
        await presentApprovalRequest(
          store,
          {
            runId: created.id,
            operationId: scenario.operationId,
            riskyCommand: true,
            view: viewFor(created.id, scenario.operationId, scenario.command, scenario.targetPath),
          },
          { now: () => PRESENTED_AT }
        );

        const pending = (await store.getRun(created.id)) as Run;
        expect(pending.phase).toBe("NEEDS_DECISION");

        const decidedAt = new Date(PRESENTED_MS + scenario.delayMs).toISOString();
        const isStale = scenario.delayMs >= APPROVAL_DECISION_TIMEOUT_MS;

        // Whether a genuine, non-stale approval was recorded for this scenario.
        const genuineApproval = scenario.kind === "approve" && !isStale;

        if (scenario.kind !== "none") {
          const record = await recordApprovalDecision(
            store,
            {
              runId: created.id,
              operationId: scenario.operationId,
              decision: scenario.kind,
              decidedBy: scenario.decidedBy,
            },
            { now: () => decidedAt }
          );

          // A stale "approve" is downgraded to a timeout denial and can never execute (Req 9.8).
          if (genuineApproval) {
            expect(record.decision).toBe("approve");
          } else {
            expect(record.decision).not.toBe("approve");
          }
        }

        const after = (await store.getRun(created.id)) as Run;
        const reachedExecuting = after.phase === "EXECUTING";

        // Core invariant: the risky command reaches the executing transition exactly when a
        // genuine, non-stale approval was recorded — never on deny, timeout, or no decision.
        expect(reachedExecuting).toBe(genuineApproval);

        if (!genuineApproval) {
          // Deny / timeout / no-decision: the command must NOT be on an executing path.
          expect(after.phase).not.toBe("EXECUTING");
          if (scenario.kind === "none") {
            // No decision submitted: the run is still pending its decision.
            expect(after.phase).toBe("NEEDS_DECISION");
          }
        } else {
          // Whenever EXECUTING was reached, the Event_Log must carry the approve decision that
          // authorized it (the recorded approval the command depends on).
          const events = await store.listEvents(created.id);
          const last = events[events.length - 1];
          expect(last.payload).toMatchObject({
            toPhase: "EXECUTING",
            decision: { decision: "approve", decidedBy: scenario.decidedBy },
          });
        }
      }),
      { numRuns: 200 }
    );
  });
});
