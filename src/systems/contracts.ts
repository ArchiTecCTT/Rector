import { z } from "zod";

/**
 * Specialist system contracts (Phase 0.5, Todo 3).
 *
 * These Zod schemas mirror the `SpecialistSystemContract`, `SpecialistTaskPacket`, and
 * `SystemResultPacket` TypeScript shapes in the source production plan
 * (rector_capability_slm_fabric_production_plan.md lines 352-407). They are CONTRACTS ONLY:
 * no routing, no execution, no model calls. Routing/execution arrive in Phase 11/12.
 *
 * Modeling choices for the plan's opaque/named types (documented per the brief — kept minimal
 * and honest, not invented rich fields):
 *   - `JsonSchema` (inputSchema/outputSchema): the plan references a JSON-schema document. We do
 *     NOT pull in a full JSON-Schema meta-schema here; we model it as an open object
 *     (`z.record(z.unknown())`) — a JsonSchema placeholder. Deep JSON-Schema validation is a
 *     later concern; at this contract layer we only assert "an object-shaped schema doc".
 *   - `SpecialistMemoryProfile`: the plan stresses specialists hold *local skill memory*, NOT
 *     global identity memory (plan lines 411-424). We capture that boundary as a strict object
 *     { scope, remembers[], forbids[] } where `scope` is "local_skill" | "scoped_packet"
 *     (skill-local by default; "scoped_packet" = only what Rector explicitly hands over).
 *   - `ApprovalPolicy`: minimal strict object { mode } with mode "never" | "on_risk" | "always".
 *   - `BudgetPolicy` / TaskPacket.budget: strict object with all-optional caps
 *     { maxUsd?, maxRuntimeMs?, maxToolCalls? }.
 *   - `ChangeSetSummary`: optional strict object { changedPaths[], additions?, deletions? }.
 *   - `MemoryPatchCandidate`: strict object { kind, content, evidenceRef? } — a candidate memory
 *     write the specialist proposes; promotion is decided later by Rector's MemoryGate, so this is
 *     deliberately a thin proposal record, not a committed memory.
 */

const NonEmptyString = z.string().min(1);
const StringArray = z.array(z.string());

/** Domains a specialist system can own (plan line 357). */
export const SpecialistDomainSchema = z.enum([
  "coding",
  "research",
  "writing",
  "math",
  "science",
  "design",
  "operations",
  "voice",
]);
export type SpecialistDomain = z.infer<typeof SpecialistDomainSchema>;

/** Risk class of a specialist system (plan line 366). */
export const SpecialistRiskProfileSchema = z.enum(["low", "medium", "high", "destructive"]);
export type SpecialistRiskProfile = z.infer<typeof SpecialistRiskProfileSchema>;

/** Admission stage gating how much a specialist is trusted (plan line 370). */
export const SpecialistAdmissionSchema = z.enum([
  "draft",
  "shadow",
  "experimental",
  "trusted",
  "quarantined",
]);
export type SpecialistAdmission = z.infer<typeof SpecialistAdmissionSchema>;

/**
 * JsonSchema placeholder. The plan's `inputSchema`/`outputSchema` are JSON-Schema documents; at
 * the contract layer we model them as open objects rather than a full meta-schema.
 */
export const JsonSchemaPlaceholderSchema = z.record(z.unknown());
export type JsonSchemaPlaceholder = z.infer<typeof JsonSchemaPlaceholderSchema>;

/**
 * Specialist memory profile — intentionally smaller than Rector's identity memory.
 * `scope`: "local_skill" = skill-local episodic/procedural memory; "scoped_packet" = only memory
 * Rector explicitly hands over in a scoped packet. `remembers`/`forbids` enumerate the boundary.
 */
export const SpecialistMemoryProfileSchema = z
  .object({
    scope: z.enum(["local_skill", "scoped_packet"]),
    remembers: StringArray,
    forbids: StringArray,
  })
  .strict();
export type SpecialistMemoryProfile = z.infer<typeof SpecialistMemoryProfileSchema>;

/** Approval policy: when a human/Rector approval gate fires. */
export const ApprovalPolicySchema = z
  .object({
    mode: z.enum(["never", "on_risk", "always"]),
  })
  .strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

