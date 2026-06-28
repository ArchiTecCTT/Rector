import { z } from "zod";

export const FACT_SCHEMA_VERSION = "rector.fact.v1";

const NonEmptyStringSchema = z.string().min(1);
const IsoDateTimeSchema = z.string().datetime();
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPrototypePollutionKey(key: string): boolean {
  return PROTOTYPE_POLLUTION_KEYS.has(key);
}

function hasSafeObjectKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeObjectKeys);
  if (value === null || typeof value !== "object") return true;
  for (const [key, nested] of Object.entries(value)) {
    if (isPrototypePollutionKey(key)) return false;
    if (!hasSafeObjectKeys(nested)) return false;
  }
  return true;
}

export const JsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z
    .union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)])
    .superRefine((value, ctx) => {
      if (!hasSafeObjectKeys(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JSON object contains a prototype pollution key" });
      }
    }),
);

export const JsonObjectSchema = z
  .record(JsonValueSchema)
  .superRefine((value, ctx) => {
    if (!hasSafeObjectKeys(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JSON object contains a prototype pollution key" });
    }
  });

export const FactIdSchema = z.string().regex(/^fact_[a-f0-9]{32,64}$/);

export const FactProducerSchema = z.enum([
  "user",
  "system",
  "cartographer",
  "tool_registry",
  "capability_eval",
  "global_harness",
  "llm_shadow",
  "validator",
  "human_operator",
]);

export const FactTrustLevelSchema = z.enum([
  "raw",
  "schema_valid",
  "provenance_attached",
  "graph_grounded",
  "scope_checked",
  "validation_linked",
  "rejected",
  "insufficient_evidence",
]);

export const FactTrustSchema = z
  .object({
    level: FactTrustLevelSchema,
    reason: NonEmptyStringSchema.optional(),
    promotedByFactId: FactIdSchema.optional(),
    validationRefs: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export const RedactionStateSchema = z.enum(["none", "redacted", "contains_sensitive", "unknown"]);

export const SafeFactPathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (value === ".") return true;
    if (value.startsWith("/")) return false;
    if (/^[a-zA-Z]:[/\\]/.test(value)) return false;
    if (value.startsWith("\\\\") || value.startsWith("//")) return false;
    if (value.startsWith("./")) return false;
    const segments = value.split(/[/\\]/);
    if (segments.some((segment) => segment === "")) return false;
    if (segments.some((segment) => segment === "..")) return false;
    if (segments.some(isPrototypePollutionKey)) return false;
    const normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith("/")) return false;
    return !normalized.split("/").some((segment) => segment === ".." || segment === "");
  }, "path must be a safe relative path with no absolute, drive, UNC, leading ./, .., empty, or prototype-pollution segments");

const SourceSpanFields = {
  path: SafeFactPathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startColumn: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
} as const;

