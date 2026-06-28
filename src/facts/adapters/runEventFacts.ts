import type { RunEvent } from "../../protocol/events";
import { redactSecrets, redactString } from "../../security/redaction";
import { artifactRef, createFactId, createFactScope, createFactTrust, runEventProvenance } from "..";
import { FACT_SCHEMA_VERSION, RectorFactSchema } from "../schemas";
import type {
  ArtifactRef,
  CapabilityCallFact,
  CapabilityWarningFact,
  ContextSliceFact,
  FactGroundingValidationFact,
  FactProvenance,
  RawArtifactFact,
  RectorFact,
} from "../types";

export interface RunEventFactAdapterOptions {
  readonly taskId?: string;
  readonly createdAt?: string;
}

const LARGE_PAYLOAD_THRESHOLD_BYTES = 4_096;

function parseFact<T extends RectorFact>(draft: Record<string, unknown>): T {
  return RectorFactSchema.parse({ ...draft, factId: createFactId(draft) }) as T;
}

function createdAt(event: RunEvent, options: RunEventFactAdapterOptions): string {
  return options.createdAt ?? event.createdAt;
}

function provenance(event: RunEvent): FactProvenance[] {
  return [runEventProvenance({ runId: event.runId, eventId: event.id, eventType: event.type })];
}

function envelope(event: RunEvent, options: RunEventFactAdapterOptions) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    runId: event.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(event, options),
    producer: "system" as const,
    provenance: provenance(event),
    scope: createFactScope({ scopeType: "run", taskIds: options.taskId ? [options.taskId] : [] }),
    redactionState: "redacted" as const,
  };
}

export function runEventToFacts(eventInput: RunEvent, options: RunEventFactAdapterOptions = {}): RectorFact[] {
  const event = redactSecrets(eventInput) as RunEvent;
  const facts: RectorFact[] = [runEventToContextSliceFact(event, options), runEventToPhaseFact(event, options)];

  if (payloadSizeBytes(event.payload) > LARGE_PAYLOAD_THRESHOLD_BYTES) {
    facts.push(runEventPayloadArtifactFact(event, options));
  }

  if (event.type === "ARTIFACT_CREATED") facts.push(runEventToArtifactFact(event, options));
  if (event.type === "VALIDATION_PASSED" || event.type === "VALIDATION_FAILED") facts.push(runEventToValidationFact(event, options));
  if (event.type === "BUDGET_CHECKED" || event.type === "RUN_BUDGET_EXHAUSTED" || event.type === "BUDGET_APPROVAL_REQUESTED") facts.push(runEventToBudgetFact(event, options));
  return facts;
}

export function runEventToContextSliceFact(event: RunEvent, options: RunEventFactAdapterOptions = {}): ContextSliceFact {
  return parseFact<ContextSliceFact>({
    ...envelope(event, options),
    kind: "context_slice",
    trust: createFactTrust("provenance_attached", "Run event preserved as bounded JSON-compatible event fact"),
    query: `${event.type}:${event.id}`,
    status: "ok",
    summary: `${event.phase}:${event.type}`,
    evidence: [],
  });
}

export function runEventToPhaseFact(event: RunEvent, options: RunEventFactAdapterOptions = {}): CapabilityCallFact {
  return parseFact<CapabilityCallFact>({
    ...envelope(event, options),
    kind: "capability_call",
    trust: createFactTrust("provenance_attached", "Run phase fact uses canonical RunPhase from the event"),
    callId: event.id,
    capabilityId: `run_phase:${event.phase}`,
    status: phaseStatus(event),
  });
}

export function runEventToArtifactFact(event: RunEvent, options: RunEventFactAdapterOptions = {}): RawArtifactFact {
  const artifact = artifactRefFromPayload(event);
  return parseFact<RawArtifactFact>({
    ...envelope(event, options),
    kind: "raw_artifact",
    trust: createFactTrust("provenance_attached", "Artifact-created event references raw artifact metadata without dumping content"),
    artifact,
    byteCount: artifact.sizeBytes ?? 0,
  });
}

export function runEventToValidationFact(event: RunEvent, options: RunEventFactAdapterOptions = {}): FactGroundingValidationFact {
  const passed = event.type === "VALIDATION_PASSED";
  const targetFactId = typeof event.payload.targetFactId === "string" && /^fact_[a-f0-9]{32,64}$/.test(event.payload.targetFactId)
    ? event.payload.targetFactId
    : createFactId({ sourceEventId: event.id, sourceEventType: event.type });
  return parseFact<FactGroundingValidationFact>({
    ...envelope(event, options),
    kind: "fact_grounding_validation",
    trust: createFactTrust("provenance_attached", "Validation run event preserved without promoting target fact"),
    targetFactId,
    status: passed ? "passed" : "failed",
    evidence: validationEvidenceFromPayload(event),
  });
}

export function runEventToBudgetFact(event: RunEvent, options: RunEventFactAdapterOptions = {}): CapabilityWarningFact {
  const severity = event.type === "RUN_BUDGET_EXHAUSTED" ? "high" : "medium";
  return parseFact<CapabilityWarningFact>({
    ...envelope(event, options),
    kind: "capability_warning",
    trust: createFactTrust("provenance_attached", "Budget event preserved as warning, not success"),
    capabilityId: "budget",
    warning: redactString(String(event.payload.reason ?? event.type)),
    severity,
  });
}

function runEventPayloadArtifactFact(event: RunEvent, options: RunEventFactAdapterOptions): RawArtifactFact {
  const artifact = artifactRef({
    uri: `run-event://${event.runId}/${event.id}/payload.json`,
    contentType: "application/json",
    sizeBytes: payloadSizeBytes(event.payload),
  });
  return parseFact<RawArtifactFact>({
    ...envelope(event, options),
    kind: "raw_artifact",
    trust: createFactTrust("provenance_attached", "Large run event payload is referenced instead of inlined"),
    artifact,
    byteCount: artifact.sizeBytes ?? 0,
  });
}

function artifactRefFromPayload(event: RunEvent): ArtifactRef {
  const uri = typeof event.payload.uri === "string"
    ? event.payload.uri
    : typeof event.payload.artifactUri === "string"
      ? event.payload.artifactUri
      : `run-event://${event.runId}/${event.id}/artifact`;
  const sizeBytes = typeof event.payload.sizeBytes === "number" && Number.isFinite(event.payload.sizeBytes) && event.payload.sizeBytes >= 0
    ? Math.trunc(event.payload.sizeBytes)
    : undefined;
  const contentType = typeof event.payload.contentType === "string" ? event.payload.contentType : undefined;
  return artifactRef({ uri, ...(sizeBytes === undefined ? {} : { sizeBytes }), ...(contentType ? { contentType } : {}) });
}

function validationEvidenceFromPayload(event: RunEvent): FactGroundingValidationFact["evidence"] {
  if (typeof event.payload.artifactUri === "string") return [artifactRef({ uri: event.payload.artifactUri })];
  if (typeof event.payload.uri === "string") return [artifactRef({ uri: event.payload.uri })];
  return [{ refType: "insufficient_evidence", reason: "validation event did not include artifact reference", missing: ["artifactUri"], searched: [event.id] }];
}

function phaseStatus(event: RunEvent): CapabilityCallFact["status"] {
  if (event.type === "RUN_FAILED" || event.type === "DAG_NODE_FAILED" || event.type === "VALIDATION_FAILED") return "failed";
  if (event.phase === "DONE" || event.type === "RUN_COMPLETED") return "completed";
  if (event.phase === "FAILED" || event.phase === "ABORTED") return "failed";
  return "running";
}

function payloadSizeBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}
