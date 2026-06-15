import crypto from "node:crypto";
import { isTerminalRunPhase, type RunPhase } from "../protocol/phases";
import { redactString } from "../security/redaction";
import type { RectorStore } from "../store";
import type { Run } from "../store/schemas";
import { runEvent } from "./externalRunSupport";

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const STEER_MESSAGE_MAX_LENGTH = 4_000;
export const MAX_STEER_QUEUE_SIZE = 20;
const STEER_PREVIEW_MAX_LENGTH = 180;

export type RunControlState = {
  runId?: string;
  interruptRequested: boolean;
  interruptReason?: string;
  steerQueue: string[];
  abortController: AbortController;
  createdAt: number;
  updatedAt: number;
};

export type InterruptRunResult =
  | { ok: true; run: Run; status: "aborting"; mutated: true }
  | { ok: true; run: Run; status: "already_terminal"; mutated: false }
  | { ok: false; status: "not_found" };

export type SteerRunResult =
  | { ok: true; run: Run; queued: true }
  | { ok: true; run: Run; queued: false; status: "already_terminal" | "empty" }
  | { ok: false; status: "not_found" };

const stateByRunId = new Map<string, RunControlState>();

export function createRunControlState(runId?: string): RunControlState {
  return {
    runId,
    interruptRequested: false,
    steerQueue: [],
    abortController: new AbortController(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function registerRunControl(runId: string, state: RunControlState = createRunControlState(runId)): RunControlState {
  cleanupRunControlStates();
  state.runId = runId;
  touch(state);
  stateByRunId.set(runId, state);
  return state;
}

export function getRunControlState(runId: string): RunControlState | undefined {
  return stateByRunId.get(runId);
}

export function clearRunControl(runId: string): void {
  stateByRunId.delete(runId);
}

export function requestInterrupt(state: RunControlState, reason?: string): void {
  state.interruptRequested = true;
  const redactedReason = redactOptional(reason);
  if (redactedReason) state.interruptReason = redactedReason;
  touch(state);
  if (!state.abortController.signal.aborted) {
    state.abortController.abort(new DOMException(state.interruptReason ?? "Run interrupted", "AbortError"));
  }
}

export function enqueueSteer(state: RunControlState, message: string): void {
  const redacted = redactString(message).trim().slice(0, STEER_MESSAGE_MAX_LENGTH);
  if (redacted.length === 0) return;
  if (state.steerQueue.length >= MAX_STEER_QUEUE_SIZE) {
    state.steerQueue.shift();
    console.warn("[RUN_CONTROL] Steer queue at capacity, dropping oldest message");
  }
  state.steerQueue.push(redacted);
  touch(state);
}

export function drainSteer(state: RunControlState): string | undefined {
  const message = state.steerQueue.shift();
  touch(state);
  return message;
}

export function createAbortSignal(state: RunControlState): AbortSignal {
  if (state.interruptRequested && !state.abortController.signal.aborted) {
    state.abortController.abort(new DOMException(state.interruptReason ?? "Run interrupted", "AbortError"));
  }
  return state.abortController.signal;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function throwIfRunInterrupted(state: RunControlState): void {
  if (!state.interruptRequested && !state.abortController.signal.aborted) return;
  throw new DOMException(state.interruptReason ?? "Run interrupted", "AbortError");
}

export async function interruptRun(
  store: RectorStore,
  runId: string,
  reason?: string,
): Promise<InterruptRunResult> {
  const run = await store.getRun(runId);
  if (!run) return { ok: false, status: "not_found" };
  if (isTerminalRunPhase(run.phase)) {
    return { ok: true, run, status: "already_terminal", mutated: false };
  }

  const state = registerRunControl(runId, getRunControlState(runId) ?? createRunControlState(runId));
  const alreadyRequested = state.interruptRequested;
  requestInterrupt(state, reason);
  if (!alreadyRequested) {
    await store.appendEvent(
      runEvent(run, "RUN_INTERRUPT_REQUESTED", run.phase, {
        reason: state.interruptReason,
        requestedAt: new Date().toISOString(),
      }),
    );
  }
  return { ok: true, run, status: "aborting", mutated: true };
}

export async function steerRun(
  store: RectorStore,
  runId: string,
  message: string,
): Promise<SteerRunResult> {
  const run = await store.getRun(runId);
  if (!run) return { ok: false, status: "not_found" };
  if (isTerminalRunPhase(run.phase)) {
    return { ok: true, run, queued: false, status: "already_terminal" };
  }

  const state = registerRunControl(runId, getRunControlState(runId) ?? createRunControlState(runId));
  const beforeLength = state.steerQueue.length;
  enqueueSteer(state, message);
  const queued = state.steerQueue.length > beforeLength;
  if (queued) {
    await store.appendEvent(
      runEvent(run, "RUN_STEER_ENQUEUED", run.phase, {
        messagePreview: preview(state.steerQueue[state.steerQueue.length - 1]),
        queuedAt: new Date().toISOString(),
      }),
    );
  }
  return queued ? { ok: true, run, queued: true } : { ok: true, run, queued: false, status: "empty" };
}

export function runControlPayload(state: RunControlState): Record<string, unknown> {
  return {
    interruptRequested: state.interruptRequested,
    interruptReason: state.interruptReason,
    steerQueueLength: state.steerQueue.length,
  };
}

export function syntheticAbortEventId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `evt-abort-${Date.now()}`;
  }
}

function cleanupRunControlStates(ttlMs = DEFAULT_STATE_TTL_MS): void {
  const cutoff = Date.now() - ttlMs;
  for (const [runId, state] of stateByRunId.entries()) {
    if (state.updatedAt < cutoff) stateByRunId.delete(runId);
  }
}

function touch(state: RunControlState): void {
  state.updatedAt = Date.now();
}

function redactOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactString(value).trim();
  return redacted.length > 0 ? redacted : undefined;
}

function preview(value: string | undefined): string {
  const redacted = redactString(value ?? "");
  return redacted.length <= STEER_PREVIEW_MAX_LENGTH
    ? redacted
    : `${redacted.slice(0, STEER_PREVIEW_MAX_LENGTH)}...`;
}
