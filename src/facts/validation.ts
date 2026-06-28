import { z } from "zod";

import { FACT_TRUST_ORDER, compareFactTrust, isTerminalFactTrust } from "./trust";
import {
  FACT_SCHEMA_VERSION,
  FactFamilyKindSchema,
  RectorFactSchema,
  SafeFactPathSchema,
} from "./schemas";
import type { EvidenceRef, FactTrust, FactValidationError, GraphRef, RectorFact, SourceSpan } from "./types";

export type FactValidationGate = "schema" | "provenance" | "scope" | "grounding" | "artifact_refs" | "redaction" | "trust_transition" | "batch";
export type FactValidationStatus = "passed" | "failed" | "insufficient_evidence";

export type FactValidationResult<TFact extends RectorFact = RectorFact> = Readonly<{
  gate: FactValidationGate;
  status: FactValidationStatus;
  ok: boolean;
  fact?: TFact;
  errors: readonly FactValidationError[];
}>;

export type FactTrustTransitionInput = Readonly<{
  fact: unknown;
  previousFact?: unknown;
  supportingFacts?: readonly unknown[];
}>;

export type FactBatchValidationResult = Readonly<{
  gate: "batch";
  ok: boolean;
  acceptedFacts: readonly RectorFact[];
  rejectedFacts: readonly FactBatchRejectedFact[];
  errors: readonly FactValidationError[];
}>;

export type FactBatchRejectedFact = Readonly<{
  input: unknown;
  status: FactValidationStatus;
  errors: readonly FactValidationError[];
}>;

type ParsedFact = Readonly<{ fact?: RectorFact; errors: readonly FactValidationError[] }>;

type ArtifactRefLike = Readonly<{
  refType: "artifact";
  uri: string;
}>;

const ALLOWED_ARTIFACT_URI_SCHEMES = ["artifact://", "rector-artifact://"] as const;
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|password|passwd|secret|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{12,}/i,
  /\b(?:DefaultEndpointsProtocol|AccountKey|SharedAccessKey|EndpointSuffix)=.+/i,
];

export function validateFactSchema(input: unknown): FactValidationResult {
  const parsed = parseFact(input);
  if (!parsed.fact) return result("schema", "failed", parsed.errors);

  const jsonCheck = validateJsonCompatible(input);
  if (jsonCheck.length > 0) return result("schema", "failed", jsonCheck, parsed.fact);

  return result("schema", "passed", [], parsed.fact);
}

export function validateFactProvenance(input: unknown): FactValidationResult {
  const parsed = parseFact(input);
  if (!parsed.fact) return result("provenance", "failed", parsed.errors);
  const fact = parsed.fact;
  const errors: FactValidationError[] = [];

  const rawUserIntent = fact.kind === "intent" && fact.producer === "user" && fact.trust.level === "raw";
  if (fact.trust.level !== "raw" && fact.provenance.length === 0) {
    errors.push(error("missing_provenance", "Every non-raw fact requires provenance.", ["provenance"]));
  }
  if (rawUserIntent && !fact.provenance.some((entry) => entry.sourceType === "user")) {
    errors.push(error("missing_user_provenance", "Raw user intent facts require explicit user provenance.", ["provenance"]));
  }

  for (const [index, provenance] of fact.provenance.entries()) {
    switch (provenance.sourceType) {
      case "artifact":
        errors.push(...validateArtifactRefObject(provenance.artifact, ["provenance", index, "artifact"]));
        if (provenance.span) errors.push(...validateSourceSpanObject(provenance.span, ["provenance", index, "span"]));
        break;
      case "graph":
        errors.push(...validateGraphRefObject(provenance.graph, ["provenance", index, "graph"]));
        break;
      case "tool_call":
        if (fact.trust.level !== "raw" && !provenance.artifact) {
          errors.push(error("missing_tool_artifact", "Non-raw tool-call provenance requires an artifact reference.", ["provenance", index, "artifact"]));
        }
        if (provenance.artifact) errors.push(...validateArtifactRefObject(provenance.artifact, ["provenance", index, "artifact"]));
        break;
      case "capability_eval":
        if (isEvidenceFact(fact) && !provenance.artifact) {
          errors.push(error("missing_capability_artifact", "Capability evidence provenance requires an artifact reference.", ["provenance", index, "artifact"]));
        }
        if (provenance.artifact) errors.push(...validateArtifactRefObject(provenance.artifact, ["provenance", index, "artifact"]));
        break;
      case "llm_shadow":
        if (!provenance.artifact) {
          errors.push(error("missing_llm_artifact", "Live LLM shadow provenance requires the raw model-output artifact reference.", ["provenance", index, "artifact"]));
        } else {
          errors.push(...validateArtifactRefObject(provenance.artifact, ["provenance", index, "artifact"]));
        }
        break;
      default:
        break;
    }
  }

  if (fact.producer === "llm_shadow" || fact.provenance.some((entry) => entry.sourceType === "llm_shadow")) {
    const hasNonLlmSupport = fact.provenance.some((entry) => entry.sourceType !== "llm_shadow" && entry.sourceType !== "user");
    const hasArtifactBackedLlmOutput = fact.provenance.some((entry) => entry.sourceType === "llm_shadow" && Boolean(entry.artifact));
    if (!hasArtifactBackedLlmOutput) {
      errors.push(error("llm_output_not_artifacted", "Live LLM claims must retain a raw output artifact reference.", ["provenance"]));
    }
    if (isStrongerThan(fact.trust.level, "provenance_attached") && !hasNonLlmSupport) {
      errors.push(error("llm_self_certification", "Live LLM claims cannot self-certify stronger trust without non-LLM supporting evidence.", ["provenance"]));
    }
  }

  return result("provenance", errors.length === 0 ? "passed" : "insufficient_evidence", errors, fact);
}

