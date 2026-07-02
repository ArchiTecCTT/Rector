import {
  createStrictOutputDiagnostic,
  diagnosticFromSemanticInvariant,
  diagnosticsFromProviderRuntimeMetadata,
  parseStrictJsonObject,
  summarizeStrictOutputDiagnostics,
  type StrictOutputDiagnostic,
  type StrictOutputRuntimeMetadata,
} from "./strictOutputDiagnostics";

export type StrictJsonAttemptKind = "first" | "repair";
export type StrictJsonPassClassification = "first_pass" | "repair_pass" | "failed_after_repair";
export type StrictJsonEvidenceStatus = "live_provider" | "test_only_injected" | "deterministic_fallback" | "unknown";

export interface StrictJsonAttemptContext {
  readonly operation: string;
  readonly attemptNumber: number;
  readonly attemptKind: StrictJsonAttemptKind;
  readonly priorDiagnostics: readonly StrictOutputDiagnostic[];
}

export interface StrictJsonAttemptOutput {
  readonly content: string;
  readonly metadata?: StrictOutputRuntimeMetadata;
  readonly evidenceStatus?: StrictJsonEvidenceStatus;
}

export type StrictJsonValidationResult<T> =
  | Readonly<{ ok: true; value: T; diagnostics?: readonly StrictOutputDiagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly StrictOutputDiagnostic[] }>;

export interface StrictJsonAttemptReport {
  readonly attemptNumber: number;
  readonly attemptKind: StrictJsonAttemptKind;
  readonly evidenceStatus: StrictJsonEvidenceStatus;
  readonly jsonParsed: boolean;
  readonly diagnostics: readonly StrictOutputDiagnostic[];
  readonly diagnosticSummary: string;
  readonly metadata?: StrictOutputRuntimeMetadata;
}

export type BoundedStrictJsonRepairLoopResult<T> =
  | Readonly<{
      status: "passed";
      classification: "first_pass" | "repair_pass";
      value: T;
      attempts: readonly StrictJsonAttemptReport[];
      diagnostics: readonly StrictOutputDiagnostic[];
    }>
  | Readonly<{
      status: "failed";
      classification: "failed_after_repair";
      attempts: readonly StrictJsonAttemptReport[];
      diagnostics: readonly StrictOutputDiagnostic[];
    }>;

export interface BoundedStrictJsonRepairLoopOptions<T> {
  readonly operation: string;
  readonly maxAttempts?: 1 | 2;
  readonly catchAttemptErrors?: boolean;
  readonly call: (context: StrictJsonAttemptContext) => Promise<StrictJsonAttemptOutput> | StrictJsonAttemptOutput;
  readonly validate: (value: unknown, context: StrictJsonAttemptContext) => StrictJsonValidationResult<T>;
}

export async function runBoundedStrictJsonRepairLoop<T>(
  options: BoundedStrictJsonRepairLoopOptions<T>,
): Promise<BoundedStrictJsonRepairLoopResult<T>> {
  const maxAttempts = options.maxAttempts ?? 2;
  const attempts: StrictJsonAttemptReport[] = [];
  const allDiagnostics: StrictOutputDiagnostic[] = [];

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const context: StrictJsonAttemptContext = {
      operation: options.operation,
      attemptNumber,
      attemptKind: attemptNumber === 1 ? "first" : "repair",
      priorDiagnostics: [...allDiagnostics],
    };

    let output: StrictJsonAttemptOutput;
    try {
      output = await options.call(context);
    } catch (error) {
      if (options.catchAttemptErrors === false) throw error;
      const diagnostics = [
        createStrictOutputDiagnostic({
          kind: "provider_runtime",
          code: "provider_attempt_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      ];
      allDiagnostics.push(...diagnostics);
      attempts.push(attemptReport(context, "unknown", false, diagnostics));
      continue;
    }

    const evidenceStatus = output.evidenceStatus ?? "unknown";
    const diagnostics: StrictOutputDiagnostic[] = [
      ...diagnosticsFromProviderRuntimeMetadata(output.metadata),
      ...deterministicFallbackDiagnostics(evidenceStatus),
    ];

    const parsed = parseStrictJsonObject(output.content);
    let value: T | undefined;
    let jsonParsed = false;

    if (parsed.ok) {
      jsonParsed = true;
      const validation = options.validate(parsed.value, context);
      diagnostics.push(...(validation.diagnostics ?? []));
      if (validation.ok) value = validation.value;
    } else {
      diagnostics.push(...parsed.diagnostics);
    }

    allDiagnostics.push(...diagnostics);
    attempts.push(attemptReport(context, evidenceStatus, jsonParsed, diagnostics, output.metadata));

    if (value !== undefined && !hasBlockingDiagnostics(diagnostics)) {
      return {
        status: "passed",
        classification: attemptNumber === 1 ? "first_pass" : "repair_pass",
        value,
        attempts,
        diagnostics: allDiagnostics,
      };
    }
  }

  return {
    status: "failed",
    classification: "failed_after_repair",
    attempts,
    diagnostics: allDiagnostics,
  };
}

function deterministicFallbackDiagnostics(evidenceStatus: StrictJsonEvidenceStatus): readonly StrictOutputDiagnostic[] {
  if (evidenceStatus !== "deterministic_fallback") return [];
  return [
    diagnosticFromSemanticInvariant({
      code: "deterministic_fallback_not_live",
      message: "Deterministic fallback output may be useful for tests or recovery, but it cannot be counted as a live strict JSON pass.",
    }),
  ];
}

function attemptReport(
  context: StrictJsonAttemptContext,
  evidenceStatus: StrictJsonEvidenceStatus,
  jsonParsed: boolean,
  diagnostics: readonly StrictOutputDiagnostic[],
  metadata?: StrictOutputRuntimeMetadata,
): StrictJsonAttemptReport {
  return {
    attemptNumber: context.attemptNumber,
    attemptKind: context.attemptKind,
    evidenceStatus,
    jsonParsed,
    diagnostics,
    diagnosticSummary: summarizeStrictOutputDiagnostics(diagnostics),
    ...(metadata ? { metadata } : {}),
  };
}

function hasBlockingDiagnostics(diagnostics: readonly StrictOutputDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
