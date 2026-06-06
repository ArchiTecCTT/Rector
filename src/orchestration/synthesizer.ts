import { z } from "zod";
import type { ContextPack } from "./contextBuilder";
import type { CrucibleDecision } from "./crucible";
import type { CompiledDag } from "./dagCompiler";
import type { DagExecutionResult } from "./executorSimulator";
import type { PlannerOutput } from "./planner";
import { buildSynthesizerPrompt, buildSynthesizerRepairPrompt } from "./prompts";
import type { SkepticReview } from "./skeptic";
import type { TriageResult } from "./triage";
import type { HealingLoopResult, HealingLoopStatus } from "./validationHealing";
import type { ObservabilitySummary } from "../observability";
import {
  invokeWithBudget,
  LLMUsageSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../providers/llm";
import { evaluateBudget, type BudgetUsage } from "../security/budget";
import { redactString } from "../security/redaction";
import type { Run } from "../store";

export type BrainstemSynthesisStatus = HealingLoopStatus | "SKIPPED" | "BLOCKED";

export interface BrainstemSynthesisInput {
  traceId: string;
  triage: TriageResult;
  contextPack: ContextPack;
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  crucibleDecision: CrucibleDecision;
  compiledDag?: CompiledDag;
  executionResult?: DagExecutionResult;
  validationHealingResult?: HealingLoopResult;
  observabilitySummary?: ObservabilitySummary;
}

export interface BrainstemSynthesis {
  status: BrainstemSynthesisStatus;
  route: string;
  traceId: string;
  evidence: string[];
  /**
   * Count of provider calls made while producing this synthesis. Relaxed from the literal `0`
   * (Phase 1) to a non-negative integer (additive, backward-compatible) so the live synthesizer
   * (ORN-36) can record real provider usage. Local/provider-free and deterministic-fallback paths
   * keep reporting `0`.
   */
  providerCalls: number;
  observability?: ObservabilitySummary;
  response: string;
}

export function synthesizeChatBrainstemResponse(input: BrainstemSynthesisInput): BrainstemSynthesis {
  const status = synthesisStatus(input);
  const evidence = synthesisEvidence(input);
  const observed = input.observabilitySummary
    ? `Observed: ${input.observabilitySummary.spanCount} spans, ${input.observabilitySummary.durationMs}ms, provider calls: ${input.observabilitySummary.modelCallCount}, provider cost: $${input.observabilitySummary.estimatedCostUsd}.`
    : "Observed: pending.";
  const response = [
    `Status: ${status}.`,
    `Route: ${input.triage.route}.`,
    `Trace: ${input.traceId}.`,
    `Evidence: ${evidence.join("; ")}.`,
    observed,
    "Local mode: provider calls: 0, API keys: not required.",
  ].join(" ");

  return {
    status,
    route: input.triage.route,
    traceId: input.traceId,
    evidence,
    providerCalls: 0,
    observability: input.observabilitySummary,
    response,
  };
}

function synthesisStatus(input: BrainstemSynthesisInput): BrainstemSynthesisStatus {
  if (input.validationHealingResult) return input.validationHealingResult.status;

  switch (input.crucibleDecision.verdict) {
    case "ACCEPTED":
      return input.executionResult?.status === "FAILED" ? "FAILED" : "SKIPPED";
    case "BLOCKED":
      return "BLOCKED";
    case "NEEDS_REVISION":
    case "ESCALATED":
      return "NEEDS_DECISION";
  }
}

function synthesisEvidence(input: BrainstemSynthesisInput): string[] {
  const execution = input.executionResult;
  const validation = input.validationHealingResult;
  const completedNodes = execution?.nodeResults.filter((result) => result.status === "SUCCESS" || result.status === "RETRIED").length ?? 0;
  const totalNodes = execution?.nodeResults.length ?? input.compiledDag?.nodes.length ?? 0;

  const evidence = [
    `triage ${input.triage.route}/${input.triage.complexity}`,
    `context ${input.contextPack.id}`,
    `plan ${input.plannerOutput.tasks.length} tasks`,
    `skeptic ${input.skepticReview.verdict} (${input.skepticReview.findings.length} findings)`,
    `crucible ${input.crucibleDecision.verdict}`,
    input.compiledDag ? `dag ${input.compiledDag.nodes.length} nodes` : "dag skipped",
    execution ? `execution ${execution.status} (${completedNodes}/${totalNodes} nodes)` : "execution skipped",
    validation ? `validation ${validation.status}` : "validation skipped",
  ];

  if (validation && validation.attempts > 0) {
    evidence.push(`healing ${validation.status} after ${validation.attempts} ${validation.attempts === 1 ? "attempt" : "attempts"}`);
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Live synthesizer agent (ORN-36)
// ---------------------------------------------------------------------------

/**
 * Result status of a live synthesizer invocation. `ok` means a schema-valid,
 * evidence-cited answer was produced by the provider; `fallback` means the
 * deterministic `synthesizeChatBrainstemResponse` was returned instead (after a
 * budget denial, provider error, validation failure, or post-repair
 * non-conformance), so the user always receives a grounded, never-crashing answer.
 */
export type LiveSynthesisStatus = "ok" | "fallback";

/**
 * Typed, schema-validated evidence citation. Each citation references a concrete
 * execution artifact or validation result from the run state (a file path, command
 * name, test/node id, failure, risk, or artifact id) so the answer is grounded, not
 * free prose. `ref`/`detail` are redacted before they leave the synthesizer.
 */
export const SynthesisCitationSchema = z.object({
  kind: z.enum(["file", "command", "test", "failure", "risk", "artifact"]),
  ref: z.string().min(1),
  detail: z.string().min(1),
});
export type SynthesisCitation = z.infer<typeof SynthesisCitationSchema>;

/**
 * The draft the model is asked to return. The model proposes only
 * `{ response, citations }`; the control plane validates it, requires non-empty
 * `citations` whenever the run carried execution/validation evidence, re-redacts
 * the assembled answer, and assembles the full {@link BrainstemSynthesis}.
 */
export const SynthesisDraftSchema = z.object({
  response: z.string().min(1),
  citations: z.array(SynthesisCitationSchema),
});
export type SynthesisDraft = z.infer<typeof SynthesisDraftSchema>;

/**
 * Outcome of {@link runLiveSynthesizer}. `synthesis` is always present and grounded
 * (the live answer on `ok`, the deterministic answer on `fallback`). `usage` is the
 * accumulated token/cost record across every provider call performed and `attempts`
 * is the number of provider calls initiated (0 when fallback precedes any call, up
 * to 2).
 */
export interface LiveSynthesisResult {
  status: LiveSynthesisStatus;
  synthesis: BrainstemSynthesis;
  citations: SynthesisCitation[];
  usage: LLMUsage;
  provider: string;
  model: string;
  attempts: number;
}

/** Dependencies for {@link runLiveSynthesizer}. The provider is mocked in tests. */
export interface LiveSynthesizerDeps {
  provider: LLMProvider;
  run: Run;
  buildPrompt?: typeof buildSynthesizerPrompt;
  buildRepairPrompt?: typeof buildSynthesizerRepairPrompt;
}

const ZERO_SYNTHESIS_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

/**
 * Prompts a configured provider for a final, evidence-cited answer from the run
 * state, validates it against {@link SynthesisDraftSchema}, requires non-empty
 * `citations` whenever the run carried execution/validation evidence, retries
 * exactly once with a repair prompt on malformed/invalid/citation-free output, and
 * on any budget/provider/validation/post-repair failure falls back to the
 * deterministic {@link synthesizeChatBrainstemResponse} so the user always receives
 * a grounded answer. A budget preflight runs before every provider call, so a denied
 * budget yields the deterministic answer with zero provider invocations and 0 USD
 * cost. Every `BrainstemSynthesisInput` field is redacted before prompt construction
 * (in the prompt builder), and the assembled `response`/`citations` are redacted
 * again before returning. Failed validation output is preserved in the answer rather
 * than omitted. No exception escapes for budget/provider/validation failures.
 */
export async function runLiveSynthesizer(
  input: BrainstemSynthesisInput,
  deps: LiveSynthesizerDeps
): Promise<LiveSynthesisResult> {
  const { provider, run } = deps;
  const buildPrompt = deps.buildPrompt ?? buildSynthesizerPrompt;
  const buildRepairPrompt = deps.buildRepairPrompt ?? buildSynthesizerRepairPrompt;
  const model = synthesisModel(provider);

  let totalUsage = ZERO_SYNTHESIS_USAGE;
  let attempts = 0;

  // Req 2.6: every BrainstemSynthesisInput field is redacted before prompt construction.
  // buildSynthesizerPrompt runs the assembled payload through redactSecrets; a malformed input
  // throws here, which routes to the deterministic fallback (never throws out of this function).
  let messages;
  try {
    messages = buildPrompt(input);
  } catch {
    return synthesisFallbackResult(input, totalUsage, provider, model, attempts);
  }

  const evidenceExists = hasExecutionOrValidationEvidence(input);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Req 2.1 (json_object) + Req 6.2 (budget preflight before EVERY call, incl. the repair call).
    const request: LLMRequest = {
      messages,
      modelRoute: "flagship",
      responseFormat: { type: "json_object" },
      task: "synthesizer",
    };

    const estimate = provider.estimateRequest(request);
    const decision = evaluateBudget(run, buildSynthesisPreflightUsage(provider, estimate, run, totalUsage));
    if (decision.status !== "allowed") {
      // Req 6.4: zero provider calls, fallback, 0 USD cost for this step.
      return synthesisFallbackResult(input, totalUsage, provider, model, attempts);
    }

    let response: LLMResponse;
    try {
      response = await invokeWithBudget(provider, request, run);
    } catch {
      // Req 2.5 / 6.4: any provider error -> deterministic fallback; the raw provider body never
      // reaches the result. Usage stays at whatever was accumulated before the failing call.
      return synthesisFallbackResult(input, totalUsage, provider, model, attempts);
    }

    attempts += 1;
    // Accumulate LLM usage across every provider call performed.
    totalUsage = addSynthesisUsage(totalUsage, response.usage);

    const validation = validateSynthesisDraft(response.content, evidenceExists);
    if (validation.ok) {
      // Req 2.1/2.2: schema-valid, evidence-cited answer assembled into a grounded BrainstemSynthesis.
      return synthesisOkResult(input, validation.draft, totalUsage, provider, response.model, attempts);
    }

    // Req 2.3/2.4: issue exactly one repair prompt on the first failure, then stop (<= 2 calls).
    if (attempt === 1) {
      messages = buildRepairPrompt(input, response.content, validation.errorSummary);
    }
  }

  // Req 2.4/2.5: still invalid after one repair -> deterministic fallback (at most two calls made).
  return synthesisFallbackResult(input, totalUsage, provider, model, attempts);
}

type SynthesisDraftValidation =
  | { ok: true; draft: SynthesisDraft }
  | { ok: false; errorSummary: string };

/**
 * Parses the model content as JSON and validates it against
 * {@link SynthesisDraftSchema}. When the run carried execution/validation evidence,
 * a citation-free answer is rejected (Req 2.2/2.3) so it routes to repair, then
 * fallback. Never throws: returns a model-facing summary used only in the repair
 * prompt.
 */
function validateSynthesisDraft(content: string, evidenceExists: boolean): SynthesisDraftValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return { ok: false, errorSummary: `Response was not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = SynthesisDraftSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errorSummary: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    };
  }

  if (evidenceExists && result.data.citations.length === 0) {
    return {
      ok: false,
      errorSummary:
        "citations: at least one citation is required because the run carried execution or validation evidence",
    };
  }

  return { ok: true, draft: result.data };
}

/**
 * Req 2.2/2.3: the run carried execution or validation evidence when at least one
 * DAG node executed or a validation/healing result exists. Used to decide whether a
 * citation-free answer is invalid.
 */
function hasExecutionOrValidationEvidence(input: BrainstemSynthesisInput): boolean {
  const executedNodes = input.executionResult?.nodeResults.length ?? 0;
  return executedNodes > 0 || input.validationHealingResult !== undefined;
}

/**
 * Assembles the grounded {@link BrainstemSynthesis} from the deterministic base
 * (status/route/trace/observability/evidence) and the redacted live answer. Req 2.7:
 * the `response` and every citation field are redacted before returning. Req 2.8:
 * failed validation output is appended to the evidence so it is never omitted.
 */
function synthesisOkResult(
  input: BrainstemSynthesisInput,
  draft: SynthesisDraft,
  usage: LLMUsage,
  provider: LLMProvider,
  model: string,
  attempts: number
): LiveSynthesisResult {
  const base = synthesizeChatBrainstemResponse(input);
  const citations = draft.citations.map(redactCitation);
  const redactedResponse = redactString(draft.response).trim();
  const evidence = [...base.evidence, ...failedValidationEvidence(input)];

  const synthesis: BrainstemSynthesis = {
    status: base.status,
    route: base.route,
    traceId: base.traceId,
    evidence,
    providerCalls: attempts,
    observability: base.observability,
    response: redactedResponse.length > 0 ? redactedResponse : base.response,
  };

  return {
    status: "ok",
    synthesis,
    citations,
    usage,
    provider: provider.metadata.id,
    model,
    attempts,
  };
}

/**
 * Returns the deterministic {@link synthesizeChatBrainstemResponse} answer (Req
 * 2.5). The deterministic synthesis never hides failed validation output and reports
 * `providerCalls: 0`; `attempts`/`usage` on the result still reflect any provider
 * calls performed before the fallback decision.
 */
function synthesisFallbackResult(
  input: BrainstemSynthesisInput,
  usage: LLMUsage,
  provider: LLMProvider,
  model: string,
  attempts: number
): LiveSynthesisResult {
  return {
    status: "fallback",
    synthesis: synthesizeChatBrainstemResponse(input),
    citations: [],
    usage,
    provider: provider.metadata.id,
    model,
    attempts,
  };
}

/** Req 2.7: redact every citation field. `redactString` never empties a non-empty string. */
function redactCitation(citation: SynthesisCitation): SynthesisCitation {
  return SynthesisCitationSchema.parse({
    kind: citation.kind,
    ref: redactString(citation.ref),
    detail: redactString(citation.detail),
  });
}

/**
 * Req 2.8: surface every failed validation output (redacted) so the assembled answer
 * never omits it.
 */
function failedValidationEvidence(input: BrainstemSynthesisInput): string[] {
  const failures = input.validationHealingResult?.failures ?? [];
  return failures.map((failure) => {
    const node = failure.nodeId ?? "unknown-node";
    const code = failure.errorCode ? ` ${failure.errorCode}` : "";
    return redactString(`validation failure ${node} [${failure.classification}]${code}: ${failure.message}`);
  });
}

function synthesisModel(provider: LLMProvider): string {
  const models = provider.metadata.models;
  return (
    models.flagship ??
    models.fast ??
    models.research ??
    models.cheap ??
    Object.values(models)[0] ??
    provider.metadata.id
  );
}

function buildSynthesisPreflightUsage(
  provider: LLMProvider,
  estimate: LLMUsage,
  run: Run,
  totalUsage: LLMUsage
): BudgetUsage {
  return {
    provider: provider.metadata.id,
    estimatedUsd: committedSynthesisNumber(run.actualCost?.usd, run.costEstimate.usd) + totalUsage.estimatedUsd + estimate.estimatedUsd,
    inputTokens: committedSynthesisNumber(run.actualTokens?.input, run.tokenEstimate.input) + totalUsage.inputTokens + estimate.inputTokens,
    outputTokens: committedSynthesisNumber(run.actualTokens?.output, run.tokenEstimate.output) + totalUsage.outputTokens + estimate.outputTokens,
    modelCalls: committedSynthesisNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + totalUsage.modelCalls + estimate.modelCalls,
    runtimeMs: committedSynthesisNumber(run.actualCost?.runtimeMs, run.costEstimate.runtimeMs),
    healingAttempts: run.healingAttempts,
  };
}

function addSynthesisUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  });
}

function committedSynthesisNumber(primary: unknown, fallback: unknown): number {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return 0;
}
