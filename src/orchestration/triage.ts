import { z } from "zod";

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

export const TriageResultSchema = z.object({
  route: TriageRouteSchema,
  confidence: z.number().min(0).max(1),
  complexity: ComplexitySchema,
  reasons: z.array(z.string().min(1)),
  riskFlags: z.array(z.string().min(1)),
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

const NO_EDIT_PATTERNS = [/\bdo not edit\b/i, /\bno edits?\b/i, /\bwithout editing\b/i, /\bplan only\b/i];
const AMBIGUOUS_PATTERNS = [/\bthe thing\b/i, /\bstuff\b/i, /\bit\b/i, /^\s*(help|hi|hello|hey)\s*[.!?]?\s*$/i];

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

export function triageUserMessage(content: string): TriageResult {
  const text = content.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  const riskFlags = new Set<string>();

  if (!text) {
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.95, "low", ["empty user message"], ["ambiguous_request"]);
  }

  if (isVagueGreeting(text)) {
    return result(
      TRIAGE_ROUTES.NEEDS_CLARIFICATION,
      0.85,
      "low",
      ["vague greeting detected"],
      ["ambiguous_request"]
    );
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasQuestionMark = text.includes("?");
  const longRunningScore = countMatches(text, LONG_RUNNING_PATTERNS);
  const codeScore = countMatches(text, CODE_EDIT_PATTERNS);
  const researchScore = countMatches(text, RESEARCH_PATTERNS);
  const planScore = countMatches(text, PLAN_ONLY_PATTERNS);
  const noEditScore = countMatches(text, NO_EDIT_PATTERNS);
  const directScore = countMatches(text, DIRECT_PATTERNS) + (hasQuestionMark ? 1 : 0);
  const ambiguousScore = countMatches(text, AMBIGUOUS_PATTERNS);

  if (ambiguousScore > 0 && wordCount <= 8) {
    reasons.push("ambiguous request detected");
    riskFlags.add("ambiguous_request");
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.82, "low", reasons, [...riskFlags]);
  }

  if (longRunningScore >= 2 || (longRunningScore >= 1 && (codeScore >= 2 || wordCount > 25))) {
    reasons.push("long-running orchestration indicators detected");
    riskFlags.add("long_running");
    if (codeScore > 0) riskFlags.add("code_change");
    if (lower.includes("deploy") || lower.includes("production")) riskFlags.add("deployment_risk");
    return result(TRIAGE_ROUTES.LONG_RUNNING, 0.78, "high", reasons, [...riskFlags]);
  }

  if (researchScore >= 1 && codeScore < 2) {
    reasons.push("research intent detected");
    riskFlags.add("external_research");
    return result(TRIAGE_ROUTES.RESEARCH, 0.76, researchScore >= 2 ? "medium" : "low", reasons, [...riskFlags]);
  }

  if (planScore >= 1 && (noEditScore >= 1 || codeScore < 2)) {
    reasons.push("planning intent detected");
    if (noEditScore >= 1) reasons.push("no-edit constraint detected");
    return result(TRIAGE_ROUTES.PLAN_ONLY, 0.8, planScore >= 2 ? "medium" : "low", reasons, [...riskFlags]);
  }

  if (codeScore >= 2) {
    reasons.push("code change intent detected");
    riskFlags.add("code_change");
    if (lower.includes("delete") || lower.includes("remove")) riskFlags.add("destructive_change");
    return result(TRIAGE_ROUTES.CODE_EDIT, 0.74, wordCount > 30 ? "high" : "medium", reasons, [...riskFlags]);
  }

  if (directScore >= 1) {
    reasons.push("direct answer intent detected");
    return result(TRIAGE_ROUTES.DIRECT_ANSWER, 0.72, "low", reasons, [...riskFlags]);
  }

  if (wordCount <= 4) {
    reasons.push("too little detail to route safely");
    riskFlags.add("ambiguous_request");
    return result(TRIAGE_ROUTES.NEEDS_CLARIFICATION, 0.7, "low", reasons, [...riskFlags]);
  }

  reasons.push("defaulting to direct answer baseline");
  return result(TRIAGE_ROUTES.DIRECT_ANSWER, 0.55, "low", reasons, [...riskFlags]);
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
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
  riskFlags: string[]
): TriageResult {
  return TriageResultSchema.parse({ route, confidence, complexity, reasons, riskFlags });
}
