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
