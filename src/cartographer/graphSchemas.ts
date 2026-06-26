import { z } from "zod";

// ---------------------------------------------------------------------------
// Node / Edge kinds (Phase 1 reservation per plan)
// ---------------------------------------------------------------------------

export const GraphNodeKindSchema = z.enum([
  "Project",
  "Package",
  "Directory",
  "File",
  "Symbol",
  "Function",
  "Class",
  "Interface",
  "TypeAlias",
  "Enum",
  "Route",
  "Test",
  "Config",
  "EnvironmentVariable",
  "Doc",
  "Tool",
  "Capability",
  "Skill",
  "Rule",
  "RunTrace",
]);

export const GraphEdgeKindSchema = z.enum([
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "REFERENCES",
  "TESTS",
  "HANDLES",
  "CONFIGURES",
  "READS",
  "WRITES",
  "OWNS",
  "VIOLATES",
  "FIXED_BY",
  "VALIDATED_BY",
  "DEPENDS_ON",
  "PROVIDED_BY",
  "WRAPPED_BY",
]);

export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>;

// ---------------------------------------------------------------------------
// JSON-compatible value for properties (strict, no functions/undefined/symbols)
// ---------------------------------------------------------------------------

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;

type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

// ---------------------------------------------------------------------------
// Core graph node / edge contracts (Zod-first, strict)
// ---------------------------------------------------------------------------

export const CartographerGraphNodeSchema = z
  .object({
    id: z.string().min(1),
    snapshotId: z.string().min(1),
    kind: GraphNodeKindSchema,
    label: z.string().min(1),
    path: z.string().min(1).optional(),
    normalizedPath: z.string().min(1).optional(),
    symbolName: z.string().min(1).optional(),
    symbolKind: z.enum(["function", "class", "interface", "typeAlias", "enum", "variable", "export"]).optional(),
    language: z.string().min(1).optional(),
    fileHash: z.string().min(1).optional(),
    startLine: z.number().int().nonnegative().optional(),
    endLine: z.number().int().nonnegative().optional(),
    properties: z.record(JsonValueSchema),
  })
  .strict();

export const CartographerGraphEdgeSchema = z
  .object({
    id: z.string().min(1),
    snapshotId: z.string().min(1),
    kind: GraphEdgeKindSchema,
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    path: z.string().min(1).optional(),
    evidence: z
      .object({
        path: z.string().min(1).optional(),
        startLine: z.number().int().nonnegative().optional(),
        endLine: z.number().int().nonnegative().optional(),
        text: z.string().optional(),
      })
      .strict()
      .optional(),
    properties: z.record(JsonValueSchema),
  })
  .strict();

export type CartographerGraphNode = z.infer<typeof CartographerGraphNodeSchema>;
export type CartographerGraphEdge = z.infer<typeof CartographerGraphEdgeSchema>;

// ---------------------------------------------------------------------------
// Graph snapshot contract
// ---------------------------------------------------------------------------

export const GraphSnapshotSchema = z
  .object({
    id: z.string().min(1),
    repoRoot: z.string().min(1),
    inventorySnapshotId: z.string().min(1),
    createdAt: z.string().datetime(),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
  })
  .strict();

export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

// ---------------------------------------------------------------------------
// Query status and typed result contracts
// ---------------------------------------------------------------------------

export const CartographerQueryStatusSchema = z.enum([
  "ok",
  "not_found",
  "ambiguous",
  "not_configured",
  "unsupported",
  "invalid_input",
]);

export type CartographerQueryStatus = z.infer<typeof CartographerQueryStatusSchema>;

// Example query input for getFile (path-based, strict)
export const GetFileGraphQueryInputSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export type GetFileGraphQueryInput = z.infer<typeof GetFileGraphQueryInputSchema>;

// Typed result variants (no vague undefined / ad-hoc shapes)
export const GetFileGraphQueryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), graphNode: CartographerGraphNodeSchema }).strict(),
  z.object({ status: z.literal("not_found"), path: z.string().min(1) }).strict(),
  z.object({ status: z.literal("ambiguous") }).strict(),
  z.object({ status: z.literal("not_configured") }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);

export type GetFileGraphQueryResult = z.infer<typeof GetFileGraphQueryResultSchema>;

// ---------------------------------------------------------------------------

export const QueryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), normalizedPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("symbol"), id: z.string().min(1).optional(), name: z.string().min(1).optional() }).strict(),
]);
export type QueryTarget = z.infer<typeof QueryTargetSchema>;

export const GetFileQueryInputSchema = z.object({ normalizedPath: z.string().min(1) }).strict();
export type GetFileQueryInput = z.infer<typeof GetFileQueryInputSchema>;

export const GetFileQueryResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      file: CartographerGraphNodeSchema,
      symbols: z.array(CartographerGraphNodeSchema),
      imports: z.array(CartographerGraphEdgeSchema),
    })
    .strict(),
  z.object({ status: z.literal("not_found"), path: z.string().min(1) }).strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type GetFileQueryResult = z.infer<typeof GetFileQueryResultSchema>;

export const GetSymbolGraphQueryInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .strict();
export type GetSymbolGraphQueryInput = z.infer<typeof GetSymbolGraphQueryInputSchema>;

export const GetSymbolGraphQueryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), symbols: z.array(CartographerGraphNodeSchema) }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type GetSymbolGraphQueryResult = z.infer<typeof GetSymbolGraphQueryResultSchema>;

export const GetDependenciesQueryInputSchema = z.object({ target: QueryTargetSchema }).strict();
export type GetDependenciesQueryInput = z.infer<typeof GetDependenciesQueryInputSchema>;

export const GetDependenciesQueryResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      edges: z.array(CartographerGraphEdgeSchema),
      targetNodes: z.array(CartographerGraphNodeSchema),
    })
    .strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type GetDependenciesQueryResult = z.infer<typeof GetDependenciesQueryResultSchema>;

export const GetDependentsQueryInputSchema = GetDependenciesQueryInputSchema;
export type GetDependentsQueryInput = GetDependenciesQueryInput;
export const GetDependentsQueryResultSchema = GetDependenciesQueryResultSchema;
export type GetDependentsQueryResult = GetDependenciesQueryResult;

export const GetImpactQueryInputSchema = z
  .object({ changedNormalizedPaths: z.array(z.string().min(1)) })
  .strict();
export type GetImpactQueryInput = z.infer<typeof GetImpactQueryInputSchema>;

export const GetImpactQueryResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      impactedFiles: z.array(z.string()),
      probableTests: z.array(z.string()),
      confidence: z.literal("structural"),
    })
    .strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type GetImpactQueryResult = z.infer<typeof GetImpactQueryResultSchema>;

export const FindTestsQueryInputSchema = z
  .object({
    targetNormalizedPath: z.string().min(1),
    getSourceText: z
      .function()
      .args(z.string())
      .returns(z.union([z.string(), z.undefined()]))
      .optional(),
    indexedFiles: z.array(z.string()).optional(),
  })
  .strict();
export type FindTestsQueryInput = z.infer<typeof FindTestsQueryInputSchema>;

export const FindTestsQueryResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      targetNormalizedPath: z.string(),
      linkedTests: z.array(
        z
          .object({
            normalizedPath: z.string(),
            relation: z.enum(["import", "basename"]),
            evidence: z.string(),
          })
          .strict()
      ),
    })
    .strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type FindTestsQueryResult = z.infer<typeof FindTestsQueryResultSchema>;

export const GetRelevantContextInputSchema = z
  .object({
    hints: z
      .object({
        paths: z.array(z.string().min(1)).optional(),
        symbolNames: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict();
export type GetRelevantContextInput = z.infer<typeof GetRelevantContextInputSchema>;

export const GetRelevantContextResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      nodes: z.array(CartographerGraphNodeSchema),
      edges: z.array(CartographerGraphEdgeSchema),
    })
    .strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type GetRelevantContextResult = z.infer<typeof GetRelevantContextResultSchema>;

export const CheckArchitectureQueryInputSchema = z
  .object({ changeSet: z.array(z.string().min(1)).optional() })
  .strict();
export type CheckArchitectureQueryInput = z.infer<typeof CheckArchitectureQueryInputSchema>;

export const CheckArchitectureQueryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), findings: z.array(z.string()) }).strict(),
  z.object({ status: z.literal("not_configured") }).strict(),
  z.object({ status: z.literal("invalid_input"), reason: z.string().min(1) }).strict(),
]);
export type CheckArchitectureQueryResult = z.infer<typeof CheckArchitectureQueryResultSchema>;

export const ListCapabilitiesQueryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), capabilities: z.array(CartographerGraphNodeSchema) }).strict(),
  z.object({ status: z.literal("not_configured") }).strict(),
]);
export type ListCapabilitiesQueryResult = z.infer<typeof ListCapabilitiesQueryResultSchema>;

export const GetCapabilityQueryInputSchema = z.object({ id: z.string().min(1) }).strict();
export type GetCapabilityQueryInput = z.infer<typeof GetCapabilityQueryInputSchema>;

export const GetCapabilityQueryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), capability: CartographerGraphNodeSchema }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("not_configured") }).strict(),
]);
export type GetCapabilityQueryResult = z.infer<typeof GetCapabilityQueryResultSchema>;

// ---------------------------------------------------------------------------
// Phase 1 kind policy: mustEmitNow (baseline) vs schemaReserved (later)
// ---------------------------------------------------------------------------

export const MUST_EMIT_NOW_NODE_KINDS = [
  "Project",
  "Package",
  "Directory",
  "File",
  "Doc",
  "Config",
  "Test",
] as const;

export const SCHEMA_RESERVED_NODE_KINDS = [
  "Symbol",
  "Function",
  "Class",
  "Interface",
  "TypeAlias",
  "Enum",
  "Route",
  "EnvironmentVariable",
  "Tool",
  "Capability",
  "Skill",
  "Rule",
  "RunTrace",
] as const;
