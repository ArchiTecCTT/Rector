import { z } from "zod";
import type { ContextPack } from "./contextBuilder";
import type { TriageResult } from "./triage";
import {
  invokeWithBudget,
  LLMUsageSchema,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from "../providers/llm";
import { evaluateBudget, type BudgetUsage } from "../security/budget";
import { redactSecrets, redactString } from "../security/redaction";
import { DEFAULT_PREPROCESSOR_RULES } from "../symbolic/defaultRules";
import { getSymbolicEngine, type Rule } from "../symbolic/symbolicEngine";
import type { Run } from "../store";

/**
 * Structured output of the cheap SLM preprocessor.
 * Flagship models should primarily consume `distilledContext` + the validated
 * `proposedToolCalls`. The other fields provide lightweight structured signals
 * (entities, intent, constraints) that can be injected into prompts or used by
 * deterministic downstream stages (skeptic, crucible, symbolic checks).
 */
export const PreprocessorOutputSchema = z.object({
  distilledContext: z.string().min(1),
  proposedToolCalls: z.array(
    z.object({
      tool: z.string().min(1),
      args: z.record(z.unknown()),
    })
  ),
  entities: z.array(z.string().min(1)),
  intent: z.string().min(1),
  constraints: z.array(z.string().min(1)),
});
export type PreprocessorOutput = z.infer<typeof PreprocessorOutputSchema>;

/** Conservative allowlist of high-level tools the preprocessor is permitted to propose. */
/** These are *proposals only*. All execution is still mediated by WorkspaceSandboxAdapter, */
/** budget gates, redaction, skeptic review, crucible, and (where relevant) human approval. */
export const ALLOWED_PREPROCESSOR_TOOLS = [
  "read_file",
  "write_file",
  "run_command",
  "list_dir",
  "search_code",
  "search_memory",
  "propose_patch",
  "search",
] as const;

export type AllowedPreprocessorTool = (typeof ALLOWED_PREPROCESSOR_TOOLS)[number];

const PreprocessorToolCallSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()),
});

export const PreprocessorInputSchema = z.object({
  rawPrompt: z.string(),
  contextPack: z.any(), // validated upstream
  triage: z.any(),
});
export type PreprocessorInput = z.infer<typeof PreprocessorInputSchema>;

const ZERO_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

export interface SLMPreprocessorResult {
  output: PreprocessorOutput;
  usage: LLMUsage;
}

/**
 * Safe fallback when the SLM call is denied, fails, or returns unparseable / unsafe output.
 * Preserves the original user signal while ensuring zero unsafe tool proposals.
 */
export function createFallbackPreprocessorOutput(input: {
  rawPrompt: string;
  contextPack: ContextPack;
  triage: TriageResult;
}): PreprocessorOutput {
  const intent = (input.contextPack.userIntentSummary || input.rawPrompt || "user request").slice(0, 200);
  const constraints = [...(input.contextPack.constraints || [])];
  // Basic entity extraction: crude but deterministic and safe (no model).
  const entities = extractSimpleEntities(input.rawPrompt);

  return PreprocessorOutputSchema.parse({
    distilledContext: redactString(input.rawPrompt || intent),
    proposedToolCalls: [],
    entities,
    intent: redactString(intent),
    constraints: constraints.map((c) => redactString(c)),
  });
}

function extractSimpleEntities(text: string): string[] {
  if (!text) return [];
  // Very lightweight heuristic: capitalized words + obvious identifiers (safe, no secrets).
  const words = text.match(/\b([A-Z][a-zA-Z0-9_]{2,}|[a-z][a-z0-9_]{3,})\b/g) ?? [];
  const unique = [...new Set(words.map((w) => w.trim()))].slice(0, 12);
  return unique;
}

