import crypto from "node:crypto";
import { z } from "zod";
import { redactSecrets, redactString } from "../security/redaction";
import type { ContextPack } from "./contextBuilder";

export const PromptTierNameSchema = z.enum(["stable", "context", "volatile"]);

export const PromptTierBudgetSchema = z.object({
  maxStableChars: z.number().int().positive().default(4_000),
  maxContextChars: z.number().int().positive().default(12_000),
  maxVolatileChars: z.number().int().positive().default(2_000),
});
export type PromptTierBudget = z.infer<typeof PromptTierBudgetSchema>;

export const DEFAULT_PROMPT_TIER_BUDGET: PromptTierBudget = PromptTierBudgetSchema.parse({});

export const PromptTierBundleSchema = z.object({
  stable: z.string(),
  stableHash: z.string().min(64).max(64),
  context: z.string(),
  volatile: z.string(),
  assembledAt: z.string().datetime(),
  tierBudget: PromptTierBudgetSchema,
  contextBytes: z.number().int().nonnegative(),
  volatileBytes: z.number().int().nonnegative(),
});
export type PromptTierBundle = z.infer<typeof PromptTierBundleSchema>;

export interface StableTierInput {
  role: string;
  systemRules: string;
  jsonContract?: string;
  productIdentity?: string;
}

export interface ContextTierInput {
  contextPack?: ContextPack;
  contextText?: string;
  approvedSkillSummaries?: string[];
  tierBudget?: Partial<PromptTierBudget>;
}

export interface VolatileTierInput {
  now?: () => string;
  phase?: string;
  task?: string;
  activeTemplateId?: string;
  budgetRemaining?: Record<string, unknown>;
}

export interface AssemblePromptTiersInput {
  stable: StableTierInput;
  context?: ContextTierInput;
  volatile?: VolatileTierInput;
  tierBudget?: Partial<PromptTierBudget>;
}

const stableHashesByRun = new Map<string, string>();

export function buildStableTier(input: StableTierInput, budget: Partial<PromptTierBudget> = {}): string {
  const tierBudget = PromptTierBudgetSchema.parse({ ...DEFAULT_PROMPT_TIER_BUDGET, ...budget });
  const productIdentity =
    input.productIdentity ??
    [
      "Product: Rector configured orchestration.",
      "Rector uses a single symbolic brainstem: triage, context, planning, skeptic, crucible, DAG, execution, validation, healing, synthesis.",
      "The product is configured orchestration, not provider-free fake chat.",
      "Never expose secrets, API keys, credentials, tokens, or raw environment values.",
    ].join("\n");

  return capText(
    [
      "[stable tier]",
      `Role: ${redactString(input.role)}`,
      productIdentity,
      "",
      redactString(input.systemRules),
      input.jsonContract ? `\n${redactString(input.jsonContract)}` : "",
    ].join("\n"),
    tierBudget.maxStableChars,
  );
}

export function buildContextTier(input: ContextTierInput = {}): string {
  const tierBudget = PromptTierBudgetSchema.parse({
    ...DEFAULT_PROMPT_TIER_BUDGET,
    ...(input.tierBudget ?? {}),
  });
  return capText(buildRawContextTier(input), tierBudget.maxContextChars);
}

export function measureContextTierChars(input: ContextTierInput = {}): number {
  return buildRawContextTier(input).length;
}

export function buildVolatileTier(input: VolatileTierInput = {}, budget: Partial<PromptTierBudget> = {}): string {
  const tierBudget = PromptTierBudgetSchema.parse({ ...DEFAULT_PROMPT_TIER_BUDGET, ...budget });
  const assembledAt = input.now?.() ?? new Date().toISOString();
  const payload = redactSecrets({
    assembledAt,
    phase: input.phase,
    task: input.task,
    activeTemplateId: input.activeTemplateId,
    budgetRemaining: input.budgetRemaining,
  });
  return capText(["[volatile tier]", JSON.stringify(payload, null, 2)].join("\n"), tierBudget.maxVolatileChars);
}