export function validateFactScope(input: unknown): FactValidationResult {
  const parsed = parseFact(input);
  if (!parsed.fact) return result("scope", "failed", parsed.errors);
  const fact = parsed.fact;
  const errors: FactValidationError[] = [];

  for (const [index, path] of fact.scope.workspacePaths.entries()) {
    errors.push(...validatePath(path, ["scope", "workspacePaths", index]));
  }
  for (const [index, graph] of fact.scope.graphRefs.entries()) {
    errors.push(...validateGraphRefObject(graph, ["scope", "graphRefs", index]));
  }
  for (const pathRef of collectPathRefs(fact)) {
    errors.push(...validatePath(pathRef.path, pathRef.pathLocation));
    if (pathRef.span) errors.push(...validateSourceSpanObject(pathRef.span, pathRef.spanLocation));
  }

  if (errors.length === 0) return result("scope", "passed", [], fact);
  const status = fact.trust.level === "rejected" || fact.trust.level === "insufficient_evidence" ? "failed" : "insufficient_evidence";
  return result("scope", status, errors, fact);
}

export function validateFactGrounding(input: unknown): FactValidationResult {
  const parsed = parseFact(input);
  if (!parsed.fact) return result("grounding", "failed", parsed.errors);
  const fact = parsed.fact;
  const errors: FactValidationError[] = [];
  const graphRefs = collectGraphRefs(fact);
  const sourceSpans = collectSourceSpans(fact);

  for (const graph of graphRefs) {
    errors.push(...validateGraphRefObject(graph.graph, graph.location));
    if (graph.graph.queryStatus === "not_found" && !isNegativeEvidenceFact(fact)) {
      errors.push(error("not_found_as_success", "Graph queryStatus not_found is valid only as negative evidence, not trusted success.", graph.location));
    }
  }
  for (const sourceSpan of sourceSpans) {
    errors.push(...validateSourceSpanObject(sourceSpan.span, sourceSpan.location));
  }

  if (requiresGraphGrounding(fact) && !hasConcreteGraphGrounding(fact, graphRefs.map((entry) => entry.graph))) {
    errors.push(error("missing_graph_grounding", "Graph-grounded facts require a Cartographer snapshot plus node or edge IDs, or an explicit snapshot fact.", ["trust"]));
  }

  if (errors.length === 0) return result("grounding", "passed", [], fact);
  return result("grounding", "insufficient_evidence", errors, fact);
}

export function validateFactArtifactRefs(input: unknown): FactValidationResult {
  const parsed = parseFact(input);
  if (!parsed.fact) return result("artifact_refs", "failed", parsed.errors);
  const fact = parsed.fact;
  const errors: FactValidationError[] = [];

  for (const artifact of collectArtifactRefs(fact)) {
    errors.push(...validateArtifactRefObject(artifact.artifact, artifact.location));
  }

  if (requiresArtifactEvidence(fact) && collectArtifactRefs(fact).length === 0 && !hasInsufficientEvidenceRef(fact)) {
    errors.push(error("missing_artifact_ref", "This fact requires artifact refs or explicit insufficient_evidence.", ["provenance"]));
  }

  return result("artifact_refs", errors.length === 0 ? "passed" : "insufficient_evidence", errors, fact);
}

