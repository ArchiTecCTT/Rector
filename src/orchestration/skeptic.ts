import { z } from "zod";
import type { ContextPack } from "./contextBuilder";
import type { PlannerOutput } from "./planner";
import type { TriageResult } from "./triage";
import { buildSkepticPrompt, buildSkepticRepairPrompt, type SkepticPromptInput } from "./prompts";
import {
  invokeWithBudget,
  LLMUsageSchema,
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../providers/llm";
import { enforceMaxPerRunBudget, evaluateBudget, type BudgetUsage } from "../security/budget";
import { redactSecrets, redactString } from "../security/redaction";
import type { Run } from "../store";

export const SkepticFindingSeveritySchema = z.enum(["BLOCKER", "MAJOR", "MINOR", "INFO"]);
export type SkepticFindingSeverity = z.infer<typeof SkepticFindingSeveritySchema>;

export const SkepticFindingSchema = z.object({
  id: z.string().min(1),
  severity: SkepticFindingSeveritySchema,
  taskId: z.string().min(1).optional(),
  category: z.string().min(1),
  message: z.string().min(1),
  evidence: z.string().min(1),
  recommendation: z.string().min(1),
});
export type SkepticFinding = z.infer<typeof SkepticFindingSchema>;

export const SkepticReviewVerdictSchema = z.enum(["SOUND", "NEEDS_REVISION", "BLOCKED"]);
export type SkepticReviewVerdict = z.infer<typeof SkepticReviewVerdictSchema>;

export const SkepticReviewSchema = z
  .object({
    verdict: SkepticReviewVerdictSchema,
    findings: z.array(SkepticFindingSchema),
    reviewedPlanId: z.string().min(1).optional(),
    planGoal: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .refine((review) => review.reviewedPlanId !== undefined || review.planGoal !== undefined, {
    message: "Skeptic review requires reviewedPlanId or planGoal",
  });
export type SkepticReview = z.infer<typeof SkepticReviewSchema>;

type RawTask = Record<string, unknown>;
type RawPlan = Record<string, unknown>;

const RISKY_LANGUAGE_PATTERN =
  /\b(modify|write|delete|remove|drop|wipe|destroy|overwrite|deploy|deployment|production|migrate|migration)\b/i;
const FILE_REFERENCE_PATTERN = /\b(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\b/g;
const API_REFERENCE_PATTERN = /\b(?:[A-Z][A-Za-z0-9]*API|[A-Z][A-Za-z0-9]*Api|[A-Za-z0-9_.-]+\s+API)\b/g;

export function reviewPlanWithSkeptic(plannerOutput: unknown, contextPack?: ContextPack): SkepticReview {
  const plan = asRecord(plannerOutput);
  const tasks = arrayOfRecords(plan.tasks);
  const findings: SkepticFinding[] = [];

  const addFinding = (input: Omit<SkepticFinding, "id">): void => {
    findings.push(
      SkepticFindingSchema.parse({
        id: `skeptic.${input.category}.${findings.length + 1}`,
        ...input,
      })
    );
  };

  if (!hasValidation(plan.validation)) {
    addFinding({
      severity: "MAJOR",
      category: "validation",
      message: "Plan is missing top-level validation criteria.",
      evidence: formatEvidence(plan.validation),
      recommendation: "Add a top-level validation summary and at least one concrete validation check.",
    });
  }

  for (const task of tasks) {
    if (!hasValidationArray(task.validation)) {
      addFinding({
        severity: "MAJOR",
        taskId: stringValue(task.id),
        category: "validation",
        message: "Task is missing validation criteria.",
        evidence: formatEvidence(task.validation),
        recommendation: "Add at least one concrete validation check for this task.",
      });
    }
  }

  const taskIds = new Set(tasks.map((task) => stringValue(task.id)).filter((id): id is string => Boolean(id)));
  for (const dependency of arrayOfRecords(plan.dependencies)) {
    const from = stringValue(dependency.from);
    const to = stringValue(dependency.to);
    if (from && !taskIds.has(from)) {
      addFinding({
        severity: "BLOCKER",
        category: "dependency",
        message: "Plan dependency references a missing source task.",
        evidence: from,
        recommendation: "Remove the dangling dependency or add the referenced source task.",
      });
    }
    if (to && !taskIds.has(to)) {
      addFinding({
        severity: "BLOCKER",
        category: "dependency",
        message: "Plan dependency references a missing target task.",
        evidence: to,
        recommendation: "Remove the dangling dependency or add the referenced target task.",
      });
    }
  }

  for (const task of tasks) {
    const taskId = stringValue(task.id);
    for (const dependencyId of stringArray(task.dependencies)) {
      if (!taskIds.has(dependencyId)) {
        addFinding({
          severity: "BLOCKER",
          taskId,
          category: "dependency",
          message: "Task dependency references a missing task.",
          evidence: dependencyId,
          recommendation: "Remove the dangling task dependency or add the referenced task.",
        });
      }
    }
  }

  if (tasks.length === 0 && !hasClarificationGate(plan, contextPack)) {
    addFinding({
      severity: "BLOCKER",
      category: "clarification",
      message: "Plan has no tasks but does not include a clarification gate.",
      evidence: "tasks=[]",
      recommendation: "Add executable tasks or include a required clarification gate before execution.",
    });
  }

  for (const task of tasks) {
    if (isUnsafeTask(task) && !hasRequiredGateForTask(plan, stringValue(task.id))) {
      addFinding({
        severity: "BLOCKER",
        taskId: stringValue(task.id),
        category: "approval",
        message: "High-risk or destructive task lacks a required approval gate.",
        evidence: `risk=${stringValue(task.risk) ?? "unknown"}; approvalRequired=${String(task.approvalRequired)}`,
        recommendation: "Add a required approval/checkpoint gate for this task before execution.",
      });
    }
  }

  if (stringValue(plan.riskLevel) === "low" && RISKY_LANGUAGE_PATTERN.test(planText(plan))) {
    addFinding({
      severity: "MAJOR",
      category: "risk",
      message: "Plan-level risk appears underestimated for implementation or destructive language.",
      evidence: `riskLevel=${stringValue(plan.riskLevel)}`,
      recommendation: "Raise the plan risk level or remove implementation/deployment/destructive actions from the plan.",
    });
  }

  for (const task of tasks) {
    if (stringValue(task.risk) === "low" && RISKY_LANGUAGE_PATTERN.test(taskText(task))) {
      addFinding({
        severity: "MAJOR",
        taskId: stringValue(task.id),
        category: "risk",
        message: "Task risk appears underestimated for implementation or destructive language.",
        evidence: `risk=${stringValue(task.risk)}`,
        recommendation: "Raise the task risk level or narrow the task to non-implementation work.",
      });
    }
  }

  for (const reference of unsupportedContextReferences(plan, tasks, contextPack)) {
    addFinding({
      severity: "MAJOR",
      category: "context",
      message: "Plan assumes a file or API that is absent from the context pack.",
      evidence: reference,
      recommendation: "Inspect or retrieve the referenced file/API before relying on it in the plan.",
    });
  }

  const dedupedFindings = deduplicateSkepticFindings(findings);
  const verdict = verdictForFindings(dedupedFindings);

  const reviewedPlanId = stringValue(plan.id);
  const planGoal = stringValue(plan.goal) ?? "unknown plan";

  return SkepticReviewSchema.parse({
    verdict,
    findings: dedupedFindings,
    reviewedPlanId,
    planGoal,
    createdAt: contextPack?.createdAt ?? "1970-01-01T00:00:00.000Z",
  });
}

export function deduplicateSkepticFindings(findings: SkepticFinding[]): SkepticFinding[] {
  const byKey = new Map<string, SkepticFinding>();
  for (const finding of findings) {
    const parsed = SkepticFindingSchema.parse(sanitizeFinding(finding));
    const key = [parsed.severity, parsed.taskId ?? "", parsed.category, parsed.message, parsed.evidence].join("\u0000");
    const existing = byKey.get(key);
    if (!existing || severityRank(parsed.severity) > severityRank(existing.severity)) {
      byKey.set(key, parsed);
    }
  }
  return [...byKey.values()].map((finding, index) =>
    SkepticFindingSchema.parse({ ...finding, id: finding.id.trim() || `skeptic.finding.${index + 1}` })
  );
}

export function verdictForFindings(findings: SkepticFinding[]): SkepticReviewVerdict {
  if (findings.some((finding) => finding.severity === "BLOCKER")) return "BLOCKED";
  return findings.some((finding) => finding.severity === "MAJOR" || finding.severity === "MINOR")
    ? "NEEDS_REVISION"
    : "SOUND";
}

function severityRank(severity: SkepticFindingSeverity): number {
  switch (severity) {
    case "BLOCKER":
      return 4;
    case "MAJOR":
      return 3;
    case "MINOR":
      return 2;
    case "INFO":
      return 1;
  }
}

function sanitizeFinding(finding: SkepticFinding): SkepticFinding {
  return SkepticFindingSchema.parse(redactSecrets(finding));
}

function asRecord(value: unknown): RawPlan {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RawPlan) : {};
}

function arrayOfRecords(value: unknown): RawTask[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function hasValidation(value: unknown): boolean {
  const validation = asRecord(value);
  return stringValue(validation.summary) !== undefined && hasValidationArray(validation.checks);
}

function hasValidationArray(value: unknown): boolean {
  return stringArray(value).length > 0;
}

function hasClarificationGate(plan: RawPlan, contextPack?: ContextPack): boolean {
  if (contextPack?.triage.route === "NEEDS_CLARIFICATION") return true;
  return arrayOfRecords(plan.approvalGates).some(
    (gate) => stringValue(gate.type) === "clarification" && gate.required === true
  );
}

function isUnsafeTask(task: RawTask): boolean {
  const risk = stringValue(task.risk);
  return risk === "high" || risk === "destructive" || task.approvalRequired === true;
}

function hasRequiredGateForTask(plan: RawPlan, taskId: string | undefined): boolean {
  return arrayOfRecords(plan.approvalGates).some((gate) => {
    if (gate.required !== true) return false;
    const taskIds = stringArray(gate.taskIds);
    return taskIds.length === 0 || (taskId !== undefined && taskIds.includes(taskId));
  });
}

function unsupportedContextReferences(plan: RawPlan, tasks: RawTask[], contextPack?: ContextPack): string[] {
  if (!contextPack) return [];

  const contextCorpus = contextPackText(contextPack).toLowerCase();
  const candidateText = [stringArray(plan.assumptions).join("\n"), ...tasks.map(taskText)].join("\n");
  const references = new Set([...matches(candidateText, FILE_REFERENCE_PATTERN), ...matches(candidateText, API_REFERENCE_PATTERN)]);

  return [...references].filter((reference) => !contextCorpus.includes(reference.toLowerCase()));
}

function contextPackText(contextPack: ContextPack): string {
  return [
    contextPack.id,
    contextPack.userIntentSummary,
    ...contextPack.constraints,
    ...contextPack.availableProviders.configured,
    ...contextPack.availableProviders.unavailable,
    ...contextPack.availableProviders.notes,
    ...contextPack.availableTools.names,
    ...contextPack.availableTools.notes,
    ...contextPack.artifactHandles.flatMap((artifact) => [artifact.artifactId, artifact.kind, artifact.uri, artifact.summary]),
    ...contextPack.relevantDocs.flatMap((artifact) => [artifact.artifactId, artifact.kind, artifact.uri, artifact.summary]),
    ...contextPack.relevantMemory.flatMap((artifact) => [artifact.artifactId, artifact.kind, artifact.uri, artifact.summary]),
    ...contextPack.inlineContext.flatMap((inline) => [inline.kind, inline.summary, inline.content]),
  ].join("\n");
}

function planText(plan: RawPlan): string {
  return [
    stringValue(plan.goal),
    stringArray(plan.assumptions).join("\n"),
    arrayOfRecords(plan.tasks).map(taskText).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function taskText(task: RawTask): string {
  return [
    stringValue(task.id),
    stringValue(task.title),
    stringValue(task.description),
    stringArray(task.expectedArtifacts).join("\n"),
    stringArray(task.validation).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

function formatEvidence(value: unknown): string {
  if (value === undefined) return "missing";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Live skeptic agent (ORN-35)
// ---------------------------------------------------------------------------

/** Result status of a live skeptic invocation. Mirrors {@link LivePlannerStatus}. */
export type LiveSkepticStatus = "ok" | "blocked";

/**
 * The draft the model is asked to return. The model proposes only a critique
 * (`verdict` + `findings`); the control plane supplies the deterministic fields
 * (`reviewedPlanId`/`planGoal` from the plan, `createdAt` from the clock) and
 * **recomputes** the verdict from finding severities, so a model can never claim
 * `SOUND` while emitting a `BLOCKER`.
 */
export const SkepticReviewDraftSchema = z.object({
  verdict: SkepticReviewVerdictSchema,
  findings: z.array(SkepticFindingSchema),
});
export type SkepticReviewDraft = z.infer<typeof SkepticReviewDraftSchema>;

/**
 * Structured, redacted blocker emitted when the live skeptic cannot return a
 * valid review. Never carries a provider secret, API key, or raw model output;
 * `details` for `SKEPTIC_INVALID` carries only Zod issue paths (schema field
 * identifiers).
 */
export const SkepticBlockerSchema = z.object({
  code: z.enum(["BUDGET_DENIED", "SKEPTIC_INVALID", "PROVIDER_ERROR"]),
  message: z.string().min(1),
  details: z.unknown().optional(),
});
export type SkepticBlocker = z.infer<typeof SkepticBlockerSchema>;

/**
 * Outcome of {@link runLiveSkeptic}. `status === "ok"` carries a schema-valid
 * `review` (consumed by `arbitratePlanWithCrucible` with no special-casing);
 * `status === "blocked"` carries a redacted `blocker`. `usage` is the accumulated
 * token/cost record across every provider call performed and `attempts` is the
 * number of provider calls initiated (0–2).
 */
export interface LiveSkepticResult {
  status: LiveSkepticStatus;
  review?: SkepticReview;
  blocker?: SkepticBlocker;
  usage: LLMUsage;
  provider: string;
  model: string;
  attempts: number;
  /** Traceable reason that explains why live semantic review fell back or blocked. */
  fallbackReason?: string;
}

/** Input for {@link runLiveSkeptic}. */
export interface LiveSkepticInput {
  plannerOutput: PlannerOutput;
  contextPack: ContextPack;
  triage?: TriageResult;
  now?: () => string;
}

/** Dependencies for {@link runLiveSkeptic}. The provider is mocked in tests. */
export interface LiveSkepticDeps {
  provider: LLMProvider;
  run: Run;
  /** Optional concrete model/deployment selected by the orchestration assignment router. */
  model?: string;
  buildPrompt?: typeof buildSkepticPrompt;
  buildRepairPrompt?: typeof buildSkepticRepairPrompt;
  /**
   * Per-invocation timeout in milliseconds. Defaults to 60_000 (Req 1.8). Exposed
   * so tests can exercise the timeout path without waiting a real minute; a
   * timed-out invocation counts as one attempt within the two-attempt maximum.
   */
  timeoutMs?: number;
}

/** Req 1.8: each single provider invocation is bounded to 60 seconds. */
const SKEPTIC_INVOCATION_TIMEOUT_MS = 60_000;

const ZERO_SKEPTIC_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

/**
 * Prompts a configured provider for a plan critique, assembles a review that
 * conforms to the **existing** `SkepticReviewSchema` (stamping the deterministic
 * fields and recomputing the verdict from finding severities), retries exactly
 * once with a repair prompt on malformed/invalid output, and otherwise resolves
 * with a structured, redacted `SkepticBlocker`. A budget preflight runs before
 * every provider call (including the repair call), so a denied budget yields a
 * `BUDGET_DENIED` blocker with zero provider invocations and 0 USD cost. Each
 * invocation is bounded to a 60-second timeout counted as one attempt. No
 * exception escapes for budget/provider/validation/timeout failures.
 */
export async function runLiveSkeptic(input: LiveSkepticInput, deps: LiveSkepticDeps): Promise<LiveSkepticResult> {
  const { plannerOutput, contextPack } = input;
  const triage = input.triage ?? contextPack.triage;
  const now = input.now ?? (() => new Date().toISOString());

  const { provider, run } = deps;
  const buildPrompt = deps.buildPrompt ?? buildSkepticPrompt;
  const buildRepairPrompt = deps.buildRepairPrompt ?? buildSkepticRepairPrompt;
  const timeoutMs = deps.timeoutMs ?? SKEPTIC_INVOCATION_TIMEOUT_MS;
  const model = deps.model ?? skepticModel(provider);

  const promptInput: SkepticPromptInput = { plannerOutput, contextPack, triage };
  const deterministicReview = reviewPlanWithSkeptic(plannerOutput, contextPack);

  if (deterministicReview.findings.some((finding) => finding.severity === "BLOCKER")) {
    return skepticOkResult(deterministicReview, ZERO_SKEPTIC_USAGE, provider, model, 0);
  }

  let totalUsage = ZERO_SKEPTIC_USAGE;
  let messages = buildPrompt(promptInput);
  let lastFailure: SkepticValidationFailure = {
    repairSummary: "Skeptic review was not produced",
    issuePaths: [],
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Req 1.5 (json_object) + Req 6.1/6.6 (budget preflight before EVERY call, incl. repair).
    const request: LLMRequest = {
      messages,
      modelRoute: "flagship",
      ...(deps.model ? { model: deps.model } : {}),
      responseFormat: { type: "json_object" },
      task: "skeptic",
    };

    const estimate = provider.estimateRequest(request);
    const decision = evaluateBudget(run, buildSkepticPreflightUsage(provider, estimate, run, totalUsage));
    // Req 3.4: layer the EXPLICIT per-run ceiling onto the existing preflight. `enforceMaxPerRunBudget`
    // projects the accumulated run cost so far (committed + usage already spent in this step) plus this
    // call's estimate and denies BEFORE any provider.invoke when the projection would breach the run's
    // per-run ceiling. Either gate denying blocks the call (no network I/O on denial).
    const ceiling = enforceMaxPerRunBudget(run, accumulatedSkepticRunUsage(run, totalUsage), estimate);
    if (decision.status !== "allowed" || ceiling.status !== "allowed") {
      // Req 6.3: zero provider calls, BUDGET_DENIED blocker, 0 USD cost for this step.
      const reason =
        [...decision.reasons, ...ceiling.reasons].join("; ") || "budget preflight denied the skeptic call";
      return skepticBlockedResult(
        makeSkepticBlocker("BUDGET_DENIED", `Skeptic call denied by budget preflight: ${reason}`),
        totalUsage,
        provider,
        model,
        attempt - 1,
        "budget preflight denied live skeptic; deterministic findings remain authoritative"
      );
    }

    // Req 1.8: bound the single invocation to a 60s timeout; a timeout counts as this attempt.
    const outcome = await invokeBounded(invokeWithBudget(provider, request, run), timeoutMs);

    if (outcome.kind === "timeout") {
      // Req 1.8/1.9: a timed-out invocation is a transport-level failure -> PROVIDER_ERROR, no
      // further call. The attempt is counted.
      return skepticBlockedResult(
        makeSkepticBlocker("PROVIDER_ERROR", `Provider call timed out after ${timeoutMs}ms`),
        totalUsage,
        provider,
        model,
        attempt,
        "provider timeout during live skeptic; deterministic findings remain authoritative"
      );
    }

    if (outcome.kind === "error") {
      // Req 1.9 / 6.5: map any provider error to a redacted PROVIDER_ERROR blocker; preserve usage;
      // exclude the raw provider response body.
      const error = outcome.error;
      const rawMessage = error instanceof ProviderError || error instanceof Error ? error.message : String(error);
      return skepticBlockedResult(
        makeSkepticBlocker("PROVIDER_ERROR", `Provider call failed: ${rawMessage}`),
        totalUsage,
        provider,
        model,
        attempt,
        "provider error during live skeptic; deterministic findings remain authoritative"
      );
    }

    const response = outcome.response;
    // Req 1.7: accumulate LLM usage across every provider call performed.
    totalUsage = addSkepticUsage(totalUsage, response.usage);

    const parsed = tryParseSkepticJson(response.content);
    if (parsed.ok) {
      const assembled = assembleSkepticReview(
        parsed.value,
        plannerOutput,
        now,
        deterministicReview.findings
      );
      if (assembled.ok) {
        // Req 1.1/1.2/1.3: schema-valid review with stamped deterministic fields + recomputed verdict.
        return skepticOkResult(assembled.review, totalUsage, provider, response.model, attempt);
      }
      lastFailure = assembled;
    } else {
      lastFailure = {
        repairSummary: `Response was not valid JSON: ${parsed.error}`,
        issuePaths: [],
      };
    }

    // Req 1.5: issue exactly one repair prompt on the first failure, then stop.
    if (attempt === 1) {
      messages = buildRepairPrompt(promptInput, response.content, lastFailure.repairSummary);
    }
  }

  // Req 1.6: still invalid after one repair -> SKEPTIC_INVALID blocker, attempts = 2, no third call.
  return skepticBlockedResult(
    makeSkepticBlocker("SKEPTIC_INVALID", skepticInvalidMessage(lastFailure.issuePaths), { issues: lastFailure.issuePaths }),
    totalUsage,
    provider,
    model,
    2,
    "live skeptic invalid after one repair; deterministic findings remain authoritative"
  );
}

interface SkepticValidationFailure {
  /** Rich, model-facing summary used only in the repair prompt (round-trips to the provider). */
  repairSummary: string;
  /** Safe schema-field identifiers (Zod issue paths) for the returned blocker details. */
  issuePaths: string[];
}

type SkepticAssembly =
  | { ok: true; review: SkepticReview }
  | ({ ok: false } & SkepticValidationFailure);

/**
 * Validates the model's draft against {@link SkepticReviewDraftSchema}, stamps the
 * deterministic fields (`reviewedPlanId`/`planGoal` from the plan, `createdAt` from
 * the clock), recomputes the verdict from finding severities (Req 1.3), and parses
 * the assembled object with {@link SkepticReviewSchema}. Never throws: returns the
 * schema-field identifiers on failure so the blocker can report them without
 * echoing raw model output.
 */
function assembleSkepticReview(
  value: unknown,
  plannerOutput: PlannerOutput,
  now: () => string,
  deterministicFindings: SkepticFinding[]
): SkepticAssembly {
  const draft = SkepticReviewDraftSchema.safeParse(value);
  if (!draft.success) {
    return {
      ok: false,
      repairSummary: draft.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
      issuePaths: uniqueSkepticIssuePaths(draft.error.issues),
    };
  }

  const mergedFindings = deduplicateSkepticFindings([...deterministicFindings, ...draft.data.findings]);
  const verdict = recomputeSkepticVerdict(mergedFindings);
  const reviewedPlanId = planIdOf(plannerOutput);
  const planGoal = typeof plannerOutput.goal === "string" && plannerOutput.goal.trim().length > 0 ? plannerOutput.goal : undefined;

  const candidate = {
    verdict,
    findings: mergedFindings,
    ...(reviewedPlanId !== undefined ? { reviewedPlanId } : {}),
    ...(planGoal !== undefined ? { planGoal } : {}),
    createdAt: now(),
  };

  const review = SkepticReviewSchema.safeParse(candidate);
  if (!review.success) {
    return {
      ok: false,
      repairSummary: review.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
      issuePaths: uniqueSkepticIssuePaths(review.error.issues),
    };
  }

  return { ok: true, review: review.data };
}

/**
 * Req 1.3: derive the verdict from finding severities. Any `BLOCKER` finding ->
 * `BLOCKED`; any other non-empty findings -> `NEEDS_REVISION`; no findings ->
 * `SOUND`. The model's advisory verdict is never trusted directly.
 */
function recomputeSkepticVerdict(findings: SkepticFinding[]): SkepticReviewVerdict {
  return verdictForFindings(findings);
}

/** Reads an optional plan id without assuming `PlannerOutput` carries one. */
function planIdOf(plannerOutput: PlannerOutput): string | undefined {
  const candidate = (plannerOutput as { id?: unknown }).id;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function skepticModel(provider: LLMProvider): string {
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

function buildSkepticPreflightUsage(
  provider: LLMProvider,
  estimate: LLMUsage,
  run: Run,
  totalUsage: LLMUsage
): BudgetUsage {
  return {
    provider: provider.metadata.id,
    estimatedUsd: committedSkepticNumber(run.actualCost?.usd, run.costEstimate.usd) + totalUsage.estimatedUsd + estimate.estimatedUsd,
    inputTokens: committedSkepticNumber(run.actualTokens?.input, run.tokenEstimate.input) + totalUsage.inputTokens + estimate.inputTokens,
    outputTokens: committedSkepticNumber(run.actualTokens?.output, run.tokenEstimate.output) + totalUsage.outputTokens + estimate.outputTokens,
    modelCalls: committedSkepticNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + totalUsage.modelCalls + estimate.modelCalls,
    runtimeMs: committedSkepticNumber(run.actualCost?.runtimeMs, run.costEstimate.runtimeMs),
    healingAttempts: run.healingAttempts,
  };
}

/**
 * Accumulated run cost so far (committed run cost + usage already spent in this step), shaped for the
 * explicit per-run ceiling gate (`enforceMaxPerRunBudget`). Mirrors the accumulation in
 * {@link buildSkepticPreflightUsage}; the next-call estimate is passed to the gate separately so it
 * projects `accumulated + next` against the run's per-run ceiling.
 */
function accumulatedSkepticRunUsage(run: Run, totalUsage: LLMUsage): { estimatedUsd: number; modelCalls: number } {
  return {
    estimatedUsd: committedSkepticNumber(run.actualCost?.usd, run.costEstimate.usd) + totalUsage.estimatedUsd,
    modelCalls: committedSkepticNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + totalUsage.modelCalls,
  };
}

function addSkepticUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  });
}

type BoundedInvocation =
  | { kind: "ok"; response: LLMResponse }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

/**
 * Races a provider invocation against a timeout. The invocation promise is wrapped
 * so it never rejects unhandled (even when the timeout wins), and the timer is
 * always cleared, so a fast response never leaves a 60s timer holding the event
 * loop open.
 */
async function invokeBounded(invocation: Promise<LLMResponse>, timeoutMs: number): Promise<BoundedInvocation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedInvocation>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const wrapped: Promise<BoundedInvocation> = invocation.then(
    (response) => ({ kind: "ok", response }),
    (error) => ({ kind: "error", error })
  );

  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function tryParseSkepticJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function uniqueSkepticIssuePaths(issues: z.ZodIssue[]): string[] {
  const paths = issues.map((issue) => issue.path.map((segment) => String(segment)).join(".") || "(root)");
  return Array.from(new Set(paths));
}

function skepticInvalidMessage(issuePaths: string[]): string {
  if (issuePaths.length === 0) {
    return "Skeptic review was invalid after one repair attempt";
  }
  return `Skeptic review failed validation after one repair attempt at fields: ${issuePaths.join(", ")}`;
}

/** Builds a redacted blocker. `message` runs through redactString; `details` through redactSecrets. */
function makeSkepticBlocker(code: SkepticBlocker["code"], message: string, details?: unknown): SkepticBlocker {
  const redactedMessage = redactString(message).trim();
  return SkepticBlockerSchema.parse({
    code,
    message: redactedMessage.length > 0 ? redactedMessage : code,
    ...(details !== undefined ? { details: redactSecrets(details) } : {}),
  });
}

function skepticBlockedResult(
  blocker: SkepticBlocker,
  usage: LLMUsage,
  provider: LLMProvider,
  model: string,
  attempts: number,
  fallbackReason?: string
): LiveSkepticResult {
  return {
    status: "blocked",
    blocker,
    usage,
    provider: provider.metadata.id,
    model,
    attempts,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function skepticOkResult(
  review: SkepticReview,
  usage: LLMUsage,
  provider: LLMProvider,
  model: string,
  attempts: number
): LiveSkepticResult {
  return {
    status: "ok",
    review,
    usage,
    provider: provider.metadata.id,
    model,
    attempts,
  };
}

function committedSkepticNumber(primary: unknown, fallback: unknown): number {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return 0;
}
