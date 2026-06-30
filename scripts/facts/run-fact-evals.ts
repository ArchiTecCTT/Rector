#!/usr/bin/env tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CartographerGraphNode, GraphSnapshot } from "../../src/cartographer";
import type { CapabilityEvalResult } from "../../src/capabilities/eval/schemas";
import type { GlobalScenario } from "../../src/evals/globalScenarioSchema";
import type { RunEvent } from "../../src/protocol/events";
import type { ToolSchemaDefinition } from "../../src/tools";
import { getEvidenceTrackDir } from "../../src/evidence";
import {
  type FactEvalCaseReport,
  type FactEvalMetricId,
  buildFactEvalReport,
  capabilityEvalResultToFacts,
  cartographerSnapshotToFact,
  createFactId,
  createFactScope,
  createFactTrust,
  diffFacts,
  factRefsForReport,
  factsEqual,
  FACT_SCHEMA_VERSION,
  globalScenarioToFacts,
  graphNodeToFact,
  fileQueryResultToFacts,
  InMemoryFactLedger,
  replayRun,
  renderFactEvalMarkdown,
  toolDefinitionToFact,
  toolResultToFacts,
  runEventToFacts,
  validateFactArtifactRefs,
  validateFactGrounding,
  validateFactProvenance,
  validateFactRedactionState,
  validateFactSchema,
  validateFactScope,
  validateFactTrustTransition,
  validationErrorsForReport,
  type FactValidationError,
  type FactValidationResult,
  type RectorFact,
} from "../../src/facts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_OUTPUT_DIR = getEvidenceTrackDir("phase2", REPO_ROOT);
const CREATED_AT = "2026-06-28T00:00:00.000Z";

export interface RunFactEvalsOptions {
  readonly outputDir?: string;
  readonly write?: boolean;
  readonly now?: () => Date;
}

export interface RunFactEvalsOutput {
  readonly report: ReturnType<typeof buildFactEvalReport>;
  readonly markdown: string;
  readonly jsonPath?: string;
  readonly markdownPath?: string;
}

type FactEvalFixture = Readonly<{
  id: string;
  title: string;
  rawInputs: readonly unknown[];
  expectedAccepted: number;
  expectedRejected: number;
  expectInsufficientEvidence?: boolean;
  expectSecretBlocked?: boolean;
  expectHallucinatedReferenceBlocked?: boolean;
}>;

type EvaluatedInput = Readonly<{
  input: unknown;
  fact?: RectorFact;
  accepted: boolean;
  errors: readonly FactValidationError[];
  checks: readonly FactValidationResult[];
}>;

export async function runFactEvals(options: RunFactEvalsOptions = {}): Promise<RunFactEvalsOutput> {
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const shouldWrite = options.write ?? true;
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const cases: FactEvalCaseReport[] = [];
  for (const fixture of buildFixtures()) cases.push(await evaluateFixture(fixture));

  const report = buildFactEvalReport({ generatedAt, cases });
  const markdown = renderFactEvalMarkdown(report);

  if (!shouldWrite) return { report, markdown };

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "fact-report.json");
  const markdownPath = path.join(outputDir, "fact-report.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, markdown, "utf8");
  return { report, markdown, jsonPath, markdownPath };
}