export function validateFactRedactionState(input: unknown): FactValidationResult {
  const parsed = parseFact(input);
  if (!parsed.fact) return result("redaction", "failed", parsed.errors);
  const fact = parsed.fact;
  const errors: FactValidationError[] = [];

  for (const finding of findSecretLikeValues(fact)) {
    errors.push(error("raw_secret_value", "Fact contains a raw secret-like value; durable facts must redact or replace it with an artifact reference.", finding.path));
  }

  if (fact.kind === "raw_artifact" && fact.redactionState === "unknown") {
    errors.push(error("unknown_raw_artifact_redaction", "Raw artifact facts must be redacted or explicitly marked none/contains_sensitive before durable use.", ["redactionState"]));
  }

  if (fact.kind === "artifact_redaction" && fact.toState === "unknown") {
    errors.push(error("unknown_artifact_redaction_output", "Artifact redaction facts cannot claim an unknown output redaction state.", ["toState"]));
  }

  return result("redaction", errors.length === 0 ? "passed" : "failed", errors, fact);
}

export function validateFactTrustTransition(input: FactTrustTransitionInput | unknown): FactValidationResult {
  const transition = isTransitionInput(input) ? input : { fact: input };
  const parsed = parseFact(transition.fact);
  if (!parsed.fact) return result("trust_transition", "failed", parsed.errors);
  const fact = parsed.fact;
  const errors: FactValidationError[] = [];
  const previous = transition.previousFact ? parseFact(transition.previousFact) : undefined;
  const supportingFacts = (transition.supportingFacts ?? []).map(parseFact).flatMap((entry) => (entry.fact ? [entry.fact] : []));

  if (previous && !previous.fact) {
    errors.push(...previous.errors);
  }
  if (previous?.fact) {
    const from = previous.fact.trust.level;
    const to = fact.trust.level;
    if (isTerminalFactTrust(from) && !isTerminalFactTrust(to) && !hasNewSupportingEvidence(previous.fact, fact, supportingFacts)) {
      errors.push(error("terminal_without_new_evidence", "Rejected or insufficient evidence facts are terminal until a new supporting evidence fact is appended.", ["trust", "level"]));
    }
    if (!isTerminalFactTrust(from) && !isTerminalFactTrust(to) && progressiveDistance(from, to) > 1 && !hasInterveningValidationSupport(from, to, supportingFacts)) {
      errors.push(error("trust_jump", `Fact trust cannot jump directly from ${from} to ${to} without supporting validation facts.`, ["trust", "level"]));
    }
  }

  const gateErrors = requiredGateErrorsForTrust(fact);
  errors.push(...gateErrors);

  return result("trust_transition", errors.length === 0 ? "passed" : "insufficient_evidence", errors, fact);
}

export function validateFactBatch(inputs: readonly unknown[]): FactBatchValidationResult {
  if (!Array.isArray(inputs)) {
    const errors = [error("batch_not_array", "validateFactBatch expects an array of fact inputs.", [])];
    return { gate: "batch", ok: false, acceptedFacts: [], rejectedFacts: [{ input: inputs, status: "failed", errors }], errors };
  }

  const acceptedFacts: RectorFact[] = [];
  const rejectedFacts: FactBatchRejectedFact[] = [];
  const allErrors: FactValidationError[] = [];
  const priorFacts: RectorFact[] = [];

  for (const input of inputs) {
    const schema = validateFactSchema(input);
    if (!schema.fact) {
      rejectedFacts.push({ input, status: schema.status, errors: schema.errors });
      allErrors.push(...schema.errors);
      continue;
    }

    const fact = schema.fact;
    const checks = [
      schema,
      validateFactProvenance(fact),
      validateFactArtifactRefs(fact),
      validateFactGrounding(fact),
      validateFactScope(fact),
      validateFactRedactionState(fact),
      validateFactTrustTransition({ fact, supportingFacts: priorFacts }),
    ];
    const errors = checks.flatMap((check) => [...check.errors]);
    if (errors.length === 0) {
      acceptedFacts.push(fact);
      priorFacts.push(fact);
    } else {
      const status: FactValidationStatus = checks.some((check) => check.status === "failed") ? "failed" : "insufficient_evidence";
      rejectedFacts.push({ input: fact, status, errors });
      allErrors.push(...errors);
    }
  }

  return { gate: "batch", ok: rejectedFacts.length === 0, acceptedFacts, rejectedFacts, errors: allErrors };
}

