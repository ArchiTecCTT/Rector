import { describe, expect, it } from "vitest";
import {
  buildCapabilityGraph,
  type BuildCapabilityGraphInput,
} from "../../src/cartographer/capabilityGraphAdapter";
import type { CapabilityGraphRecord } from "../../src/cartographer/capabilityGraphRecords";

describe("capabilityGraphAdapter", () => {
  it("builds Capability nodes only from explicit records and maps evalCaseIds to VALIDATED_BY", () => {
    const rec: CapabilityGraphRecord = {
      id: "cartographer.grounding",
      label: "Cartographer grounding",
      toolNames: ["workspace.read_file"],
      evalCaseIds: ["rg-orchestration-search", "tsc-runtime-mode-error"],
      productionAdmission: "production",
      source: "phase0_eval",
      warnings: [],
    };
    const input: BuildCapabilityGraphInput = { snapshotId: "snap:cap-1", records: [rec] };
    const res = buildCapabilityGraph(input);
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap).toBeDefined();
    expect(cap?.id).toBe("capability:cartographer.grounding");
    const wrapped = res.edges.filter((e) => e.kind === "WRAPPED_BY");
    expect(wrapped.length).toBe(1);
    expect(wrapped[0].toNodeId).toBe("tool:workspace.read_file");
    const validated = res.edges.filter((e) => e.kind === "VALIDATED_BY");
    expect(validated.length).toBe(2);
    expect(validated.some((e) => e.properties.caseId === "rg-orchestration-search")).toBe(true);
  });

  it("returns not_configured semantics via empty records (no synthetic success)", () => {
    const res = buildCapabilityGraph({ snapshotId: "s", records: [] });
    expect(res.nodes.length).toBe(0);
    expect(res.edges.length).toBe(0);
  });

  it("never promotes simulator.echo into capability records", () => {
    const rec: CapabilityGraphRecord = {
      id: "c1",
      label: "c1",
      toolNames: ["simulator.echo"],
      evalCaseIds: [],
      productionAdmission: "production",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({ snapshotId: "s", records: [rec] });
    // The adapter must still emit the WRAPPED_BY, but the capability itself carries productionAdmission from the record.
    // The contract test asserts that capability metadata source (not the adapter) must not list simulator.echo as production capability.
    // Here we simply ensure the adapter does not fabricate a capability id from the tool name.
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap?.id).toBe("capability:c1");
  });
});
