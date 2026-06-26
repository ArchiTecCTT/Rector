import { makeEdgeId } from "./graphIds";
import type {
  CartographerGraphEdge,
  CartographerGraphNode,
} from "./graphTypes";

export type EvalSuiteCaseRef = {
  readonly caseId: string;
};

export type BuildEvalSuiteGraphInput = {
  readonly snapshotId: string;
  readonly evalCaseIds: readonly string[]; // explicit only, from metadata records
};

export type BuildEvalSuiteGraphResult = {
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Builds explicit eval-suite / eval-case graph facts for Phase 1D.
 *
 * - Consumes only explicit metadata (evalCaseIds from records); no inference.
 * - No provider calls, no tool dispatch, no model assignments.
 * - Emits RunTrace nodes using the evalcase:<caseId> id pattern so that
 *   VALIDATED_BY edges (emitted from capability side using explicit records)
 *   have matching target nodes.
 * - Does not emit PROVIDED_BY edges (none exist deterministically in Phase 1D).
 * - Empty input yields empty deterministic output (no synthetic success).
 */
export function buildEvalSuiteGraph(input: BuildEvalSuiteGraphInput): BuildEvalSuiteGraphResult {
  const { snapshotId, evalCaseIds } = input;
  const nodes: CartographerGraphNode[] = [];
  const edges: CartographerGraphEdge[] = [];

  for (const caseId of evalCaseIds) {
    const evalTargetId = `evalcase:${caseId}`;
    nodes.push({
      id: evalTargetId,
      snapshotId,
      kind: "RunTrace",
      label: caseId,
      properties: {
        caseId,
        source: "phase0_eval",
      },
    });
  }

  const sortedNodes = [...nodes].sort(compareId);
  const sortedEdges = [...edges].sort(compareId);
  return { nodes: sortedNodes, edges: sortedEdges };
}

/**
 * Deterministic helper to construct a VALIDATED_BY edge from a capability node
 * to an explicit eval case id. Centralizes the id/edge shape for eval references.
 * Callers must pass only explicitly recorded caseIds.
 */
export function makeValidatedByEvalCaseEdge(
  snapshotId: string,
  capabilityNodeId: string,
  caseId: string,
): CartographerGraphEdge {
  const evalTargetId = `evalcase:${caseId}`;
  return {
    id: makeEdgeId("VALIDATED_BY", capabilityNodeId, evalTargetId),
    snapshotId,
    kind: "VALIDATED_BY",
    fromNodeId: capabilityNodeId,
    toNodeId: evalTargetId,
    properties: { caseId },
    evidence: { text: caseId },
  };
}
