import { z } from "zod";
import { PlannerOutputSchema, type PlannerOutput } from "./planner";
import { SkepticFindingSchema, SkepticReviewSchema, type SkepticFinding, type SkepticReview } from "./skeptic";

export const CRUCIBLE_MAX_ROUNDS = 2;

export const CrucibleVerdictSchema = z.enum(["ACCEPTED", "NEEDS_REVISION", "ESCALATED", "BLOCKED"]);
export type CrucibleVerdict = z.infer<typeof CrucibleVerdictSchema>;

export const CrucibleRevisionRequestSchema = z.object({
  targetedFindings: z.array(SkepticFindingSchema).min(1),
  requiredChanges: z.array(z.string().min(1)).min(1),
});
export type CrucibleRevisionRequest = z.infer<typeof CrucibleRevisionRequestSchema>;

export const CrucibleEscalationSchema = z.object({
  reason: z.string().min(1),
  findings: z.array(SkepticFindingSchema),
  exhaustedRounds: z.boolean(),
});
export type CrucibleEscalation = z.infer<typeof CrucibleEscalationSchema>;

export const CrucibleDecisionSchema = z.object({
  verdict: CrucibleVerdictSchema,
  reason: z.string().min(1),
  acceptedPlan: PlannerOutputSchema.optional(),
  revisionRequest: CrucibleRevisionRequestSchema.optional(),
  escalation: CrucibleEscalationSchema.optional(),
  blockerFindings: z.array(SkepticFindingSchema),
  round: z.number().int().min(1).max(CRUCIBLE_MAX_ROUNDS),
  maxRounds: z.literal(CRUCIBLE_MAX_ROUNDS),
  createdAt: z.string().datetime(),
}).superRefine((data, ctx) => {
  if (data.verdict === "ACCEPTED" && !data.acceptedPlan) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "acceptedPlan is required when verdict is ACCEPTED",
      path: ["acceptedPlan"],
    });
  }
  if (data.verdict === "NEEDS_REVISION" && !data.revisionRequest) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "revisionRequest is required when verdict is NEEDS_REVISION",
      path: ["revisionRequest"],
    });
  }
  if (data.verdict === "ESCALATED" && !data.escalation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "escalation is required when verdict is ESCALATED",
      path: ["escalation"],
    });
  }
  if (data.verdict === "BLOCKED" && !data.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "reason is required when verdict is BLOCKED",
      path: ["reason"],
    });
  }
});
export type CrucibleDecision = z.infer<typeof CrucibleDecisionSchema>;

export type CrucibleInput = {
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  round?: number;
  priorRounds?: number;
  now?: () => string;
};

export function arbitratePlanWithCrucible(input: CrucibleInput): CrucibleDecision {
  const plannerOutput = PlannerOutputSchema.parse(input.plannerOutput);
  const skepticReview = SkepticReviewSchema.parse(input.skepticReview);
  const round = boundedRound(input);
  const createdAt = input.now?.() ?? new Date().toISOString();

  const blockerFindings = skepticReview.findings.filter((finding) => finding.severity === "BLOCKER");
  if (skepticReview.verdict === "BLOCKED" || blockerFindings.length > 0) {
    return CrucibleDecisionSchema.parse({
      verdict: "BLOCKED",
      reason:
        blockerFindings.length > 0
          ? `Crucible blocked execution because ${blockerFindings.length} BLOCKER finding(s) must be resolved before planning can continue.`
          : "Crucible blocked execution because the skeptic review verdict is BLOCKED.",
      blockerFindings,
      round,
      maxRounds: CRUCIBLE_MAX_ROUNDS,
      createdAt,
    });
  }

  if (skepticReview.verdict === "SOUND") {
    return CrucibleDecisionSchema.parse({
      verdict: "ACCEPTED",
      reason: "Crucible accepted the plan because the skeptic review found it SOUND.",
      acceptedPlan: plannerOutput,
      blockerFindings: [],
      round,
      maxRounds: CRUCIBLE_MAX_ROUNDS,
      createdAt,
    });
  }

  const revisionFindings = skepticReview.findings.filter(
    (finding) => finding.severity === "MAJOR" || finding.severity === "MINOR"
  );

  if (revisionFindings.length > 0 && round < CRUCIBLE_MAX_ROUNDS) {
    return CrucibleDecisionSchema.parse({
      verdict: "NEEDS_REVISION",
      reason: `Crucible requests targeted planner revision for ${revisionFindings.length} MAJOR/MINOR finding(s).`,
      revisionRequest: {
        targetedFindings: revisionFindings,
        requiredChanges: requiredChangesFor(revisionFindings),
      },
      blockerFindings: [],
      round,
      maxRounds: CRUCIBLE_MAX_ROUNDS,
      createdAt,
    });
  }

  if (revisionFindings.length > 0) {
    const reason = `Crucible escalated because max revision rounds (${CRUCIBLE_MAX_ROUNDS}) were exhausted with unresolved MAJOR/MINOR finding(s).`;
    return CrucibleDecisionSchema.parse({
      verdict: "ESCALATED",
      reason,
      escalation: {
        reason,
        findings: revisionFindings,
        exhaustedRounds: true,
      },
      blockerFindings: [],
      round,
      maxRounds: CRUCIBLE_MAX_ROUNDS,
      createdAt,
    });
  }

  return CrucibleDecisionSchema.parse({
    verdict: "ACCEPTED",
    reason: "Crucible accepted the plan because there are no blocker, major, or minor findings.",
    acceptedPlan: plannerOutput,
    blockerFindings: [],
    round,
    maxRounds: CRUCIBLE_MAX_ROUNDS,
    createdAt,
  });
}

function boundedRound(input: Pick<CrucibleInput, "round" | "priorRounds">): number {
  const requested = input.round ?? (input.priorRounds === undefined ? 1 : input.priorRounds + 1);
  if (!Number.isFinite(requested)) return 1;
  return Math.min(CRUCIBLE_MAX_ROUNDS, Math.max(1, Math.trunc(requested)));
}

function requiredChangesFor(findings: SkepticFinding[]): string[] {
  const changes = findings.map((finding) => finding.recommendation.trim()).filter(Boolean);
  return [...new Set(changes)];
}
