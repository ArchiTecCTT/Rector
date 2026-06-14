import { z } from "zod";
import { PlannerOutputSchema, type PlannerOutput } from "./planner";
import type { ContextPack } from "./contextBuilder";
import { SkepticFindingSchema, SkepticReviewSchema, type SkepticFinding, type SkepticReview } from "./skeptic";
import { redactString } from "../security/redaction";
import {
  SkillActivationDecisionSchema,
  skillRiskOf,
  type SkillActivationDecision,
  type SkillManifest,
} from "../memory/skillSchema";

export const CRUCIBLE_MAX_ROUNDS = 2;
export const DEFAULT_MAX_SKILLS_PER_RUN = 5;

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
  "SKILL_POLICY_REVISION",
]);
export type CrucibleReasonCode = z.infer<typeof CrucibleReasonCodeSchema>;

export const CrucibleDecisionTraceSchema = z.object({
  reasonCode: CrucibleReasonCodeSchema,
  policy: z.string().min(1),
  targetedFindingIds: z.array(z.string().min(1)),
  repairable: z.boolean(),
  humanDecisionRequired: z.boolean(),
  exhaustedRounds: z.boolean(),
  skillActivation: z.array(SkillActivationDecisionSchema).default([]),
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

export interface SkillCatalogReader {
  get(id: string): SkillManifest | undefined;
}

export interface SkillActivationPolicyContext {
  catalog?: SkillCatalogReader;
  contextPack?: ContextPack;
  maxSkills?: number;
  allowlistedCommands?: string[];
  availableEnvVars?: string[];
  platform?: string;
}

export type CrucibleInput = {
  plannerOutput: PlannerOutput;
  skepticReview: SkepticReview;
  round?: number;
  priorRounds?: number;
  now?: () => string;
  skillsCatalog?: SkillCatalogReader;
  contextPack?: ContextPack;
  skillPolicy?: Omit<SkillActivationPolicyContext, "catalog" | "contextPack">;
};

export function arbitratePlanWithCrucible(input: CrucibleInput): CrucibleDecision {
  const plannerOutput = PlannerOutputSchema.parse(input.plannerOutput);
  const skepticReview = SkepticReviewSchema.parse(input.skepticReview);
  const round = boundedRound(input);
  const createdAt = input.now?.() ?? new Date().toISOString();
  const skillActivation = evaluateSkillActivations(plannerOutput, {
    catalog: input.skillsCatalog,
    contextPack: input.contextPack,
    ...(input.skillPolicy ?? {}),
  });
  const skillRevisionFindings = skillFindingsFor(skillActivation);

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
      }, skillActivation),
    });
  }

  if (skepticReview.verdict === "SOUND" && skillRevisionFindings.length === 0) {
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
      }, skillActivation),
    });
  }

  const skepticRevisionFindings = skepticReview.findings.filter(
    (finding) => finding.severity === "MAJOR" || finding.severity === "MINOR"
  );
  const revisionFindings = [...skillRevisionFindings, ...skepticRevisionFindings];
  const humanDecisionFindings = skepticRevisionFindings.filter(requiresHumanDecision);

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
      }, skillActivation),
    });
  }

  if (revisionFindings.length > 0 && round < CRUCIBLE_MAX_ROUNDS) {
    const reasonCode = skillRevisionFindings.length > 0 ? "SKILL_POLICY_REVISION" : "REPAIRABLE_FINDINGS_REVISION";
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
      trace: traceDecision(reasonCode, revisionFindings, {
        repairable: true,
        humanDecisionRequired: false,
        exhaustedRounds: false,
      }, skillActivation),
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
      }, skillActivation),
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
    }, skillActivation),
  });
}

export function evaluateSkillActivations(
  plan: PlannerOutput,
  context: SkillActivationPolicyContext = {},
): SkillActivationDecision[] {
  const requested = uniqueRequestedSkillIds(plan.requestedSkills ?? []);
  if (requested.length === 0) return [];

  const maxSkills = Math.max(1, Math.trunc(context.maxSkills ?? DEFAULT_MAX_SKILLS_PER_RUN));
  const decisions: SkillActivationDecision[] = [];

  for (const [index, skillId] of requested.entries()) {
    if (index >= maxSkills) {
      decisions.push(skillDecision(skillId, "denied", `Skill cap exceeded: at most ${maxSkills} skill(s) may be activated per run.`));
      continue;
    }

    const manifest = context.catalog?.get(skillId);
    if (!manifest) {
      decisions.push(skillDecision(skillId, "denied", "Unknown skill id requested by planner."));
      continue;
    }

    if (skillRiskOf(manifest) === "high" && !planHasRequiredApprovalGate(plan)) {
      decisions.push(skillDecision(skillId, "denied", "High-risk skill requires an explicit required approval gate in the plan."));
      continue;
    }

    const prerequisiteDecision = evaluatePrerequisites(manifest, context);
    if (prerequisiteDecision) {
      decisions.push(skillDecision(skillId, prerequisiteDecision.decision, prerequisiteDecision.reason));
      continue;
    }

    decisions.push(skillDecision(skillId, "approved", "Skill exists and policy prerequisites are satisfied."));
  }

  return decisions;
}

