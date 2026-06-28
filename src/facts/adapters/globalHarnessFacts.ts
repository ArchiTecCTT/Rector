import type { RunEvent } from "../../protocol/events";
import { redactSecrets, redactString } from "../../security/redaction";
import type { GlobalScenario, GlobalValidator } from "../../evals/globalScenarioSchema";
import type { Scorecard } from "../../evals/scorecards";
import { createFactId, createFactScope, createFactTrust } from "..";
import { FACT_SCHEMA_VERSION, RectorFactSchema } from "../schemas";
import type {
  CapabilityCallFact,
  CapabilityCoverageFact,
  CapabilityEvidenceFact,
  CapabilityFailureFact,
  CapabilityRequestFact,
  CapabilityWarningFact,
  EvidenceRef,
  FactGroundingValidationFact,
  FactProvenance,
  IntentFact,
  RectorFact,
  SuccessCriteriaFact,
  TaskConstraintFact,
  ValidationObligationFact,
} from "../types";
import { runEventToFacts } from "./runEventFacts";

export interface GlobalHarnessFactAdapterOptions {
  readonly runId: string;
  readonly taskId?: string;
  readonly createdAt?: string;
}

export interface GlobalHarnessResultInput {
  readonly scenario: GlobalScenario;
  readonly scorecard?: Scorecard;
  readonly actualStatus?: "passed" | "failed" | "skipped";
  readonly trace?: readonly RunEvent[];
  readonly regressionArtifactRefs?: readonly string[];
  readonly options: GlobalHarnessFactAdapterOptions;
}

function createdAt(options: GlobalHarnessFactAdapterOptions): string {
  return options.createdAt ?? new Date().toISOString();
}

function parseFact<T extends RectorFact>(draft: Record<string, unknown>): T {
  return RectorFactSchema.parse({ ...draft, factId: createFactId(draft) }) as T;
}

function provenance(scenarioId: string, scorecardId?: string): FactProvenance[] {
  return [{ sourceType: "global_harness", scenarioId, ...(scorecardId ? { scorecardId } : {}) }];
}

function envelope(options: GlobalHarnessFactAdapterOptions, scenario: GlobalScenario, scorecardId?: string) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    runId: options.runId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    createdAt: createdAt(options),
    producer: "global_harness" as const,
    provenance: provenance(scenario.id, scorecardId),
    scope: createFactScope({ scopeType: "workspace", workspacePaths: [scenario.workspace, ...scenario.expected.changedPaths, ...scenario.expected.unchangedPaths], taskIds: options.taskId ? [options.taskId] : [] }),
    redactionState: "redacted" as const,
  };
}

export function globalScenarioToFacts(scenarioInput: GlobalScenario, options: GlobalHarnessFactAdapterOptions): Array<IntentFact | TaskConstraintFact | SuccessCriteriaFact | CapabilityRequestFact | CapabilityCallFact | ValidationObligationFact> {
  const scenario = redactSecrets(scenarioInput) as GlobalScenario;
  const base = envelope(options, scenario);
  const facts: Array<IntentFact | TaskConstraintFact | SuccessCriteriaFact | CapabilityRequestFact | CapabilityCallFact | ValidationObligationFact> = [
    parseFact<IntentFact>({
      ...base,
      kind: "intent",
      trust: createFactTrust("provenance_attached", "Global scenario user goal is harness input, not proof of behavior"),
      intent: scenario.userGoal,
      confidence: 1,
    }),
    parseFact<CapabilityRequestFact>({
      ...base,
      kind: "capability_request",
      trust: createFactTrust("provenance_attached", "Global scenario request preserves scenario id"),
      requestId: scenario.id,
      capabilityId: `global_scenario:${scenario.type}`,
      intent: scenario.title,
    }),
    parseFact<CapabilityCallFact>({
      ...base,
      kind: "capability_call",
      trust: createFactTrust("provenance_attached", "Expected scenario status preserved from oracle"),
      callId: `${scenario.id}:expected:${scenario.expected.status}`,
      capabilityId: `global_scenario:${scenario.id}:expected`,
      status: mapScenarioStatus(scenario.expected.status),
    }),
  ];

  for (const criteria of scenario.successCriteria) {
    facts.push(parseFact<SuccessCriteriaFact>({
      ...base,
      kind: "success_criteria",
      trust: createFactTrust("provenance_attached", "Scenario success criteria preserved"),
      criteria,
    }));
  }

  facts.push(...scenarioConstraintFacts(scenario, options));
  for (const validator of scenario.validators) {
    facts.push(parseFact<ValidationObligationFact>({
      ...base,
      kind: "validation_obligation",
      trust: createFactTrust("provenance_attached", "Validator command id and allowlisted command preserved"),
      obligationId: validator.id,
      validator: validator.cmd,
      targetFactIds: [],
      requiredEvidence: validatorRequiredEvidence(validator),
    }));
  }

  return facts;
}

