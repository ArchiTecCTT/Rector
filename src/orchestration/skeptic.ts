import { z } from "zod";
import type { ContextPack } from "./contextBuilder";

export const SkepticFindingSeveritySchema = z.enum(["BLOCKER", "MAJOR", "MINOR", "INFO"]);
export type SkepticFindingSeverity = z.infer<typeof SkepticFindingSeveritySchema>;

export const SkepticFindingSchema = z.object({
  id: z.string().min(1),
  severity: SkepticFindingSeveritySchema,
  taskId: z.string().min(1).optional(),
  category: z.string().min(1),
  message: z.string().min(1),
  evidence: z.string().min(1),
  recommendation: z.string().min(1),
});
export type SkepticFinding = z.infer<typeof SkepticFindingSchema>;

export const SkepticReviewVerdictSchema = z.enum(["SOUND", "NEEDS_REVISION", "BLOCKED"]);
export type SkepticReviewVerdict = z.infer<typeof SkepticReviewVerdictSchema>;

export const SkepticReviewSchema = z
  .object({
    verdict: SkepticReviewVerdictSchema,
    findings: z.array(SkepticFindingSchema),
    reviewedPlanId: z.string().min(1).optional(),
    planGoal: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .refine((review) => review.reviewedPlanId !== undefined || review.planGoal !== undefined, {
    message: "Skeptic review requires reviewedPlanId or planGoal",
  });
export type SkepticReview = z.infer<typeof SkepticReviewSchema>;

type RawTask = Record<string, unknown>;
type RawPlan = Record<string, unknown>;

const RISKY_LANGUAGE_PATTERN =
  /\b(code|edit|modify|change|write|delete|remove|drop|wipe|destroy|overwrite|deploy|deployment|production|migrate|migration)\b/i;
const FILE_REFERENCE_PATTERN = /\b(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\b/g;
const API_REFERENCE_PATTERN = /\b(?:[A-Z][A-Za-z0-9]*API|[A-Z][A-Za-z0-9]*Api|[A-Za-z0-9_.-]+\s+API)\b/g;

export function reviewPlanWithSkeptic(plannerOutput: unknown, contextPack?: ContextPack): SkepticReview {
  const plan = asRecord(plannerOutput);
  const tasks = arrayOfRecords(plan.tasks);
  const findings: SkepticFinding[] = [];

  const addFinding = (input: Omit<SkepticFinding, "id">): void => {
    findings.push(
      SkepticFindingSchema.parse({
        id: `skeptic.${input.category}.${findings.length + 1}`,
        ...input,
      })
    );
  };

  if (!hasValidation(plan.validation)) {
    addFinding({
      severity: "MAJOR",
      category: "validation",
      message: "Plan is missing top-level validation criteria.",
      evidence: formatEvidence(plan.validation),
      recommendation: "Add a top-level validation summary and at least one concrete validation check.",
    });
  }

  for (const task of tasks) {
    if (!hasValidationArray(task.validation)) {
      addFinding({
        severity: "MAJOR",
        taskId: stringValue(task.id),
        category: "validation",
        message: "Task is missing validation criteria.",
        evidence: formatEvidence(task.validation),
        recommendation: "Add at least one concrete validation check for this task.",
      });
    }
  }

  const taskIds = new Set(tasks.map((task) => stringValue(task.id)).filter((id): id is string => Boolean(id)));
  for (const dependency of arrayOfRecords(plan.dependencies)) {
    const from = stringValue(dependency.from);
    const to = stringValue(dependency.to);
    if (from && !taskIds.has(from)) {
      addFinding({
        severity: "BLOCKER",
        category: "dependency",
        message: "Plan dependency references a missing source task.",
        evidence: from,
        recommendation: "Remove the dangling dependency or add the referenced source task.",
      });
    }
    if (to && !taskIds.has(to)) {
      addFinding({
        severity: "BLOCKER",
        category: "dependency",
        message: "Plan dependency references a missing target task.",
        evidence: to,
        recommendation: "Remove the dangling dependency or add the referenced target task.",
      });
    }
  }

  for (const task of tasks) {
    const taskId = stringValue(task.id);
    for (const dependencyId of stringArray(task.dependencies)) {
      if (!taskIds.has(dependencyId)) {
        addFinding({
          severity: "BLOCKER",
          taskId,
          category: "dependency",
          message: "Task dependency references a missing task.",
          evidence: dependencyId,
          recommendation: "Remove the dangling task dependency or add the referenced task.",
        });
      }
    }
  }

  if (tasks.length === 0 && !hasClarificationGate(plan, contextPack)) {
    addFinding({
      severity: "BLOCKER",
      category: "clarification",
      message: "Plan has no tasks but does not include a clarification gate.",
      evidence: "tasks=[]",
      recommendation: "Add executable tasks or include a required clarification gate before execution.",
    });
  }

  for (const task of tasks) {
    if (isUnsafeTask(task) && !hasRequiredGateForTask(plan, stringValue(task.id))) {
      addFinding({
        severity: "BLOCKER",
        taskId: stringValue(task.id),
        category: "approval",
        message: "High-risk or destructive task lacks a required approval gate.",
        evidence: `risk=${stringValue(task.risk) ?? "unknown"}; approvalRequired=${String(task.approvalRequired)}`,
        recommendation: "Add a required approval/checkpoint gate for this task before execution.",
      });
    }
  }

  if (stringValue(plan.riskLevel) === "low" && RISKY_LANGUAGE_PATTERN.test(planText(plan))) {
    addFinding({
      severity: "MAJOR",
      category: "risk",
      message: "Plan-level risk appears underestimated for implementation or destructive language.",
      evidence: `riskLevel=${stringValue(plan.riskLevel)}`,
      recommendation: "Raise the plan risk level or remove implementation/deployment/destructive actions from the plan.",
    });
  }

  for (const task of tasks) {
    if (stringValue(task.risk) === "low" && RISKY_LANGUAGE_PATTERN.test(taskText(task))) {
      addFinding({
        severity: "MAJOR",
        taskId: stringValue(task.id),
        category: "risk",
        message: "Task risk appears underestimated for implementation or destructive language.",
        evidence: `risk=${stringValue(task.risk)}`,
        recommendation: "Raise the task risk level or narrow the task to non-implementation work.",
      });
    }
  }

  for (const reference of unsupportedContextReferences(plan, tasks, contextPack)) {
    addFinding({
      severity: "MAJOR",
      category: "context",
      message: "Plan assumes a file or API that is absent from the context pack.",
      evidence: reference,
      recommendation: "Inspect or retrieve the referenced file/API before relying on it in the plan.",
    });
  }

  const verdict: SkepticReviewVerdict = findings.some((finding) => finding.severity === "BLOCKER")
    ? "BLOCKED"
    : findings.length > 0
      ? "NEEDS_REVISION"
      : "SOUND";

  const reviewedPlanId = stringValue(plan.id);
  const planGoal = stringValue(plan.goal) ?? "unknown plan";

  return SkepticReviewSchema.parse({
    verdict,
    findings,
    reviewedPlanId,
    planGoal,
    createdAt: contextPack?.createdAt ?? "1970-01-01T00:00:00.000Z",
  });
}

function asRecord(value: unknown): RawPlan {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RawPlan) : {};
}

function arrayOfRecords(value: unknown): RawTask[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function hasValidation(value: unknown): boolean {
  const validation = asRecord(value);
  return stringValue(validation.summary) !== undefined && hasValidationArray(validation.checks);
}

function hasValidationArray(value: unknown): boolean {
  return stringArray(value).length > 0;
}

function hasClarificationGate(plan: RawPlan, contextPack?: ContextPack): boolean {
  if (contextPack?.triage.route === "NEEDS_CLARIFICATION") return true;
  return arrayOfRecords(plan.approvalGates).some(
    (gate) => stringValue(gate.type) === "clarification" && gate.required === true
  );
}

function isUnsafeTask(task: RawTask): boolean {
  const risk = stringValue(task.risk);
  return risk === "high" || risk === "destructive" || task.approvalRequired === true;
}

function hasRequiredGateForTask(plan: RawPlan, taskId: string | undefined): boolean {
  return arrayOfRecords(plan.approvalGates).some((gate) => {
    if (gate.required !== true) return false;
    const taskIds = stringArray(gate.taskIds);
    return taskIds.length === 0 || (taskId !== undefined && taskIds.includes(taskId));
  });
}

function unsupportedContextReferences(plan: RawPlan, tasks: RawTask[], contextPack?: ContextPack): string[] {
  if (!contextPack) return [];

  const contextCorpus = contextPackText(contextPack).toLowerCase();
  const candidateText = [stringArray(plan.assumptions).join("\n"), ...tasks.map(taskText)].join("\n");
  const references = new Set([...matches(candidateText, FILE_REFERENCE_PATTERN), ...matches(candidateText, API_REFERENCE_PATTERN)]);

  return [...references].filter((reference) => !contextCorpus.includes(reference.toLowerCase()));
}

function contextPackText(contextPack: ContextPack): string {
  return [
    contextPack.id,
    contextPack.userIntentSummary,
    ...contextPack.constraints,
    ...contextPack.availableProviders.configured,
    ...contextPack.availableProviders.unavailable,
    ...contextPack.availableProviders.notes,
    ...contextPack.availableTools.names,
    ...contextPack.availableTools.notes,
    ...contextPack.artifactHandles.flatMap((artifact) => [artifact.artifactId, artifact.kind, artifact.uri, artifact.summary]),
    ...contextPack.relevantDocs.flatMap((artifact) => [artifact.artifactId, artifact.kind, artifact.uri, artifact.summary]),
    ...contextPack.relevantMemory.flatMap((artifact) => [artifact.artifactId, artifact.kind, artifact.uri, artifact.summary]),
    ...contextPack.inlineContext.flatMap((inline) => [inline.kind, inline.summary, inline.content]),
  ].join("\n");
}

function planText(plan: RawPlan): string {
  return [
    stringValue(plan.goal),
    stringArray(plan.assumptions).join("\n"),
    arrayOfRecords(plan.tasks).map(taskText).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function taskText(task: RawTask): string {
  return [
    stringValue(task.id),
    stringValue(task.title),
    stringValue(task.description),
    stringArray(task.expectedArtifacts).join("\n"),
    stringArray(task.validation).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

function formatEvidence(value: unknown): string {
  if (value === undefined) return "missing";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
