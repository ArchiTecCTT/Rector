import { z } from "zod";
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

export const TRIAGE_ROUTES = {
  DIRECT_ANSWER: "DIRECT_ANSWER",
  PLAN_ONLY: "PLAN_ONLY",
  CODE_EDIT: "CODE_EDIT",
  RESEARCH: "RESEARCH",
  LONG_RUNNING: "LONG_RUNNING",
  NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
} as const;

export const TriageRouteSchema = z.enum([
  TRIAGE_ROUTES.DIRECT_ANSWER,
  TRIAGE_ROUTES.PLAN_ONLY,
  TRIAGE_ROUTES.CODE_EDIT,
  TRIAGE_ROUTES.RESEARCH,
  TRIAGE_ROUTES.LONG_RUNNING,
  TRIAGE_ROUTES.NEEDS_CLARIFICATION,
]);
export type TriageRoute = z.infer<typeof TriageRouteSchema>;

export const ComplexitySchema = z.enum(["low", "medium", "high"]);
export type Complexity = z.infer<typeof ComplexitySchema>;

export const TriageSignalsSchema = z.object({
  wordCount: z.number().int().nonnegative(),
  hasQuestionMark: z.boolean(),
  routeScores: z.object({
    DIRECT_ANSWER: z.number().nonnegative(),
    PLAN_ONLY: z.number().nonnegative(),
    CODE_EDIT: z.number().nonnegative(),
    RESEARCH: z.number().nonnegative(),
    LONG_RUNNING: z.number().nonnegative(),
    NEEDS_CLARIFICATION: z.number().nonnegative(),
  }),
  matchedSignals: z.object({
    longRunning: z.number().int().nonnegative(),
    codeEdit: z.number().int().nonnegative(),
    research: z.number().int().nonnegative(),
    planOnly: z.number().int().nonnegative(),
    noEdit: z.number().int().nonnegative(),
    directAnswer: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    explicitEdit: z.number().int().nonnegative(),
  }),
  destructiveTerms: z.array(z.string().min(1)),
  conflictingIntents: z.boolean(),
  highRiskAction: z.boolean(),
});
export type TriageSignals = z.infer<typeof TriageSignalsSchema>;

