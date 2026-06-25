import { z } from "zod";
import { PHASE_0_THRESHOLDS } from "./metrics";

type NoProductionFakesAuditReport = {
  readonly scanRoot: string;
  readonly scannedFileCount: number;
  readonly findingCount: number;
  readonly exitCode: 0;
  readonly findings: readonly { readonly ruleId: string }[];
};

export const Phase0BaselineSchema = z.object({
  schemaVersion: z.literal("rector.phase0-baseline.v1"),
  generatedAt: z.string(),
  git: z.object({
    branch: z.string(),
    headSha: z.string(),
  }),
  testBaseline: z.object({
    totalTests: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  capabilityCorpus: z.object({
    caseCount: z.number().int().nonnegative(),
    artifactKinds: z.array(z.string()),
  }),
  fakeAudit: z.object({
    findingCount: z.number().int().nonnegative(),
    perRule: z.record(z.string(), z.number().int().nonnegative()),
  }),
  metricThresholds: z.object({
    schema_valid: z.number(),
    recall: z.number(),
    omission: z.number(),
    secret_leak: z.number(),
    compression: z.number(),
    raw_token_reduction: z.number(),
    line_ref_accuracy: z.number(),
    root_cause_accuracy: z.number(),
  }),
  validationStrengthRubric: z.object({
    T0: z.string(),
    T1: z.string(),
    T2: z.string(),
    T3: z.string(),
    T4: z.string(),
    T5: z.string(),
  }),
  costRiskDefinitions: z.object({
    tokenEstimator: z.string(),
    fakeAuditPolicy: z.string(),
  }),
});

export type Phase0Baseline = z.infer<typeof Phase0BaselineSchema>;

export const VALIDATION_STRENGTH_RUBRIC = {
  T0: "Schema validity (strict parse, no coercion)",
  T1: "Critical evidence recall (mustContain coverage)",
  T2: "Critical omission rate (must-not-miss)",
  T3: "Secret / PII leak prevention (forbidden + redaction)",
  T4: "Line-reference accuracy (exact line counts)",
  T5: "Root-cause accuracy (recall + exit + lines)",
} as const;

export const COST_RISK_DEFINITIONS = {
  tokenEstimator: "estimateApproxTokensFromText (src/capabilities/eval/tokens.ts) — 4 chars ≈ 1 token, always ≥1",
  fakeAuditPolicy: "report-only; never blocks CI; records findingCount + per-rule counts",
} as const;

export async function buildPhase0Baseline(options: {
  now?: () => Date;
  gitBranch?: string;
  gitHeadSha?: string;
  testBaseline?: { totalTests: number; passed: number; skipped: number };
  capabilityCorpus?: { caseCount: number; artifactKinds: string[] };
  fakeAuditReport?: NoProductionFakesAuditReport;
}): Promise<Phase0Baseline> {
  const now = options.now ?? (() => new Date());
  const gitBranch = options.gitBranch ?? "rector-0.3.0-phase0-and-0.5";
  const gitHeadSha = options.gitHeadSha ?? "76a7945866cfde6b54b613881042a65308d9577e";
  const testBaseline = options.testBaseline ?? { totalTests: 2241, passed: 2236, skipped: 5 };
  const capabilityCorpus = options.capabilityCorpus ?? { caseCount: 10, artifactKinds: ["text/plain"] };

  const fakeReport: NoProductionFakesAuditReport =
    options.fakeAuditReport ?? {
      scanRoot: ".",
      scannedFileCount: 0,
      findingCount: 0,
      exitCode: 0,
      findings: [],
    };
  const perRule: Record<string, number> = {};
  for (const f of fakeReport.findings) {
    perRule[f.ruleId] = (perRule[f.ruleId] ?? 0) + 1;
  }

  const baseline: Phase0Baseline = {
    schemaVersion: "rector.phase0-baseline.v1",
    generatedAt: now().toISOString(),
    git: { branch: gitBranch, headSha: gitHeadSha },
    testBaseline,
    capabilityCorpus,
    fakeAudit: {
      findingCount: fakeReport.findingCount,
      perRule,
    },
    metricThresholds: { ...PHASE_0_THRESHOLDS },
    validationStrengthRubric: { ...VALIDATION_STRENGTH_RUBRIC },
    costRiskDefinitions: { ...COST_RISK_DEFINITIONS },
  };

  return Phase0BaselineSchema.parse(baseline);
}