/** Budget caps; all optional (absence = no explicit cap at this layer). */
export const BudgetPolicySchema = z
  .object({
    maxUsd: z.number().nonnegative().optional(),
    maxRuntimeMs: z.number().int().nonnegative().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

/**
 * SpecialistSystemContract (plan lines 351-371). Declares one specialist system's identity,
 * domain, typed I/O, capabilities, validators, memory boundary, risk/approval/budget policy,
 * eval suites, and admission stage.
 */
export const SpecialistSystemContractSchema = z
  .object({
    schemaVersion: z.literal("rector.specialist-system.v1"),
    systemId: NonEmptyString,
    domain: SpecialistDomainSchema,
    purpose: NonEmptyString,
    inputSchema: JsonSchemaPlaceholderSchema,
    outputSchema: JsonSchemaPlaceholderSchema,
    supportedTaskKinds: StringArray,
    capabilityRefs: StringArray,
    validatorRefs: StringArray,
    memoryProfile: SpecialistMemoryProfileSchema,
    riskProfile: SpecialistRiskProfileSchema,
    approvalPolicy: ApprovalPolicySchema,
    budgetPolicy: BudgetPolicySchema,
    evalSuiteRefs: StringArray,
    admission: SpecialistAdmissionSchema,
  })
  .strict();
export type SpecialistSystemContract = z.infer<typeof SpecialistSystemContractSchema>;

/**
 * SpecialistTaskPacket (plan lines 375-389). The typed work order Rector sends a specialist:
 * goal, success criteria, scope fences, memory packet refs, capability hints, validation
 * requirements, budget, and a risk tolerance.
 */
export const SpecialistTaskPacketSchema = z
  .object({
    taskId: NonEmptyString,
    systemId: NonEmptyString,
    userGoal: NonEmptyString,
    successCriteria: StringArray,
    constraints: StringArray,
    allowedScopes: StringArray,
    forbiddenScopes: StringArray,
    memoryPacketRefs: StringArray,
    capabilityHints: StringArray,
    validationRequirements: StringArray,
    budget: BudgetPolicySchema,
    riskTolerance: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type SpecialistTaskPacket = z.infer<typeof SpecialistTaskPacketSchema>;

/**
 * ChangeSetSummary — optional summary of file changes a specialist produced.
 * Minimal honest shape: which paths changed plus optional line counts.
 */
export const ChangeSetSummarySchema = z
  .object({
    changedPaths: StringArray,
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ChangeSetSummary = z.infer<typeof ChangeSetSummarySchema>;

/**
 * MemoryPatchCandidate — a memory write the specialist PROPOSES. Promotion is decided later by
 * Rector's MemoryGate (plan line 256), so this is a thin proposal: a kind, the content, and an
 * optional evidence reference backing it.
 */
export const MemoryPatchCandidateSchema = z
  .object({
    kind: NonEmptyString,
    content: NonEmptyString,
    evidenceRef: NonEmptyString.optional(),
  })
  .strict();
export type MemoryPatchCandidate = z.infer<typeof MemoryPatchCandidateSchema>;

/** Cost accounting returned with every result (plan line 405). */
export const SystemResultCostSchema = z
  .object({
    usd: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    runtimeMs: z.number().int().nonnegative(),
  })
  .strict();
export type SystemResultCost = z.infer<typeof SystemResultCostSchema>;

/**
 * SystemResultPacket (plan lines 393-406). What a specialist returns: status, summary, evidence/
 * artifact/validation refs, optional change set, uncertainty, follow-up questions, proposed memory
 * candidates, and cost accounting.
 */
export const SystemResultPacketSchema = z
  .object({
    taskId: NonEmptyString,
    systemId: NonEmptyString,
    status: z.enum(["succeeded", "needs_decision", "failed", "partial"]),
    summary: z.string(),
    evidenceRefs: StringArray,
    artifactRefs: StringArray,
    validationRefs: StringArray,
    changes: ChangeSetSummarySchema.optional(),
    uncertainty: StringArray,
    followUpQuestions: StringArray,
    memoryCandidates: z.array(MemoryPatchCandidateSchema),
    cost: SystemResultCostSchema,
  })
  .strict();
export type SystemResultPacket = z.infer<typeof SystemResultPacketSchema>;

/**
 * Structured validation result for a SystemResultPacket: a discriminated union so callers can
 * branch on `ok` without throwing. On failure, `error` is the ZodError from safeParse so callers
 * get field-level paths (e.g. which member was missing/invalid).
 */
export type ValidateSystemResultPacketOutcome =
  | { readonly ok: true; readonly value: SystemResultPacket }
  | { readonly ok: false; readonly error: z.ZodError };

/**
 * Validate an unknown value as a SystemResultPacket. Returns a typed-result-or-structured-error
 * instead of throwing, so the consuming runner (Todo 6) and registry (Todo 7) can handle invalid
 * specialist output deterministically.
 */
export function validateSystemResultPacket(value: unknown): ValidateSystemResultPacketOutcome {
  const parsed = SystemResultPacketSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return { ok: false, error: parsed.error };
}