export const SourceSpanSchema = z
  .object(SourceSpanFields)
  .strict()
  .refine((span) => span.endLine >= span.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

const SourceSpanRefSchema = z
  .object({ refType: z.literal("source_span"), ...SourceSpanFields })
  .strict()
  .refine((span) => span.endLine >= span.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export const ArtifactRefSchema = z
  .object({
    refType: z.literal("artifact"),
    uri: NonEmptyStringSchema,
    sha256: Sha256HexSchema.optional(),
    contentType: NonEmptyStringSchema.optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const GraphRefSchema = z
  .object({
    refType: z.literal("graph"),
    snapshotId: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema.optional(),
    edgeId: NonEmptyStringSchema.optional(),
    queryStatus: z.enum(["ok", "not_found", "ambiguous", "not_configured", "unsupported", "invalid_input"]).optional(),
  })
  .strict();

export const ValidationRefSchema = z
  .object({
    refType: z.literal("validation"),
    validationId: NonEmptyStringSchema,
    validator: NonEmptyStringSchema,
    status: z.enum(["passed", "failed", "skipped", "blocked"]),
    checkedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const InsufficientEvidenceSchema = z
  .object({
    refType: z.literal("insufficient_evidence"),
    reason: NonEmptyStringSchema,
    missing: z.array(NonEmptyStringSchema).default([]),
    searched: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

export const EvidenceRefSchema = z.union([
  ArtifactRefSchema,
  GraphRefSchema,
  SourceSpanRefSchema,
  ValidationRefSchema,
  z
    .object({
      refType: z.literal("url"),
      url: z.string().url(),
      label: NonEmptyStringSchema.optional(),
    })
    .strict(),
  InsufficientEvidenceSchema,
]);

export const FactValidationErrorSchema = z
  .object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    path: z.array(z.union([z.string(), z.number()])).default([]),
    severity: z.enum(["info", "warning", "error"]).default("error"),
  })
  .strict();

export const FactScopeSchema = z
  .object({
    scopeType: z.enum(["run", "task", "workspace", "repository", "global"]),
    workspacePaths: z.array(SafeFactPathSchema).default([]),
    graphRefs: z.array(GraphRefSchema).default([]),
    taskIds: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();

const UserProvenanceSchema = z
  .object({
    sourceType: z.literal("user"),
    userMessageId: NonEmptyStringSchema.optional(),
    source: z.literal("user").default("user"),
  })
  .strict();

export const FactProvenanceSchema = z.discriminatedUnion("sourceType", [
  UserProvenanceSchema,
  z.object({ sourceType: z.literal("system"), systemId: NonEmptyStringSchema, note: NonEmptyStringSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("artifact"), artifact: ArtifactRefSchema, span: SourceSpanSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("graph"), graph: GraphRefSchema }).strict(),
  z.object({ sourceType: z.literal("tool_call"), toolName: NonEmptyStringSchema, callId: NonEmptyStringSchema, artifact: ArtifactRefSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("capability_eval"), capabilityId: NonEmptyStringSchema, caseId: NonEmptyStringSchema.optional(), artifact: ArtifactRefSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("global_harness"), scenarioId: NonEmptyStringSchema, scorecardId: NonEmptyStringSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("run_event"), runId: NonEmptyStringSchema, eventId: NonEmptyStringSchema, eventType: NonEmptyStringSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("validation"), validation: ValidationRefSchema }).strict(),
  z.object({ sourceType: z.literal("llm_shadow"), providerId: NonEmptyStringSchema, modelId: NonEmptyStringSchema, artifact: ArtifactRefSchema.optional() }).strict(),
  z.object({ sourceType: z.literal("human_operator"), operatorId: NonEmptyStringSchema, note: NonEmptyStringSchema.optional() }).strict(),
]);

export const FactEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(FACT_SCHEMA_VERSION),
    factId: FactIdSchema,
    kind: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema.optional(),
    createdAt: IsoDateTimeSchema,
    producer: FactProducerSchema,
    provenance: z.array(FactProvenanceSchema),
    trust: FactTrustSchema,
    scope: FactScopeSchema,
    redactionState: RedactionStateSchema,
    supersedesFactId: FactIdSchema.optional(),
    contradictsFactId: FactIdSchema.optional(),
  })
  .strict();

function baseFact<K extends string, T extends z.ZodRawShape>(kind: K, shape: T) {
  return FactEnvelopeSchema.extend({ kind: z.literal(kind), ...shape }).strict();
}

export const IntentFactSchema = baseFact("intent", {
  intent: NonEmptyStringSchema,
  confidence: z.number().min(0).max(1).optional(),
});
export const TaskConstraintFactSchema = baseFact("task_constraint", { constraint: NonEmptyStringSchema });
export const SuccessCriteriaFactSchema = baseFact("success_criteria", { criteria: NonEmptyStringSchema });
export const RiskToleranceFactSchema = baseFact("risk_tolerance", { level: z.enum(["low", "medium", "high", "unknown"]), rationale: NonEmptyStringSchema.optional() });
export const UnknownOrAmbiguityFactSchema = baseFact("unknown_or_ambiguity", { question: NonEmptyStringSchema, options: z.array(NonEmptyStringSchema).default([]) });

export const CartographerSnapshotFactSchema = baseFact("cartographer_snapshot", { snapshotId: NonEmptyStringSchema, nodeCount: z.number().int().nonnegative(), edgeCount: z.number().int().nonnegative() });
export const GraphNodeFactRefSchema = baseFact("graph_node_ref", { graph: GraphRefSchema.refine((ref) => ref.nodeId !== undefined, "nodeId is required") });
export const GraphEdgeFactRefSchema = baseFact("graph_edge_ref", { graph: GraphRefSchema.refine((ref) => ref.edgeId !== undefined, "edgeId is required") });
export const ContextSliceFactSchema = baseFact("context_slice", { query: NonEmptyStringSchema, status: z.enum(["ok", "not_found", "ambiguous", "unsupported", "invalid_input"]), summary: NonEmptyStringSchema.optional(), evidence: z.array(EvidenceRefSchema).default([]) });
export const FileContextFactSchema = baseFact("file_context", { path: SafeFactPathSchema, graph: GraphRefSchema.optional(), summary: NonEmptyStringSchema.optional() });
export const SymbolContextFactSchema = baseFact("symbol_context", { symbolName: NonEmptyStringSchema, graph: GraphRefSchema.optional(), summary: NonEmptyStringSchema.optional() });
export const ImpactContextFactSchema = baseFact("impact_context", { changedPaths: z.array(SafeFactPathSchema), impactedPaths: z.array(SafeFactPathSchema), probableTests: z.array(SafeFactPathSchema).default([]), confidence: z.enum(["structural", "partial", "insufficient_evidence"]) });
export const TestLinkContextFactSchema = baseFact("test_link_context", { targetPath: SafeFactPathSchema, testPaths: z.array(SafeFactPathSchema), relation: z.enum(["import", "basename", "explicit", "insufficient_evidence"]) });
export const CapabilityGraphContextFactSchema = baseFact("capability_graph_context", { capabilityId: NonEmptyStringSchema, graphRefs: z.array(GraphRefSchema), status: z.enum(["ok", "not_found", "not_configured", "unsupported"]) });

export const ToolDefinitionFactSchema = baseFact("tool_definition", { toolName: NonEmptyStringSchema, description: NonEmptyStringSchema, risk: z.enum(["low", "medium", "high", "destructive"]), requiresApproval: z.boolean(), requiresSandbox: z.boolean() });
export const ToolCallFactSchema = baseFact("tool_call", { callId: NonEmptyStringSchema, toolName: NonEmptyStringSchema, args: JsonObjectSchema.default({}) });
export const ToolResultFactSchema = baseFact("tool_result", { callId: NonEmptyStringSchema, toolName: NonEmptyStringSchema, ok: z.boolean(), output: JsonValueSchema.optional(), error: NonEmptyStringSchema.optional(), artifact: ArtifactRefSchema.optional() });
export const ToolFailureFactSchema = baseFact("tool_failure", { callId: NonEmptyStringSchema, toolName: NonEmptyStringSchema, code: NonEmptyStringSchema, message: NonEmptyStringSchema, details: JsonObjectSchema.optional(), retryable: z.boolean().default(false), artifact: ArtifactRefSchema.optional() });
export const CapabilityRequestFactSchema = baseFact("capability_request", { requestId: NonEmptyStringSchema, capabilityId: NonEmptyStringSchema, intent: NonEmptyStringSchema });
export const CapabilityCallFactSchema = baseFact("capability_call", { callId: NonEmptyStringSchema, capabilityId: NonEmptyStringSchema, status: z.enum(["requested", "running", "completed", "failed", "skipped"]) });
export const CapabilityEvidenceFactSchema = baseFact("capability_evidence", { capabilityId: NonEmptyStringSchema, summary: NonEmptyStringSchema, evidence: z.array(EvidenceRefSchema).min(1) });
export const CapabilityCoverageFactSchema = baseFact("capability_coverage", { capabilityId: NonEmptyStringSchema, searchedScope: z.array(SafeFactPathSchema), rawCount: z.number().int().nonnegative(), returnedCount: z.number().int().nonnegative(), omittedScope: z.array(NonEmptyStringSchema).default([]) });
export const CapabilityWarningFactSchema = baseFact("capability_warning", { capabilityId: NonEmptyStringSchema, warning: NonEmptyStringSchema, severity: z.enum(["low", "medium", "high"]) });
export const CapabilityFailureFactSchema = baseFact("capability_failure", { capabilityId: NonEmptyStringSchema, reason: NonEmptyStringSchema, retryable: z.boolean(), evidence: z.array(EvidenceRefSchema).default([]) });

export const RawArtifactFactSchema = baseFact("raw_artifact", { artifact: ArtifactRefSchema, byteCount: z.number().int().nonnegative(), tokenCount: z.number().int().nonnegative().optional() });
export const RawArtifactChunkFactSchema = baseFact("raw_artifact_chunk", { artifact: ArtifactRefSchema, chunkIndex: z.number().int().nonnegative(), byteStart: z.number().int().nonnegative(), byteEnd: z.number().int().nonnegative(), chunkSha256: Sha256HexSchema });
export const ArtifactHashFactSchema = baseFact("artifact_hash", { artifact: ArtifactRefSchema, algorithm: z.literal("sha256"), hash: Sha256HexSchema });
export const ArtifactRedactionFactSchema = baseFact("artifact_redaction", { artifact: ArtifactRefSchema, fromState: RedactionStateSchema, toState: RedactionStateSchema, method: NonEmptyStringSchema.optional() });

export const PlanCandidateFactSchema = baseFact("plan_candidate", { proposalId: NonEmptyStringSchema, summary: NonEmptyStringSchema, steps: z.array(NonEmptyStringSchema).default([]), evidence: z.array(EvidenceRefSchema).default([]) });
export const CritiqueFactSchema = baseFact("critique", { targetFactId: FactIdSchema.optional(), critique: NonEmptyStringSchema, severity: z.enum(["info", "warning", "blocker"]) });
export const ValidationObligationFactSchema = baseFact("validation_obligation", { obligationId: NonEmptyStringSchema, validator: NonEmptyStringSchema, targetFactIds: z.array(FactIdSchema), requiredEvidence: z.array(NonEmptyStringSchema).default([]) });
export const RepairCandidateFactSchema = baseFact("repair_candidate", { repairId: NonEmptyStringSchema, summary: NonEmptyStringSchema, targetFactIds: z.array(FactIdSchema).default([]) });
export const MemoryPatchCandidateFactSchema = baseFact("memory_patch_candidate", { memoryKey: NonEmptyStringSchema, patchSummary: NonEmptyStringSchema, evidence: z.array(EvidenceRefSchema).default([]) });

export const FactSchemaValidationFactSchema = baseFact("fact_schema_validation", { targetFactId: FactIdSchema, valid: z.boolean(), errors: z.array(FactValidationErrorSchema).default([]) });
export const FactGroundingValidationFactSchema = baseFact("fact_grounding_validation", { targetFactId: FactIdSchema, status: z.enum(["passed", "failed", "insufficient_evidence"]), evidence: z.array(EvidenceRefSchema).default([]) });
export const FactScopeValidationFactSchema = baseFact("fact_scope_validation", { targetFactId: FactIdSchema, status: z.enum(["passed", "failed", "insufficient_evidence"]), checkedPaths: z.array(SafeFactPathSchema).default([]), errors: z.array(FactValidationErrorSchema).default([]) });
export const FactProvenanceValidationFactSchema = baseFact("fact_provenance_validation", { targetFactId: FactIdSchema, status: z.enum(["passed", "failed", "insufficient_evidence"]), errors: z.array(FactValidationErrorSchema).default([]) });
export const FactReplayValidationFactSchema = baseFact("fact_replay_validation", { targetFactId: FactIdSchema.optional(), runHash: NonEmptyStringSchema.optional(), status: z.enum(["passed", "failed", "skipped"]), errors: z.array(FactValidationErrorSchema).default([]) });

export const RectorFactSchema = z
  .discriminatedUnion("kind", [
    IntentFactSchema,
    TaskConstraintFactSchema,
    SuccessCriteriaFactSchema,
    RiskToleranceFactSchema,
    UnknownOrAmbiguityFactSchema,
    CartographerSnapshotFactSchema,
    GraphNodeFactRefSchema,
    GraphEdgeFactRefSchema,
    ContextSliceFactSchema,
    FileContextFactSchema,
    SymbolContextFactSchema,
    ImpactContextFactSchema,
    TestLinkContextFactSchema,
    CapabilityGraphContextFactSchema,
    ToolDefinitionFactSchema,
    ToolCallFactSchema,
    ToolResultFactSchema,
    ToolFailureFactSchema,
    CapabilityRequestFactSchema,
    CapabilityCallFactSchema,
    CapabilityEvidenceFactSchema,
    CapabilityCoverageFactSchema,
    CapabilityWarningFactSchema,
    CapabilityFailureFactSchema,
    RawArtifactFactSchema,
    RawArtifactChunkFactSchema,
    ArtifactHashFactSchema,
    ArtifactRedactionFactSchema,
    PlanCandidateFactSchema,
    CritiqueFactSchema,
    ValidationObligationFactSchema,
    RepairCandidateFactSchema,
    MemoryPatchCandidateFactSchema,
    FactSchemaValidationFactSchema,
    FactGroundingValidationFactSchema,
    FactScopeValidationFactSchema,
    FactProvenanceValidationFactSchema,
    FactReplayValidationFactSchema,
  ])
  .superRefine((fact, ctx) => {
    const rawUserIntent = fact.kind === "intent" && fact.producer === "user" && fact.trust.level === "raw";
    if (fact.provenance.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "provenance is required" });
    }
    if (rawUserIntent && !fact.provenance.some((p) => p.sourceType === "user")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance"], message: "raw user intent facts require explicit user provenance" });
    }
    if (fact.trust.level === "graph_grounded" && fact.scope.graphRefs.length === 0 && !fact.provenance.some((p) => p.sourceType === "graph")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trust"], message: "graph_grounded facts require graph scope or graph provenance" });
    }
    if (fact.trust.level === "validation_linked" && fact.trust.validationRefs.length === 0 && !fact.provenance.some((p) => p.sourceType === "validation")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trust", "validationRefs"], message: "validation_linked facts require validation refs or validation provenance" });
    }
  });

export const FactFamilyKindSchema = z.enum([
  "intent",
  "task_constraint",
  "success_criteria",
  "risk_tolerance",
  "unknown_or_ambiguity",
  "cartographer_snapshot",
  "graph_node_ref",
  "graph_edge_ref",
  "context_slice",
  "file_context",
  "symbol_context",
  "impact_context",
  "test_link_context",
  "capability_graph_context",
  "tool_definition",
  "tool_call",
  "tool_result",
  "tool_failure",
  "capability_request",
  "capability_call",
  "capability_evidence",
  "capability_coverage",
  "capability_warning",
  "capability_failure",
  "raw_artifact",
  "raw_artifact_chunk",
  "artifact_hash",
  "artifact_redaction",
  "plan_candidate",
  "critique",
  "validation_obligation",
  "repair_candidate",
  "memory_patch_candidate",
  "fact_schema_validation",
  "fact_grounding_validation",
  "fact_scope_validation",
  "fact_provenance_validation",
  "fact_replay_validation",
]);
