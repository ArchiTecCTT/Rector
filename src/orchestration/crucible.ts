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

export const CrucibleReasonCodeSchema = z.enum([
  "NO_FINDINGS_ACCEPTED",
  "SOUND_REVIEW_ACCEPTED",
  "BLOCKER_FINDINGS_BLOCKED",
  "SKEPTIC_BLOCKED",
  "REPAIRABLE_FINDINGS_REVISION",
  "HUMAN_DECISION_ESCALATED",
  "MAX_ROUNDS_ESCALATED",
]);
export type CrucibleReasonCode = z.infer<typeof CrucibleReasonCodeSchema>;

export const CrucibleDecisionTraceSchema = z.object({
  reasonCode: CrucibleReasonCodeSchema,
  policy: z.string().min(1),
  targetedFindingIds: z.array(z.string().min(1)),
  repairable: z.boolean(),
  humanDecisionRequired: z.boolean(),
  exhaustedRounds: z.boolean(),
});
export type CrucibleDecisionTrace = z.infer<typeof CrucibleDecisionTraceSchema>;

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
  trace: CrucibleDecisionTraceSchema.optional(),
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
    const reason =
      blockerFindings.length > 0
        ? `Crucible blocked execution because ${blockerFindings.length} BLOCKER finding(s) must be resolved before planning can continue.`
        : "Crucible blocked execution because the skeptic review verdict is BLOCKED.";
    return CrucibleDecisionSchema.parse({
      verdict: "BLOCKED",
      reason,
      blockerFindings,
      round,
      maxRounds: CRUCIBLE_MAX_ROUNDS,
      createdAt,
      trace: traceDecision(blockerFindings.length > 0 ? "BLOCKER_FINDINGS_BLOCKED" : "SKEPTIC_BLOCKED", blockerFindings, {
        repairable: false,
        humanDecisionRequired: false,
        exhaustedRounds: round >= CRUCIBLE_MAX_ROUNDS,
      }),
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
      trace: traceDecision("SOUND_REVIEW_ACCEPTED", [], {
        repairable: false,
        humanDecisionRequired: false,
        exhaustedRounds: false,
      }),
    });
  }

  const revisionFindings = skepticReview.findings.filter(
    (finding) => finding.severity === "MAJOR" || finding.severity === "MINOR"
  );
  const humanDecisionFindings = revisionFindings.filter(requiresHumanDecision);

  if (humanDecisionFindings.length > 0) {
    const reason = `Crucible escalated because ${humanDecisionFindings.length} finding(s) require an explicit human/operator decision.`;
    return CrucibleDecisionSchema.parse({
      verdict: "ESCALATED",
      reason,
      escalation: {
        reason,
        findings: humanDecisionFindings,
        exhaustedRounds: false,
      },
      blockerFindings: [],
      round,
      maxRounds: CRUCIBLE_MAX_ROUNDS,
      createdAt,
      trace: traceDecision("HUMAN_DECISION_ESCALATED", humanDecisionFindings, {
        repairable: false,
        humanDecisionRequired: true,
        exhaustedRounds: false,
      }),
    });
  }

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
      trace: traceDecision("REPAIRABLE_FINDINGS_REVISION", revisionFindings, {
        repairable: true,
        humanDecisionRequired: false,
        exhaustedRounds: false,
      }),
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
      trace: traceDecision("MAX_ROUNDS_ESCALATED", revisionFindings, {
        repairable: false,
        humanDecisionRequired: false,
        exhaustedRounds: true,
      }),
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
    trace: traceDecision("NO_FINDINGS_ACCEPTED", [], {
      repairable: false,
      humanDecisionRequired: false,
      exhaustedRounds: false,
    }),
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

function requiresHumanDecision(finding: SkepticFinding): boolean {
  const category = finding.category.toLowerCase();
  const text = `${finding.message} ${finding.recommendation}`.toLowerCase();
  return category === "approval" || category === "clarification" || /human|operator|approval|decision/.test(text);
}

function traceDecision(
  reasonCode: CrucibleReasonCode,
  findings: SkepticFinding[],
  flags: Pick<CrucibleDecisionTrace, "repairable" | "humanDecisionRequired" | "exhaustedRounds">
): CrucibleDecisionTrace {
  return CrucibleDecisionTraceSchema.parse({
    reasonCode,
    policy: "accepted only without blockers; repairable findings revise before max rounds; human decisions escalate; exhausted rounds escalate",
    targetedFindingIds: findings.map((finding) => finding.id),
    ...flags,
  });
}
