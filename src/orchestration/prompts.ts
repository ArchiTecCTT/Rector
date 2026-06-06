import { z } from "zod";
import type { LLMMessage } from "../providers/llm";
import { PlannerInputSchema, PlannerOutputSchema, type PlannerInput, type PlannerOutput } from "./planner";
import { ContextPackSchema, type ContextPack } from "./contextBuilder";
import { TriageResultSchema, type TriageResult } from "./triage";
import { redactSecrets } from "../security/redaction";

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
- Every "dependencies[].from" and "dependencies[].to" must reference an existing task "id".
- Every task's "dependencies" entry must reference an existing task "id".
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
  plannerOutput: PlannerOutputSchema,
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
