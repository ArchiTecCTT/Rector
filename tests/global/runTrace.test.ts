import { describe, it, expect } from "vitest";
import { buildTaskPacket, buildRunTrace, validateTrace } from "../../src/evals/runTrace";
import { RunEventSchema } from "../../src/protocol/events";
import { RunPhaseSchema } from "../../src/protocol/phases";
import { SpecialistTaskPacketSchema } from "../../src/systems/contracts";

describe("runTrace", () => {
  it("buildTaskPacket produces valid SpecialistTaskPacket", () => {
    const pkt = buildTaskPacket();
    expect(() => SpecialistTaskPacketSchema.parse(pkt)).not.toThrow();
  });

  it("buildRunTrace uses only canonical phases and produces valid RunEvents", () => {
    const trace = buildRunTrace("run-1", ["CHAT_RECEIVED", "TRIAGE", "DONE"]);
    expect(trace.length).toBeGreaterThan(0);
    const { valid, errors } = validateTrace(trace);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    for (const ev of trace) {
      expect(() => RunEventSchema.parse(ev)).not.toThrow();
      expect(() => RunPhaseSchema.parse(ev.phase)).not.toThrow();
    }
  });

  it("validateTrace rejects unknown phases", () => {
    const bad = [{ id: "e1", runId: "r1", type: "RUN_CREATED", phase: "INVENTED_PHASE", payload: {}, createdAt: new Date().toISOString() }];
    const { valid } = validateTrace(bad as any);
    expect(valid).toBe(false);
  });
});
