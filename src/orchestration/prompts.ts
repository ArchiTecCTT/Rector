import { z } from "zod";
import type { LLMMessage } from "../providers/llm";
import { PlannerInputSchema, PlannerOutputSchema, type PlannerInput, type PlannerOutput } from "./planner";
import { ContextPackSchema, type ContextPack } from "./contextBuilder";
import { TriageResultSchema, type TriageResult } from "./triage";
import type { BrainstemSynthesisInput } from "./synthesizer";
import { redactSecrets, redactString } from "../security/redaction";

const MEMORY_CONTEXT_MAX_ENTRIES = 8;
const MEMORY_CONTEXT_MAX_CHARS_PER_LINE = 200;

/** Caps and redacts time-aware memory lines before they reach any LLM prompt. */
export function sanitizeMemoryContextForPrompt(memoryContext: string[] | undefined): string[] | undefined {
  if (!memoryContext || memoryContext.length === 0) return undefined;
  const sanitized = memoryContext
    .slice(0, MEMORY_CONTEXT_MAX_ENTRIES)
    .map((line) => redactString(line).slice(0, MEMORY_CONTEXT_MAX_CHARS_PER_LINE));
  return sanitized.length > 0 ? sanitized : undefined;
}

function contextPackMemoryContext(contextPack: ContextPack): string[] | undefined {
  return sanitizeMemoryContextForPrompt(contextPack.memoryContext);
}

/**
 * System rules that anchor the live planner. The LLM only *proposes* a plan; the symbolic
 * control plane validates it against `PlannerOutputSchema` + `validatePlannerOutput`, budgets it,
 * and refuses unsafe/malformed output deterministically. These rules make the safety bar explicit
 * so the model's first attempt is as likely as possible to pass validation.
 */
export const PLANNER_SYSTEM_RULES = [
  "You are Rector's planning agent. You propose an execution plan for a single user request.",
  "You do NOT execute anything: a deterministic control plane validates, budgets, and runs the plan.",
  "Return ONLY a single JSON object that conforms exactly to the contract below.",
  "Do not wrap the JSON in markdown code fences, prose, comments, or trailing text.",
  "Never include secrets, API keys, credentials, or environment variable values in the plan.",
  "Prefer the smallest safe plan that satisfies the request; do not invent unrelated work.",
].join("\n");

/**
 * The JSON contract the planner must produce. Mirrors `PlannerOutputSchema` and the invariants
 * enforced by `validatePlannerOutput` so the model is held to the same safety bar as the fake plan.
 */
export const PLANNER_JSON_CONTRACT = `Output a JSON object with this exact shape:

{
  "goal": string,                       // non-empty; the concrete objective of the plan
  "assumptions": string[],              // each non-empty; explicit planning assumptions
  "tasks": [
    {
      "id": string,                     // non-empty; unique within the plan
      "title": string,                  // non-empty
      "description": string,            // non-empty
      "dependencies": string[],         // ids of other tasks in this plan that must run first
      "expectedArtifacts": string[],    // each non-empty; what the task produces
      "validation": string[],           // at least one non-empty check verifying the task
      "risk": "low" | "medium" | "high" | "destructive",
      "approvalRequired": boolean       // true if the task must not run without explicit approval
    }
  ],
  "dependencies": [
    { "from": string, "to": string, "reason"?: string }  // task id -> task id edges
  ],
  "validation": {
    "summary": string,                  // non-empty; how the plan as a whole is validated
    "checks": string[]                  // at least one non-empty plan-level check
  },
  "riskLevel": "low" | "medium" | "high" | "destructive",
  "approvalGates": [
    {
      "id": string,                     // non-empty
      "type": "approval" | "checkpoint" | "clarification",
      "reason": string,                 // non-empty
      "required": boolean,
      "taskIds": string[]               // task ids covered by this gate (empty = plan-level gate)
    }
  ]
}

Hard invariants (the control plane rejects any plan that violates these):
- Every task "id" must be unique and stable.
- Every "dependencies[].from" and "dependencies[].to" must reference an existing task "id".
- Every task's "dependencies" entry must reference an existing task "id".
- Every approval gate "taskIds" entry must reference an existing task "id".
- Every task must carry at least one concrete validation check.
- Every task with "risk" of "high"/"destructive" must set "approvalRequired": true.
- If ANY task has "approvalRequired": true or "risk" of "high"/"destructive", OR the top-level
  "riskLevel" is "high"/"destructive", then every such unsafe task must be covered by a required
  approval gate (a gate with "required": true whose "taskIds" include the task), or there must be a
  required plan-level gate (a gate with "required": true and an empty "taskIds" array).
- When the request lacks enough detail to plan safely, return zero tasks and a required gate of type
  "clarification" instead of guessing.`;

