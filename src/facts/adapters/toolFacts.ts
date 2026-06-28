import { redactSecrets, redactString } from "../../security/redaction";
import type { ToolEventSinkInput, ToolResult, ToolSchemaDefinition } from "../../tools";
import {
  createFactId,
  createFactScope,
  createFactTrust,
  FACT_SCHEMA_VERSION,
  ArtifactRefSchema,
  RectorFactSchema,
  toolCallProvenance,
  type ArtifactRef,
  type CapabilityWarningFact,
  type FactProvenance,
  type RectorFact,
  type ToolCallFact,
  type ToolDefinitionFact,
  type ToolFailureFact,
  type ToolResultFact,
} from "..";

export interface ToolFactAdapterOptions {
  readonly runId: string;
  readonly taskId?: string;
  readonly createdAt?: string;
}

export interface ToolCallFactInput {
  readonly callId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly options: ToolFactAdapterOptions;
}

export interface ToolResultFactInput {
  readonly callId: string;
  readonly toolName?: string;
  readonly result: ToolResult;
  readonly options: ToolFactAdapterOptions;
}

function createdAt(options: ToolFactAdapterOptions): string {
  return options.createdAt ?? new Date().toISOString();
}

function parseFact<T extends RectorFact>(draft: Record<string, unknown>): T {
  return RectorFactSchema.parse({ ...draft, factId: createFactId(draft) }) as T;
}

function envelope(options: ToolFactAdapterOptions, provenance: readonly FactProvenance[]) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "tool_registry" as const,
    provenance: [...provenance],
    scope: createFactScope({ scopeType: "run", taskIds: options.taskId ? [options.taskId] : [] }),
    redactionState: "redacted" as const,
  };
}

export function toolDefinitionToFact(definition: ToolSchemaDefinition, options: ToolFactAdapterOptions): ToolDefinitionFact {
  const redacted = redactSecrets(definition) as ToolSchemaDefinition;
  const provenance: FactProvenance[] = [{ sourceType: "system", systemId: "tool_registry", note: redacted.name }];
  return parseFact<ToolDefinitionFact>({
    ...envelope(options, provenance),
    kind: "tool_definition",
    trust: createFactTrust("schema_valid", "Tool definition is schema-validated registry metadata; it is not execution evidence"),
    toolName: redacted.name,
    description: redacted.description,
    risk: redacted.risk,
    requiresApproval: redacted.requiresApproval,
    requiresSandbox: redacted.requiresSandbox,
  });
}

export function toolCallToFact(input: ToolCallFactInput): ToolCallFact {
  const redactedArgs = redactSecrets(input.args) as Record<string, unknown>;
  const provenance = [toolCallProvenance({ toolName: input.toolName, callId: input.callId })];
  return parseFact<ToolCallFact>({
    ...envelope(input.options, provenance),
    kind: "tool_call",
    trust: createFactTrust("provenance_attached", "Tool call fact preserves tool name, call id, and redacted args"),
    callId: input.callId,
    toolName: redactString(input.toolName),
    args: redactedArgs,
  });
}

export function toolResultToFacts(input: ToolResultFactInput): Array<ToolResultFact | ToolFailureFact> {
  const toolName = input.toolName ?? input.result.toolName;
  if (!toolName) {
    throw new Error("toolResultToFacts requires a toolName when ToolResult.toolName is absent");
  }
  const redactedResult = redactSecrets(input.result) as ToolResult;
  const artifact = artifactFromMetadata(redactedResult.metadata);
  const provenance = [toolCallProvenance({ toolName, callId: input.callId, ...(artifact ? { artifact } : {}) })];
  const resultFact = parseFact<ToolResultFact>({
    ...envelope(input.options, provenance),
    kind: "tool_result",
    trust: redactedResult.ok ? createFactTrust("provenance_attached", "Tool result is redacted and linked to a tool call") : createFactTrust("rejected", "Tool result reports failure"),
    callId: input.callId,
    toolName: redactString(toolName),
    ok: redactedResult.ok,
    output: redactedResult.output,
    ...(redactedResult.error ? { error: redactedResult.error.message } : {}),
    ...(artifact ? { artifact } : {}),
  });

  if (redactedResult.ok || !redactedResult.error) return [resultFact];

  const failureFact = parseFact<ToolFailureFact>({
    ...envelope(input.options, provenance),
    kind: "tool_failure",
    trust: createFactTrust("rejected", `ToolRegistry classified failure as ${redactedResult.error.code}`),
    callId: input.callId,
    toolName: redactString(toolName),
    code: redactedResult.error.code,
    message: redactedResult.error.message,
    ...(redactedResult.error.details ? { details: redactedResult.error.details as Record<string, unknown> } : {}),
    retryable: isRetryableToolError(redactedResult.error.code),
    ...(artifact ? { artifact } : {}),
  });
  return [resultFact, failureFact];
}