function parseFact(input: unknown): ParsedFact {
  const parsed = RectorFactSchema.safeParse(input);
  if (parsed.success) return { fact: parsed.data, errors: [] };
  return { errors: parsed.error.issues.map(zodIssueToValidationError) };
}

function result<TFact extends RectorFact>(gate: FactValidationGate, status: FactValidationStatus, errors: readonly FactValidationError[], fact?: TFact): FactValidationResult<TFact> {
  return { gate, status, ok: status === "passed" && errors.length === 0, fact, errors };
}

function error(code: string, message: string, path: readonly (string | number)[] = [], severity: FactValidationError["severity"] = "error"): FactValidationError {
  return { code, message, path: [...path], severity };
}

function zodIssueToValidationError(issue: z.ZodIssue): FactValidationError {
  return error(issue.code, issue.message, issue.path);
}

function validateJsonCompatible(input: unknown): FactValidationError[] {
  const errors: FactValidationError[] = [];
  function visit(value: unknown, path: (string | number)[]): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) errors.push(error("non_finite_number", "Facts must contain only finite JSON numbers.", path));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
          errors.push(error("prototype_pollution_key", "Facts must not contain prototype pollution keys.", [...path, key]));
          continue;
        }
        if (typeof nested === "undefined") continue;
        visit(nested, [...path, key]);
      }
      return;
    }
    if (typeof value === "undefined") errors.push(error("undefined_value", "Facts must not contain undefined values inside arrays.", path));
    else errors.push(error("non_json_value", `Facts must be JSON-compatible; received ${typeof value}.`, path));
  }
  visit(input, []);
  return errors;
}

function validatePath(path: string, location: readonly (string | number)[]): FactValidationError[] {
  const parsed = SafeFactPathSchema.safeParse(path);
  return parsed.success ? [] : parsed.error.issues.map((issue) => error("unsafe_path", issue.message, location));
}

function validateSourceSpanObject(span: SourceSpan, location: readonly (string | number)[]): FactValidationError[] {
  const errors: FactValidationError[] = [];
  errors.push(...validatePath(span.path, [...location, "path"]));
  if (!Number.isInteger(span.startLine) || span.startLine <= 0) errors.push(error("invalid_source_span", "Source span startLine must be a positive integer.", [...location, "startLine"]));
  if (!Number.isInteger(span.endLine) || span.endLine <= 0) errors.push(error("invalid_source_span", "Source span endLine must be a positive integer.", [...location, "endLine"]));
  if (span.endLine < span.startLine) errors.push(error("invalid_source_span", "Source span endLine must be greater than or equal to startLine.", [...location, "endLine"]));
  if (span.startColumn !== undefined && (!Number.isInteger(span.startColumn) || span.startColumn <= 0)) errors.push(error("invalid_source_span", "Source span startColumn must be a positive integer.", [...location, "startColumn"]));
  if (span.endColumn !== undefined && (!Number.isInteger(span.endColumn) || span.endColumn <= 0)) errors.push(error("invalid_source_span", "Source span endColumn must be a positive integer.", [...location, "endColumn"]));
  return errors;
}

function validateGraphRefObject(graph: GraphRef, location: readonly (string | number)[]): FactValidationError[] {
  const errors: FactValidationError[] = [];
  if (!graph.snapshotId.trim()) errors.push(error("missing_graph_snapshot", "Graph refs require a Cartographer snapshot ID.", [...location, "snapshotId"]));
  if (graph.queryStatus === "ok" && !graph.nodeId && !graph.edgeId) {
    errors.push(error("missing_graph_object_id", "Successful graph refs require a nodeId or edgeId.", location));
  }
  if (graph.queryStatus !== "not_found" && (graph.nodeId === "not_found" || graph.edgeId === "not_found")) {
    errors.push(error("fake_graph_reference", "Graph node/edge IDs must be concrete IDs, not placeholder not_found values.", location));
  }
  return errors;
}

function validateArtifactRefObject(artifact: ArtifactRefLike, location: readonly (string | number)[]): FactValidationError[] {
  const errors: FactValidationError[] = [];
  if (!ALLOWED_ARTIFACT_URI_SCHEMES.some((scheme) => artifact.uri.startsWith(scheme))) {
    errors.push(error("unsafe_artifact_uri", "Artifact refs must use an allowed artifact URI scheme, not absolute files, drive paths, UNC paths, or external URLs.", [...location, "uri"]));
  }
  if (artifact.uri.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(artifact.uri) || artifact.uri.startsWith("//") || artifact.uri.startsWith("\\\\") || artifact.uri.includes("..")) {
    errors.push(error("unsafe_artifact_uri", "Artifact refs must not contain absolute or traversal-style paths.", [...location, "uri"]));
  }
  return errors;
}