/**
 * Builds the initial planner prompt: system rules + JSON contract, then a user message carrying the
 * request intent and the deterministic context pack. Validates `input` against `PlannerInputSchema`
 * so callers cannot construct a prompt from malformed input.
 */
export function buildPlannerPrompt(input: PlannerInput): LLMMessage[] {
  const parsed = PlannerInputSchema.parse(input);
  return [
    { role: "system", content: `${PLANNER_SYSTEM_RULES}\n\n${PLANNER_JSON_CONTRACT}` },
    { role: "user", content: buildContextMessage(parsed) },
  ];
}

/**
 * Builds the single repair prompt. Replays the original system + user messages, shows the model its
 * previous (rejected) output, and appends a focused instruction containing the validation error
 * summary. The control plane allows exactly one repair attempt before emitting a structured blocker.
 */
export function buildPlannerRepairPrompt(
  input: PlannerInput,
  priorContent: string,
  errorSummary: string
): LLMMessage[] {
  const [systemMessage, userMessage] = buildPlannerPrompt(input);
  return [
    systemMessage,
    userMessage,
    { role: "assistant", content: priorContent },
    {
      role: "user",
      content: [
        "Your previous response was rejected by the validator.",
        `Validation error: ${errorSummary}`,
        "",
        "Fix every issue above and reply again with ONLY the corrected JSON object.",
        "Do not include markdown fences, explanations, or any text outside the JSON object.",
      ].join("\n"),
    },
  ];
}