export function approvedSkillIdsFromDecision(decision: CrucibleDecision): string[] {
  return (decision.trace?.skillActivation ?? [])
    .filter((activation) => activation.decision === "approved")
    .map((activation) => activation.skillId);
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
  flags: Pick<CrucibleDecisionTrace, "repairable" | "humanDecisionRequired" | "exhaustedRounds">,
  skillActivation: SkillActivationDecision[] = [],
): CrucibleDecisionTrace {
  return CrucibleDecisionTraceSchema.parse({
    reasonCode,
    policy: "accepted only without blockers; skill policy denials revise; repairable findings revise before max rounds; human decisions escalate; exhausted rounds escalate",
    targetedFindingIds: findings.map((finding) => finding.id),
    skillActivation,
    ...flags,
  });
}

function evaluatePrerequisites(
  manifest: SkillManifest,
  context: SkillActivationPolicyContext,
): { decision: "denied" | "deferred"; reason: string } | undefined {
  const prerequisites = manifest.frontmatter.prerequisites;
  if (!prerequisites) return undefined;

  const platform = context.platform ?? process.platform;
  const platforms = prerequisites.platforms ?? [];
  if (platforms.length > 0 && !platforms.some((candidate) => platformMatches(candidate, platform))) {
    return {
      decision: "denied",
      reason: `Skill platform prerequisite is not satisfied for ${platform}.`,
    };
  }

  const commands = prerequisites.commands ?? [];
  if (commands.length > 0) {
    if (context.allowlistedCommands === undefined) {
      return {
        decision: "deferred",
        reason: "Command prerequisites require sandbox allowlist data that is not available for this run.",
      };
    }
    const missing = commands.filter((command) => !commandAllowed(command, context.allowlistedCommands ?? []));
    if (missing.length > 0) {
      return {
        decision: "denied",
        reason: `Command prerequisites are not allowed by sandbox policy: ${missing.join(", ")}.`,
      };
    }
  }

  const envVars = prerequisites.env_vars ?? [];
  if (envVars.length > 0) {
    if (context.availableEnvVars === undefined) {
      return {
        decision: "deferred",
        reason: "Environment prerequisites require UI-managed readiness data that is not available for this run.",
      };
    }
    const available = new Set(context.availableEnvVars);
    const missing = envVars.filter((name) => !available.has(name));
    if (missing.length > 0) {
      return {
        decision: "denied",
        reason: `Environment prerequisites are not marked ready: ${missing.join(", ")}.`,
      };
    }
  }

  return undefined;
}

function skillFindingsFor(decisions: SkillActivationDecision[]): SkepticFinding[] {
  return decisions
    .filter((decision) => decision.decision === "denied")
    .map((decision, index) =>
      SkepticFindingSchema.parse({
        id: `skill.policy.${index + 1}`,
        severity: "MAJOR",
        category: "skill",
        message: redactString(`Requested skill ${decision.skillId} was denied by crucible skill policy.`),
        evidence: redactString(`requestedSkills included ${decision.skillId}; policy reason: ${decision.reason}`),
        recommendation: "Remove the skill request, request a known lower-risk skill, or satisfy the required approval/prerequisite gate.",
      })
    );
}

function skillDecision(
  skillId: string,
  decision: SkillActivationDecision["decision"],
  reason: string,
): SkillActivationDecision {
  return SkillActivationDecisionSchema.parse({
    skillId: redactString(skillId),
    decision,
    reason: redactString(reason),
  });
}

function uniqueRequestedSkillIds(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function planHasRequiredApprovalGate(plan: PlannerOutput): boolean {
  return plan.approvalGates.some((gate) => gate.required) || plan.tasks.some((task) => task.approvalRequired);
}

function commandAllowed(command: string, allowlistedCommands: string[]): boolean {
  const firstToken = command.trim().split(/\s+/)[0] ?? command;
  return allowlistedCommands.includes(command) || allowlistedCommands.includes(firstToken);
}

function platformMatches(candidate: string, current: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  const platform = current.toLowerCase();
  if (normalized === platform) return true;
  if (normalized === "windows" && platform === "win32") return true;
  if (normalized === "macos" && platform === "darwin") return true;
  if (normalized === "linux" && platform === "linux") return true;
  return false;
}