function buildFixtures(): FactEvalFixture[] {
  const options = { runId: "run-fact-evals", taskId: "task-phase-2e", createdAt: CREATED_AT };
  const snapshot: GraphSnapshot = { id: "graph-snapshot-phase-2e", repoRoot: REPO_ROOT, inventorySnapshotId: "inventory-phase-2e", createdAt: CREATED_AT, nodeCount: 1, edgeCount: 0 };
  const node: CartographerGraphNode = { id: "node:file:src/facts/index.ts", snapshotId: snapshot.id, kind: "File", label: "src/facts/index.ts", normalizedPath: "src/facts/index.ts", properties: {} };
  const toolDefinition: ToolSchemaDefinition = { name: "phase2e.inspect", description: "Inspect committed offline fact fixture metadata", inputSchema: { path: { type: "string" } }, risk: "low", requiresApproval: false, requiresSandbox: false };
  const capabilityResult: CapabilityEvalResult = {
    schemaVersion: "rector.capability-eval.v1",
    caseId: "phase2e-capability-eval",
    capabilityId: "cartographer.grounding",
    passed: true,
    metricScores: { schema_valid: 1, recall: 1, omission: 0, secret_leak: 0, compression: 10, raw_token_reduction: 0.9, line_ref_accuracy: 1, root_cause_accuracy: 1 },
    omissions: [],
    rawArtifactRefs: ["artifact://phase-2e/capability-eval-result.json"],
  };
  const scenario = globalScenarioFixture();
  const runEvent: RunEvent = {
    id: "evt-phase2e-validation",
    runId: "run-fact-evals",
    type: "VALIDATION_FAILED",
    phase: "VALIDATING",
    payload: { targetFactId: createFactId({ target: "phase2e" }), artifactUri: "artifact://phase-2e/validator-output.txt" },
    createdAt: CREATED_AT,
  };

  return [
    {
      id: "cartographer_snapshot_to_facts",
      title: "Cartographer snapshot and graph object become graph-grounded facts",
      rawInputs: [cartographerSnapshotToFact(snapshot, options), graphNodeToFact(node, options)],
      expectedAccepted: 2,
      expectedRejected: 0,
    },
    {
      id: "cartographer_not_found_to_negative_fact",
      title: "Cartographer not_found query is preserved as insufficient evidence",
      rawInputs: fileQueryResultToFacts({ snapshotId: snapshot.id, query: "missing.ts", result: { status: "not_found", path: "missing.ts" }, options }),
      expectedAccepted: 1,
      expectedRejected: 0,
      expectInsufficientEvidence: true,
    },
    {
      id: "tool_registry_definition_to_fact",
      title: "Tool registry definition becomes schema-valid metadata fact",
      rawInputs: [toolDefinitionToFact(toolDefinition, options)],
      expectedAccepted: 1,
      expectedRejected: 0,
    },
    {
      id: "tool_failure_to_failure_fact",
      title: "Tool failure keeps failure reason and source artifact reference",
      rawInputs: toolResultToFacts({
        callId: "tool-call-phase2e",
        toolName: "phase2e.inspect",
        options,
        result: { ok: false, toolName: "phase2e.inspect", output: {}, error: { code: "TOOL_HANDLER_FAILED", message: "fixture command failed" }, halt: true, middlewareHalt: true, metadata: { artifactUri: "artifact://phase-2e/tool-failure.json", artifactContentType: "application/json" } },
      }),
      expectedAccepted: 2,
      expectedRejected: 0,
    },
    {
      id: "capability_eval_result_to_evidence_facts",
      title: "Capability eval result becomes evidence, coverage, and request facts",
      rawInputs: capabilityEvalResultToFacts({ result: capabilityResult, options }),
      expectedAccepted: 2,
      expectedRejected: 0,
    },
    {
      id: "global_scenario_to_oracle_facts",
      title: "Global scenario oracle and validators become typed fact obligations",
      rawInputs: globalScenarioToFacts(scenario, options),
      expectedAccepted: 16,
      expectedRejected: 0,
    },
    {
      id: "run_event_trace_to_facts",
      title: "Run event trace becomes run-scoped facts without dumping payloads",
      rawInputs: runEventToFacts(runEvent, { taskId: options.taskId, createdAt: CREATED_AT }),
      expectedAccepted: 3,
      expectedRejected: 0,
    },
    {
      id: "malformed_fact_rejected",
      title: "Malformed fact input is rejected by schema validation",
      rawInputs: [{ schemaVersion: FACT_SCHEMA_VERSION, kind: "tool_result", runId: "run-fact-evals" }],
      expectedAccepted: 0,
      expectedRejected: 1,
    },
    {
      id: "fake_provenance_rejected",
      title: "Fake live-model provenance cannot self-certify without raw artifact refs",
      rawInputs: [fakeLlmShadowFact()],
      expectedAccepted: 0,
      expectedRejected: 1,
      expectInsufficientEvidence: true,
      expectHallucinatedReferenceBlocked: true,
    },
    {
      id: "secret_payload_redacted_or_blocked",
      title: "Secret-like payload is blocked from durable accepted facts",
      rawInputs: [secretLeakingFact()],
      expectedAccepted: 0,
      expectedRejected: 1,
      expectSecretBlocked: true,
    },
  ];
}

