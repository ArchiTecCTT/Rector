import crypto from "node:crypto";
import type { RunEvent, RunEventType } from "../protocol/events";
import type { RunPhase } from "../protocol/phases";
import { redactSecrets } from "../security/redaction";
import type { Run, UpdateRunInput } from "../store/schemas";

/** Thrown when an optimistic-concurrency transition detects a version mismatch (M21).
 *  Callers should retry the transition up to `maxTransitionRetries` times. */
export class ConcurrentTransitionError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number
  ) {
    super(
      `Concurrent transition conflict for run ${runId}: expected version ${expectedVersion}, actual ${actualVersion}`
    );
    this.name = "ConcurrentTransitionError";
  }
}

/** Maximum number of retries for a run transition when a ConcurrentTransitionError occurs (M21). */
export const maxTransitionRetries = 3;

export type RunStateMachineStore = {
  getRun(id: string): Promise<Run | undefined>;
  updateRun(id: string, patch: UpdateRunInput): Promise<Run | undefined>;
  appendEvent(event: RunEvent): Promise<RunEvent>;
  commitRunTransition(
    runId: string,
    patch: UpdateRunInput,
    event: RunEvent
  ): Promise<{ run: Run; event: RunEvent }>;
};

export type RunTransitionOptions = {
  now?: () => string;
  eventId?: () => string;
  payload?: Record<string, unknown>;
  traceId?: string;
  attempts?: number;
  healingAttempts?: number;
  validationAttempts?: number;
  lastError?: string;
  decisionRequest?: Record<string, unknown>;
  decision?: unknown;
};

export type RunTransitionResult = {
  run: Run;
  event: RunEvent;
};

