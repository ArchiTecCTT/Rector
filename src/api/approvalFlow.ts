import { createDecisionRequest, resumeFromDecision } from "../orchestration/runStateMachine";
import type { RunTransitionResult } from "../orchestration/runStateMachine";
import { redactStringOrSuppress } from "../security/redaction";
import type { RectorStore } from "../store";

/**
 * Run Approval UX — decision recorder (Requirement 9).
 *
 * This module binds the existing run `NEEDS_DECISION` state (and the sandbox `NEEDS_APPROVAL`
 * operation result that triggers it) to a recorded user decision, reusing the existing run state
 * machine (`createDecisionRequest` / `resumeFromDecision`) and the existing `Event_Log` rather than
 * a new persistence path. It adds no new execution capability: it only records a decision and asks
 * the state machine to continue (execute the approved operation) or cancel it (continue the run to a
 * final answer that excludes the denied operation, leaving targets unchanged).
 */

/** An explicit user decision over a pending operation. */
export type ApprovalDecision = "approve" | "deny";

/**
 * The recorded outcome of a decision. `timeout-denied` is produced when a decision arrives (or is
 * swept) more than {@link APPROVAL_DECISION_TIMEOUT_MS} after the operation was presented — a stale
 * approval can never execute a risky command (Requirement 9.8).
 */
export type RecordedApprovalDecision = ApprovalDecision | "timeout-denied";

/**
 * The redacted view of a pending operation shown to the user before any decision can be submitted
 * (Requirement 9.2). Every field is routed through the Redaction_Layer so no unredacted secret can
 * appear in the displayed diff, command, or target path (Requirement 9.6).
 */
export interface ApprovalRequestView {
  runId: string;
  operationId: string;
  diff: string;
  command?: string;
  targetPath: string;
}

/**
 * The decision-request payload persisted on the run (`run.decisionRequest`) and streamed over SSE
 * when an operation is presented for approval. Carries only non-secret identifiers, the presentation
 * timestamp (used for the 30-minute timeout), whether the operation is a risky command, and the
 * redacted operation view.
 */
export interface ApprovalDecisionRequest {
  kind: "approval";
  operationId: string;
  presentedAt: string;
  riskyCommand: boolean;
  view: ApprovalRequestView;
}

/** The persisted decision record (also the `decision` payload on the resume Event_Log entry). */
export interface ApprovalDecisionRecord {
  runId: string;
  operationId: string;
  decision: RecordedApprovalDecision;
  decidedBy: string;
  decidedAt: string;
}

/** Codes describing why a decision could not be processed (Requirement 9.7). */
export type ApprovalProcessingErrorCode =
  | "RUN_NOT_FOUND"
  | "NOT_AWAITING_DECISION"
  | "OPERATION_MISMATCH"
  | "RECORD_FAILED";

/**
 * Raised when the Approval_Flow cannot present an operation for decision or cannot record a decision
 * in the Event_Log. The run is left in its pending-decision state (the state-machine commit is
 * atomic, so a failed resume never mutates the run) and the caller surfaces an indication that the
 * decision could not be processed (Requirement 9.7).
 */
export class ApprovalProcessingError extends Error {
  readonly name = "ApprovalProcessingError";
  readonly code: ApprovalProcessingErrorCode;
  constructor(message: string, code: ApprovalProcessingErrorCode) {
    super(message);
    this.code = code;
  }
}

/** No decision within 30 minutes of presentation is treated as a denial (Requirement 9.8). */
export const APPROVAL_DECISION_TIMEOUT_MS = 30 * 60 * 1000;

export interface ApprovalFlowOptions {
  now?: () => string;
}

/**
 * Present a pending sandbox operation (a `NEEDS_APPROVAL` result) for a user decision by moving the
 * run into `NEEDS_DECISION` via `createDecisionRequest` (Requirements 9.1, 9.2).
 *
 * The persisted/streamed decision request carries only the redacted operation view plus non-secret
 * identifiers and a `presentedAt` timestamp. `createDecisionRequest` already routes the payload
 * through the Redaction_Layer; the view fields are additionally pre-redacted here for defense in
 * depth (Requirement 9.6).
 */
export async function presentApprovalRequest(
  store: RectorStore,
  input: { runId: string; operationId: string; view: ApprovalRequestView; riskyCommand?: boolean },
  options: ApprovalFlowOptions = {}
): Promise<RunTransitionResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const presentedAt = now();

  const request: ApprovalDecisionRequest = {
    kind: "approval",
    operationId: input.operationId,
    presentedAt,
    riskyCommand: input.riskyCommand ?? false,
    view: redactApprovalView(input.view),
  };

  return createDecisionRequest(store, input.runId, request as unknown as Record<string, unknown>, { now });
}

