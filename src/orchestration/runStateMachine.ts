import crypto from "node:crypto";
import type { RunEvent, RunEventType } from "../protocol/events";
import type { RunPhase } from "../protocol/phases";
import { redactSecrets } from "../security/redaction";
import type { Run, UpdateRunInput } from "../store/schemas";

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
  NEEDS_DECISION: [
    "TRIAGE",
    "CONTEXT_BUILDING",
    "PLANNING",
    "SKEPTIC_REVIEW",
    "CRUCIBLE",
    "DAG_COMPILATION",
    "EXECUTING",
    "VALIDATING",
    "HEALING",
    "SYNTHESIZING",
    "ABORTED",
    "FAILED",
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
  const run = await store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  validateTransition(run.phase, targetPhase, options);

  const patch = buildRunPatch(targetPhase, options);
  const event = buildRunEvent(
    run,
    run.phase,
    targetPhase,
    eventTypeForTargetPhase(targetPhase),
    options
  );

  return store.commitRunTransition(runId, patch, event);
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
 * Note: Target phases exclude terminal targets (like DONE, FAILED, ABORTED),
 * the initial CHAT_RECEIVED phase, and recursion into NEEDS_DECISION itself.
 */
export async function resumeFromDecision(
  store: RunStateMachineStore,
  runId: string,
  targetPhase: Exclude<RunPhase, "CHAT_RECEIVED" | "DONE" | "NEEDS_DECISION">,
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
