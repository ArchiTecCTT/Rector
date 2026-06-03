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
