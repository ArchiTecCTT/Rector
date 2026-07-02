import { z } from "zod";

import { redactSecrets, redactString } from "../security/redaction";

export type StrictOutputDiagnosticKind =
  | "json_syntax"
  | "schema"
  | "semantic_invariant"
  | "provenance"
  | "grounding"
  | "scope"
  | "redaction"
  | "truncation"
  | "provider_runtime";

export type StrictOutputDiagnosticSeverity = "error" | "warning" | "info";

export type StrictOutputPathSegment = string | number;
export type StrictOutputPathInput = string | readonly StrictOutputPathSegment[] | undefined;

export interface StrictOutputDiagnostic {
  readonly kind: StrictOutputDiagnosticKind;
  readonly code: string;
  readonly path: string;
  readonly pathSegments: readonly StrictOutputPathSegment[];
  readonly message: string;
  readonly severity: StrictOutputDiagnosticSeverity;
  readonly details?: unknown;
}

/** Bounded, persistence-safe view of diagnostics (no model-derived messages or details). */
export interface SafeStrictOutputDiagnostic {
  readonly kind: StrictOutputDiagnosticKind;
  readonly code: string;
  readonly path: string;
  readonly severity: StrictOutputDiagnosticSeverity;
}

export type StrictOutputDiagnosticInput = Readonly<{
  kind: StrictOutputDiagnosticKind;
  code: string;
  message: string;
  path?: StrictOutputPathInput;
  severity?: StrictOutputDiagnosticSeverity;
  details?: unknown;
}>;

export type StrictOutputValidationHookName = "provenance" | "grounding" | "scope" | "redaction";

export type StrictOutputValidationHookResult = Readonly<{
  hook: StrictOutputValidationHookName;
  ok?: boolean;
  diagnostics?: readonly Readonly<{
    code: string;
    message: string;
    path?: StrictOutputPathInput;
    severity?: StrictOutputDiagnosticSeverity;
    details?: unknown;
  }>[];
}>;

export type StrictOutputRuntimeMetadata = Readonly<{
  provider?: string;
  model?: string;
  finishReason?: string;
  truncated?: boolean;
  timedOut?: boolean;
  errorCode?: string;
  errorMessage?: string;
  maxOutputTokens?: number;
  outputChars?: number;
}>;

export type StrictJsonParseResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; diagnostics: readonly StrictOutputDiagnostic[] }>;

const MAX_DIAGNOSTIC_MESSAGE_CHARS = 500;
const DEFAULT_SUMMARY_CHARS = 1_200;
const DEFAULT_MAX_SAFE_DIAGNOSTIC_ITEMS = 32;
const DIAGNOSTIC_SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9][A-Za-z0-9_-]{8,})\b/g;

export function projectSafeStrictOutputDiagnostics(
  diagnostics: readonly StrictOutputDiagnostic[],
  options: Readonly<{ maxItems?: number }> = {},
): readonly SafeStrictOutputDiagnostic[] {
  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? DEFAULT_MAX_SAFE_DIAGNOSTIC_ITEMS));
  return diagnostics.slice(0, maxItems).map((diagnostic) => ({
    kind: diagnostic.kind,
    code: diagnostic.code,
    path: diagnostic.path,
    severity: diagnostic.severity,
  }));
}

export function parseStrictJsonObject(content: string): StrictJsonParseResult {
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        createStrictOutputDiagnostic({
          kind: "json_syntax",
          code: "json_syntax_error",
          path: [],
          message: `Response was not valid JSON. Parser error type: ${error instanceof Error ? error.name : "unknown"}`,
        }),
      ],
    };
  }
}

export function zodDiagnostics(error: z.ZodError): readonly StrictOutputDiagnostic[] {
  return error.issues.map((issue) =>
    createStrictOutputDiagnostic({
      kind: "schema",
      code: `zod_${issue.code}`,
      path: issue.path,
      message: issue.message,
      details: {
        zodCode: issue.code,
      },
    }),
  );
}

export function diagnosticFromSemanticInvariant(input: Readonly<{
  code: string;
  message: string;
  path?: StrictOutputPathInput;
  severity?: StrictOutputDiagnosticSeverity;
  details?: unknown;
}>): StrictOutputDiagnostic {
  return createStrictOutputDiagnostic({
    kind: "semantic_invariant",
    code: input.code,
    message: input.message,
    path: input.path,
    severity: input.severity,
    details: input.details,
  });
}