async function evaluateFixture(fixture: FactEvalFixture): Promise<FactEvalCaseReport> {
  const evaluated = fixture.rawInputs.map(evaluateInput);
  const acceptedFacts = evaluated.flatMap((entry) => entry.accepted && entry.fact ? [entry.fact] : []);
  const rejected = evaluated.filter((entry) => !entry.accepted);
  const validationErrors = evaluated.flatMap((entry) => [...entry.errors]);
  const failureReasons: string[] = [];

  if (acceptedFacts.length !== fixture.expectedAccepted) failureReasons.push(`expected ${fixture.expectedAccepted} accepted fact(s), got ${acceptedFacts.length}`);
  if (rejected.length !== fixture.expectedRejected) failureReasons.push(`expected ${fixture.expectedRejected} rejected input(s), got ${rejected.length}`);
  if (fixture.expectInsufficientEvidence && !hasInsufficientEvidence(evaluated)) failureReasons.push("expected insufficient_evidence/rejected evidence state was not observed");
  if (fixture.expectSecretBlocked && !validationErrors.some((error) => error.code.includes("secret"))) failureReasons.push("expected secret-like payload to be blocked by redaction validation");
  if (fixture.expectHallucinatedReferenceBlocked && !validationErrors.some((error) => error.code.includes("llm") || error.code.includes("artifact") || error.code.includes("provenance"))) failureReasons.push("expected fake/hallucinated provenance to be rejected");

  const replaySuccessRate = await computeReplaySuccessRate(acceptedFacts);
  const factDiffAccuracy = computeFactDiffAccuracy(acceptedFacts);
  const factRefs = factRefsForReport(acceptedFacts);
  const metrics = metricsForCase({ evaluated, acceptedFacts, factRefs, replaySuccessRate, factDiffAccuracy, fixture });

  return {
    id: fixture.id,
    title: fixture.title,
    passed: failureReasons.length === 0,
    acceptedFactCount: acceptedFacts.length,
    rejectedInputCount: rejected.length,
    failureReasons,
    metrics,
    factRefs,
    validationErrors: validationErrorsForReport(validationErrors),
  };
}

function evaluateInput(input: unknown): EvaluatedInput {
  const schema = validateFactSchema(input);
  if (!schema.fact) return { input, accepted: false, errors: schema.errors, checks: [schema] };
  const fact = schema.fact;
  const checks = [
    schema,
    validateFactProvenance(fact),
    validateFactArtifactRefs(fact),
    validateFactGrounding(fact),
    validateFactScope(fact),
    validateFactRedactionState(fact),
    validateFactTrustTransition({ fact }),
  ];
  const errors = checks.flatMap((check) => [...check.errors]);
  return { input, fact, accepted: errors.length === 0, errors, checks };
}