export const ALLOWED_RUN_PHASE_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  // CHAT_RECEIVED represents the forced/initial phase of a run when a user chat message is first received.
  // It only transitions directly to TRIAGE to start the orchestration workflow.
  CHAT_RECEIVED: ["TRIAGE"],
  TRIAGE: ["CONTEXT_BUILDING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  CONTEXT_BUILDING: ["PLANNING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  PLANNING: ["SKEPTIC_REVIEW", "NEEDS_DECISION", "FAILED", "ABORTED"],
  SKEPTIC_REVIEW: ["CRUCIBLE", "PLANNING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  CRUCIBLE: ["DAG_COMPILATION", "PLANNING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  DAG_COMPILATION: ["EXECUTING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  EXECUTING: ["VALIDATING", "HEALING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  VALIDATING: ["SYNTHESIZING", "HEALING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  HEALING: ["VALIDATING", "NEEDS_DECISION", "FAILED", "ABORTED"],
  SYNTHESIZING: ["DONE", "NEEDS_DECISION", "FAILED", "ABORTED"],
  // M20: NEEDS_DECISION transitions restricted to minimal set.
  // Removed: TRIAGE, CONTEXT_BUILDING, SKEPTIC_REVIEW, CRUCIBLE,
  //   DAG_COMPILATION, VALIDATING, HEALING
  // These could allow injection to bypass orchestration safeguards.
  NEEDS_DECISION: [
    "EXECUTING",    // approve operation
    "SYNTHESIZING", // deny operation, produce final answer
    "PLANNING",     // re-plan after decision
    "FAILED",       // timeout/abort
    "ABORTED",      // user abort
  ],
  DONE: [],
  FAILED: [],
  ABORTED: [],
};

let generatedEventCounter = 0;

export function isAllowedRunPhaseTransition(fromPhase: RunPhase, toPhase: RunPhase): boolean {
  return ALLOWED_RUN_PHASE_TRANSITIONS[fromPhase].includes(toPhase);
}

export async function transitionRun(
  store: RunStateMachineStore,
  runId: string,
  targetPhase: RunPhase,
  options: RunTransitionOptions = {}
): Promise<RunTransitionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxTransitionRetries; attempt++) {
    const run = await store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    validateTransition(run.phase, targetPhase, options);

    const patch = buildRunPatch(targetPhase, options);
    // Increment version for optimistic concurrency (M21)
    patch.version = (run.version ?? 0) + 1;
    const event = buildRunEvent(
      run,
      run.phase,
      targetPhase,
      eventTypeForTargetPhase(targetPhase),
      options
    );

    try {
      return await store.commitRunTransition(runId, patch, event);
    } catch (error) {
      if (error instanceof ConcurrentTransitionError) {
        lastError = error;
        // Retry: re-read the run and try again
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function createDecisionRequest(
  store: RunStateMachineStore,
  runId: string,
  decisionRequest: Record<string, unknown>,
  options: Omit<RunTransitionOptions, "decisionRequest" | "decision"> = {}
): Promise<RunTransitionResult> {
  return transitionRun(store, runId, "NEEDS_DECISION", {
    ...options,
    decisionRequest,
  });
}

export async function abortRun(
  store: RunStateMachineStore,
  runId: string,
  options: Omit<RunTransitionOptions, "lastError"> & { lastError?: string } = {}
): Promise<RunTransitionResult> {
  return transitionRun(store, runId, "ABORTED", {
    ...options,
    lastError: redactStringOption(options.lastError ?? "Run interrupted by request"),
  });
}

/**
 * Resumes a run from a decision request, transitioning to the target phase.
 * M20: Target phases restricted to EXECUTING, SYNTHESIZING, PLANNING, FAILED, ABORTED.
 * Removed: TRIAGE, CONTEXT_BUILDING, SKEPTIC_REVIEW, CRUCIBLE, DAG_COMPILATION,
 *   VALIDATING, HEALING — these could allow injection to bypass safeguards.
 */
export async function resumeFromDecision(
  store: RunStateMachineStore,
  runId: string,
  targetPhase: "EXECUTING" | "SYNTHESIZING" | "PLANNING" | "FAILED" | "ABORTED",
  decision: unknown,
  options: Omit<RunTransitionOptions, "decision"> = {}
): Promise<RunTransitionResult> {
  if (decision === undefined) {
    throw new Error("Decision input is required to resume run");
  }

  return transitionRun(store, runId, targetPhase, {
    ...options,
    decision,
  });
}

function validateTransition(fromPhase: RunPhase, targetPhase: RunPhase, options: RunTransitionOptions): void {
  if (!isAllowedRunPhaseTransition(fromPhase, targetPhase)) {
    throw new Error(`Invalid run phase transition: ${fromPhase} -> ${targetPhase}`);
  }

  if (fromPhase === "NEEDS_DECISION" && options.decision === undefined) {
    throw new Error("Decision input is required to resume run");
  }
}

function buildRunPatch(targetPhase: RunPhase, options: RunTransitionOptions): UpdateRunInput {
  const patch: UpdateRunInput = {
    phase: targetPhase,
    status: statusForPhase(targetPhase),
  };

  if (options.attempts !== undefined) patch.attempts = options.attempts;
  if (options.healingAttempts !== undefined) patch.healingAttempts = options.healingAttempts;
  if (options.validationAttempts !== undefined) patch.validationAttempts = options.validationAttempts;
  if (options.lastError !== undefined) patch.lastError = options.lastError;

  if (targetPhase === "NEEDS_DECISION") {
    patch.decisionRequest = redactSecrets(options.decisionRequest ?? {});
  } else if (options.decision !== undefined) {
    patch.decisionRequest = undefined;
  }

  return patch;
}

function buildRunEvent(
  run: Run,
  fromPhase: RunPhase,
  targetPhase: RunPhase,
  type: RunEventType,
  options: RunTransitionOptions
): RunEvent {
  const payload: Record<string, unknown> = {
    fromPhase,
    toPhase: targetPhase,
    ...(options.payload ?? {}),
  };

  if (targetPhase === "NEEDS_DECISION") {
    payload.decisionRequest = options.decisionRequest ?? {};
  }

  if (options.decision !== undefined) {
    payload.decision = options.decision;
  }

  if (options.lastError !== undefined) {
    payload.lastError = options.lastError;
  }

  return {
    id: options.eventId?.() ?? nextEventId(),
    runId: run.id,
    type,
    phase: targetPhase,
    payload: redactSecrets(payload),
    traceId: options.traceId ?? run.traceId,
    createdAt: options.now?.() ?? new Date().toISOString(),
  };
}

function eventTypeForTargetPhase(targetPhase: RunPhase): RunEventType {
  switch (targetPhase) {
    case "NEEDS_DECISION":
      return "DECISION_REQUESTED";
    case "DONE":
      return "RUN_COMPLETED";
    case "FAILED":
      return "RUN_FAILED";
    case "ABORTED":
      return "RUN_ABORTED";
    default:
      return "PHASE_CHANGED";
  }
}

function statusForPhase(phase: RunPhase): string {
  switch (phase) {
    case "DONE":
      return "completed";
    case "FAILED":
      return "failed";
    case "ABORTED":
      return "aborted";
    case "NEEDS_DECISION":
      return "needs_decision";
    default:
      return "running";
  }
}

function nextEventId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    generatedEventCounter += 1;
    return `evt-${Date.now()}-${generatedEventCounter}`;
  }
}

function redactStringOption(value: string): string {
  return redactSecrets(value) as string;
}
