import { z } from "zod";
import { RunEventSchema, type RunEvent, type RunEventType } from "../protocol/events";
import { RunPhaseSchema, type RunPhase } from "../protocol/phases";
import { SpecialistTaskPacketSchema, type SpecialistTaskPacket } from "../systems/contracts";

/**
 * Build a minimal valid SpecialistTaskPacket for dry-run traces.
 * Caller must ensure systemId is in allowed/forbidden lists for delegation_quality tests.
 */
export function buildTaskPacket(overrides: Partial<SpecialistTaskPacket> = {}): SpecialistTaskPacket {
  const base: SpecialistTaskPacket = {
    taskId: "task-dry-001",
    systemId: "coding-basic-fix",
    userGoal: "Fix the failing test in src/calculator.ts",
    successCriteria: ["All tests pass", "No new linter errors"],
    constraints: ["Edit only src/calculator.ts"],
    allowedScopes: ["src/calculator.ts"],
    forbiddenScopes: ["package.json"],
    memoryPacketRefs: [],
    capabilityHints: ["typescript", "vitest"],
    validationRequirements: ["tsc --noEmit", "vitest run"],
    budget: { maxUsd: 0.01, maxRuntimeMs: 30_000, maxToolCalls: 10 },
    riskTolerance: "low",
  };
  const merged = { ...base, ...overrides };
  return SpecialistTaskPacketSchema.parse(merged);
}

/**
 * Build a deterministic RunEvent trace using ONLY phases from RunPhaseSchema.
 * Never invents phases. All events validate under RunEventSchema.
 */
export function buildRunTrace(
  runId: string,
  phases: readonly RunPhase[],
  basePayload: Record<string, unknown> = {},
): RunEvent[] {
  const events: RunEvent[] = [];
  let t = 0;
  for (const phase of phases) {
    const ev = RunEventSchema.parse({
      id: `evt-${runId}-${t}`,
      runId,
      type: (phase === "CHAT_RECEIVED" ? "RUN_CREATED" : "PHASE_CHANGED") as RunEventType,
      phase,
      payload: { ...basePayload, step: t },
      createdAt: new Date(Date.now() + t * 1000).toISOString(),
    });
    events.push(ev);
    t++;
  }
  // Terminal phase
  const terminal = RunEventSchema.parse({
    id: `evt-${runId}-${t}`,
    runId,
    type: "RUN_COMPLETED",
    phase: "DONE",
    payload: { ...basePayload, terminal: true },
    createdAt: new Date(Date.now() + t * 1000).toISOString(),
  });
  events.push(terminal);
  return events;
}

/**
 * Validate that a trace only uses canonical phases and validates under RunEventSchema.
 */
export function validateTrace(trace: readonly RunEvent[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const ev of trace) {
    const parsed = RunEventSchema.safeParse(ev);
    if (!parsed.success) {
      errors.push(`invalid event ${ev.id}: ${parsed.error.message}`);
    }
    const phaseOk = RunPhaseSchema.safeParse(ev.phase).success;
    if (!phaseOk) {
      errors.push(`unknown phase ${ev.phase} in event ${ev.id}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