export const TriageResultSchema = z.object({
  route: TriageRouteSchema,
  confidence: z.number().min(0).max(1),
  complexity: ComplexitySchema,
  reasons: z.array(z.string().min(1)),
  riskFlags: z.array(z.string().min(1)),
  signals: TriageSignalsSchema.optional(),
  approvalRequired: z.boolean().optional(),
  source: z.enum(["deterministic", "live", "fallback"]).optional(),
  fallbackReason: z.string().min(1).optional(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

const LONG_RUNNING_PATTERNS = [
  /\bend[- ]to[- ]end\b/i,
  /\bbuild (the )?(entire|full|complete)\b/i,
  /\bdeploy\b/i,
  /\bbenchmark\b/i,
  /\biterate\b/i,
  /\ball tests\b/i,
  /\bmigrate\b/i,
  /\bproduction\b/i,
];

const CODE_EDIT_PATTERNS = [
  /\bfix\b/i,
  /\bimplement\b/i,
  /\badd\b/i,
  /\bupdate\b/i,
  /\brefactor\b/i,
  /\bedit\b/i,
  /\bchange\b/i,
  /\bsrc\//i,
  /\btest(s)?\b/i,
  /\.(ts|tsx|js|jsx|json|md|css|html)\b/i,
];

const EXPLICIT_EDIT_PATTERNS = [
  /\bapply\b/i,
  /\bfix\b/i,
  /\bedit\b/i,
  /\bmodify\b/i,
  /\bchange\b/i,
  /\bupdate\b/i,
  /\brefactor\b/i,
  /\bimplement\b/i,
  /\bwrite\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdrop\b/i,
  /\bwipe\b/i,
  /\bdestroy\b/i,
  /\boverwrite\b/i,
];

const RESEARCH_PATTERNS = [
  /\bresearch\b/i,
  /\bcompare\b/i,
  /\bcurrent\b/i,
  /\blatest\b/i,
  /\bsources?\b/i,
  /\bweb\b/i,
  /\binvestigate\b/i,
];

const PLAN_ONLY_PATTERNS = [
  /\bplan\b/i,
  /\bdesign\b/i,
  /\barchitecture\b/i,
  /\bproposal\b/i,
  /\boutline\b/i,
];

const NO_EDIT_PATTERNS = [
  /\bdo not edit\b/i,
  /\bno edits?\b/i,
  /\bwithout editing\b/i,
  /\bplan only\b/i,
  /\bdo not (change|modify|write|touch|apply)\b/i,
];
const AMBIGUOUS_PATTERNS = [
  /\bthe thing\b/i,
  /\bstuff\b/i,
  /\bit\b/i,
  /^\s*(help|hi|hello|hey)\s*[.!?]?\s*$/i,
];
const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdrop\b/i,
  /\bwipe\b/i,
  /\bdestroy\b/i,
  /\boverwrite\b/i,
  /\btruncate\b/i,
  /\bforce[- ]push\b/i,
  /\bdeploy\b/i,
  /\bproduction\b/i,
  /\bmigrate\b/i,
];

// Vague greetings carry no task detail and must route to NEEDS_CLARIFICATION (Req 3.1).
// Each pattern matches the whole message after trailing punctuation has been stripped.
const GREETING_PATTERNS = [
  /^(hi+|hey+|hello+|helo+|hiya|heya|yo|sup|howdy|greetings)$/i,
  /^(hi|hey|hello)\s+there$/i,
  /^(what'?s|whats|wat)\s+up$/i,
  /^wh?assup$/i,
  /^good\s+(morning|afternoon|evening|day)$/i,
  /^how\s+(are\s+you|'?s\s+it\s+going|are\s+things|'?s\s+things)$/i,
  /^how\s+do\s+you\s+do$/i,
];
const DIRECT_PATTERNS = [/\bwhat is\b/i, /\bexplain\b/i, /\bdefine\b/i, /\bsummarize\b/i, /\bhow does\b/i, /\bwhy\b/i];

export function scoreTriageSignals(content: string): TriageSignals {
  const text = content.trim();
  const wordCount = text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;
  const hasQuestionMark = text.includes("?");
  const longRunning = countMatches(text, LONG_RUNNING_PATTERNS);
  const codeEdit = countMatches(text, CODE_EDIT_PATTERNS);
  const research = countMatches(text, RESEARCH_PATTERNS);
  const planOnly = countMatches(text, PLAN_ONLY_PATTERNS);
  const noEdit = countMatches(text, NO_EDIT_PATTERNS);
  const directAnswer = countMatches(text, DIRECT_PATTERNS) + (hasQuestionMark ? 1 : 0);
  const ambiguous = countMatches(text, AMBIGUOUS_PATTERNS);
  const explicitEdit = countMatches(text, EXPLICIT_EDIT_PATTERNS);
  const explicitEditOutsideNoEdit = countMatches(stripNoEditPhrases(text), EXPLICIT_EDIT_PATTERNS);
  const destructiveTerms = matchedTerms(text, DESTRUCTIVE_PATTERNS);
  const conflictingIntents = noEdit > 0 && explicitEditOutsideNoEdit > 0;
  const highRiskAction = destructiveTerms.length > 0 || longRunning >= 2;

  return TriageSignalsSchema.parse({
    wordCount,
    hasQuestionMark,
    routeScores: {
      DIRECT_ANSWER: directAnswer,
      PLAN_ONLY: planOnly + noEdit,
      CODE_EDIT: codeEdit,
      RESEARCH: research,
      LONG_RUNNING: longRunning,
      NEEDS_CLARIFICATION: ambiguous + (conflictingIntents ? 3 : 0),
    },
    matchedSignals: {
      longRunning,
      codeEdit,
      research,
      planOnly,
      noEdit,
      directAnswer,
      ambiguous,
      explicitEdit,
    },
    destructiveTerms,
    conflictingIntents,
    highRiskAction,
  });
}

export function triageUserMessage(content: string): TriageResult {
  const text = content.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  const riskFlags = new Set<string>();
  const signals = scoreTriageSignals(text);

  for (const flag of riskFlagsForSignals(signals, lower)) {
    riskFlags.add(flag);
  }

  if (!text) {
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.95, "low", ["empty user message"], ["ambiguous_request"], signals);
  }

  if (isVagueGreeting(text)) {
    return result(
      TRIAGE_ROUTES.NEEDS_CLARIFICATION,
      0.85,
      "low",
      ["vague greeting detected"],
      ["ambiguous_request"],
      signals
    );
  }

  const { wordCount, hasQuestionMark } = signals;
  const longRunningScore = signals.matchedSignals.longRunning;
  const codeScore = signals.matchedSignals.codeEdit;
  const researchScore = signals.matchedSignals.research;
  const planScore = signals.matchedSignals.planOnly;
  const noEditScore = signals.matchedSignals.noEdit;
  const directScore = signals.matchedSignals.directAnswer;
  const ambiguousScore = signals.matchedSignals.ambiguous;

  if (signals.conflictingIntents) {
    reasons.push("conflicting plan-only and edit intents detected");
    riskFlags.add("conflicting_intent");
    riskFlags.add("approval_required");
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.9, "medium", reasons, [...riskFlags], signals);
  }

  if (ambiguousScore > 0 && wordCount <= 8) {
    reasons.push("ambiguous request detected");
    riskFlags.add("ambiguous_request");
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.82, "low", reasons, [...riskFlags], signals);
  }

  if (signals.highRiskAction && Math.max(...Object.values(signals.routeScores)) <= 1 && wordCount <= 12) {
    reasons.push("high-risk action lacks enough routing detail");
    riskFlags.add("ambiguous_request");
    riskFlags.add("approval_required");
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.68, "medium", reasons, [...riskFlags], signals);
  }

  if (longRunningScore >= 2 || (longRunningScore >= 1 && (codeScore >= 2 || wordCount > 25))) {
    reasons.push("long-running orchestration indicators detected");
    riskFlags.add("long_running");
    if (codeScore > 0) riskFlags.add("code_change");
    if (lower.includes("deploy") || lower.includes("production")) riskFlags.add("deployment_risk");
    return result(TRIAGE_ROUTES.LONG_RUNNING, 0.78, "high", reasons, [...riskFlags], signals);
  }

  if (researchScore >= 1 && codeScore < 2) {
    reasons.push("research intent detected");
    riskFlags.add("external_research");
    return result(TRIAGE_ROUTES.RESEARCH, 0.76, researchScore >= 2 ? "medium" : "low", reasons, [...riskFlags], signals);
  }

  if (planScore >= 1 && (noEditScore >= 1 || codeScore < 2)) {
    reasons.push("planning intent detected");
    if (noEditScore >= 1) reasons.push("no-edit constraint detected");
    return result(TRIAGE_ROUTES.PLAN_ONLY, 0.8, planScore >= 2 ? "medium" : "low", reasons, [...riskFlags], signals);
  }

  if (codeScore >= 2) {
    reasons.push("code change intent detected");
    riskFlags.add("code_change");
    if (signals.destructiveTerms.length > 0) {
      riskFlags.add("destructive_change");
      riskFlags.add("approval_required");
    }
    return result(TRIAGE_ROUTES.CODE_EDIT, 0.74, wordCount > 30 || signals.highRiskAction ? "high" : "medium", reasons, [...riskFlags], signals);
  }

  if (directScore >= 1) {
    reasons.push("direct answer intent detected");
    return result(TRIAGE_ROUTES.DIRECT_ANSWER, 0.72, signals.highRiskAction ? "medium" : "low", reasons, [...riskFlags], signals);
  }

  if (wordCount <= 4) {
    reasons.push("too little detail to route safely");
    riskFlags.add("ambiguous_request");
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.7, "low", reasons, [...riskFlags], signals);
  }

  reasons.push("defaulting to direct answer baseline");
  return result(TRIAGE_ROUTES.DIRECT_ANSWER, 0.55, signals.highRiskAction ? "medium" : "low", reasons, [...riskFlags], signals);
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function matchedTerms(text: string, patterns: RegExp[]): string[] {
  const terms = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      const match = text.match(pattern);
      if (match?.[0]) terms.add(match[0].toLowerCase());
    }
  }
  return [...terms].sort();
}

