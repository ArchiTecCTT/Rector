import { z } from "zod";
import { ContextPackSchema, summarize, type ContextPack } from "./contextBuilder";
import { TRIAGE_ROUTES, TriageResultSchema, type TriageResult } from "./triage";

export const PlannerRiskLevelSchema = z.enum(["low", "medium", "high", "destructive"]);
export type PlannerRiskLevel = z.infer<typeof PlannerRiskLevelSchema>;

export const PlannerDependencySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type PlannerDependency = z.infer<typeof PlannerDependencySchema>;

export const PlannerTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  dependencies: z.array(z.string().min(1)),
  expectedArtifacts: z.array(z.string().min(1)),
  validation: z.array(z.string().min(1)).min(1),
  risk: PlannerRiskLevelSchema,
  approvalRequired: z.boolean(),
});
export type PlannerTask = z.infer<typeof PlannerTaskSchema>;

export const ApprovalGateSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["approval", "checkpoint", "clarification"]),
  reason: z.string().min(1),
  required: z.boolean(),
  taskIds: z.array(z.string().min(1)),
});
export type ApprovalGate = z.infer<typeof ApprovalGateSchema>;

export const PlannerValidationSchema = z.object({
  summary: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1),
});
export type PlannerValidation = z.infer<typeof PlannerValidationSchema>;

export const PlannerInputSchema = z.object({
  triage: TriageResultSchema,
  contextPack: ContextPackSchema,
  messageContent: z.string().optional(),
  intent: z.string().optional(),
});
export type PlannerInput = z.infer<typeof PlannerInputSchema>;

