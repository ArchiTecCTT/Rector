import { z } from "zod";
import { OrchestrationRoleSchema } from "../providers/orchestrationAssignments";
import { MemoryRoleSchema } from "../providers/memoryAssignments";

const NonEmptyStringSchema = z.string().min(1);
const OptionalNoteSchema = z.string().max(1000).optional();

function isLocalProviderToken(value: string | undefined): boolean {
  if (!value) return true;
  return value === "deterministic" || value === "disabled" || value === "local" || value.startsWith("local");
}

export const TEMPLATE_SCHEMA_VERSION = "rector.template.v1" as const;

export const TemplateRiskLevelSchema = z.enum(["local", "low", "medium", "high"]);
export type TemplateRiskLevel = z.infer<typeof TemplateRiskLevelSchema>;

export const TemplateCostTierSchema = z.enum(["free", "low", "medium", "high"]);
export type TemplateCostTier = z.infer<typeof TemplateCostTierSchema>;

export const TemplateOrchestrationProviderSchema = z.union([
  z.literal("deterministic"),
  z.literal("disabled"),
  NonEmptyStringSchema,
]);

export const TemplateOrchestrationAssignmentSchema = z
  .object({
    role: OrchestrationRoleSchema,
    providerId: TemplateOrchestrationProviderSchema,
    modelId: NonEmptyStringSchema.optional(),
    fallbackProviderId: TemplateOrchestrationProviderSchema.optional(),
    fallbackModelId: NonEmptyStringSchema.optional(),
    enabled: z.boolean(),
    maxUsdPerCall: z.number().nonnegative().finite().optional(),
    maxTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    requiresJsonMode: z.boolean().optional(),
    requiresToolCalling: z.boolean().optional(),
    requiresStreaming: z.boolean().optional(),
    notes: OptionalNoteSchema,
  })
  .strict();
export type TemplateOrchestrationAssignment = z.infer<typeof TemplateOrchestrationAssignmentSchema>;

export const TemplateMemoryProviderSchema = z.union([
  z.literal("local"),
  z.literal("disabled"),
  NonEmptyStringSchema,
]);

export const TemplateMemoryAssignmentSchema = z
  .object({
    role: MemoryRoleSchema,
    providerRecordId: TemplateMemoryProviderSchema,
    providerKind: NonEmptyStringSchema.optional(),
    enabled: z.boolean(),
    readPriority: z.number().int().nonnegative().optional(),
    writePriority: z.number().int().nonnegative().optional(),
    fallbackProviderRecordId: TemplateMemoryProviderSchema.optional(),
    retentionPolicy: z.enum(["ephemeral", "session", "durable", "longTerm"]).optional(),
    maxEntries: z.number().int().positive().optional(),
    maxUsdPerDay: z.number().nonnegative().finite().optional(),
    notes: OptionalNoteSchema,
  })
  .strict();
export type TemplateMemoryAssignment = z.infer<typeof TemplateMemoryAssignmentSchema>;

export const TemplateModuleToggleSchema = z
  .object({
    moduleId: NonEmptyStringSchema,
    enabled: z.boolean(),
    notes: OptionalNoteSchema,
  })
  .strict();
export type TemplateModuleToggle = z.infer<typeof TemplateModuleToggleSchema>;

export const TemplateSandboxPolicySchema = z
  .object({
    mode: z.enum(["fake", "local-safe", "e2b", "disabled"]),
    network: z.enum(["disabled", "allowlisted", "enabled"]),
    allowlist: z.array(NonEmptyStringSchema).default([]),
    requireApprovalFor: z.array(NonEmptyStringSchema).default([]),
    notes: OptionalNoteSchema,
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.network === "enabled" && policy.mode !== "e2b") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message: "unrestricted network is only allowed with an explicitly external sandbox mode",
      });
    }
  });
export type TemplateSandboxPolicy = z.infer<typeof TemplateSandboxPolicySchema>;

export const TemplateBudgetPolicySchema = z
  .object({
    estimatedCostTier: TemplateCostTierSchema,
    maxUsdPerRun: z.number().nonnegative().finite().optional(),
    maxUsdPerDay: z.number().nonnegative().finite().optional(),
    maxUsdPerMonth: z.number().nonnegative().finite().optional(),
    maxPonderUsdPerDay: z.number().nonnegative().finite().optional(),
    notes: OptionalNoteSchema,
  })
  .strict()
  .superRefine((budget, ctx) => {
    if (budget.maxUsdPerRun !== undefined && budget.maxUsdPerDay !== undefined && budget.maxUsdPerRun > budget.maxUsdPerDay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxUsdPerRun"],
        message: "maxUsdPerRun must not exceed maxUsdPerDay",
      });
    }
    if (budget.maxUsdPerDay !== undefined && budget.maxUsdPerMonth !== undefined && budget.maxUsdPerDay > budget.maxUsdPerMonth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxUsdPerDay"],
        message: "maxUsdPerDay must not exceed maxUsdPerMonth",
      });
    }
  });
