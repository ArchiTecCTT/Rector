import type { CapabilityEvidencePacket } from "../../capabilities/eval/evidencePacket";
import type { CapabilityEvalCase, CapabilityEvalResult } from "../../capabilities/eval/schemas";
import { redactSecrets, redactString } from "../../security/redaction";
import {
  artifactRef,
  capabilityEvalProvenance,
  createFactId,
  createFactScope,
  createFactTrust,
  FACT_SCHEMA_VERSION,
  insufficientEvidence,
  isSafeFactPath,
  RectorFactSchema,
  type CapabilityCoverageFact,
  type CapabilityEvidenceFact,
  type CapabilityFailureFact,
  type CapabilityRequestFact,
  type CapabilityWarningFact,
  type EvidenceRef,
  type FactProvenance,
  type RectorFact,
} from "..";

export interface CapabilityEvalFactAdapterOptions {
  readonly runId: string;
  readonly taskId?: string;
  readonly createdAt?: string;
}

function createdAt(options: CapabilityEvalFactAdapterOptions): string {
  return options.createdAt ?? new Date().toISOString();
}

function parseFact<T extends RectorFact>(draft: Record<string, unknown>): T {
  return RectorFactSchema.parse({ ...draft, factId: createFactId(draft) }) as T;
}

function safePaths(paths: readonly string[]): string[] {
  return paths.filter(isSafeFactPath);
}

function envelope(options: CapabilityEvalFactAdapterOptions, provenance: readonly FactProvenance[], workspacePaths: readonly string[] = []) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "capability_eval" as const,
    provenance: [...provenance],
    scope: createFactScope({ scopeType: "workspace", workspacePaths: safePaths(workspacePaths), taskIds: options.taskId ? [options.taskId] : [] }),
    redactionState: "redacted" as const,
  };
}

export function capabilityEvalCaseToRequestFact(caseInput: CapabilityEvalCase, options: CapabilityEvalFactAdapterOptions): CapabilityRequestFact {
  const evalCase = redactSecrets(caseInput) as CapabilityEvalCase;
  const provenance = [capabilityEvalProvenance({ capabilityId: evalCase.capabilityId, caseId: evalCase.id })];
  return parseFact<CapabilityRequestFact>({
    ...envelope(options, provenance, evalCase.request.scope),
    kind: "capability_request",
    trust: createFactTrust("schema_valid", "Capability eval case is schema-validated request metadata"),
    requestId: evalCase.id,
    capabilityId: evalCase.capabilityId,
    intent: evalCase.request.intent,
  });
}

export function capabilityEvalResultToFacts(input: {
  readonly caseInput?: CapabilityEvalCase;
  readonly result: CapabilityEvalResult;
  readonly options: CapabilityEvalFactAdapterOptions;
}): Array<CapabilityRequestFact | CapabilityEvidenceFact | CapabilityCoverageFact | CapabilityWarningFact | CapabilityFailureFact> {
  const result = redactSecrets(input.result) as CapabilityEvalResult;
  const facts: Array<CapabilityRequestFact | CapabilityEvidenceFact | CapabilityCoverageFact | CapabilityWarningFact | CapabilityFailureFact> = [];
  const provenance = [capabilityEvalProvenance({ capabilityId: result.capabilityId, caseId: result.caseId, ...(result.rawArtifactRefs[0] ? { artifact: artifactRef({ uri: result.rawArtifactRefs[0] }) } : {}) })];

  if (input.caseInput) facts.push(capabilityEvalCaseToRequestFact(input.caseInput, input.options));

  facts.push(parseFact<CapabilityEvidenceFact>({
    ...envelope(input.options, provenance, input.caseInput?.request.scope ?? []),
    kind: "capability_evidence",
    trust: result.rawArtifactRefs.length > 0 ? createFactTrust("provenance_attached", "Capability eval evidence references raw artifacts") : createFactTrust("insufficient_evidence", "Capability eval result did not include raw artifact refs"),
    capabilityId: result.capabilityId,
    summary: result.passed ? `Capability eval ${result.caseId} passed with metric evidence` : `Capability eval ${result.caseId} failed or skipped with metric evidence`,
    evidence: evidenceRefsFromRawArtifacts(result.rawArtifactRefs, `capability eval ${result.caseId} did not include artifact refs`),
  }));

  facts.push(parseFact<CapabilityCoverageFact>({
    ...envelope(input.options, provenance, input.caseInput?.request.scope ?? []),
    kind: "capability_coverage",
    trust: createFactTrust("provenance_attached", "Coverage counts are eval measurements, not truth claims"),
    capabilityId: result.capabilityId,
    searchedScope: safePaths(input.caseInput?.request.scope ?? []),
    rawCount: result.rawArtifactRefs.length,
    returnedCount: result.rawArtifactRefs.length - result.omissions.length >= 0 ? result.rawArtifactRefs.length - result.omissions.length : 0,
    omittedScope: result.omissions,
  }));

  for (const omission of result.omissions) {
    facts.push(parseFact<CapabilityWarningFact>({
      ...envelope(input.options, provenance, input.caseInput?.request.scope ?? []),
      kind: "capability_warning",
      trust: createFactTrust("provenance_attached", "Capability eval omission preserved as warning"),
      capabilityId: result.capabilityId,
      warning: redactString(omission),
      severity: "medium",
    }));
  }

  if (!result.passed || result.failureReason) {
    facts.push(parseFact<CapabilityFailureFact>({
      ...envelope(input.options, provenance, input.caseInput?.request.scope ?? []),
      kind: "capability_failure",
      trust: createFactTrust("rejected", "Capability eval did not pass"),
      capabilityId: result.capabilityId,
      reason: redactString(result.failureReason ?? `eval ${result.caseId} did not pass`),
      retryable: false,
      evidence: evidenceRefsFromRawArtifacts(result.rawArtifactRefs, `failure ${result.caseId} had no artifact refs`),
    }));
  }

  return facts;
}