function buildContextMessage(input: PlannerInput): string {
  const { triage, contextPack } = input;
  const requestText = (input.messageContent ?? input.intent ?? contextPack.userIntentSummary ?? "").trim();

  const memoryContext = contextPackMemoryContext(contextPack);
  const context = {
    request: requestText,
    triage: {
      route: triage.route,
      confidence: triage.confidence,
      complexity: triage.complexity,
      reasons: triage.reasons,
      riskFlags: triage.riskFlags,
    },
    context: {
      userIntentSummary: contextPack.userIntentSummary,
      constraints: contextPack.constraints,
      riskFlags: contextPack.riskFlags,
      relevantDocs: contextPack.relevantDocs.map((doc) => ({ kind: doc.kind, summary: doc.summary })),
      relevantMemory: contextPack.relevantMemory.map((item) => ({ kind: item.kind, summary: item.summary })),
      ...(memoryContext ? { memoryContext } : {}),
      artifactHandles: contextPack.artifactHandles.map((handle) => ({ kind: handle.kind, summary: handle.summary })),
      inlineContext: contextPack.inlineContext.map((entry) => ({ kind: entry.kind, summary: entry.summary })),
      availableProviders: contextPack.availableProviders,
      availableTools: contextPack.availableTools,
    },
  };

  return [
    "Plan the following request. Use the triage decision and context as the source of truth.",
    "",
    "CONTEXT (JSON):",
    JSON.stringify(context, null, 2),
    "",
    "Respond with ONLY the plan JSON object described in the system instructions.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Live skeptic prompts (ORN-35)
// ---------------------------------------------------------------------------

/**
 * System rules that anchor the live skeptic. The model only *proposes* a critique draft
 * (`verdict` + `findings`); the symbolic control plane stamps the deterministic fields
 * (`reviewedPlanId`/`planGoal` from the plan, `createdAt` from the clock), **recomputes** the
 * verdict from finding severities so a model can never claim `SOUND` while emitting a `BLOCKER`,
 * and validates the assembled review against `SkepticReviewSchema`. These rules make the safety bar
 * explicit so the model's first attempt is as likely as possible to pass validation.
 */
export const SKEPTIC_SYSTEM_RULES = [
  "You are Rector's skeptic agent. You critique a single proposed execution plan.",
  "Focus on safety, validation coverage, missing dependencies, under-estimated risk, missing approval gates, and likely failure modes.",
  "You do NOT execute, edit, or approve anything: a deterministic control plane consumes your critique.",
  "Return ONLY a single JSON object that conforms exactly to the contract below.",
  "Do not wrap the JSON in markdown code fences, prose, comments, or trailing text.",
  "Never include secrets, API keys, credentials, tokens, or environment variable values in any field.",
  "Ground every finding in concrete evidence drawn from the plan or context; do not invent issues.",
  "The control plane recomputes the final verdict from your finding severities, so report findings honestly.",
].join("\n");

/**
 * The JSON contract the skeptic must produce. Mirrors `SkepticReviewDraftSchema`
 * (`{ verdict, findings }`) and the `SkepticFindingSchema` shape so the model is held to the same
 * structural bar the control plane validates against.
 */
export const SKEPTIC_JSON_CONTRACT = `Output a JSON object with this exact shape:

{
  "verdict": "SOUND" | "NEEDS_REVISION" | "BLOCKED",  // advisory; the control plane recomputes this
  "findings": [
    {
      "id": string,                                    // non-empty; unique within this review
      "severity": "BLOCKER" | "MAJOR" | "MINOR" | "INFO",
      "taskId": string,                                // optional; the plan task this finding is about
      "category": string,                              // non-empty; e.g. "validation", "dependency", "risk", "approval", "context"
      "message": string,                               // non-empty; what is wrong
      "evidence": string,                              // non-empty; the concrete plan/context basis for the finding
      "recommendation": string                         // non-empty; the concrete corrective action
    }
  ]
}

Severity guidance (the control plane derives the final verdict from these):
- Use "BLOCKER" for issues that make the plan unsafe or impossible to execute (e.g. a dangling
  dependency, a high-risk/destructive task with no required approval gate, or no tasks and no
  clarification gate). Any BLOCKER forces an overall "BLOCKED" verdict.
- Use "MAJOR" for significant quality or safety gaps (e.g. missing validation criteria,
  under-estimated risk, reliance on a file/API absent from the context). Any non-BLOCKER finding
  forces at least a "NEEDS_REVISION" verdict.
- Use "MINOR"/"INFO" for low-impact observations.
- Return an empty "findings" array (and verdict "SOUND") only when the plan has no issues.`;

/**
 * Input accepted by {@link buildSkepticPrompt}. Mirrors the live skeptic's `LiveSkepticInput`
 * shape: the plan to critique, the deterministic context pack, and an optional triage decision
 * (the context pack already carries one; an explicit `triage` overrides it in the prompt).
 */
export const SkepticPromptInputSchema = z.object({
  // `plannerOutput` is referenced lazily: `prompts` sits inside the planner import
  // cycle, so when planner is the cycle entry `PlannerOutputSchema` is still
  // undefined while this module initializes. `z.lazy` resolves the binding at
  // parse time (after the cycle settles) instead of capturing it at construction,
  // which would otherwise make every `buildSkepticPrompt` call throw.
  plannerOutput: z.lazy(() => PlannerOutputSchema),
  contextPack: ContextPackSchema,
  triage: TriageResultSchema.optional(),
});
export type SkepticPromptInput = z.infer<typeof SkepticPromptInputSchema>;

/**
 * Builds the initial skeptic prompt: system rules + JSON contract, then a user message carrying the
 * redacted plan and context the model must critique. Validates `input` against
 * `SkepticPromptInputSchema` so callers cannot construct a prompt from malformed input, and runs
 * the assembled payload through `redactSecrets` so no configured secret reaches the provider.
 */
export function buildSkepticPrompt(input: SkepticPromptInput): LLMMessage[] {
  const parsed = SkepticPromptInputSchema.parse(input);
  return [
    { role: "system", content: `${SKEPTIC_SYSTEM_RULES}\n\n${SKEPTIC_JSON_CONTRACT}` },
    { role: "user", content: buildSkepticContextMessage(parsed) },
  ];
}

/**
 * Builds the single skeptic repair prompt. Replays the original system + user messages, shows the
 * model its previous (rejected) draft, and appends a focused instruction containing the validation
 * error summary. The control plane allows exactly one repair attempt before emitting a structured
 * `SKEPTIC_INVALID` blocker.
 */
export function buildSkepticRepairPrompt(
  input: SkepticPromptInput,
  priorContent: string,
  errorSummary: string
): LLMMessage[] {
  const [systemMessage, userMessage] = buildSkepticPrompt(input);
  return [
    systemMessage,
    userMessage,
    { role: "assistant", content: priorContent },
    {
      role: "user",
      content: [
        "Your previous response was rejected by the validator.",
        `Validation error: ${errorSummary}`,
        "",
        "Fix every issue above and reply again with ONLY the corrected JSON object.",
        "Do not include markdown fences, explanations, or any text outside the JSON object.",
      ].join("\n"),
    },
  ];
}

function buildSkepticContextMessage(input: SkepticPromptInput): string {
  const { plannerOutput, contextPack } = input;
  const triage = input.triage ?? contextPack.triage;

  // Redact the entire payload so no configured secret can reach the provider, even if a plan field
  // or context summary echoed one.
  const memoryContext = contextPackMemoryContext(contextPack);
  const payload = redactSecrets({
    plan: {
      goal: plannerOutput.goal,
      assumptions: plannerOutput.assumptions,
      riskLevel: plannerOutput.riskLevel,
      tasks: plannerOutput.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        dependencies: task.dependencies,
        expectedArtifacts: task.expectedArtifacts,
        validation: task.validation,
        risk: task.risk,
        approvalRequired: task.approvalRequired,
      })),
      dependencies: plannerOutput.dependencies,
      validation: plannerOutput.validation,
      approvalGates: plannerOutput.approvalGates,
    },
    triage: {
      route: triage.route,
      confidence: triage.confidence,
      complexity: triage.complexity,
      reasons: triage.reasons,
      riskFlags: triage.riskFlags,
    },
    context: {
      userIntentSummary: contextPack.userIntentSummary,
      constraints: contextPack.constraints,
      riskFlags: contextPack.riskFlags,
      relevantDocs: contextPack.relevantDocs.map((doc) => ({ kind: doc.kind, summary: doc.summary })),
      relevantMemory: contextPack.relevantMemory.map((item) => ({ kind: item.kind, summary: item.summary })),
      ...(memoryContext ? { memoryContext } : {}),
      artifactHandles: contextPack.artifactHandles.map((handle) => ({ kind: handle.kind, summary: handle.summary })),
      inlineContext: contextPack.inlineContext.map((entry) => ({ kind: entry.kind, summary: entry.summary })),
      availableProviders: contextPack.availableProviders,
      availableTools: contextPack.availableTools,
    },
  });

  return [
    "Critique the following plan. Use the plan, triage decision, and context as the source of truth.",
    "",
    "PLAN AND CONTEXT (JSON):",
    JSON.stringify(payload, null, 2),
    "",
    "Respond with ONLY the critique JSON object described in the system instructions.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Live synthesizer prompts (ORN-36)
// ---------------------------------------------------------------------------

/**
 * System rules that anchor the live synthesizer. The model only *proposes* a final answer draft
 * (`response` + `citations`); the symbolic control plane validates it against `SynthesisDraftSchema`,
 * requires non-empty citations whenever the run carried execution/validation evidence, re-redacts
 * the assembled answer, and falls back to the deterministic `synthesizeChatBrainstemResponse` on any
 * budget/provider/validation failure. These rules make the safety and grounding bar explicit so the
 * model's first attempt is as likely as possible to pass validation.
 */
export const SYNTHESIZER_SYSTEM_RULES = [
  "You are Rector's synthesis agent. You write the final answer to a single user request from the run state.",
  "You do NOT execute, edit, or approve anything: a deterministic control plane validates your answer and may fall back to a deterministic answer.",
  "Ground every claim in the run state below. Do not invent files, commands, tests, results, or risks that are not present in it.",
  "Cite your evidence: each citation must reference a concrete execution artifact or validation result from the run state (a file path, command, test/node id, failure, risk, or artifact id).",
  "When the run carried any execution or validation evidence, you MUST include at least one citation.",
  "Never hide or omit failed validation output; report failures honestly and surface unresolved risks.",
  "Use these section headings in the response text: Summary, Actions, Validation, Risks, Next steps.",
  "State what was attempted, what was fixed, which files changed, validation status, unresolved risks, and point the reader to the trace drawer for the raw run data.",
  "Keep the answer concise: at most 2000 characters.",
  "Return ONLY a single JSON object that conforms exactly to the contract below.",
  "Do not wrap the JSON in markdown code fences, prose, comments, or trailing text.",
  "Never include secrets, API keys, credentials, tokens, or environment variable values in any field.",
].join("\n");

/**
 * The JSON contract the synthesizer must produce. Mirrors `SynthesisDraftSchema`
 * (`{ response, citations }`) and the `SynthesisCitationSchema` shape so the model is held to the
 * same structural bar the control plane validates against.
 */
export const SYNTHESIZER_JSON_CONTRACT = `Output a JSON object with this exact shape:

{
  "response": string,                                  // non-empty; the final answer to the user request (<= 2000 characters); use Summary/Actions/Validation/Risks/Next steps sections and reference the trace drawer for raw run data
  "citations": [
    {
      "kind": "file" | "command" | "test" | "failure" | "risk" | "artifact",
      "ref": string,                                   // non-empty; a path, command name, node id, or artifact id present in the run state
      "detail": string                                 // non-empty; the concrete evidence drawn from the run state
    }
  ]
}

Citation rules (the control plane enforces these):
- Each "ref" MUST reference an execution artifact or validation result that appears in the run state
  below (e.g. an execution node id, a validation/healing failure, a planned file, or an artifact id).
- Provide at least one citation whenever the run state contains any execution or validation evidence;
  an empty "citations" array is only valid when no execution or validation was performed.
- Use "kind": "failure" to cite a failed command or validation result, and "kind": "risk" to cite an
  unresolved risk or a needed human decision. Do not omit failed validation output.`;

/**
 * Input accepted by {@link buildSynthesizerPrompt}. Reuses the existing `BrainstemSynthesisInput`
 * shape unchanged (the same input the deterministic `synthesizeChatBrainstemResponse` consumes).
 */
export type SynthesizerPromptInput = BrainstemSynthesisInput;

/**
 * Validation schema for the synthesizer prompt input. Reuses the planner/context/triage schemas
 * (as the skeptic prompt input does) and validates the run-state evidence the prompt consumes with
 * focused, permissive (`.passthrough()`) sub-schemas. Those sub-schemas are defined inline rather
 * than imported from the crucible/DAG/execution/healing/observability modules on purpose: `prompts`
 * sits inside the planner import cycle, so eagerly importing those planner-dependent schemas here
 * would read them before their modules finish initializing.
 */
export const SynthesizerPromptInputSchema = z.object({
  traceId: z.string().min(1),
  triage: TriageResultSchema,
  contextPack: ContextPackSchema,
  // Referenced lazily for the same reason as `SkepticPromptInputSchema`: `prompts`
  // is inside the planner import cycle, so capturing `PlannerOutputSchema` eagerly
  // here would store `undefined` when planner is the cycle entry.
  plannerOutput: z.lazy(() => PlannerOutputSchema),
  skepticReview: z
    .object({
      verdict: z.string().min(1),
      findings: z.array(z.unknown()),
    })
    .passthrough(),
  crucibleDecision: z
    .object({
      verdict: z.string().min(1),
      reason: z.string().min(1),
    })
    .passthrough(),
  compiledDag: z
    .object({ nodes: z.array(z.unknown()) })
    .passthrough()
    .optional(),
  executionResult: z
    .object({ status: z.string().min(1), nodeResults: z.array(z.unknown()) })
    .passthrough()
    .optional(),
  validationHealingResult: z
    .object({
      status: z.string().min(1),
      attempts: z.number(),
      failures: z.array(z.unknown()),
      actions: z.array(z.unknown()),
    })
    .passthrough()
    .optional(),
  observabilitySummary: z
    .object({
      spanCount: z.number(),
      durationMs: z.number(),
      modelCallCount: z.number(),
      estimatedCostUsd: z.number(),
    })
    .passthrough()
    .optional(),
  decomposedResults: z.string().optional(),
});

/**
 * Builds the initial synthesizer prompt: system rules + JSON contract, then a user message carrying
 * the redacted run state the model must answer from. Validates `input` against
 * `SynthesizerPromptInputSchema` so callers cannot construct a prompt from malformed input, and runs
 * the assembled payload through `redactSecrets` so no configured secret reaches the provider.
 */
export function buildSynthesizerPrompt(input: SynthesizerPromptInput): LLMMessage[] {
  SynthesizerPromptInputSchema.parse(input);
  return [
    { role: "system", content: `${SYNTHESIZER_SYSTEM_RULES}\n\n${SYNTHESIZER_JSON_CONTRACT}` },
    { role: "user", content: buildSynthesizerContextMessage(input) },
  ];
}

/**
 * Builds the single synthesizer repair prompt. Replays the original system + user messages, shows
 * the model its previous (rejected) draft, and appends a focused instruction containing the
 * validation error summary. The control plane allows exactly one repair attempt before falling back
 * to the deterministic synthesizer.
 */
export function buildSynthesizerRepairPrompt(
  input: SynthesizerPromptInput,
  priorContent: string,
  errorSummary: string
): LLMMessage[] {
  const [systemMessage, userMessage] = buildSynthesizerPrompt(input);
  return [
    systemMessage,
    userMessage,
    { role: "assistant", content: priorContent },
    {
      role: "user",
      content: [
        "Your previous response was rejected by the validator.",
        `Validation error: ${errorSummary}`,
        "",
        "Fix every issue above and reply again with ONLY the corrected JSON object.",
        "Use these response sections: Summary, Actions, Validation, Risks, Next steps.",
        "Cite only evidence that appears in the run state, and include at least one citation when execution or validation evidence exists.",
        "Do not include markdown fences, explanations, or any text outside the JSON object.",
      ].join("\n"),
    },
  ];
}

function buildSynthesizerContextMessage(input: SynthesizerPromptInput): string {
  const {
    triage,
    contextPack,
    plannerOutput,
    skepticReview,
    crucibleDecision,
    compiledDag,
    executionResult,
    validationHealingResult,
    observabilitySummary,
    decomposedResults,
  } = input;

  // Redact the entire payload so no configured secret can reach the provider, even if a plan field,
  // context summary, command output, or failure message echoed one.
  const memoryContext = contextPackMemoryContext(contextPack);
  const payload = redactSecrets({
    request: contextPack.userIntentSummary,
    triage: {
      route: triage.route,
      confidence: triage.confidence,
      complexity: triage.complexity,
      reasons: triage.reasons,
      riskFlags: triage.riskFlags,
    },
    context: {
      userIntentSummary: contextPack.userIntentSummary,
      constraints: contextPack.constraints,
      riskFlags: contextPack.riskFlags,
      relevantDocs: contextPack.relevantDocs.map((doc) => ({ kind: doc.kind, summary: doc.summary })),
      relevantMemory: contextPack.relevantMemory.map((item) => ({ kind: item.kind, summary: item.summary })),
      ...(memoryContext ? { memoryContext } : {}),
      artifactHandles: contextPack.artifactHandles.map((handle) => ({ kind: handle.kind, summary: handle.summary })),
      inlineContext: contextPack.inlineContext.map((entry) => ({ kind: entry.kind, summary: entry.summary })),
    },
    plan: {
      goal: plannerOutput.goal,
      riskLevel: plannerOutput.riskLevel,
      tasks: plannerOutput.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        expectedArtifacts: task.expectedArtifacts,
        validation: task.validation,
        risk: task.risk,
        approvalRequired: task.approvalRequired,
      })),
      validation: plannerOutput.validation,
    },
    skeptic: {
      verdict: skepticReview.verdict,
      findings: skepticReview.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        taskId: finding.taskId,
        category: finding.category,
        message: finding.message,
        recommendation: finding.recommendation,
      })),
    },
    crucible: {
      verdict: crucibleDecision.verdict,
      reason: crucibleDecision.reason,
    },
    dag: compiledDag
      ? {
          nodes: compiledDag.nodes.map((node) => ({ id: node.id, type: node.type, label: node.label })),
        }
      : undefined,
    execution: executionResult
      ? {
          status: executionResult.status,
          nodeResults: executionResult.nodeResults.map((result) => ({
            nodeId: result.nodeId,
            status: result.status,
            attempts: result.attempts,
            error: result.error ? { code: result.error.code, message: result.error.message } : undefined,
          })),
        }
      : undefined,
    validation: validationHealingResult
      ? {
          status: validationHealingResult.status,
          attempts: validationHealingResult.attempts,
          failures: validationHealingResult.failures.map((failure) => ({
            nodeId: failure.nodeId,
            classification: failure.classification,
            errorCode: failure.errorCode,
            message: failure.message,
          })),
          actions: validationHealingResult.actions.map((action) => ({
            type: action.type,
            nodeId: action.nodeId,
            reason: action.reason,
          })),
        }
      : undefined,
    observability: observabilitySummary
      ? {
          spanCount: observabilitySummary.spanCount,
          durationMs: observabilitySummary.durationMs,
          modelCallCount: observabilitySummary.modelCallCount,
          estimatedCostUsd: observabilitySummary.estimatedCostUsd,
        }
      : undefined,
    decomposedResults: decomposedResults || undefined,
  });

  return [
    "Write the final answer to the request below. Use the run state as the source of truth and cite your evidence.",
    "",
    "RUN STATE (JSON):",
    JSON.stringify(payload, null, 2),
    "",
    "Respond with ONLY the answer JSON object described in the system instructions.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Live repair-agent prompt (ORN-38)
// ---------------------------------------------------------------------------

/**
 * System rules that anchor the live repair agent. The model only *proposes* a single patch from the
 * already-redacted failed output; the symbolic control plane validates the proposal against
 * `RepairPatchProposalSchema`, applies it ONLY through the safe workspace executor (which re-enforces
 * workspace containment, the allowlist/denylist, and an explicit approval), re-runs validation, and
 * bounds the number of healing rounds. These rules make the safety bar explicit so the model's
 * proposal is as likely as possible to be applicable.
 */
export const REPAIR_SYSTEM_RULES = [
  "You are Rector's repair agent. You propose a single file patch that fixes one failed execution step.",
  "You do NOT execute, write, or approve anything: a deterministic control plane validates your proposal,",
  "applies it only through a contained safe executor, and re-runs validation.",
  "Propose the smallest safe patch that addresses the failure; do not invent unrelated changes.",
  "Target only a safe relative path inside the workspace (no absolute paths, no '..' segments, no leading slash).",
  "Return ONLY a single JSON object that conforms exactly to the contract below.",
  "Do not wrap the JSON in markdown code fences, prose, comments, or trailing text.",
  "Never include secrets, API keys, credentials, tokens, or environment variable values in any field.",
].join("\n");

/**
 * The JSON contract the repair agent must produce. Mirrors the live healing loop's
 * `RepairPatchProposal` shape (`{ path, operation, content, rationale }`).
 */
export const REPAIR_JSON_CONTRACT = `Output a JSON object with this exact shape:

{
  "path": string,                       // non-empty; a safe relative path inside the workspace
  "operation": "add" | "update" | "delete",
  "content": string,                    // the full proposed file content (may be empty for "delete")
  "rationale": string                   // non-empty; why this patch fixes the failure
}`;

/**
 * Input accepted by {@link buildRepairPrompt}. The `failedOutput` is the already-redacted stdout /
 * stderr / failure message of the failed step; `contextPack` provides the grounding context.
 */
export interface RepairPromptInput {
  classification: string;
  failedOutput: string;
  nodeId?: string;
  contextPack: ContextPack;
  symbolicHints?: string[];
}

/**
 * Builds the repair-agent prompt: system rules + JSON contract, then a user message carrying the
 * redacted failed output and context. The assembled payload runs through `redactSecrets` so no
 * configured secret reaches the provider even if the failed output or context echoed one.
 */
export function buildRepairPrompt(input: RepairPromptInput): LLMMessage[] {
  const memoryContext = contextPackMemoryContext(input.contextPack);
  const payload = redactSecrets({
    failure: {
      classification: input.classification,
      nodeId: input.nodeId,
      failedOutput: input.failedOutput,
    },
    context: {
      userIntentSummary: input.contextPack.userIntentSummary,
      constraints: input.contextPack.constraints,
      riskFlags: input.contextPack.riskFlags,
      ...(memoryContext ? { memoryContext } : {}),
    },
    symbolicHints: input.symbolicHints ?? [],
  });

  return [
    { role: "system", content: `${REPAIR_SYSTEM_RULES}\n\n${REPAIR_JSON_CONTRACT}` },
    {
      role: "user",
      content: [
        "Propose a single patch that fixes the failed execution step below.",
        "",
        "FAILURE AND CONTEXT (JSON):",
        JSON.stringify(payload, null, 2),
        "",
        "Respond with ONLY the patch JSON object described in the system instructions.",
      ].join("\n"),
    },
  ];
}