export type TemplateBudgetPolicy = z.infer<typeof TemplateBudgetPolicySchema>;

export const TemplateSkillPolicySchema = z
  .object({
    enabledTags: z.array(NonEmptyStringSchema).default([]),
    plannerGuidance: OptionalNoteSchema,
  })
  .strict();
export type TemplateSkillPolicy = z.infer<typeof TemplateSkillPolicySchema>;

export const RectorTemplateSchema = z
  .object({
    schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    author: NonEmptyStringSchema.optional(),
    tags: z.array(NonEmptyStringSchema),
    intendedUse: z.array(NonEmptyStringSchema),
    riskLevel: TemplateRiskLevelSchema,
    orchestrationAssignments: z.array(TemplateOrchestrationAssignmentSchema),
    memoryAssignments: z.array(TemplateMemoryAssignmentSchema),
    moduleToggles: z.array(TemplateModuleToggleSchema).optional(),
    sandboxPolicy: TemplateSandboxPolicySchema.optional(),
    budgets: TemplateBudgetPolicySchema.optional(),
    skillPolicy: TemplateSkillPolicySchema.optional(),
    requiredProviderKinds: z.array(NonEmptyStringSchema).optional(),
    requiredCapabilities: z.array(NonEmptyStringSchema).optional(),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((template, ctx) => {
    const orchestrationRoles = new Set<string>();
    for (const [index, assignment] of template.orchestrationAssignments.entries()) {
      if (orchestrationRoles.has(assignment.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["orchestrationAssignments", index, "role"],
          message: `duplicate orchestration role ${assignment.role}`,
        });
      }
      orchestrationRoles.add(assignment.role);
    }

    const memoryRoles = new Set<string>();
    for (const [index, assignment] of template.memoryAssignments.entries()) {
      if (memoryRoles.has(assignment.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memoryAssignments", index, "role"],
          message: `duplicate memory role ${assignment.role}`,
        });
      }
      memoryRoles.add(assignment.role);
    }

    if (template.riskLevel === "local") {
      const externalRequirements = template.requiredProviderKinds?.filter((kind) => !isLocalProviderToken(kind)) ?? [];
      if (externalRequirements.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredProviderKinds"],
          message: "local templates must not require external providers",
        });
      }

      for (const [index, assignment] of template.orchestrationAssignments.entries()) {
        if (!isLocalProviderToken(assignment.providerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["orchestrationAssignments", index, "providerId"],
            message: "local templates must not assign external orchestration providers",
          });
        }
        if (!isLocalProviderToken(assignment.fallbackProviderId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["orchestrationAssignments", index, "fallbackProviderId"],
            message: "local templates must not assign external orchestration fallback providers",
          });
        }
      }

      for (const [index, assignment] of template.memoryAssignments.entries()) {
        if (!isLocalProviderToken(assignment.providerRecordId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["memoryAssignments", index, "providerRecordId"],
            message: "local templates must not assign external memory providers",
          });
        }
        if (!isLocalProviderToken(assignment.fallbackProviderRecordId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["memoryAssignments", index, "fallbackProviderRecordId"],
            message: "local templates must not assign external memory fallback providers",
          });
        }
        if (!isLocalProviderToken(assignment.providerKind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["memoryAssignments", index, "providerKind"],
            message: "local templates must not assign external memory provider kinds",
          });
        }
      }

      if (template.sandboxPolicy?.network !== undefined && template.sandboxPolicy.network !== "disabled") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sandboxPolicy", "network"],
          message: "local templates must disable sandbox network access",
        });
      }
      if (template.budgets?.estimatedCostTier !== undefined && template.budgets.estimatedCostTier !== "free") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["budgets", "estimatedCostTier"],
          message: "local templates must be free cost tier",
        });
      }
    }
  });
export type RectorTemplate = z.infer<typeof RectorTemplateSchema>;

export interface TemplateValidationIssue {
  path: string;
  message: string;
}

export interface TemplateValidationResult {
  ok: boolean;
  issues: TemplateValidationIssue[];
}

export function validateRectorTemplate(input: unknown): TemplateValidationResult {
  const parsed = RectorTemplateSchema.safeParse(input);
  if (parsed.success) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join(".") || "template",
      message: issue.message,
    })),
  };
}

export function parseRectorTemplate(input: unknown): RectorTemplate {
  return RectorTemplateSchema.parse(input);
}