export function capabilityEvidencePacketToFacts(packetInput: CapabilityEvidencePacket, options: CapabilityEvalFactAdapterOptions): Array<CapabilityEvidenceFact | CapabilityCoverageFact | CapabilityWarningFact | CapabilityFailureFact> {
  const packet = redactSecrets(packetInput) as CapabilityEvidencePacket;
  const provenance = [capabilityEvalProvenance({ capabilityId: packet.capabilityId, caseId: packet.caseId, ...(packet.rawArtifactRefs[0] ? { artifact: artifactRef({ uri: packet.rawArtifactRefs[0] }) } : {}) })];
  const workspacePaths = packet.evidence.map((item) => item.path).filter((path): path is string => path !== undefined);
  const evidence = packet.evidence.length > 0
    ? packet.evidence.flatMap((item) => evidenceRefsFromPacketItem(item, packet.rawArtifactRefs))
    : [insufficientEvidence({ reason: "capability evidence packet contains no evidence items", missing: ["evidence item"], searched: packet.rawArtifactRefs })];

  const facts: Array<CapabilityEvidenceFact | CapabilityCoverageFact | CapabilityWarningFact | CapabilityFailureFact> = [
    parseFact<CapabilityEvidenceFact>({
      ...envelope(options, provenance, workspacePaths),
      kind: "capability_evidence",
      trust: packet.evidence.length > 0 ? createFactTrust("provenance_attached", "Capability evidence packet item refs are preserved") : createFactTrust("insufficient_evidence", "Packet has no evidence items"),
      capabilityId: packet.capabilityId,
      summary: packet.summary,
      evidence,
    }),
    parseFact<CapabilityCoverageFact>({
      ...envelope(options, provenance, workspacePaths),
      kind: "capability_coverage",
      trust: createFactTrust("provenance_attached", "Capability packet coverage preserved as measurement"),
      capabilityId: packet.capabilityId,
      searchedScope: safePaths(workspacePaths),
      rawCount: packet.rawArtifactRefs.length,
      returnedCount: packet.evidence.length,
      omittedScope: [...packet.coverage.missingMustContain, ...packet.coverage.unresolvedArtifactRefs, ...packet.coverage.unresolvedFileRefs, ...packet.coverage.outOfBoundsLineRefs],
    }),
  ];

  for (const warning of packet.warnings) {
    facts.push(parseFact<CapabilityWarningFact>({
      ...envelope(options, provenance, workspacePaths),
      kind: "capability_warning",
      trust: createFactTrust("provenance_attached", "Capability evidence packet warning preserved"),
      capabilityId: packet.capabilityId,
      warning: redactString(warning),
      severity: "medium",
    }));
  }

  if (!packet.coverage.passed) {
    facts.push(parseFact<CapabilityFailureFact>({
      ...envelope(options, provenance, workspacePaths),
      kind: "capability_failure",
      trust: createFactTrust("rejected", "Capability evidence coverage did not pass"),
      capabilityId: packet.capabilityId,
      reason: "capability evidence coverage failed",
      retryable: false,
      evidence,
    }));
  }
  return facts;
}

function evidenceRefsFromRawArtifacts(rawArtifactRefs: readonly string[], missingReason: string): EvidenceRef[] {
  if (rawArtifactRefs.length === 0) {
    return [insufficientEvidence({ reason: missingReason, missing: ["rawArtifactRefs"], searched: [] })];
  }
  return rawArtifactRefs.map((uri) => artifactRef({ uri }));
}

function evidenceRefsFromPacketItem(item: CapabilityEvidencePacket["evidence"][number], packetRawRefs: readonly string[]): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  if (item.path && item.lineStart && item.lineEnd) {
    refs.push({ refType: "source_span", path: item.path, startLine: item.lineStart, endLine: item.lineEnd });
  }
  refs.push(artifactRef({ uri: item.rawArtifactRef }));
  if (!packetRawRefs.includes(item.rawArtifactRef)) {
    refs.push(insufficientEvidence({ reason: "evidence item raw artifact ref is not declared by packet", missing: [item.rawArtifactRef], searched: [...packetRawRefs] }));
  }
  return refs;
}
