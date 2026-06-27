import { describe, expect, it } from "vitest";
import {
  buildCapabilityGraph,
  type BuildCapabilityGraphInput,
} from "../../src/cartographer/capabilityGraphAdapter";
import type { CapabilityGraphRecord } from "../../src/cartographer/capabilityGraphRecords";
import { createDefaultToolRegistry } from "../../src/tools";
import { buildToolGraph } from "../../src/cartographer/toolGraphAdapter";

describe("capabilityGraphAdapter", () => {
  it("builds Capability nodes only from explicit records and maps evalCaseIds to VALIDATED_BY", () => {
    const rec: CapabilityGraphRecord = {
      id: "cartographer.grounding",
      label: "Cartographer grounding",
      toolNames: ["workspace.read_file"],
      evalCaseIds: ["rg-orchestration-search", "tsc-runtime-mode-error"],
      productionAdmission: "production",
      risk: "low",
      source: "phase0_eval",
      warnings: [],
    };
    const input: BuildCapabilityGraphInput = { snapshotId: "snap:cap-1", records: [rec] };
    const res = buildCapabilityGraph(input);
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap).toBeDefined();
    expect(cap?.id).toBe("capability:cartographer.grounding");
    expect(cap?.properties.risk).toBe("low");
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

  it("downgrades simulator.echo production capabilities using default admissions when toolAdmissions omitted", () => {
    const rec: CapabilityGraphRecord = {
      id: "c1",
      label: "c1",
      toolNames: ["simulator.echo"],
      evalCaseIds: [],
      productionAdmission: "production",
      risk: "high",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({ snapshotId: "s", records: [rec] });
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap?.properties.productionAdmission).toBe("quarantined");
    const warnings = JSON.parse(String(cap?.properties.warnings ?? "[]")) as string[];
    expect(warnings).toContain("production-capability-wraps-nonproduction-tool:simulator.echo");
  });

  it("downgrades production capabilities that wrap non-production tools when toolAdmissions are supplied", () => {
    const registry = createDefaultToolRegistry();
    const toolGraph = buildToolGraph({ snapshotId: "snap-tools", toolEntries: registry.snapshot() });
    const toolAdmissions = Object.fromEntries(
      toolGraph.nodes.map((n) => [n.label, n.properties.productionAdmission as string]),
    ) as Record<string, "production" | "test_only" | "report_only" | "quarantined">;

    const rec: CapabilityGraphRecord = {
      id: "c1",
      label: "c1",
      toolNames: ["simulator.echo"],
      evalCaseIds: [],
      productionAdmission: "production",
      risk: "high",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({ snapshotId: "s", records: [rec], toolAdmissions });
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap?.id).toBe("capability:c1");
    expect(cap?.properties.productionAdmission).toBe("quarantined");
    const warnings = JSON.parse(String(cap?.properties.warnings ?? "[]")) as string[];
    expect(warnings).toContain("production-capability-wraps-nonproduction-tool:simulator.echo");
  });

  it("downgrades when explicit toolAdmissions mark a tool quarantined", () => {
    const rec: CapabilityGraphRecord = {
      id: "c-quarantine",
      label: "c-quarantine",
      toolNames: ["fake.tool"],
      evalCaseIds: [],
      productionAdmission: "production",
      risk: "destructive",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({
      snapshotId: "s",
      records: [rec],
      toolAdmissions: { "fake.tool": "quarantined" },
    });
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap?.properties.productionAdmission).toBe("quarantined");
    const warnings = JSON.parse(String(cap?.properties.warnings ?? "[]")) as string[];
    expect(warnings).toContain("production-capability-wraps-nonproduction-tool:fake.tool");
  });

  it("emits WRAPPED_BY once when toolNames repeat", () => {
    const rec: CapabilityGraphRecord = {
      id: "dup-wrap",
      label: "dup-wrap",
      toolNames: ["workspace.read_file", "workspace.read_file"],
      evalCaseIds: ["eval-1", "eval-1"],
      productionAdmission: "production",
      risk: "low",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({ snapshotId: "s", records: [rec] });
    const wrapped = res.edges.filter((e) => e.kind === "WRAPPED_BY");
    const validated = res.edges.filter((e) => e.kind === "VALIDATED_BY");
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].toNodeId).toBe("tool:workspace.read_file");
    expect(validated).toHaveLength(1);
    expect(validated[0].toNodeId).toBe("evalcase:eval-1");
  });

  it("deduplicates guardrail warnings when toolNames repeat", () => {
    const rec: CapabilityGraphRecord = {
      id: "dup",
      label: "dup",
      toolNames: ["simulator.echo", "simulator.echo"],
      evalCaseIds: [],
      productionAdmission: "production",
      risk: "high",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({ snapshotId: "s", records: [rec] });
    const cap = res.nodes.find((n) => n.kind === "Capability");
    const warnings = JSON.parse(String(cap?.properties.warnings ?? "[]")) as string[];
    const matches = warnings.filter((w) => w === "production-capability-wraps-nonproduction-tool:simulator.echo");
    expect(matches).toHaveLength(1);
  });

  it("keeps production admission for production-safe tool sets", () => {
    const registry = createDefaultToolRegistry();
    const toolGraph = buildToolGraph({ snapshotId: "snap-tools", toolEntries: registry.snapshot() });
    const toolAdmissions = Object.fromEntries(
      toolGraph.nodes.map((n) => [n.label, n.properties.productionAdmission as string]),
    ) as Record<string, "production" | "test_only" | "report_only" | "quarantined">;

    const rec: CapabilityGraphRecord = {
      id: "safe",
      label: "safe",
      toolNames: ["workspace.read_file"],
      evalCaseIds: [],
      productionAdmission: "production",
      risk: "low",
      source: "manual_fixture",
      warnings: [],
    };
    const res = buildCapabilityGraph({ snapshotId: "s", records: [rec], toolAdmissions });
    const cap = res.nodes.find((n) => n.kind === "Capability");
    expect(cap?.properties.productionAdmission).toBe("production");
    expect(cap?.properties.risk).toBe("low");
  });
});