export function toolEventSinkInputToFacts(input: {
  readonly event: ToolEventSinkInput;
  readonly callId: string;
  readonly options: ToolFactAdapterOptions;
}): Array<ToolCallFact | ToolResultFact | ToolFailureFact | CapabilityWarningFact> {
  const payload = redactSecrets(input.event.payload) as Record<string, unknown>;
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";

  if (input.event.type === "TOOL_INVOKED") {
    const args = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input) ? payload.input as Record<string, unknown> : {};
    return [toolCallToFact({ callId: input.callId, toolName, args, options: input.options })];
  }

  if (input.event.type === "TOOL_COMPLETED") {
    const ok = payload.ok === true;
    const output = payload.output && typeof payload.output === "object" && !Array.isArray(payload.output) ? payload.output as Record<string, unknown> : {};
    const error = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error) ? payload.error as ToolResult["error"] : undefined;
    return toolResultToFacts({
      callId: input.callId,
      toolName,
      options: input.options,
      result: {
        ok,
        toolName,
        output,
        ...(error ? { error } : {}),
        halt: payload.halt === true,
        middlewareHalt: payload.middlewareHalt === true,
        metadata: { sourceEventType: input.event.type, phase: input.event.phase },
      },
    });
  }

  return [parseFact<CapabilityWarningFact>({
    ...envelope(input.options, [{ sourceType: "system", systemId: "tool_registry", note: input.event.type }]),
    kind: "capability_warning",
    trust: createFactTrust("provenance_attached", "Tool registry budget event preserved as warning fact"),
    capabilityId: "tool_registry",
    warning: redactString(String(payload.reason ?? input.event.type)),
    severity: "medium",
  })];
}

function artifactFromMetadata(metadata: Record<string, unknown>): ArtifactRef | undefined {
  const uri = typeof metadata.artifactUri === "string"
    ? metadata.artifactUri
    : typeof metadata.rawArtifactUri === "string"
      ? metadata.rawArtifactUri
      : undefined;
  if (!uri) return undefined;

  const base = ArtifactRefSchema.safeParse({ refType: "artifact", uri });
  if (!base.success) return undefined;

  let draft: ArtifactRef = base.data;
  if (typeof metadata.artifactSha256 === "string") {
    const withSha = ArtifactRefSchema.safeParse({ ...draft, sha256: metadata.artifactSha256 });
    if (withSha.success) draft = withSha.data;
  }
  if (typeof metadata.artifactContentType === "string") {
    const withType = ArtifactRefSchema.safeParse({ ...draft, contentType: metadata.artifactContentType });
    if (withType.success) draft = withType.data;
  }
  if (typeof metadata.artifactSizeBytes === "number" && Number.isFinite(metadata.artifactSizeBytes) && metadata.artifactSizeBytes >= 0) {
    const withSize = ArtifactRefSchema.safeParse({ ...draft, sizeBytes: Math.trunc(metadata.artifactSizeBytes) });
    if (withSize.success) draft = withSize.data;
  }
  return draft;
}

function isRetryableToolError(code: ToolResult["error"] extends infer E ? E extends { code: infer C } ? C : never : never): boolean {
  return code === "TOOL_UNAVAILABLE" || code === "BUDGET_EXCEEDED";
}