function collectArtifactRefs(fact: RectorFact): { artifact: ArtifactRefLike; location: (string | number)[] }[] {
  const refs: { artifact: ArtifactRefLike; location: (string | number)[] }[] = [];
  visitValue(fact, [], (value, path) => {
    if (isRecord(value) && value.refType === "artifact" && typeof value.uri === "string") refs.push({ artifact: value as ArtifactRefLike, location: path });
  });
  return refs;
}

function collectGraphRefs(fact: RectorFact): { graph: GraphRef; location: (string | number)[] }[] {
  const refs: { graph: GraphRef; location: (string | number)[] }[] = [];
  visitValue(fact, [], (value, path) => {
    if (isRecord(value) && value.refType === "graph" && typeof value.snapshotId === "string") refs.push({ graph: value as GraphRef, location: path });
  });
  return refs;
}

function collectSourceSpans(fact: RectorFact): { span: SourceSpan; location: (string | number)[] }[] {
  const spans: { span: SourceSpan; location: (string | number)[] }[] = [];
  visitValue(fact, [], (value, path) => {
    if (isRecord(value) && typeof value.path === "string" && typeof value.startLine === "number" && typeof value.endLine === "number") {
      spans.push({ span: value as SourceSpan, location: path });
    }
  });
  return spans;
}

function collectPathRefs(fact: RectorFact): { path: string; pathLocation: (string | number)[]; span?: SourceSpan; spanLocation: (string | number)[] }[] {
  const refs: { path: string; pathLocation: (string | number)[]; span?: SourceSpan; spanLocation: (string | number)[] }[] = [];
  visitValue(fact, [], (value, path) => {
    if (!isRecord(value) || typeof value.path !== "string") return;
    if (typeof value.startLine === "number" && typeof value.endLine === "number") refs.push({ path: value.path, pathLocation: [...path, "path"], span: value as SourceSpan, spanLocation: path });
    else refs.push({ path: value.path, pathLocation: [...path, "path"], spanLocation: path });
  });
  return refs;
}

function visitValue(value: unknown, path: (string | number)[], visitor: (value: unknown, path: (string | number)[]) => void): void {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitValue(item, [...path, index], visitor));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) visitValue(nested, [...path, key], visitor);
}

function findSecretLikeValues(fact: RectorFact): { path: (string | number)[] }[] {
  const findings: { path: (string | number)[] }[] = [];
  visitValue(fact, [], (value, path) => {
    if (typeof value !== "string") return;
    if (isSafeRedactionMarker(value)) return;
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) findings.push({ path });
  });
  return findings;
}

