import { z } from "zod";
import { RunPhaseSchema } from "./phases";

export const RUN_EVENT_TYPES = [
  "RUN_CREATED",
  "PHASE_CHANGED",
  "ENVELOPE_SENT",
  "DAG_COMPILED",
  "DAG_NODE_STARTED",
  "DAG_NODE_COMPLETED",
  "DAG_NODE_FAILED",
  "VALIDATION_PASSED",
  "VALIDATION_FAILED",
  "HEALING_STARTED",
  "HEALING_APPLIED",
  "DECISION_REQUESTED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_ABORTED",
  "BUDGET_CHECKED",
  "ARTIFACT_CREATED",
  "CONTEXT_BUDGET_EVALUATED",
  "CONTEXT_COMPRESSED",
  "STABLE_TIER_MUTATION_BLOCKED",
  "SKILL_ACTIVATION_DECIDED",
  "TOOL_INVOKED",
  "TOOL_COMPLETED",
] as const;

export const RunEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: RunEventTypeSchema,
  phase: RunPhaseSchema,
  payload: z.record(z.unknown()).default({}),
  traceId: z.string().min(1).optional(),
  redactionState: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});

export type RunEvent = z.infer<typeof RunEventSchema>;
