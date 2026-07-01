/** Kinds accepted by the Phase 2F live fact-shadow strict JSON runner (not the full RectorFact union). */
export const LIVE_FACT_SHADOW_ALLOWED_KINDS = [
  "intent",
  "task_constraint",
  "unknown_or_ambiguity",
  "capability_evidence",
  "capability_warning",
  "capability_failure",
] as const;

export type LiveFactShadowAllowedKind = (typeof LIVE_FACT_SHADOW_ALLOWED_KINDS)[number];

export type LiveFactShadowPromptScenario = Readonly<{
  id: string;
  expectedKinds: readonly string[];
}>;

export function buildLiveFactShadowSystemContract(): string {
  const allowedKindsLine = `ONLY allowed values for facts[].kind: ${LIVE_FACT_SHADOW_ALLOWED_KINDS.join(", ")}.`;
  return [
    "Return only JSON. Do not use Markdown.",
    'Shape: {"facts":[...]}.',
    allowedKindsLine,
    "Allowed fact object shapes (kind must be one of the list above):",
    '{"kind":"intent","intent":string,"confidence":number?}',
    '{"kind":"task_constraint","constraint":string}',
    '{"kind":"unknown_or_ambiguity","question":string,"options":string[]?}',
    '{"kind":"capability_evidence","capabilityId":string,"summary":string,"evidence":[{"refType":"source_span","path":string,"startLine":number,"endLine":number}]}',
    '{"kind":"capability_warning","capabilityId":string,"warning":string,"severity":"low"|"medium"|"high"}',
    '{"kind":"capability_failure","capabilityId":string,"reason":string,"retryable":boolean,"evidence":[{"refType":"insufficient_evidence","reason":string,"missing":string[],"searched":string[]}]}',
    "For capability_evidence, every evidence entry must use refType source_span with path/startLine/endLine copied exactly from the committed artifact (no invented paths or lines).",
    "For capability_warning, describe grounded uncertainty or cascade/noise; do not claim a fix or code change.",
    "Never invent files, line numbers, tests, fixes, or root causes. Use insufficient_evidence when unsupported.",
    "Do not use kind values outside the allowed list (no diagnostic, root_cause, cascade, error, typescript_diagnostic, or similar invented labels).",
  ].join("\n");
}

export function buildLiveFactShadowScenarioGuidance(scenario: LiveFactShadowPromptScenario): string {
  const expected = scenario.expectedKinds.length > 0 ? scenario.expectedKinds.join(", ") : "any allowed kind";
  const lines = [
    `This case expects at least one schema-valid fact with kind: ${expected}.`,
  ];

  if (scenario.id === "tsc_diagnostic_grouping") {
    lines.push(
      "TypeScript compiler output: represent the root diagnostic (primary TS error) as capability_evidence with source_span evidence pointing at the exact file line in the artifact.",
      "Represent dependent/cascade diagnostics or uncertainty as capability_warning (not a separate kind).",
      "Never use kind diagnostic, root_cause, cascade, typescript_error, or similar — only capability_evidence and/or capability_warning.",
      "Do not claim a fix; cite only lines that appear in the committed tsc artifact.",
    );
  }

  if (scenario.expectedKinds.includes("capability_evidence")) {
    lines.push(
      "When emitting capability_evidence, include at least one source_span evidence ref grounded in the artifact text.",
    );
  }

  return lines.join("\n");
}