/** Build a compact, redacted prompt for the cheap SLM. */
function buildPreprocessorPrompt(input: {
  rawPrompt: string;
  contextPack: ContextPack;
  triage: TriageResult;
}): string {
  const prompt = redactString(input.rawPrompt ?? "");
  const intent = redactString(input.contextPack.userIntentSummary ?? "");
  const constraints = (input.contextPack.constraints ?? []).map((c: string) => redactString(c)).slice(0, 8);
  const riskFlags = (input.contextPack.riskFlags ?? []).map((r: string) => redactString(r)).slice(0, 6);
  const tools = (input.contextPack.availableTools?.names ?? []).map((t: string) => redactString(t)).slice(0, 12);
  const memoryContext = (input.contextPack.memoryContext ?? [])
    .slice(0, 8)
    .map((line: string) => redactString(line).slice(0, 200));

  // The instruction forces a strict JSON shape. The SLM must return *only* this object.
  const lines = [
    "You are a fast, cheap preprocessor for a symbolic AI orchestration system.",
    "Your job is to turn a potentially long/bloated user request and its context into a compact, structured summary.",
    "Respond with ONLY a single JSON object matching this exact shape (no markdown, no extra text):",
    JSON.stringify({
      distilledContext: "string (clean, concise restatement of the user's actual goal and key facts; redact any secrets)",
      proposedToolCalls: [
        { tool: "string (one of: read_file, write_file, run_command, list_dir, search_code, search_memory, propose_patch, search)", args: {} },
      ],
      entities: ["string[] (key files, components, concepts mentioned)"],
      intent: "string (one-sentence primary user intent)",
      constraints: ["string[] (hard constraints or requirements from the request or context)"],
    }),
    "",
    "User request (may be long):",
    prompt.slice(0, 4000),
    "",
    "Known high-level intent summary:",
    intent,
    "",
    "Known constraints:",
    constraints.join(" | ") || "(none)",
    "",
    ...(memoryContext.length > 0
      ? ["Time-aware memory context:", ...memoryContext, ""]
      : []),
    "Risk flags from triage:",
    riskFlags.join(", ") || "(none)",
    "",
    "Available high-level tools in this workspace (use only names from this list or omit):",
    tools.join(", ") || "(standard workspace tools)",
    "",
    "Rules:",
    "- Never include secrets, API keys, passwords, or PII in any field.",
    "- proposedToolCalls must only reference the allowed tool names listed above. Drop any others.",
    "- Keep distilledContext under ~1200 characters when possible.",
    "- If the request is ambiguous or unsafe, still produce the best possible distillation and leave proposedToolCalls empty.",
  ];
  return lines.join("\n");
}

/** Convert a provider usage estimate into the shape expected by evaluateBudget. */
function buildPreprocessorBudgetUsage(provider: LLMProvider, estimate: LLMUsage, run: Run): BudgetUsage {
  const committedUsd = (run.actualCost as any)?.usd ?? (run.costEstimate as any).usd ?? 0;
  const committedInput = (run.actualTokens as any)?.input ?? (run.tokenEstimate as any).input ?? 0;
  const committedOutput = (run.actualTokens as any)?.output ?? (run.tokenEstimate as any).output ?? 0;
  const committedCalls = (run.actualCost as any)?.modelCalls ?? (run.costEstimate as any).modelCalls ?? 0;

  return {
    provider: provider.metadata.id,
    estimatedUsd: committedUsd + estimate.estimatedUsd,
    inputTokens: committedInput + estimate.inputTokens,
    outputTokens: committedOutput + estimate.outputTokens,
    modelCalls: committedCalls + estimate.modelCalls,
    runtimeMs: run.budget?.maxRuntimeMs ?? 60_000,
    healingAttempts: run.healingAttempts ?? 0,
  };
}

/**
 * Run the cheap SLM preprocessor.
 *
 * Contract:
 * - Always returns a valid PreprocessorOutput (never throws to the caller).
 * - Budget preflight happens BEFORE any provider call.
 * - responseFormat is forced to json_object.
 * - Output is validated with Zod.
 * - proposedToolCalls are filtered against the documented allowlist.
 * - All material that could contain secrets is passed through redaction.
 * - On any denial/failure path a safe deterministic fallback is returned.
 */
