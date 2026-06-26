import type { CapabilityGraphRecord } from "./capabilityGraphRecords";
import { makeCapabilityId, makeEdgeId, makeToolId } from "./graphIds";
import type {
  CartographerGraphEdge,
  CartographerGraphNode,
} from "./graphTypes";

export type BuildCapabilityGraphInput = {
  readonly snapshotId: string;
  readonly records: readonly CapabilityGraphRecord[];
};

export type BuildCapabilityGraphResult = {
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildCapabilityGraph(input: BuildCapabilityGraphInput): BuildCapabilityGraphResult {
  const { snapshotId, records } = input;
  const nodes: CartographerGraphNode[] = [];
  const edges: CartographerGraphEdge[] = [];

  for (const rec of records) {
    const capId = makeCapabilityId(rec.id);
    const props: Record<string, string | number | boolean | null> = {
      label: rec.label,
      source: rec.source,
      productionAdmission: rec.productionAdmission,
    };
    if (rec.warnings && rec.warnings.length > 0) {
      props.warnings = JSON.stringify(rec.warnings);
    }
    nodes.push({
      id: capId,
      snapshotId,
      kind: "Capability",
      label: rec.label,
      properties: props,
    });

    for (const toolName of rec.toolNames) {
      const toolId = makeToolId(toolName);
      edges.push({
        id: makeEdgeId("WRAPPED_BY", capId, toolId),
        snapshotId,
        kind: "WRAPPED_BY",
        fromNodeId: capId,
        toNodeId: toolId,
        properties: {},
      });
    }

    for (const caseId of rec.evalCaseIds) {
      const evalTargetId = `evalcase:${caseId}`;
      edges.push({
        id: makeEdgeId("VALIDATED_BY", capId, evalTargetId),
        snapshotId,
        kind: "VALIDATED_BY",
        fromNodeId: capId,
        toNodeId: evalTargetId,
        properties: { caseId },
        evidence: { text: caseId },
      });
    }
  }

  const sortedNodes = [...nodes].sort(compareId);
  const sortedEdges = [...edges].sort(compareId);
  return { nodes: sortedNodes, edges: sortedEdges };
}
