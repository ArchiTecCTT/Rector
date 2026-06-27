import type { ToolRegistryEntry, ToolSchemaDefinition } from "../tools";
import { makeToolId } from "./graphIds";
import { getDefaultToolProductionAdmission } from "./toolProductionAdmission";
import type {
  CartographerGraphEdge,
  CartographerGraphNode,
} from "./graphTypes";

export type { ToolProductionAdmission } from "./capabilityGraphRecords";

export type BuildToolGraphInput = {
  readonly snapshotId: string;
  readonly tools?: readonly ToolSchemaDefinition[];
  readonly toolEntries?: readonly ToolRegistryEntry[] | ReadonlyMap<string, ToolRegistryEntry>;
};

export type BuildToolGraphResult = {
  readonly nodes: readonly CartographerGraphNode[];
  readonly edges: readonly CartographerGraphEdge[];
};

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function resolveToolWorkItems(
  input: BuildToolGraphInput,
): Array<{ definition: ToolSchemaDefinition; entry?: ToolRegistryEntry }> {
  if (Array.isArray(input.toolEntries)) {
    return input.toolEntries.map((entry) => ({ definition: entry.definition, entry }));
  }
  if (input.toolEntries) {
    return [...input.toolEntries.values()].map((entry) => ({
      definition: entry.definition,
      entry,
    }));
  }
  if (input.tools) {
    return input.tools.map((definition) => ({ definition, entry: undefined }));
  }
  return [];
}

function getToolSource(entry?: ToolRegistryEntry): string {
  return entry?.source ?? "builtin";
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
  const { snapshotId } = input;
  const nodes: CartographerGraphNode[] = [];
  for (const { definition: t, entry } of resolveToolWorkItems(input)) {
    const admission = getDefaultToolProductionAdmission(t.name);
    const warnings = getWarningsForTool(t.name);
    const props: Record<string, string | number | boolean | null> = {
      description: t.description,
      risk: t.risk,
      requiresApproval: t.requiresApproval,
      requiresSandbox: t.requiresSandbox,
      toolSource: getToolSource(entry),
      productionAdmission: admission,
      inputSchema: JSON.stringify(t.inputSchema),
    };
    if (entry?.moduleId) {
      props.moduleId = entry.moduleId;
    }
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