export function diagnosticsFromValidationHooks(
  results: readonly StrictOutputValidationHookResult[],
): readonly StrictOutputDiagnostic[] {
  const diagnostics: StrictOutputDiagnostic[] = [];
  for (const result of results) {
    if (result.diagnostics && result.diagnostics.length > 0) {
      diagnostics.push(
        ...result.diagnostics.map((diagnostic) =>
          createStrictOutputDiagnostic({
            kind: result.hook,
            code: diagnostic.code,
            message: diagnostic.message,
            path: diagnostic.path,
            severity: diagnostic.severity,
            details: diagnostic.details,
          }),
        ),
      );
      continue;
    }
    if (result.ok === false) {
      diagnostics.push(
        createStrictOutputDiagnostic({
          kind: result.hook,
          code: `${result.hook}_check_failed`,
          message: `${result.hook} diagnostic hook failed without detailed diagnostics`,
        }),
      );
    }
  }
  return diagnostics;
}

export function diagnosticsFromProviderRuntimeMetadata(
  metadata: StrictOutputRuntimeMetadata | undefined,
): readonly StrictOutputDiagnostic[] {
  if (!metadata) return [];

  const diagnostics: StrictOutputDiagnostic[] = [];
  if (metadata.finishReason === "length" || metadata.truncated === true) {
    diagnostics.push(
      createStrictOutputDiagnostic({
        kind: "truncation",
        code: "provider_output_truncated",
        message: runtimeMessage("Provider output was truncated before a complete strict JSON object could be trusted", metadata),
        details: metadata,
      }),
    );
  }

  const providerRuntimeCode = runtimeDiagnosticCode(metadata);
  if (providerRuntimeCode) {
    diagnostics.push(
      createStrictOutputDiagnostic({
        kind: "provider_runtime",
        code: providerRuntimeCode,
        message: runtimeMessage(metadata.errorMessage ?? "Provider runtime metadata reported a failed generation", metadata),
        details: metadata,
      }),
    );
  }

  return diagnostics;
}

export function createStrictOutputDiagnostic(input: StrictOutputDiagnosticInput): StrictOutputDiagnostic {
  const path = normalizeDiagnosticPath(input.path);
  return {
    kind: input.kind,
    code: sanitizeCode(input.code),
    path: path.path,
    pathSegments: path.segments,
    message: boundDiagnosticText(input.message, MAX_DIAGNOSTIC_MESSAGE_CHARS),
    severity: input.severity ?? "error",
    ...(input.details !== undefined ? { details: redactSecrets(input.details) } : {}),
  };
}

export function summarizeStrictOutputDiagnostics(
  diagnostics: readonly StrictOutputDiagnostic[],
  options: Readonly<{ maxChars?: number }> = {},
): string {
  const maxChars = Math.max(24, Math.trunc(options.maxChars ?? DEFAULT_SUMMARY_CHARS));
  if (diagnostics.length === 0) return "No strict output diagnostics.";
  const summary = diagnostics
    .map((diagnostic) => `${diagnostic.kind}/${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
    .join("; ");
  return boundDiagnosticText(summary, maxChars);
}

function runtimeDiagnosticCode(metadata: StrictOutputRuntimeMetadata): string | undefined {
  if (metadata.timedOut === true) return metadata.errorCode?.trim() || "provider_timeout";
  if (metadata.errorCode?.trim()) return metadata.errorCode.trim();
  if (metadata.finishReason === "error") return "provider_generation_error";
  return undefined;
}

function runtimeMessage(message: string, metadata: StrictOutputRuntimeMetadata): string {
  const provider = metadata.provider ? ` provider=${metadata.provider}` : "";
  const model = metadata.model ? ` model=${metadata.model}` : "";
  return `${message}.${provider}${model}`.trim();
}

function normalizeDiagnosticPath(input: StrictOutputPathInput): {
  readonly path: string;
  readonly segments: readonly StrictOutputPathSegment[];
} {
  if (Array.isArray(input)) {
    const segments = input.map((segment) => (typeof segment === "number" ? segment : String(segment)));
    return { path: segments.length > 0 ? segments.map(String).join(".") : "(root)", segments };
  }
  if (typeof input === "string" && input.trim().length > 0 && input.trim() !== "(root)") {
    const path = input.trim();
    return { path, segments: path.split(".").filter(Boolean) };
  }
  return { path: "(root)", segments: [] };
}

function sanitizeCode(code: string): string {
  const sanitized = code.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return sanitized.length > 0 ? sanitized.slice(0, 120) : "strict_output_diagnostic";
}

function boundDiagnosticText(value: string, maxChars: number): string {
  const redacted = redactDiagnosticString(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= maxChars) return redacted;
  if (maxChars <= 3) return redacted.slice(0, maxChars);
  const bounded = `${redacted.slice(0, maxChars - 3)}...`;
  return redacted.includes("[REDACTED]") && !bounded.includes("[REDACTED]")
    ? `[REDACTED] ${bounded}`.slice(0, maxChars)
    : bounded;
}

function redactDiagnosticString(value: string): string {
  return redactString(value).replace(DIAGNOSTIC_SECRET_VALUE_PATTERN, "[REDACTED]");
}
