import type { LLMMessage } from "../providers/llm";
import { PlannerInputSchema, type PlannerInput } from "./planner";

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