export async function runSLMPreprocessor(
  input: { rawPrompt: string; contextPack: ContextPack; triage: TriageResult },
  deps: { slmProvider: LLMProvider; run: Run }
): Promise<SLMPreprocessorResult> {
  const { slmProvider, run } = deps;

  // Always produce a redacted view of the input for the prompt.
  const safeInput = {
    rawPrompt: redactString(input.rawPrompt ?? ""),
    contextPack: input.contextPack,
    triage: input.triage,
  };

  const request: LLMRequest = {
    messages: [
      {
        role: "user",
        content: buildPreprocessorPrompt(safeInput),
      },
    ],
    modelRoute: "cheap", // The caller (chatRunner) chooses the actual cheap/SLM provider via router.
    responseFormat: { type: "json_object" },
    task: "preprocessor",
  };

  // Budget preflight (identical discipline to planner / skeptic / repair).
  const estimate = slmProvider.estimateRequest(request);
  const decision = evaluateBudget(run, buildPreprocessorBudgetUsage(slmProvider, estimate, run));
  if (decision.status !== "allowed") {
    return { output: createFallbackPreprocessorOutput(input), usage: ZERO_USAGE };
  }

  let response: LLMResponse;
  try {
    response = await invokeWithBudget(slmProvider, request, run);
  } catch {
    return { output: createFallbackPreprocessorOutput(input), usage: ZERO_USAGE };
  }

  // Redact anything that came back from the provider before we trust it.
  const rawContent = redactSecrets(response.content ?? "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return { output: createFallbackPreprocessorOutput(input), usage: response.usage };
  }

  const validated = PreprocessorOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return { output: createFallbackPreprocessorOutput(input), usage: response.usage };
  }

  let output = validated.data;

  // Deterministic safety filter on tool proposals (allowlist).
  const allowlistedToolCalls = output.proposedToolCalls
    .filter((tc) => ALLOWED_PREPROCESSOR_TOOLS.includes(tc.tool as AllowedPreprocessorTool))
    .map((tc) => ({
      tool: tc.tool,
      // Redact any arg values that might be strings (defensive).
      args: Object.fromEntries(
        Object.entries(tc.args).map(([k, v]) => [
          k,
          typeof v === "string" ? redactString(v) : v,
        ])
      ),
    }));

  // Symbolic engine validation: block unsafe proposals and collect suggest:* hints.
  const symbolicValidation = validateToolCallsWithSymbolicEngine(allowlistedToolCalls);

  output = {
    ...output,
    distilledContext: redactString(output.distilledContext),
    intent: redactString(output.intent),
    entities: output.entities.map((e) => redactString(e)),
    constraints: [
      ...output.constraints.map((c) => redactString(c)),
      ...symbolicValidation.constraints.map((c) => redactString(c)),
    ],
    proposedToolCalls: symbolicValidation.allowed,
  };

  // Final schema enforcement after filtering.
  return {
    output: PreprocessorOutputSchema.parse(output),
    usage: response.usage,
  };
}

export interface SymbolicToolValidationResult {
  allowed: Array<{ tool: string; args: Record<string, unknown> }>;
  constraints: string[];
}

/**
 * Validates proposed tool calls against the symbolic rule engine.
 * Blocked tools are removed; `suggest:*` actions are collected as constraint hints.
 */
export function validateToolCallsWithSymbolicEngine(
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>,
  rules: Rule[] = DEFAULT_PREPROCESSOR_RULES
): SymbolicToolValidationResult {
  const engine = getSymbolicEngine();
  const allowed: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const constraintHints: string[] = [];

  for (const toolCall of toolCalls) {
    const evaluation = engine.evaluate(rules, { tool: toolCall.tool, args: toolCall.args });
    if (!evaluation.blocked) {
      allowed.push(toolCall);
    }
    for (const action of evaluation.actions) {
      if (action.startsWith("suggest:")) {
        constraintHints.push(action.slice("suggest:".length));
      }
    }
  }

  return { allowed, constraints: [...new Set(constraintHints)] };
}

/**
 * Pure deterministic preprocessor usable in local/fake paths or when no cheap provider
 * is configured. Produces a reasonable distillation without any model call.
 */
export function runDeterministicPreprocessor(input: {
  rawPrompt: string;
  contextPack: ContextPack;
  triage: TriageResult;
}): PreprocessorOutput {
  const base = createFallbackPreprocessorOutput(input);
  // Enhance the fallback slightly with a tiny deterministic "distillation" (still no secrets).
  const distilled = [
    base.intent,
    ...(input.contextPack.constraints ?? []).slice(0, 3),
  ]
    .filter(Boolean)
    .join(". ")
    .slice(0, 800);

  return PreprocessorOutputSchema.parse({
    ...base,
    distilledContext: distilled || base.distilledContext,
  });
}
