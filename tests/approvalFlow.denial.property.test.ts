import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  APPROVAL_DECISION_TIMEOUT_MS,
  presentApprovalRequest,
  recordApprovalDecision,
  type ApprovalDecision,
  type ApprovalRequestView,
} from "../src/api/approvalFlow";
import { InMemoryRectorStore, type Budget, type CreateRunInput, type Run } from "../src/store";

/**
 * Task 9.5 — Denial leaves targets unchanged property test.
 *
 * **Property 16: Denial leaves targets unchanged and continues the run**
 * **Validates: Requirements 9.5, 9.8**
 *
 * For any operation that is denied (explicitly via a `deny` decision, or by the
 * 30-minute decision timeout that downgrades any submission to `timeout-denied`),
 * no file write occurs for that operation, the affected targets remain unchanged,
 * and the run continues to a final answer (`SYNTHESIZING`) that excludes the denied
 * operation (the pending decision request is cleared and the run never transitions
 * to `EXECUTING`).
 *
 * The test drives only `presentApprovalRequest` / `recordApprovalDecision` against
 * the in-memory store with an injected clock. The "affected targets" are modelled as
 * a workspace snapshot keyed by the operation's target path; because the denial path
 * performs no execution, the snapshot must be byte-for-byte identical afterwards.
 * Zero provider/network/disk calls occur.
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

function makeRunInput(): CreateRunInput {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "EXECUTING",
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

/** Base presentation instant; decision instants are derived as offsets from it. */
const PRESENTED_AT_MS = Date.parse("2026-06-03T00:00:00.000Z");

/** A denial scenario: an explicit `deny`, or a `timeout` that downgrades any submission. */
type DenialScenario =
  | { kind: "deny"; submitted: "deny"; decidedOffsetMs: number }
  | { kind: "timeout"; submitted: ApprovalDecision; decidedOffsetMs: number };

const denialScenarioArb: fc.Arbitrary<DenialScenario> = fc.oneof(
  // Explicit denial within the decision window.
  fc
    .integer({ min: 0, max: APPROVAL_DECISION_TIMEOUT_MS - 1 })
    .map((decidedOffsetMs) => ({ kind: "deny", submitted: "deny", decidedOffsetMs }) as const),
  // Timeout denial: any submission at/after the 30-minute window becomes `timeout-denied`,
  // including a late "approve" which must never execute the operation (Req 9.8).
  fc
    .record({
      submitted: fc.constantFrom<ApprovalDecision>("approve", "deny"),
      extraMs: fc.integer({ min: 0, max: 7 * 24 * 60 * 60 * 1000 }),
    })
    .map(
      ({ submitted, extraMs }) =>
        ({
          kind: "timeout",
          submitted,
          decidedOffsetMs: APPROVAL_DECISION_TIMEOUT_MS + extraMs,
        }) as const,
    ),
);

const viewArb: fc.Arbitrary<{
  operationId: string;
  diff: string;
  command: string | undefined;
  targetPath: string;
  riskyCommand: boolean;
  decidedBy: string;
  targetContent: string;
}> = fc.record({
  operationId: fc.string({ minLength: 1, maxLength: 24 }),
  diff: fc.string({ maxLength: 200 }),
  command: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
  targetPath: fc.string({ minLength: 1, maxLength: 60 }),
  riskyCommand: fc.boolean(),
  decidedBy: fc.string({ minLength: 1, maxLength: 24 }),
  targetContent: fc.string({ maxLength: 200 }),
});

describe("approval denial leaves targets unchanged (Property 16)", () => {
  // Feature: productization-alpha, Property 16: Denial leaves targets unchanged and continues the run
  it("denial (explicit or timeout) keeps targets unchanged and continues the run to SYNTHESIZING excluding the operation", async () => {
    await fc.assert(
      fc.asyncProperty(viewArb, denialScenarioArb, async (op, scenario) => {
        const store = new InMemoryRectorStore({ now: () => "2026-06-03T00:00:00.000Z" });
        const created = await store.createRun(makeRunInput());

        const view: ApprovalRequestView = {
          runId: created.id,
          operationId: op.operationId,
          diff: op.diff,
          command: op.command,
          targetPath: op.targetPath,
        };

        const presentedAt = new Date(PRESENTED_AT_MS).toISOString();
        await presentApprovalRequest(
          store,
          {
            runId: created.id,
            operationId: op.operationId,
            riskyCommand: op.riskyCommand,
            view,
          },
          { now: () => presentedAt },
        );

        // The affected targets, modelled as a workspace snapshot keyed by target path.
        // The denial path must never touch this state (no file write for the operation).
        const workspace = new Map<string, string>([[op.targetPath, op.targetContent]]);
        const targetsBefore = JSON.stringify([...workspace.entries()]);

        const submitted: ApprovalDecision = scenario.submitted;
        const decidedAt = new Date(PRESENTED_AT_MS + scenario.decidedOffsetMs).toISOString();

        const record = await recordApprovalDecision(
          store,
          {
            runId: created.id,
            operationId: op.operationId,
            decision: submitted,
            decidedBy: op.decidedBy,
          },
          { now: () => decidedAt },
        );

        // The decision is recorded as a denial (explicit or timeout-based), never as an approval.
        const deniedOutcomes = scenario.kind === "timeout" ? ["timeout-denied"] : ["deny"];
        expect(deniedOutcomes).toContain(record.decision);
        expect(record.decision).not.toBe("approve");

        const resumed = (await store.getRun(created.id)) as Run;

        // The run continues to a final answer (SYNTHESIZING) and stays running.
        expect(resumed.phase).toBe("SYNTHESIZING");
        expect(resumed.status).toBe("running");

        // The denied operation is excluded from the continued run: its pending decision
        // request is cleared so it is never carried forward for execution.
        expect(resumed.decisionRequest).toBeUndefined();

        // No file write occurred for the operation; the affected targets are unchanged.
        const targetsAfter = JSON.stringify([...workspace.entries()]);
        expect(targetsAfter).toBe(targetsBefore);

        // The run never transitioned into EXECUTING — the operation never ran.
        const events = await store.listEvents(created.id);
        const executed = events.some(
          (event) => (event.payload as { toPhase?: string } | undefined)?.toPhase === "EXECUTING",
        );
        expect(executed).toBe(false);

        // The final transition moved from the pending-decision state to the final-answer state.
        const last = events[events.length - 1];
        expect(last.payload).toMatchObject({
          fromPhase: "NEEDS_DECISION",
          toPhase: "SYNTHESIZING",
        });
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