export function globalHarnessResultToFacts(input: GlobalHarnessResultInput): RectorFact[] {
  const scenario = redactSecrets(input.scenario) as GlobalScenario;
  const scorecard = input.scorecard ? redactSecrets(input.scorecard) as Scorecard : undefined;
  const facts: RectorFact[] = [...globalScenarioToFacts(scenario, input.options)];
  const scenarioFactId = facts[0]?.factId ?? createFactId({ scenarioId: scenario.id });
  const actualStatus = input.actualStatus ?? (scorecard ? (scorecard.passed ? "passed" : "failed") : scenario.expected.status);
  const scorecardId = scorecard ? `${scorecard.schemaVersion}:${scorecard.scenarioId}` : undefined;
  const base = envelope(input.options, scenario, scorecardId);

  facts.push(parseFact<CapabilityCallFact>({
    ...base,
    kind: "capability_call",
    trust: createFactTrust("provenance_attached", "Actual scenario status preserved from harness result"),
    callId: `${scenario.id}:actual:${actualStatus}`,
    capabilityId: `global_scenario:${scenario.id}:actual`,
    status: mapScenarioStatus(actualStatus),
  }));

  if (scorecard) {
    facts.push(parseFact<FactGroundingValidationFact>({
      ...base,
      kind: "fact_grounding_validation",
      trust: createFactTrust("provenance_attached", "Scorecard dimensions are harness measurements, not final truth"),
      targetFactId: scenarioFactId,
      status: scorecard.passed ? "passed" : "failed",
      evidence: [{ refType: "insufficient_evidence", reason: "scorecard dimensions are metric measurements without raw validator artifact refs", missing: ["validator artifacts"], searched: [scorecard.scenarioId] }],
    }));
    facts.push(parseFact<CapabilityCoverageFact>({
      ...base,
      kind: "capability_coverage",
      trust: createFactTrust("provenance_attached", "Global scorecard dimensions preserved as coverage measurements"),
      capabilityId: `global_scorecard:${scorecard.scenarioId}`,
      searchedScope: [scenario.workspace],
      rawCount: Object.keys(scorecard.dimensions).length,
      returnedCount: Object.values(scorecard.dimensions).filter((dimension) => dimension.score > 0).length,
      omittedScope: Object.entries(scorecard.dimensions).filter(([, dimension]) => dimension.score < 1).map(([dimension]) => dimension),
    }));
    if (!scorecard.passed) {
      facts.push(parseFact<CapabilityFailureFact>({
        ...base,
        kind: "capability_failure",
        trust: createFactTrust("rejected", "Global scorecard did not pass"),
        capabilityId: `global_scorecard:${scorecard.scenarioId}`,
        reason: `global scorecard failed for ${scorecard.scenarioId}`,
        retryable: false,
        evidence: scorecardFailureEvidence(input.regressionArtifactRefs, scorecard.scenarioId),
      }));
    }
  }

  if (actualStatus === "skipped") {
    facts.push(parseFact<CapabilityWarningFact>({
      ...base,
      kind: "capability_warning",
      trust: createFactTrust("provenance_attached", "Skipped global scenario preserved honestly"),
      capabilityId: `global_scenario:${scenario.id}`,
      warning: `scenario ${scenario.id} skipped`,
      severity: "medium",
    }));
  }

  for (const artifactUri of input.regressionArtifactRefs ?? []) {
    facts.push(parseFact<CapabilityEvidenceFact>({
      ...base,
      kind: "capability_evidence",
      trust: createFactTrust("provenance_attached", "Regression artifact reference preserved"),
      capabilityId: `global_scenario:${scenario.id}`,
      summary: `Regression artifact for ${scenario.id}`,
      evidence: [{ refType: "artifact", uri: artifactUri }],
    }));
  }

  for (const event of input.trace ?? []) facts.push(...runEventToFacts(event, input.options));
  return facts;
}

function scenarioConstraintFacts(scenario: GlobalScenario, options: GlobalHarnessFactAdapterOptions): TaskConstraintFact[] {
  const base = envelope(options, scenario);
  const constraints = [
    `workspace:${scenario.workspace}`,
    `allowedSystems:${scenario.allowedSystems.join(",")}`,
    `forbiddenSystems:${scenario.forbiddenSystems.join(",")}`,
    `expectedSpecialist:${scenario.expectedSpecialist}`,
    `operation:${scenario.operation.kind}`,
    `budget:maxToolCalls=${scenario.budgets.maxToolCalls}`,
    `budget:maxRuntimeMs=${scenario.budgets.maxRuntimeMs}`,
    `budget:maxMainModelRawToolTokens=${scenario.budgets.maxMainModelRawToolTokens}`,
    `expected.changedPaths:${scenario.expected.changedPaths.join(",")}`,
    `expected.unchangedPaths:${scenario.expected.unchangedPaths.join(",")}`,
  ];
  return constraints.map((constraint) => parseFact<TaskConstraintFact>({
    ...base,
    kind: "task_constraint",
    trust: createFactTrust("provenance_attached", "Global scenario constraint preserved"),
    constraint: redactString(constraint),
  }));
}

function mapScenarioStatus(status: "passed" | "failed" | "skipped"): CapabilityCallFact["status"] {
  if (status === "passed") return "completed";
  if (status === "failed") return "failed";
  return "skipped";
}

function validatorRequiredEvidence(validator: GlobalValidator): string[] {
  return [
    `cmd:${validator.cmd}`,
    ...validator.args.map((arg, index) => `arg${index}:${arg}`),
    `cwd:${validator.cwd}`,
    `timeoutMs:${validator.timeoutMs}`,
    `expectedExitCode:${validator.expectedExitCode}`,
  ];
}

function scorecardFailureEvidence(regressionArtifactRefs: readonly string[] | undefined, scenarioId: string): EvidenceRef[] {
  const refs = regressionArtifactRefs ?? [];
  if (refs.length > 0) {
    return refs.map((uri) => ({ refType: "artifact" as const, uri }));
  }
  return [{
    refType: "insufficient_evidence",
    reason: "scorecard failure has no regression artifact refs in adapter input",
    missing: ["regressionArtifactRefs"],
    searched: [scenarioId],
  }];
}
