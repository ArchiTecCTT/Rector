import { z } from "zod";
import { STATES } from "./states";

/** A single subtask within a task */
export const SubtaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  result: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
});

export type Subtask = z.infer<typeof SubtaskSchema>;

/** Event record for history */
export const EventSchema = z.object({
  id: z.string(),
  topic: z.string(),
  payload: z.record(z.unknown()),
  timestamp: z.number(),
});

export type Event = z.infer<typeof EventSchema>;

/** The task state machine document */
export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  state: z.enum([
    STATES.INTAKE,
    STATES.ARCHITECTURAL_PLAN,
    STATES.SLM_EXECUTION_FANOUT,
    STATES.SANDBOX_VALIDATION,
    STATES.HEALING_LOOP,
    STATES.FINAL_SYNTHESIS,
    STATES.HUMAN_HANDOFF,
    STATES.PAUSED,
    STATES.ABORTED,
  ]),
  previousState: z.string().optional(),
  subtasks: z.array(SubtaskSchema),
  events: z.array(EventSchema),
  output: z.string().optional(),
  approved: z.boolean().optional(),
  validationResult: z
    .object({
      passed: z.boolean(),
      errors: z.array(z.string()),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Task = z.infer<typeof TaskSchema>;
