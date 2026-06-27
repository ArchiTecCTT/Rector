import { describe, expect, it } from "vitest";
import {
  buildEvalSuiteGraph,
  makeValidatedByEvalCaseEdge,
  type BuildEvalSuiteGraphInput,
} from "../../src/cartographer/evalSuiteGraphAdapter";

describe("evalSuiteGraphAdapter", () => {
  it("builds RunTrace nodes for explicit evalCaseIds only and produces deterministic sorted output", () => {
    const input: BuildEvalSuiteGraphInput = {
      snapshotId: "snap:eval-1",
      evalCaseIds: ["rg-orchestration-search", "tsc-runtime-mode-error"],
    };
    const res = buildEvalSuiteGraph(input);
    expect(res.nodes.length).toBe(2);
    expect(res.edges.length).toBe(0); // adapter itself does not emit edges; edges come from capability side using explicit records
    const ids = res.nodes.map((n) => n.id);
    expect(ids).toEqual(["evalcase:rg-orchestration-search", "evalcase:tsc-runtime-mode-error"]);
    // deterministic on repeat
    const res2 = buildEvalSuiteGraph(input);
    expect(res2.nodes.map((n) => n.id)).toEqual(ids);
    const n0 = res.nodes[0];
    expect(n0.kind).toBe("RunTrace");
    expect(n0.properties.caseId).toBe("rg-orchestration-search");
    expect(n0.properties.source).toBe("phase0_eval");
  });

  it("returns empty deterministic result for empty explicit metadata (no synthetic success)", () => {
    const res = buildEvalSuiteGraph({ snapshotId: "s", evalCaseIds: [] });
    expect(res.nodes.length).toBe(0);
    expect(res.edges.length).toBe(0);
    const res2 = buildEvalSuiteGraph({ snapshotId: "s", evalCaseIds: [] });
    expect(res2).toEqual(res);
  });

  it("makeValidatedByEvalCaseEdge produces deterministic VALIDATED_BY edge using makeEdgeId and explicit caseId", () => {
    const edge = makeValidatedByEvalCaseEdge("snap:1", "capability:cartographer.grounding", "rg-orchestration-search");
    expect(edge.id).toBe("edge:VALIDATED_BY:capability:cartographer.grounding:evalcase:rg-orchestration-search");
    expect(edge.kind).toBe("VALIDATED_BY");
    expect(edge.fromNodeId).toBe("capability:cartographer.grounding");
    expect(edge.toNodeId).toBe("evalcase:rg-orchestration-search");
    expect(edge.properties.caseId).toBe("rg-orchestration-search");
    expect(edge.evidence?.text).toBe("rg-orchestration-search");
  });

  it("never emits PROVIDED_BY (no deterministic model assignment in Phase 1D)", () => {
    const res = buildEvalSuiteGraph({ snapshotId: "s", evalCaseIds: ["c1"] });
    const hasProvided = res.edges.some((e) => e.kind === "PROVIDED_BY");
    expect(hasProvided).toBe(false);
  });

  it("dedupes duplicate evalCaseIds preserving first-seen order (regression C4 for duplicate RunTrace node ids)", () => {
    const input: BuildEvalSuiteGraphInput = {
      snapshotId: "snap:dup",
      evalCaseIds: ["c1", "c1", "c2", "c1"],
    };
    const res = buildEvalSuiteGraph(input);
    expect(res.nodes.length).toBe(2);
    const ids = res.nodes.map((n) => n.id);
    expect(ids).toEqual(["evalcase:c1", "evalcase:c2"]);
    // deterministic on repeat (and same after dedupe + sort)
    const res2 = buildEvalSuiteGraph(input);
    expect(res2.nodes.map((n) => n.id)).toEqual(ids);
  });
});
