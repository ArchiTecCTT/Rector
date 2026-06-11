import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  APPROVAL_DECISION_TIMEOUT_MS,
  presentApprovalRequest,
  recordApprovalDecision,
  type ApprovalDecision,
  type ApprovalRequestView,
  type RecordedApprovalDecision,
} from "../src/api/approvalFlow";
import { InMemoryRectorStore, type Budget, type CreateRunInput } from "../src/store";
import type { RunEvent } from "../src/protocol/events";
import type { Run, UpdateRunInput } from "../src/store/schemas";

/**
 * Task 9.3 — Decision-before-action ordering property test.
 *
 * **Property 14: A decision is recorded before the operation acts**
 * **Validates: Requirements 9.3**
 *
 * For any approve or deny decision, a decision record carrying the decision, the
 * deciding user identity, and a timestamp is appended to the Event_Log before the
 * operation is executed or cancelled. In this control plane, an operation can only
 * "act" once the run leaves `NEEDS_DECISION` for an acting phase: `EXECUTING`
 * (the approved operation runs) or `SYNTHESIZING` (the denied/timed-out operation
 * is cancelled and the run continues to a final answer).
 *
 * `recordApprovalDecision` appends the decision atomically with that resume
 * transition via `commitRunTransition`. We instrument the in-memory store so that
 * at the exact moment an acting transition commits, we read the Event_Log and
 * assert the decision record is already present — a non-atomic or
 * record-after-acting implementation would be caught here.
 *
 * The whole flow is deterministic and uses only the in-memory store: zero network
 * and zero provider calls.
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

/** True when an Event_Log entry carries a recorded approval decision record. */
function decisionRecordOf(
  event: RunEvent
): { decision: unknown; decidedBy: unknown; decidedAt: unknown } | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  const decision = payload?.decision as Record<string, unknown> | undefined;
  if (!decision || typeof decision !== "object") return undefined;
  if (!("decision" in decision) || !("decidedBy" in decision) || !("decidedAt" in decision)) {
    return undefined;
  }
  return { decision: decision.decision, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt };
}

const ACTING_PHASES = new Set<string>(["EXECUTING", "SYNTHESIZING"]);

/**
 * In-memory store that snapshots, at every acting-phase commit, whether the
 * Event_Log already contains a decision record. Because `commitRunTransition` is
 * atomic, capturing immediately after the inner commit observes exactly the state
 * the operation would see when it begins to act.
 */
class OrderingProbeStore extends InMemoryRectorStore {
  readonly actingTransitions: Array<{
    phase: string;
    decisionRecordedBeforeActing: boolean;
    record?: { decision: unknown; decidedBy: unknown; decidedAt: unknown };
  }> = [];

  async commitRunTransition(
    runId: string,
    patch: UpdateRunInput,
    event: RunEvent
  ): Promise<{ run: Run; event: RunEvent }> {
    const result = await super.commitRunTransition(runId, patch, event);
    if (patch.phase !== undefined && ACTING_PHASES.has(patch.phase)) {
      const events = await this.listEvents(runId);
      const recorded = events.map(decisionRecordOf).find((r) => r !== undefined);
      this.actingTransitions.push({
        phase: patch.phase,
        decisionRecordedBeforeActing: recorded !== undefined,
        record: recorded,
      });
    }
    return result;
  }
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split("");

/** Simple identifier/identity tokens that won't trip the redaction layer. */
function tokenArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...ID_CHARS), { minLength, maxLength }).map((cs) => cs.join(""));
}

const decisionArb: fc.Arbitrary<ApprovalDecision> = fc.constantFrom("approve", "deny");

const PRESENTED_AT_MS = Date.parse("2026-06-03T00:00:00.000Z");

function view(runId: string, operationId: string): ApprovalRequestView {
  return {
    runId,
    operationId,
    diff: "--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+const x = 1;",
    command: "npm run build",
    targetPath: "src/file.ts",
  };
}

/** Expected effective decision after the 30-minute timeout downgrade (Req 9.8). */
function expectedDecision(decision: ApprovalDecision, delayMs: number): RecordedApprovalDecision {
  return delayMs >= APPROVAL_DECISION_TIMEOUT_MS ? "timeout-denied" : decision;
}

describe("decision-before-action ordering (Property 14)", () => {
  // Feature: productization-alpha, Property 14: A decision is recorded before the operation acts
  it("records the decision in the Event_Log before the operation executes or is cancelled", async () => {
    await fc.assert(
      fc.asyncProperty(
        decisionArb,
        tokenArb(1, 16), // operationId
        tokenArb(1, 16), // decidedBy (deciding user identity)
        // Delay from presentation to decision; spans both sides of the 30-minute timeout so the
        // approve->EXECUTING and deny/timeout->SYNTHESIZING acting paths are both exercised.
        fc.integer({ min: 0, max: 2 * APPROVAL_DECISION_TIMEOUT_MS }),
        async (decision, operationId, decidedBy, delayMs) => {
          const store = new OrderingProbeStore({ now: () => new Date(PRESENTED_AT_MS).toISOString() });
          const run = await store.createRun(makeRunInput());

          const presentedAt = new Date(PRESENTED_AT_MS).toISOString();
          await presentApprovalRequest(
            store,
            { runId: run.id, operationId, riskyCommand: true, view: view(run.id, operationId) },
            { now: () => presentedAt }
          );

          const decidedAt = new Date(PRESENTED_AT_MS + delayMs).toISOString();
          const record = await recordApprovalDecision(
            store,
            { runId: run.id, operationId, decision, decidedBy },
            { now: () => decidedAt }
          );

          const effective = expectedDecision(decision, delayMs);
          expect(record.decision).toBe(effective);

          // The operation acted exactly once (one resume into an acting phase).
          expect(store.actingTransitions).toHaveLength(1);
          const acting = store.actingTransitions[0];

          // Approve -> EXECUTING (operation runs); deny/timeout -> SYNTHESIZING (operation cancelled).
          expect(acting.phase).toBe(effective === "approve" ? "EXECUTING" : "SYNTHESIZING");

          // Property 14: the decision record is present at the instant the operation acts, and it
          // carries the decision, the deciding identity, and a timestamp.
          expect(acting.decisionRecordedBeforeActing).toBe(true);
          expect(acting.record).toMatchObject({
            decision: effective,
            decidedBy,
            decidedAt,
          });

          // Defense in depth: the resume event itself is the recorded decision (atomic with acting).
          const events = await store.listEvents(run.id);
          const last = events[events.length - 1];
          expect(decisionRecordOf(last)).toMatchObject({ decision: effective, decidedBy, decidedAt });
        }
      ),
      { numRuns: 100 }
    );
  }, 60_000);
});