function stripNoEditPhrases(text: string): string {
  return NO_EDIT_PATTERNS.reduce((current, pattern) => current.replace(pattern, " "), text);
}

function riskFlagsForSignals(signals: TriageSignals, lower: string): string[] {
  const flags = new Set<string>();
  if (signals.destructiveTerms.length > 0) {
    flags.add("destructive_change");
    flags.add("approval_required");
  }
  if (lower.includes("deploy") || lower.includes("production")) flags.add("deployment_risk");
  if (signals.matchedSignals.codeEdit > 0 && signals.destructiveTerms.length > 0) flags.add("code_change");
  return [...flags];
}

// True when the whole message is a bare greeting with no task detail (Req 3.1).
// Trailing punctuation is stripped so "Hello!", "hi.", and "What's up?" all match.
function isVagueGreeting(text: string): boolean {
  const normalized = text.trim().replace(/[.!?]+$/u, "").trim();
  if (!normalized) {
    return false;
  }
  return GREETING_PATTERNS.some((pattern) => pattern.test(normalized));
}

function result(
  route: TriageRoute,
  confidence: number,
  complexity: Complexity,
  reasons: string[],
  riskFlags: string[],
  signals: TriageSignals,
  extras: Partial<Pick<TriageResult, "fallbackReason" | "source">> = {}
): TriageResult {
  const uniqueRiskFlags = [...new Set(riskFlags)].sort();
  return TriageResultSchema.parse({
    route,
    confidence,
    complexity,
    reasons: [...new Set(reasons)].filter(Boolean),
    riskFlags: uniqueRiskFlags,
    signals,
    approvalRequired: uniqueRiskFlags.includes("approval_required") || uniqueRiskFlags.includes("destructive_change"),
    source: extras.source ?? "deterministic",
    ...(extras.fallbackReason ? { fallbackReason: extras.fallbackReason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Optional live triage (Chunk 042a)
// ---------------------------------------------------------------------------

export const TriageBlockerSchema = z.object({
  code: z.enum(["BUDGET_DENIED", "TRIAGE_INVALID", "PROVIDER_ERROR"]),
  message: z.string().min(1),
  details: z.unknown().optional(),
});
export type TriageBlocker = z.infer<typeof TriageBlockerSchema>;

export const LiveTriageDraftSchema = z.object({
  route: TriageRouteSchema,
  confidence: z.number().min(0).max(1),
  complexity: ComplexitySchema,
  reasons: z.array(z.string().min(1)).min(1),
  riskFlags: z.array(z.string().min(1)).default([]),
});
export type LiveTriageDraft = z.infer<typeof LiveTriageDraftSchema>;

export interface LiveTriageResult {
  status: "ok" | "fallback";
  triage: TriageResult;
  blocker?: TriageBlocker;
  usage: LLMUsage;
  provider: string;
  model: string;
  attempts: number;
  fallbackReason?: string;
}

export interface LiveTriageDeps {
  provider: LLMProvider;
  run: Run;
  buildPrompt?: (content: string, baseline: TriageResult) => LLMRequest["messages"];
  buildRepairPrompt?: (content: string, baseline: TriageResult, priorContent: string, errorSummary: string) => LLMRequest["messages"];
}

const ZERO_TRIAGE_USAGE: LLMUsage = LLMUsageSchema.parse({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedUsd: 0,
  modelCalls: 0,
});

export async function runLiveTriage(content: string, deps: LiveTriageDeps): Promise<LiveTriageResult> {
  const baseline = triageUserMessage(content);
  const provider = deps.provider;
  const run = deps.run;
  const model = triageModel(provider);
  const buildPrompt = deps.buildPrompt ?? buildTriagePrompt;
  const buildRepairPrompt = deps.buildRepairPrompt ?? buildTriageRepairPrompt;

  let totalUsage = ZERO_TRIAGE_USAGE;
  let messages = buildPrompt(content, baseline);
  let lastFailure: { repairSummary: string; issuePaths: string[] } = {
    repairSummary: "Triage output was not produced",
    issuePaths: [],
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const request: LLMRequest = {
      messages,
      modelRoute: "fast",
      responseFormat: { type: "json_object" },
      task: "triage",
    };

    const estimate = provider.estimateRequest(request);
    const decision = evaluateBudget(run, buildTriagePreflightUsage(provider, estimate, run, totalUsage));
    const ceiling = enforceMaxPerRunBudget(run, accumulatedTriageRunUsage(run, totalUsage), estimate);
    if (decision.status !== "allowed" || ceiling.status !== "allowed") {
      const reason = [...decision.reasons, ...ceiling.reasons].join("; ") || "budget preflight denied the triage call";
      return fallbackResult(
        baseline,
        makeTriageBlocker("BUDGET_DENIED", `Triage call denied by budget preflight: ${reason}`),
        totalUsage,
        provider,
        model,
        attempt - 1,
        "budget preflight denied live triage"
      );
    }

    let response: LLMResponse;
    try {
      response = await invokeWithBudget(provider, request, run);
    } catch (error) {
      const rawMessage = error instanceof ProviderError || error instanceof Error ? error.message : String(error);
      return fallbackResult(
        baseline,
        makeTriageBlocker("PROVIDER_ERROR", `Provider call failed: ${rawMessage}`),
        totalUsage,
        provider,
        model,
        attempt,
        "provider error during live triage"
      );
    }

    totalUsage = addTriageUsage(totalUsage, response.usage);
    const parsed = tryParseTriageJson(response.content);
    if (parsed.ok) {
      const validation = safeValidateLiveTriage(parsed.value, baseline);
      if (validation.ok) {
        return {
          status: "ok",
          triage: validation.triage,
          usage: totalUsage,
          provider: provider.metadata.id,
          model: response.model,
          attempts: attempt,
        };
      }
      lastFailure = validation;
    } else {
      lastFailure = {
        repairSummary: `Response was not valid JSON: ${parsed.error}`,
        issuePaths: [],
      };
    }

    if (attempt === 1) {
      messages = buildRepairPrompt(content, baseline, response.content, lastFailure.repairSummary);
    }
  }

  return fallbackResult(
    baseline,
    makeTriageBlocker("TRIAGE_INVALID", triageInvalidMessage(lastFailure.issuePaths), { issues: lastFailure.issuePaths }),
    totalUsage,
    provider,
    model,
    2,
    "live triage invalid after one repair attempt"
  );
}

export function buildTriagePrompt(content: string, baseline: TriageResult): LLMRequest["messages"] {
  const payload = redactSecrets({
    request: content,
    baseline: {
      route: baseline.route,
      confidence: baseline.confidence,
      complexity: baseline.complexity,
      reasons: baseline.reasons,
      riskFlags: baseline.riskFlags,
      signals: baseline.signals,
    },
  });

  return [
    {
      role: "system",
      content: [
        "You are Rector's triage classifier for one user request.",
        "Return ONLY a JSON object with route, confidence, complexity, reasons, and riskFlags.",
        "Routes: DIRECT_ANSWER, PLAN_ONLY, CODE_EDIT, RESEARCH, LONG_RUNNING, NEEDS_CLARIFICATION.",
        "Do not include markdown, prose, comments, or secrets.",
        "If plan-only/no-edit conflicts with edit/implementation intent, choose NEEDS_CLARIFICATION.",
        "If destructive/deployment actions are present, include riskFlags destructive_change and approval_required.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Classify this request. Use the deterministic baseline and signals as evidence, but correct it if clearly wrong.",
        "JSON payload:",
        JSON.stringify(payload, null, 2),
      ].join("\n"),
    },
  ];
}

export function buildTriageRepairPrompt(
  content: string,
  baseline: TriageResult,
  priorContent: string,
  errorSummary: string
): LLMRequest["messages"] {
  const [systemMessage, userMessage] = buildTriagePrompt(content, baseline);
  return [
    systemMessage,
    userMessage,
    { role: "assistant", content: priorContent },
    {
      role: "user",
      content: [
        "Your previous response was rejected by the validator.",
        `Validation error: ${errorSummary}`,
        "Reply again with ONLY the corrected JSON object.",
      ].join("\n"),
    },
  ];
}

function safeValidateLiveTriage(
  value: unknown,
  baseline: TriageResult
): { ok: true; triage: TriageResult } | { ok: false; repairSummary: string; issuePaths: string[] } {
  const parsed = LiveTriageDraftSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      repairSummary: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
      issuePaths: uniqueTriageIssuePaths(parsed.error.issues),
    };
  }

  const candidate = calibrateLiveTriage(parsed.data, baseline);
  return { ok: true, triage: candidate };
}

function calibrateLiveTriage(candidate: LiveTriageDraft, baseline: TriageResult): TriageResult {
  const signals = baseline.signals ?? scoreTriageSignals("");
  const riskFlags = new Set([...baseline.riskFlags, ...candidate.riskFlags]);
  const reasons = [...candidate.reasons, "live triage schema validated"];

  if (signals.destructiveTerms.length > 0) {
    riskFlags.add("destructive_change");
    riskFlags.add("approval_required");
  }
  if (signals.conflictingIntents) {
    riskFlags.add("conflicting_intent");
    riskFlags.add("approval_required");
    return result(
      TRIAGE_ROUTES.NEEDS_CLARIFICATION,
      Math.max(candidate.confidence, 0.88),
      "medium",
      [...reasons, "conflicting plan-only and edit intents detected"],
      [...riskFlags],
      signals,
      { source: "live" }
    );
  }
  if (signals.highRiskAction && candidate.confidence < 0.65) {
    riskFlags.add("ambiguous_request");
    riskFlags.add("approval_required");
    return result(
      TRIAGE_ROUTES.NEEDS_CLARIFICATION,
      candidate.confidence,
      candidate.complexity === "high" ? "high" : "medium",
      [...reasons, "low-confidence live triage on high-risk action"],
      [...riskFlags],
      signals,
      { source: "live" }
    );
  }

  return result(candidate.route, candidate.confidence, candidate.complexity, reasons, [...riskFlags], signals, {
    source: "live",
  });
}

function fallbackResult(
  baseline: TriageResult,
  blocker: TriageBlocker,
  usage: LLMUsage,
  provider: LLMProvider,
  model: string,
  attempts: number,
  fallbackReason: string
): LiveTriageResult {
  const triage = TriageResultSchema.parse({
    ...baseline,
    source: "fallback",
    fallbackReason,
  });
  return {
    status: "fallback",
    triage,
    blocker,
    usage,
    provider: provider.metadata.id,
    model,
    attempts,
    fallbackReason,
  };
}

function triageModel(provider: LLMProvider): string {
  const models = provider.metadata.models;
  return models.fast ?? models.cheap ?? models.flagship ?? Object.values(models)[0] ?? provider.metadata.id;
}

function buildTriagePreflightUsage(
  provider: LLMProvider,
  estimate: LLMUsage,
  run: Run,
  totalUsage: LLMUsage
): BudgetUsage {
  return {
    provider: provider.metadata.id,
    estimatedUsd: committedNumber(run.actualCost?.usd, run.costEstimate.usd) + totalUsage.estimatedUsd + estimate.estimatedUsd,
    inputTokens: committedNumber(run.actualTokens?.input, run.tokenEstimate.input) + totalUsage.inputTokens + estimate.inputTokens,
    outputTokens: committedNumber(run.actualTokens?.output, run.tokenEstimate.output) + totalUsage.outputTokens + estimate.outputTokens,
    modelCalls: committedNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + totalUsage.modelCalls + estimate.modelCalls,
    runtimeMs: committedNumber(run.actualCost?.runtimeMs, run.costEstimate.runtimeMs),
    healingAttempts: run.healingAttempts,
  };
}

function accumulatedTriageRunUsage(run: Run, totalUsage: LLMUsage): { estimatedUsd: number; modelCalls: number } {
  return {
    estimatedUsd: committedNumber(run.actualCost?.usd, run.costEstimate.usd) + totalUsage.estimatedUsd,
    modelCalls: committedNumber(run.actualCost?.modelCalls, run.costEstimate.modelCalls) + totalUsage.modelCalls,
  };
}

function addTriageUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  return LLMUsageSchema.parse({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedUsd: left.estimatedUsd + right.estimatedUsd,
    modelCalls: left.modelCalls + right.modelCalls,
  });
}

function tryParseTriageJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function makeTriageBlocker(code: TriageBlocker["code"], message: string, details?: unknown): TriageBlocker {
  const redactedMessage = redactString(message).trim();
  return TriageBlockerSchema.parse({
    code,
    message: redactedMessage.length > 0 ? redactedMessage : code,
    ...(details !== undefined ? { details: redactSecrets(details) } : {}),
  });
}

function triageInvalidMessage(issuePaths: string[]): string {
  if (issuePaths.length === 0) return "Triage output was invalid after one repair attempt";
  return `Triage output failed validation after one repair attempt at fields: ${issuePaths.join(", ")}`;
}

function uniqueTriageIssuePaths(issues: z.ZodIssue[]): string[] {
  const paths = issues.map((issue) => issue.path.map((segment) => String(segment)).join(".") || "(root)");
  return Array.from(new Set(paths));
}

function committedNumber(primary: unknown, fallback: unknown): number {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return 0;
}
