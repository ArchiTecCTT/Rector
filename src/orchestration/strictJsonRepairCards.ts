import {
  type StrictOutputDiagnostic,
  type StrictOutputDiagnosticKind,
} from "./strictOutputDiagnostics";

const DEFAULT_MAX_CARDS = 24;
const DEFAULT_MAX_TOTAL_CHARS = 6_000;
const DEFAULT_MAX_PROBLEM_CHARS = 280;
const DEFAULT_MAX_REPAIR_CHARS = 240;

/** Output contract restated on every strict JSON repair attempt. */
export const STRICT_JSON_REPAIR_OUTPUT_RULES = [
  "Emit one complete JSON object only (full regeneration, not a patch or partial diff).",
  "Do not wrap the JSON in markdown code fences or add prose outside the object.",
  "Omit optional fields instead of null unless the contract explicitly allows null.",
  "Finish every array and string; do not truncate mid-object.",
].join("\n");

export function renderStrictJsonRepairCards(
  diagnostics: readonly StrictOutputDiagnostic[],
  options: Readonly<{ maxCards?: number; maxTotalChars?: number }> = {},
): string {
  const maxCards = Math.max(1, Math.trunc(options.maxCards ?? DEFAULT_MAX_CARDS));
  const maxTotalChars = Math.max(256, Math.trunc(options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS));

  const blocking = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const selected = (blocking.length > 0 ? blocking : diagnostics).slice(0, maxCards);

  if (selected.length === 0) {
    return boundRepairText("No strict JSON repair cards (no diagnostics).", maxTotalChars);
  }

  const header = "Strict JSON repair cards (compiler-style):";
  const cards = selected.map((diagnostic, index) => formatRepairCard(diagnostic, index + 1));
  let body = [header, ...cards].join("\n\n");
  if (body.length > maxTotalChars) {
    body = boundRepairText(body, maxTotalChars);
  }
  return body;
}

export function repairHintForDiagnostic(diagnostic: StrictOutputDiagnostic): string {
  const fromDetails = repairHintFromDetails(diagnostic.details, diagnostic.kind, diagnostic.code);
  if (fromDetails) return boundRepairText(fromDetails, DEFAULT_MAX_REPAIR_CHARS);
  const byCode = REPAIR_GUIDANCE_BY_CODE[diagnostic.code];
  if (byCode) return byCode;
  const byKind = REPAIR_GUIDANCE_BY_KIND[diagnostic.kind];
  if (byKind) return byKind;
  return "Correct the value at this path so it satisfies the role JSON contract and control-plane validators.";
}

function formatRepairCard(diagnostic: StrictOutputDiagnostic, index: number): string {
  const problem = boundRepairText(diagnostic.message, DEFAULT_MAX_PROBLEM_CHARS);
  const repair = repairHintForDiagnostic(diagnostic);
  return [
    `[${index}] path: ${diagnostic.path}`,
    `    kind/code: ${diagnostic.kind} / ${diagnostic.code}`,
    `    problem: ${problem}`,
    `    repair: ${repair}`,
  ].join("\n");
}

function repairHintFromDetails(
  details: unknown,
  kind: StrictOutputDiagnosticKind,
  code: string,
): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;

  if (typeof record.expected === "string" && record.expected.trim().length > 0) {
    return `Expected ${record.expected.trim()} at this path.`;
  }

  if (Array.isArray(record.expectedValues) && record.expectedValues.length > 0) {
    const values = record.expectedValues
      .map((value) => (typeof value === "string" ? value.trim() : String(value)))
      .filter((value) => value.length > 0)
      .slice(0, 12);
    if (values.length > 0) {
      return `Expected one of: ${values.join(", ")}.`;
    }
  }

  if (record.zodCode === "invalid_enum_value") {
    return "Use only enum literals allowed by the contract for this field.";
  }
  if (record.zodCode === "invalid_type") {
    return "Change the value type at this path to match the contract (string, number, boolean, array, or object).";
  }
  if (record.zodCode === "too_small") {
    return "Provide a non-empty value or satisfy the minimum length/count required by the contract.";
  }
  if (record.zodCode === "unrecognized_keys") {
    return "Remove unknown top-level or nested keys not defined in the contract.";
  }

  if (kind === "semantic_invariant" && code === "planner_invariant_failed") {
    return "Fix planner safety invariants: unique task ids, valid dependency references, and required approval gates for unsafe work.";
  }

  return undefined;
}

const REPAIR_GUIDANCE_BY_KIND: Readonly<Partial<Record<StrictOutputDiagnosticKind, string>>> = {
  json_syntax:
    "Return syntactically valid JSON: balanced braces/brackets, double-quoted keys/strings, no trailing commas.",
  schema: "Adjust the field at this path to match the role JSON contract (types, required keys, enums, min lengths).",
  semantic_invariant:
    "Satisfy control-plane semantic rules (references, gates, risk/approval coupling) without inventing ids.",
  provenance: "Cite or attach only sources present in the supplied context or run evidence.",
  grounding: "Ground every claim in run state or context evidence; do not invent execution results.",
  scope: "Keep the payload within the triage route and request scope; do not add unrelated work.",
  redaction: "Remove secret-like substrings; never echo API keys, tokens, or credentials in the JSON.",
  truncation:
    "Emit a smaller but complete JSON object: shorten strings/lists if needed, but include every required key.",
  provider_runtime:
    "Prior output may be incomplete; regenerate the full JSON object in one response within output limits.",
};

const REPAIR_GUIDANCE_BY_CODE: Readonly<Record<string, string>> = {
  json_syntax_error:
    "Start from `{` and end with `}`; ensure the payload is a single JSON object with no surrounding text.",
  provider_output_truncated:
    "Reduce verbosity and return a complete object before the output limit; required keys must still be present.",
  provider_timeout: "Return a valid complete JSON object promptly; avoid oversized nested structures.",
  provider_generation_error: "Regenerate the full contract object; do not return an error string or prose.",
  provider_attempt_failed: "Regenerate the full JSON object; the prior attempt did not complete successfully.",
  deterministic_fallback_not_live:
    "Live repair must come from the model: output a complete strict JSON object that passes validation.",
  grounding_check_failed: "Add or fix evidence references so findings align with the plan under review.",
  provenance_check_failed: "Reference only artifacts and context handles that appear in the prompt context.",
  scope_check_failed: "Remove out-of-scope tasks or fields that violate the active triage route.",
  redaction_check_failed: "Replace secret-like values with safe placeholders or remove them from the JSON.",
  planner_invariant_failed:
    "Fix dependency edges, gate taskIds, and approvalRequired flags so every reference resolves to tasks[].id.",
  dangling_dependency: "Point dependency ids at existing tasks[].id values only.",
};

function boundRepairText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 3)}...`;
}