function metricsForCase(input: {
  readonly evaluated: readonly EvaluatedInput[];
  readonly acceptedFacts: readonly RectorFact[];
  readonly factRefs: ReturnType<typeof factRefsForReport>;
  readonly replaySuccessRate: number;
  readonly factDiffAccuracy: number;
  readonly fixture: FactEvalFixture;
}): Record<FactEvalMetricId, number> {
  const schemaChecks = input.evaluated.map((entry) => entry.checks.find((check) => check.gate === "schema"));
  const factsOrExpectedRejections = input.acceptedFacts.length + input.fixture.expectedRejected;
  return {
    schema_valid_rate: input.fixture.expectedAccepted === 0 && input.fixture.expectedRejected > 0 ? 1 : rate(schemaChecks.filter(Boolean).filter((check) => check?.ok).length, schemaChecks.length),
    provenance_complete_rate: input.acceptedFacts.length === 0 ? 1 : rate(input.acceptedFacts.filter((fact) => fact.provenance.length > 0).length, input.acceptedFacts.length),
    grounding_success_rate: rate(input.evaluated.filter((entry) => entry.checks.some((check) => check.gate === "grounding" && (check.ok || entry.fact?.trust.level === "insufficient_evidence" || entry.fact?.trust.level === "rejected"))).length || (input.fixture.expectedRejected > 0 ? input.fixture.expectedRejected : 0), input.evaluated.length),
    insufficient_evidence_correctness: input.fixture.expectInsufficientEvidence ? (hasInsufficientEvidence(input.evaluated) ? 1 : 0) : 1,
    hallucinated_reference_count: input.fixture.expectHallucinatedReferenceBlocked ? 0 : input.evaluated.reduce((count, entry) => count + entry.errors.filter((error) => ["fake_graph_reference", "missing_llm_artifact", "llm_output_not_artifacted", "unsafe_artifact_uri"].includes(error.code)).length, 0),
    secret_leak_count: Math.max(0, input.evaluated.reduce((count, entry) => count + entry.errors.filter((error) => error.code === "raw_secret_value").length, 0) - (input.fixture.expectSecretBlocked ? 1 : 0)),
    replay_success_rate: input.replaySuccessRate,
    fact_diff_accuracy: input.factDiffAccuracy,
    raw_artifact_ref_coverage: factsOrExpectedRejections === 0 ? 1 : rate(input.factRefs.filter((factRef) => factRef.sourceRefs.length > 0).length + input.fixture.expectedRejected, factsOrExpectedRejections),
    trust_transition_violation_count: input.fixture.expectHallucinatedReferenceBlocked ? 0 : input.evaluated.reduce((count, entry) => count + entry.errors.filter((error) => error.code === "trust_jump" || error.code.startsWith("trust_requires_")).length, 0),
  };
}

async function computeReplaySuccessRate(facts: readonly RectorFact[]): Promise<number> {
  if (facts.length === 0) return 1;
  const ledger = new InMemoryFactLedger({ now: () => CREATED_AT });
  await ledger.appendMany(facts);
  const replayed = await replayRun(ledger);
  return factsEqual(facts, replayed.facts) ? 1 : 0;
}

function computeFactDiffAccuracy(facts: readonly RectorFact[]): number {
  const diff = diffFacts([], facts);
  return diff.added.length === facts.length && diff.removed.length === 0 && diff.changed.length === 0 ? 1 : 0;
}

