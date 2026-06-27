import type { CapabilityGraphRecord, ToolProductionAdmission } from "./capabilityGraphRecords";
import { makeCapabilityId, makeEdgeId, makeToolId } from "./graphIds";
import { resolveToolProductionAdmission } from "./toolProductionAdmission";
import type {
  CartographerGraphEdge,
  CartographerGraphNode,
} from "./graphTypes";

export type BuildCapabilityGraphInput = {
  readonly snapshotId: string;
  readonly records: readonly CapabilityGraphRecord[];
  readonly toolAdmissions?: ReadonlyMap<string, ToolProductionAdmission> | Record<string, ToolProductionAdmission>;
};

export type BuildCapabilityGraphResult = {
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function lookupExplicitToolAdmission(
  toolAdmissions: BuildCapabilityGraphInput["toolAdmissions"],
  toolName: string,
): ToolProductionAdmission | undefined {
  if (!toolAdmissions) return undefined;
  if (toolAdmissions instanceof Map) {
    return toolAdmissions.get(toolName);
  }
  const recordAdmissions = toolAdmissions as Record<string, ToolProductionAdmission>;
  if (!Object.prototype.hasOwnProperty.call(recordAdmissions, toolName)) {
    return undefined;
  }
  return recordAdmissions[toolName];
}

function resolveToolAdmissionForGuardrail(
  toolAdmissions: BuildCapabilityGraphInput["toolAdmissions"],
  toolName: string,
): ToolProductionAdmission {
  return resolveToolProductionAdmission(toolName, lookupExplicitToolAdmission(toolAdmissions, toolName));
}

function isNonProductionToolAdmission(admission: ToolProductionAdmission | undefined): boolean {
  return admission === "test_only" || admission === "quarantined";
}

function applyProductionCapabilityGuardrails(
  rec: CapabilityGraphRecord,
  toolAdmissions: BuildCapabilityGraphInput["toolAdmissions"],
): { productionAdmission: ToolProductionAdmission; warnings: string[] } {
  let productionAdmission = rec.productionAdmission;
  const warnings = [...(rec.warnings ?? [])];

  if (productionAdmission !== "production") {
    return { productionAdmission, warnings };
  }

  const guardrailWarningKeys = new Set<string>();
  for (const toolName of rec.toolNames) {
    const toolAdmission = resolveToolAdmissionForGuardrail(toolAdmissions, toolName);
    if (isNonProductionToolAdmission(toolAdmission)) {
      productionAdmission = "quarantined";
      const msg = `production-capability-wraps-nonproduction-tool:${toolName}`;
      if (!guardrailWarningKeys.has(msg)) {
        guardrailWarningKeys.add(msg);
        warnings.push(msg);
      }
    }
  }

  return { productionAdmission, warnings };
}

export function buildCapabilityGraph(input: BuildCapabilityGraphInput): BuildCapabilityGraphResult {
  const { snapshotId, records, toolAdmissions } = input;
  const nodes: CartographerGraphNode[] = [];
  const edges: CartographerGraphEdge[] = [];

  for (const rec of records) {
    const { productionAdmission, warnings } = applyProductionCapabilityGuardrails(rec, toolAdmissions);
    const capId = makeCapabilityId(rec.id);
    const props: Record<string, string | number | boolean | null> = {
      label: rec.label,
      source: rec.source,
      productionAdmission,
      risk: rec.risk,
    };
    if (warnings.length > 0) {
      props.warnings = JSON.stringify(warnings);
    }
    nodes.push({
      id: capId,
      snapshotId,
      kind: "Capability",
      label: rec.label,
      properties: props,
    });

    const uniqueToolNames = [...new Set(rec.toolNames)];
    for (const toolName of uniqueToolNames) {
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

    const uniqueEvalCaseIds = [...new Set(rec.evalCaseIds)];
    for (const caseId of uniqueEvalCaseIds) {
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