function isSafeRedactionMarker(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("[redacted]") || normalized.includes("<redacted>") || normalized.includes("***redacted***");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTransitionInput(input: unknown): input is FactTrustTransitionInput {
  return isRecord(input) && "fact" in input;
}

function requiresGraphGrounding(fact: RectorFact): boolean {
  return isStrongerThanOrEqual(fact.trust.level, "graph_grounded") || fact.kind.startsWith("graph_") || fact.kind === "cartographer_snapshot";
}

function hasConcreteGraphGrounding(fact: RectorFact, graphRefs: readonly GraphRef[]): boolean {
  if (fact.kind === "cartographer_snapshot") return Boolean(fact.snapshotId);
  return graphRefs.some((ref) => Boolean(ref.snapshotId && (ref.nodeId || ref.edgeId)) && ref.queryStatus !== "not_found");
}

function isEvidenceFact(fact: RectorFact): boolean {
  return fact.kind === "capability_evidence" || fact.kind === "capability_failure" || fact.kind === "context_slice" || fact.kind.endsWith("validation");
}

function isNegativeEvidenceFact(fact: RectorFact): boolean {
  if (fact.trust.level === "insufficient_evidence" || fact.trust.level === "rejected") return true;
  if (fact.kind === "context_slice" && fact.status === "not_found") return true;
  if (fact.kind === "capability_graph_context" && fact.status === "not_found") return true;
  if (fact.kind === "capability_failure") return true;
  return hasInsufficientEvidenceRef(fact);
}

function hasInsufficientEvidenceRef(fact: RectorFact): boolean {
  let found = false;
  visitValue(fact, [], (value) => {
    if (isRecord(value) && value.refType === "insufficient_evidence") found = true;
  });
  return found;
}

function requiresArtifactEvidence(fact: RectorFact): boolean {
  return fact.producer === "llm_shadow" || fact.provenance.some((entry) => entry.sourceType === "llm_shadow") || fact.kind === "raw_artifact" || fact.kind === "raw_artifact_chunk";
}

function requiredGateErrorsForTrust(fact: RectorFact): FactValidationError[] {
  if (fact.trust.level === "raw" || fact.trust.level === "rejected" || fact.trust.level === "insufficient_evidence") return [];
  const errors: FactValidationError[] = [];
  const gates: FactValidationResult[] = [validateFactSchema(fact)];
  if (isStrongerThanOrEqual(fact.trust.level, "provenance_attached")) gates.push(validateFactProvenance(fact));
  if (isStrongerThanOrEqual(fact.trust.level, "graph_grounded")) gates.push(validateFactGrounding(fact));
  if (isStrongerThanOrEqual(fact.trust.level, "scope_checked")) gates.push(validateFactScope(fact));
  if (isStrongerThanOrEqual(fact.trust.level, "validation_linked")) {
    gates.push(validateFactArtifactRefs(fact));
    const hasValidationSupport = fact.trust.validationRefs.length > 0 || fact.provenance.some((entry) => entry.sourceType === "validation");
    if (!hasValidationSupport) errors.push(error("missing_validation_support", "validation_linked trust requires validation refs or validation provenance.", ["trust", "validationRefs"]));
  }
  for (const gate of gates) {
    if (!gate.ok) errors.push(...gate.errors.map((entry) => ({ ...entry, code: `trust_requires_${entry.code}` })));
  }
  return errors;
}

function hasNewSupportingEvidence(previous: RectorFact, fact: RectorFact, supportingFacts: readonly RectorFact[]): boolean {
  if (fact.factId !== previous.factId && (fact.supersedesFactId === previous.factId || fact.contradictsFactId === previous.factId)) {
    return supportingFacts.some((support) => support.factId !== previous.factId && !isTerminalFactTrust(support.trust.level));
  }
  return false;
}

function hasInterveningValidationSupport(from: FactTrust["level"], to: FactTrust["level"], supportingFacts: readonly RectorFact[]): boolean {
  const fromIndex = FACT_TRUST_ORDER.indexOf(from as (typeof FACT_TRUST_ORDER)[number]);
  const toIndex = FACT_TRUST_ORDER.indexOf(to as (typeof FACT_TRUST_ORDER)[number]);
  if (fromIndex === -1 || toIndex === -1 || toIndex <= fromIndex + 1) return true;
  const requiredKinds = new Set<string>();
  for (const level of FACT_TRUST_ORDER.slice(fromIndex + 1, toIndex)) {
    if (level === "schema_valid") requiredKinds.add("fact_schema_validation");
    if (level === "provenance_attached") requiredKinds.add("fact_provenance_validation");
    if (level === "graph_grounded") requiredKinds.add("fact_grounding_validation");
    if (level === "scope_checked") requiredKinds.add("fact_scope_validation");
  }
  return [...requiredKinds].every((kind) => supportingFacts.some((support) => support.kind === kind && support.trust.level !== "rejected" && support.trust.level !== "insufficient_evidence"));
}

function progressiveDistance(from: FactTrust["level"], to: FactTrust["level"]): number {
  const fromIndex = FACT_TRUST_ORDER.indexOf(from as (typeof FACT_TRUST_ORDER)[number]);
  const toIndex = FACT_TRUST_ORDER.indexOf(to as (typeof FACT_TRUST_ORDER)[number]);
  if (fromIndex === -1 || toIndex === -1) return 0;
  return toIndex - fromIndex;
}

function isStrongerThan(level: FactTrust["level"], threshold: FactTrust["level"]): boolean {
  return compareFactTrust(level, threshold) > 0;
}

function isStrongerThanOrEqual(level: FactTrust["level"], threshold: FactTrust["level"]): boolean {
  return compareFactTrust(level, threshold) >= 0;
}

export function isKnownFactKind(kind: string): boolean {
  return FactFamilyKindSchema.safeParse(kind).success;
}

export function isKnownFactSchemaVersion(schemaVersion: string): boolean {
  return schemaVersion === FACT_SCHEMA_VERSION;
}