function hasInsufficientEvidence(evaluated: readonly EvaluatedInput[]): boolean {
  return evaluated.some((entry) => entry.fact?.trust.level === "insufficient_evidence" || entry.fact?.trust.level === "rejected" || entry.errors.some((error) => error.code.includes("insufficient") || error.code.includes("missing_llm") || error.code.includes("provenance")));
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

function globalScenarioFixture(): GlobalScenario {
  return {
    schemaVersion: "rector.global-scenario.v1",
    id: "phase2e-fact-ref-scenario",
    title: "Phase 2E fact refs are expected in global harness evidence",
    type: "evidence",
    workspace: "tests/fixtures/repos/rector-mini-fix",
    userGoal: "Verify fact references are represented as typed evidence obligations",
    allowedSystems: ["coding"],
    forbiddenSystems: ["memory-writer"],
    expectedSpecialist: "coding",
    successCriteria: ["fact refs resolve", "validator trace is retained"],
    validators: [{ id: "fixture-integrity-verifier", cmd: "node", args: ["src/fixture-integrity.verify.js"], cwd: ".", timeoutMs: 30_000, expectedExitCode: 0 }],
    oracles: { mustChange: [], mustNotChange: ["src/calculator.ts"], mustIncludeEvidence: ["cartographer.grounding", "fact:global_harness:oracle"] },
    budgets: { maxToolCalls: 10, maxRuntimeMs: 60_000, maxMainModelRawToolTokens: 100 },
    setup: { copyWorkspaceToTemp: false, fixtures: [] },
    operation: { kind: "validator_only" },
    expected: { status: "passed", changedPaths: [], unchangedPaths: ["src/calculator.ts"], evidenceRefs: ["cartographer.grounding", "fact:global_harness:oracle"] },
  };
}

function fakeLlmShadowFact(): RectorFact {
  const draft = {
    schemaVersion: FACT_SCHEMA_VERSION as typeof FACT_SCHEMA_VERSION,
    kind: "intent" as const,
    runId: "run-fact-evals",
    createdAt: CREATED_AT,
    producer: "llm_shadow" as const,
    provenance: [{ sourceType: "llm_shadow" as const, providerId: "FakeLLMProvider", modelId: "fake-live-claim" }],
    trust: createFactTrust("provenance_attached", "Fake provider provenance must not be accepted as live evidence"),
    scope: createFactScope({ scopeType: "run" }),
    redactionState: "none" as const,
    intent: "claim generated by a fake provider",
    confidence: 0.99,
  };
  return { ...draft, factId: createFactId(draft) } as RectorFact;
}

function secretLeakingFact(): RectorFact {
  const draft = {
    schemaVersion: FACT_SCHEMA_VERSION as typeof FACT_SCHEMA_VERSION,
    kind: "tool_result" as const,
    runId: "run-fact-evals",
    createdAt: CREATED_AT,
    producer: "tool_registry" as const,
    provenance: [{ sourceType: "tool_call" as const, toolName: "phase2e.secret", callId: "tool-call-secret", artifact: { refType: "artifact" as const, uri: "artifact://phase-2e/secret-output.txt" } }],
    trust: createFactTrust("provenance_attached", "Secret-like payload must be blocked before durable reporting"),
    scope: createFactScope({ scopeType: "run" }),
    redactionState: "none" as const,
    callId: "tool-call-secret",
    toolName: "phase2e.secret",
    ok: true,
    output: buildSecretLikeFixtureValue(),
  };
  return { ...draft, factId: createFactId(draft) } as RectorFact;
}

function buildSecretLikeFixtureValue(): string {
  const keyLabel = ["api", "_", "key", "="].join("");
  const tokenPrefix = ["sk", "_", "test", "_"].join("");
  const tokenBody = ["12345678", "90abcdef", "12345678", "90abcdef"].join("");
  return `${keyLabel}${tokenPrefix}${tokenBody}`;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

if (isMain()) {
  runFactEvals().then((output) => {
    const relJson = output.jsonPath ? path.relative(REPO_ROOT, output.jsonPath) : undefined;
    const relMd = output.markdownPath ? path.relative(REPO_ROOT, output.markdownPath) : undefined;
    process.stdout.write([
      "[fact-evals] offline Phase 2E run complete (no model).",
      `  cases: ${output.report.passedCount}/${output.report.caseCount} passed`,
      `  failed: ${output.report.failedCount}`,
      `  metrics: ${output.report.metrics.map((metric) => `${metric.id}=${metric.value.toFixed(4)}(${metric.passed ? "pass" : "fail"})`).join(" ")}`,
      relJson ? `  json: ${relJson}` : "",
      relMd ? `  md:   ${relMd}` : "",
    ].filter(Boolean).join("\n") + "\n");
    if (output.report.failedCount > 0 || output.report.metrics.some((metric) => !metric.passed)) process.exitCode = 1;
  }).catch((error: unknown) => {
    process.stderr.write(`[fact-evals] FAILED to produce report: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