export function assemblePromptTiers(input: AssemblePromptTiersInput): PromptTierBundle {
  const tierBudget = PromptTierBudgetSchema.parse({
    ...DEFAULT_PROMPT_TIER_BUDGET,
    ...(input.tierBudget ?? {}),
  });
  const assembledAt = input.volatile?.now?.() ?? new Date().toISOString();
  const stable = buildStableTier(input.stable, tierBudget);
  const context = buildContextTier({ ...(input.context ?? {}), tierBudget });
  const volatile = buildVolatileTier({ ...(input.volatile ?? {}), now: () => assembledAt }, tierBudget);

  return PromptTierBundleSchema.parse({
    stable,
    stableHash: sha256(stable),
    context,
    volatile,
    assembledAt,
    tierBudget,
    contextBytes: Buffer.byteLength(context, "utf8"),
    volatileBytes: Buffer.byteLength(volatile, "utf8"),
  });
}

export function joinPromptTiers(bundle: PromptTierBundle): string {
  return [bundle.stable, bundle.context, bundle.volatile].filter((part) => part.trim().length > 0).join("\n\n---\n\n");
}

export function assertStableTierUnchanged(runId: string, priorHash: string | undefined, currentHash: string): void {
  const remembered = priorHash ?? stableHashesByRun.get(runId);
  if (remembered && remembered !== currentHash) {
    throw new Error(`Stable prompt tier mutation blocked for run ${redactString(runId)}`);
  }
  stableHashesByRun.set(runId, currentHash);
}

export function rememberStableTierHashForRun(runId: string, stableHash: string): void {
  assertStableTierUnchanged(runId, stableHashesByRun.get(runId), stableHash);
}

export function getStableTierHashForRun(runId: string): string | undefined {
  return stableHashesByRun.get(runId);
}

export function clearStableTierHashForRun(runId: string): void {
  stableHashesByRun.delete(runId);
}

function buildRawContextTier(input: ContextTierInput): string {
  const sections: string[] = ["[context tier]"];
  if (input.contextText) sections.push(redactString(input.contextText));
  if (input.contextPack) {
    sections.push(JSON.stringify(contextPackForTier(input.contextPack), null, 2));
  }
  if (input.approvedSkillSummaries?.length) {
    sections.push(
      JSON.stringify(
        { approvedSkills: input.approvedSkillSummaries.map((summary) => redactString(summary)) },
        null,
        2,
      ),
    );
  }
  return sections.join("\n");
}

function contextPackForTier(contextPack: ContextPack): Record<string, unknown> {
  return redactSecrets({
    contextPackId: contextPack.id,
    userIntentSummary: contextPack.userIntentSummary,
    constraints: contextPack.constraints,
    riskFlags: contextPack.riskFlags,
    relevantDocs: contextPack.relevantDocs.map((doc) => ({
      kind: doc.kind,
      summary: doc.summary,
      status: doc.status,
      rankScore: doc.rankScore,
    })),
    relevantMemory: contextPack.relevantMemory.map((memory) => ({
      kind: memory.kind,
      summary: memory.summary,
      status: memory.status,
      rankScore: memory.rankScore,
    })),
    artifactHandles: contextPack.artifactHandles.map((handle) => ({
      kind: handle.kind,
      uri: handle.uri,
      summary: handle.summary,
    })),
    inlineContext: contextPack.inlineContext.map((entry) => ({
      kind: entry.kind,
      summary: entry.summary,
      contentPreview: entry.content.slice(0, 500),
    })),
    memoryContext: contextPack.memoryContext,
    availableTools: contextPack.availableTools,
    availableProviders: {
      configured: contextPack.availableProviders.configured,
      unavailable: contextPack.availableProviders.unavailable,
      notes: contextPack.availableProviders.notes,
    },
  });
}

function capText(value: string, maxChars: number): string {
  const redacted = redactString(value);
  if (redacted.length <= maxChars) return redacted;
  if (maxChars <= 3) return redacted.slice(0, maxChars);
  return `${redacted.slice(0, maxChars - 3)}...`;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
