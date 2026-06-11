import { z } from "zod";

export const RUN_PHASES = [
  "CHAT_RECEIVED",
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
  "DONE",
  "NEEDS_DECISION",
  "FAILED",
  "ABORTED",
] as const;

export const RunPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/**
 * The canonical Terminal_Phase set: a run that reaches one of these phases has finished its
 * lifecycle and no further phase transitions follow. Streaming (ORN-40) ends a stream exactly once
 * when an event carrying one of these phases is observed; the cost/observability surfaces treat
 * them as run-final. This is the single source of truth — consumers MUST use `isTerminalRunPhase`
 * (or this set) rather than hardcoding the phase names.
 */
export const TERMINAL_RUN_PHASES = ["DONE", "NEEDS_DECISION", "FAILED", "ABORTED"] as const;
export type TerminalRunPhase = (typeof TERMINAL_RUN_PHASES)[number];

const TERMINAL_RUN_PHASE_SET: ReadonlySet<RunPhase> = new Set<RunPhase>(TERMINAL_RUN_PHASES);

/** True when `phase` is a Terminal_Phase (`DONE`, `NEEDS_DECISION`, `FAILED`, or `ABORTED`). */
export function isTerminalRunPhase(phase: RunPhase): phase is TerminalRunPhase {
  return TERMINAL_RUN_PHASE_SET.has(phase);
}

export const RUN_PHASE_STATUS_LABELS: Record<RunPhase, string> = {
  CHAT_RECEIVED: "Thinking",
  TRIAGE: "Thinking",
  CONTEXT_BUILDING: "Thinking",
  PLANNING: "Planning",
  SKEPTIC_REVIEW: "Planning",
  CRUCIBLE: "Planning",
  DAG_COMPILATION: "Planning",
  EXECUTING: "Executing",
  VALIDATING: "Validating",
  HEALING: "Repairing",
  SYNTHESIZING: "Thinking",
  DONE: "Done",
  NEEDS_DECISION: "Needs decision",
  FAILED: "Failed",
  ABORTED: "Failed",
};