/**
 * Record a user's approve/deny decision over a pending operation and continue the run.
 *
 * Guarantees:
 * - The decision, the deciding identity, and a timestamp are appended to the Event_Log atomically
 *   with the run transition, before the operation is executed or cancelled (Requirement 9.3).
 * - An `approve` decision resumes the run to `EXECUTING` so the approved operation can run; a `deny`
 *   (or timeout) decision resumes to `SYNTHESIZING` so the run continues to a final answer that
 *   excludes the operation, leaving its targets unchanged (Requirements 9.5, 9.8).
 * - A risky shell command therefore never runs without a recorded approval: only a genuine,
 *   non-stale `approve` produces an executing transition (Requirement 9.4).
 * - If the run is not awaiting this operation's decision, or the Event_Log write fails, an
 *   {@link ApprovalProcessingError} is thrown and the run stays pending (Requirement 9.7).
 * - A decision submitted more than 30 minutes after presentation is downgraded to `timeout-denied`
 *   regardless of the submitted value (Requirement 9.8).
 */
export async function recordApprovalDecision(
  store: RectorStore,
  input: { runId: string; operationId: string; decision: ApprovalDecision; decidedBy: string },
  options: ApprovalFlowOptions = {}
): Promise<ApprovalDecisionRecord> {
  const now = options.now ?? (() => new Date().toISOString());
  const decidedAt = now();

  const run = await store.getRun(input.runId);
  if (!run) {
    throw new ApprovalProcessingError(`Run not found: ${input.runId}`, "RUN_NOT_FOUND");
  }

  // The run must be awaiting a decision; otherwise there is nothing to record (Requirement 9.7).
  if (run.phase !== "NEEDS_DECISION" || run.decisionRequest === undefined) {
    throw new ApprovalProcessingError(
      `Run ${input.runId} is not awaiting an approval decision.`,
      "NOT_AWAITING_DECISION"
    );
  }

  // The presented operation must match the one being decided.
  const request = parseApprovalRequest(run.decisionRequest);
  if (!request || request.operationId !== input.operationId) {
    throw new ApprovalProcessingError(
      `No pending operation "${input.operationId}" is awaiting a decision on run ${input.runId}.`,
      "OPERATION_MISMATCH"
    );
  }

  // A stale decision past the 30-minute window is a timeout denial: a late "approve" can never run
  // the operation (Requirement 9.8).
  const decision = resolveEffectiveDecision(input.decision, request.presentedAt, decidedAt);

  const record: ApprovalDecisionRecord = {
    runId: input.runId,
    operationId: input.operationId,
    decision,
    decidedBy: input.decidedBy,
    decidedAt,
  };

  // Approval continues to execution; denial/timeout continues to a final answer excluding it.
  const targetPhase = decision === "approve" ? "EXECUTING" : "SYNTHESIZING";

  try {
    // `resumeFromDecision` atomically appends the decision event (carrying the decision, the
    // deciding identity, and the timestamp) to the Event_Log AND applies the phase transition.
    // Because the commit is atomic, a failure leaves the run untouched/pending (Requirement 9.7);
    // on success the decision is recorded before the operation executes or is cancelled
    // (Requirement 9.3).
    await resumeFromDecision(store, input.runId, targetPhase, record, { now });
  } catch (error) {
    throw new ApprovalProcessingError(
      `Failed to record approval decision for run ${input.runId}: ${messageOf(error)}`,
      "RECORD_FAILED"
    );
  }

  return record;
}

/**
 * Redact each displayed field of an operation view (Requirement 9.6) with outbound-failure
 * suppression (Requirement 11.5): each field is routed through `redactStringOrSuppress`, so if
 * redaction of a field throws, that field's raw content is suppressed and replaced with the fixed
 * redaction-failed placeholder rather than streamed unredacted in the `ApprovalRequestView`.
 */
function redactApprovalView(view: ApprovalRequestView): ApprovalRequestView {
  return {
    runId: view.runId,
    operationId: view.operationId,
    diff: redactStringOrSuppress(view.diff),
    command: view.command === undefined ? undefined : redactStringOrSuppress(view.command),
    targetPath: redactStringOrSuppress(view.targetPath),
  };
}

/**
 * Best-effort parse of the persisted (already-redacted) decision request back into an
 * {@link ApprovalDecisionRequest}. Returns `undefined` when the stored value is not an approval
 * request (so a non-approval decision request is never mistaken for one).
 */
function parseApprovalRequest(value: Record<string, unknown>): ApprovalDecisionRequest | undefined {
  if (value.kind !== "approval") return undefined;
  const operationId = value.operationId;
  const presentedAt = value.presentedAt;
  if (typeof operationId !== "string" || operationId.length === 0) return undefined;
  if (typeof presentedAt !== "string" || presentedAt.length === 0) return undefined;
  return {
    kind: "approval",
    operationId,
    presentedAt,
    riskyCommand: value.riskyCommand === true,
    view: (value.view ?? {}) as ApprovalRequestView,
  };
}

/** A decision recorded >= 30 minutes after presentation is a timeout denial (Requirement 9.8). */
function resolveEffectiveDecision(
  decision: ApprovalDecision,
  presentedAt: string,
  decidedAt: string
): RecordedApprovalDecision {
  const presented = Date.parse(presentedAt);
  const decided = Date.parse(decidedAt);
  if (Number.isFinite(presented) && Number.isFinite(decided) && decided - presented >= APPROVAL_DECISION_TIMEOUT_MS) {
    return "timeout-denied";
  }
  return decision;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
