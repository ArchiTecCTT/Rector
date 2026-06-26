import type { ToolSchemaDefinition } from "../tools/types";
import { makeToolId } from "./graphIds";
import type {
  CartographerGraphEdge,
  CartographerGraphNode,
} from "./graphTypes";

export type ToolProductionAdmission =
  | "production"
  | "test_only"
  | "report_only"
  | "quarantined";

export type BuildToolGraphInput = {
  readonly snapshotId: string;
  readonly tools: readonly ToolSchemaDefinition[];
};

export type BuildToolGraphResult = {
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function getProductionAdmission(name: string): ToolProductionAdmission {
  if (name === "simulator.echo") {
    return "test_only";
  }
  return "production";
}

function getToolSource(): string {
  return "builtin";
}

function getWarningsForTool(name: string): readonly string[] {
  if (name === "workspace.validate") {
    return [
      "fake-validation: current implementation may return synthetic passed without executing real validators; quarantined until fake-purge",
    ];
  }
  return [];
}

export function buildToolGraph(input: BuildToolGraphInput): BuildToolGraphResult {
  const { snapshotId, tools } = input;
  const nodes: CartographerGraphNode[] = [];
  for (const t of tools) {
    const admission = getProductionAdmission(t.name);
    const warnings = getWarningsForTool(t.name);
    const props: Record<string, string | number | boolean | null> = {
      description: t.description,
      risk: t.risk,
      requiresApproval: t.requiresApproval,
      requiresSandbox: t.requiresSandbox,
      toolSource: getToolSource(),
      productionAdmission: admission,
      inputSchema: JSON.stringify(t.inputSchema),
    };
    if (warnings.length > 0) {
      props.warnings = JSON.stringify(warnings);
      if (t.name === "workspace.validate") {
        props.fakeValidationWarning = warnings[0];
      }
    }
    const node: CartographerGraphNode = {
      id: makeToolId(t.name),
      snapshotId,
      kind: "Tool",
      label: t.name,
      properties: props,
    };
    nodes.push(node);
  }
  const sortedNodes = [...nodes].sort(compareId);
  return { nodes: sortedNodes, edges: [] };
}