export const PlannerOutputSchema = z.object({
  goal: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  tasks: z.array(PlannerTaskSchema),
  dependencies: z.array(PlannerDependencySchema),
  validation: PlannerValidationSchema,
  riskLevel: PlannerRiskLevelSchema,
  approvalGates: z.array(ApprovalGateSchema),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export function createFakePlan(input: PlannerInput): PlannerOutput {
  const parsed = PlannerInputSchema.parse(input);
  const intent = summarize(parsed.messageContent ?? parsed.intent ?? parsed.contextPack.userIntentSummary, 180);
  const base = basePlan(intent, parsed.triage, parsed.contextPack);

  switch (parsed.triage.route) {
    case TRIAGE_ROUTES.DIRECT_ANSWER:
      return validatePlannerOutput({
        ...base,
        assumptions: [...base.assumptions, "User expects a concise answer or synthesis, not file changes."],
        tasks: [
          task({
            id: "answer.synthesize",
            title: "Synthesize direct answer",
            description: "Use available conversation context to produce a concise response.",
            expectedArtifacts: ["Assistant answer"],
            validation: ["Answer addresses the stated question", "No file edits or external calls are planned"],
          }),
        ],
        validation: validation("Direct answer plan has exactly one synthesis task and no execution side effects", [
          "Confirm response is grounded in provided context",
          "Confirm no edit, tool, or provider execution tasks are included",
        ]),
        riskLevel: "low",
      });

    case TRIAGE_ROUTES.PLAN_ONLY:
      return validatePlannerOutput({
        ...base,
        assumptions: [...base.assumptions, "User requested planning only; no file edits should be executed."],
        tasks: [
          task({
            id: "plan.inspect",
            title: "Inspect planning inputs",
            description: "Review request constraints and available context before drafting the plan.",
            expectedArtifacts: ["Constraint summary"],
            validation: ["Constraints are captured", "No executable code-change steps are started"],
          }),
          task({
            id: "plan.document",
            title: "Document implementation plan",
            description: "Draft a sequenced plan with validation and risk notes.",
            dependencies: ["plan.inspect"],
            expectedArtifacts: ["Planning document or response"],
            validation: ["Plan includes ordered steps", "Plan includes validation and risk notes"],
          }),
        ],
        dependencies: [{ from: "plan.inspect", to: "plan.document" }],
        validation: validation("Planning-only output stays non-executing and documents validation criteria", [
          "Confirm no edit task is marked executable",
          "Confirm the plan includes validation criteria",
        ]),
        riskLevel: "low",
      });

    case TRIAGE_ROUTES.CODE_EDIT: {
      const destructive = hasDestructiveRisk(parsed.triage, intent);
      const editRisk: PlannerRiskLevel = destructive ? "destructive" : parsed.triage.complexity === "high" ? "high" : "medium";
      const approvalRequired = editRisk === "high" || editRisk === "destructive";
      const editTask = task({
        id: "code.edit",
        title: "Apply focused code changes",
        description: destructive
          ? "Apply requested code changes only after explicit approval for destructive actions."
          : "Apply focused code changes according to the inspected scope.",
        dependencies: ["code.inspect"],
        expectedArtifacts: ["Updated source files"],
        validation: ["Changes match requested scope", "No unrelated files are changed"],
        risk: editRisk,
        approvalRequired,
      });

      return validatePlannerOutput({
        ...base,
        assumptions: [...base.assumptions, "User expects code inspection, focused edits, and validation."],
        tasks: [
          task({
            id: "code.inspect",
            title: "Inspect target code and tests",
            description: "Identify relevant files, existing patterns, and safe edit boundaries.",
            expectedArtifacts: ["Inspection notes"],
            validation: ["Relevant files are identified", "Existing project patterns are noted"],
            risk: "low",
          }),
          editTask,
          task({
            id: "code.validate",
            title: "Validate changes",
            description: "Run targeted tests or checks appropriate for the edit.",
            dependencies: ["code.edit"],
            expectedArtifacts: ["Validation evidence"],
            validation: ["Relevant tests or build checks are executed", "Failures are reported explicitly"],
            risk: "medium",
          }),
        ],
        dependencies: [
          { from: "code.inspect", to: "code.edit" },
          { from: "code.edit", to: "code.validate" },
        ],
        validation: validation("Code-edit plan inspects before editing and validates after editing", [
          "Confirm inspect precedes edit",
          "Confirm edit precedes validation",
          "Confirm destructive/high-risk edits have an approval gate",
        ]),
        riskLevel: editRisk,
        approvalGates: approvalRequired
          ? [
              {
                id: destructive ? "gate.destructive-code-edit" : "gate.high-risk-code-edit",
                type: "approval",
                reason: destructive
                  ? "Request includes destructive or irreversible code-change indicators."
                  : "High-complexity code changes require explicit approval before editing.",
                required: true,
                taskIds: ["code.edit"],
              },
            ]
          : [],
      });
    }

    case TRIAGE_ROUTES.RESEARCH:
      return validatePlannerOutput({
        ...base,
        assumptions: [...base.assumptions, "User expects research synthesis with source citation."],
        tasks: [
          task({
            id: "research.gather",
            title: "Gather research inputs",
            description: "Collect relevant evidence from allowed docs, memory, or future research tools.",
            expectedArtifacts: ["Research notes"],
            validation: ["Sources are relevant to the request", "Source limitations are captured"],
            risk: "medium",
          }),
          task({
            id: "research.synthesize",
            title: "Synthesize findings",
            description: "Compare evidence and produce an answer aligned to the user goal.",
            dependencies: ["research.gather"],
            expectedArtifacts: ["Research synthesis"],
            validation: ["Claims are supported by gathered evidence", "Uncertainty is stated"],
            risk: "medium",
          }),
          task({
            id: "research.cite",
            title: "Attach citations",
            description: "List cited sources and connect key claims to evidence.",
            dependencies: ["research.synthesize"],
            expectedArtifacts: ["Cited source list"],
            validation: ["Every source has a stable reference", "Citation list is present in final output"],
            risk: "low",
          }),
        ],
        dependencies: [
          { from: "research.gather", to: "research.synthesize" },
          { from: "research.synthesize", to: "research.cite" },
        ],
        validation: validation("Research plan gathers, synthesizes, and cites evidence", [
          "Confirm cited source list is planned",
          "Confirm unsupported claims are avoided or labeled",
        ]),
        riskLevel: "medium",
      });

    case TRIAGE_ROUTES.LONG_RUNNING:
      return validatePlannerOutput({
        ...base,
        assumptions: [...base.assumptions, "User request likely needs staged execution and checkpoints."],
        tasks: [
          task({
            id: "long.scope",
            title: "Define staged scope",
            description: "Break the request into bounded stages with budgets and stop conditions.",
            expectedArtifacts: ["Stage breakdown"],
            validation: ["Stages are independently verifiable", "Stop conditions are explicit"],
            risk: "medium",
          }),
          task({
            id: "long.checkpoint",
            title: "Request checkpoint approval",
            description: "Pause for approval before extended, costly, or deployment-affecting work.",
            dependencies: ["long.scope"],
            expectedArtifacts: ["Checkpoint decision"],
            validation: ["Approval gate is recorded", "Next stage is not executed before approval"],
            risk: "high",
            approvalRequired: true,
          }),
          task({
            id: "long.execute-stage",
            title: "Execute approved stage",
            description: "Run only the approved stage and collect validation evidence.",
            dependencies: ["long.checkpoint"],
            expectedArtifacts: ["Stage output", "Validation evidence"],
            validation: ["Work stays within approved stage", "Evidence is captured before next checkpoint"],
            risk: "high",
            approvalRequired: true,
          }),
        ],
        dependencies: [
          { from: "long.scope", to: "long.checkpoint" },
          { from: "long.checkpoint", to: "long.execute-stage" },
        ],
        validation: validation("Long-running plan includes explicit checkpoints before execution", [
          "Confirm checkpoint gate exists",
          "Confirm high-risk stage execution requires approval",
        ]),
        riskLevel: "high",
        approvalGates: [
          {
            id: "gate.long-running-checkpoint",
            type: "checkpoint",
            reason: "Long-running work requires explicit checkpoint approval before execution continues.",
            required: true,
            taskIds: ["long.checkpoint", "long.execute-stage"],
          },
        ],
      });

    case TRIAGE_ROUTES.NEEDS_CLARIFICATION:
      return validatePlannerOutput({
        ...base,
        assumptions: [...base.assumptions, "Request lacks enough detail for safe executable tasks."],
        tasks: [],
        validation: validation("Clarification plan has no executable tasks and waits for user input", [
          "Wait for explicit user clarification before execution",
          "Do not infer missing scope silently",
        ]),
        riskLevel: "low",
        approvalGates: [
          {
            id: "gate.clarification-required",
            type: "clarification",
            reason: "The request needs a user decision or clarification before planning executable work.",
            required: true,
            taskIds: [],
          },
        ],
      });
  }
}

export function validatePlannerOutput(output: unknown): PlannerOutput {
  const parsed = PlannerOutputSchema.parse(output);

  for (const dependency of parsed.dependencies) {
    if (!parsed.tasks.some((taskItem) => taskItem.id === dependency.from)) {
      throw new Error(`Planner dependency references missing source task: ${dependency.from}`);
    }
    if (!parsed.tasks.some((taskItem) => taskItem.id === dependency.to)) {
      throw new Error(`Planner dependency references missing target task: ${dependency.to}`);
    }
  }

  for (const taskItem of parsed.tasks) {
    for (const dependencyId of taskItem.dependencies) {
      if (!parsed.tasks.some((candidate) => candidate.id === dependencyId)) {
        throw new Error(`Planner task ${taskItem.id} references missing dependency: ${dependencyId}`);
      }
    }
  }

  const unsafeTaskIds = parsed.tasks
    .filter((taskItem) => taskItem.approvalRequired || taskItem.risk === "high" || taskItem.risk === "destructive")
    .map((taskItem) => taskItem.id);
  const unsafePlan = parsed.riskLevel === "high" || parsed.riskLevel === "destructive" || unsafeTaskIds.length > 0;

  if (unsafePlan) {
    const gatedTaskIds = new Set(parsed.approvalGates.filter((gate) => gate.required).flatMap((gate) => gate.taskIds));
    const hasPlanLevelGate = parsed.approvalGates.some((gate) => gate.required && gate.taskIds.length === 0);
    const allUnsafeTasksGated = unsafeTaskIds.every((taskId) => gatedTaskIds.has(taskId));

    if (!hasPlanLevelGate && !allUnsafeTasksGated) {
      throw new Error("Unsafe planner output requires an approval gate for every high-risk task");
    }
  }

  return parsed;
}

function basePlan(intent: string, triage: TriageResult, contextPack: ContextPack): PlannerOutput {
  return {
    goal: `Plan for: ${intent || contextPack.userIntentSummary}`,
    assumptions: [
      `Triage route is ${triage.route} with ${triage.confidence.toFixed(2)} confidence.`,
      `Context pack ${contextPack.id} is the planning source of truth.`,
    ],
    tasks: [],
    dependencies: [],
    validation: validation("Default planner validation", ["Planner output schema parses"]),
    riskLevel: riskFromTriage(triage),
    approvalGates: [],
  };
}

function task(input: {
  id: string;
  title: string;
  description: string;
  dependencies?: string[];
  expectedArtifacts: string[];
  validation: string[];
  risk?: PlannerRiskLevel;
  approvalRequired?: boolean;
}): PlannerTask {
  return PlannerTaskSchema.parse({
    dependencies: [],
    risk: "low",
    approvalRequired: false,
    ...input,
  });
}

function validation(summary: string, checks: string[]): PlannerValidation {
  return PlannerValidationSchema.parse({ summary, checks });
}

function riskFromTriage(triage: TriageResult): PlannerRiskLevel {
  if (hasDestructiveRisk(triage, "")) return "destructive";
  if (triage.complexity === "high" || triage.riskFlags.includes("deployment_risk")) return "high";
  if (triage.complexity === "medium" || triage.riskFlags.length > 0) return "medium";
  return "low";
}

function hasDestructiveRisk(triage: TriageResult, intent: string): boolean {
  return (
    triage.riskFlags.includes("destructive_change") ||
    triage.riskFlags.includes("deployment_risk") ||
    /\b(delete|remove|drop|wipe|destroy|overwrite|production|deploy)\b/i.test(intent)
  );
}
