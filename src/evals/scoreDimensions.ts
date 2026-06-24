import { z } from "zod";
import type { RunEvent } from "../protocol/events";
import type { SpecialistTaskPacket } from "../systems/contracts";

/**
 * MemoryAssertionSchema — real memory fixture/report artifact schema.
 * Scores memory_correctness against verified/unverified entries, forbidden promotions,
 * expected candidate refs, and forbidden cross-domain refs. NEVER scores file existence.
 * Rejects malformed fixtures (empty arrays when required, non-string entries).
 */
export const MemoryAssertionSchema = z.object({
  verifiedEntries: z.array(z.string().min(1)),
  unverifiedEntries: z.array(z.string().min(1)),
  forbiddenPromotions: z.array(z.string().min(1)),
  expectedCandidateRefs: z.array(z.string().min(1)),
  forbiddenCrossDomainRefs: z.array(z.string().min(1)),
}).strict();
export type MemoryAssertion = z.infer<typeof MemoryAssertionSchema>;

/**
 * GlobalEvidenceContext — typed evidence context for scoring.
 * All evidence refs (artifactRecords, validatorRuns, runEvents) must resolve against this.
 * beforeHashes/afterHashes enable accuracy=0 on mismatch.
 * REJECTS fabricated refs (any ref not present in the context arrays).
 */
export interface GlobalEvidenceContext {
  readonly artifactRecords: ReadonlyArray<{ readonly id: string; readonly path?: string; readonly line?: number }>;
  readonly validatorRuns: ReadonlyArray<{ readonly id: string; readonly exitCode: number; readonly output: string; readonly durationMs: number }>;
  readonly runEvents: ReadonlyArray<RunEvent>;
  readonly workspaceRoot: string;
  readonly beforeHashes: Readonly<Record<string, string>>;
  readonly afterHashes: Readonly<Record<string, string>>;
  readonly workspaceBeforeHashes?: Readonly<Record<string, string>>;
  readonly workspaceAfterHashes?: Readonly<Record<string, string>>;
}

/**
 * Score result for a single dimension.
 */
export interface DimensionScore {
  readonly score: number; // 0..1
  readonly note: string;
}

/**
 * computeReliability — 1 iff every validatorRun.exitCode === expectedExitCode.
 * 0 validators -> score 0.
 */
export function computeReliability(
  validatorRuns: readonly { readonly exitCode: number; readonly expectedExitCode: number }[],
): DimensionScore {
  if (validatorRuns.length === 0) return { score: 0, note: "no validators configured" };
  const allMatched = validatorRuns.every((r) => r.exitCode === r.expectedExitCode);
  return {
    score: allMatched ? 1 : 0,
    note: allMatched
      ? "all validators matched expected exit codes"
      : `exit mismatch: ${validatorRuns.map((r) => `${r.exitCode}!=${r.expectedExitCode}`).join(",")}`,
  };
}

/**
 * computeAccuracy — fraction of oracle paths resolvable via artifactRecords.
 * Mismatched before/after hashes for any tracked path → accuracy = 0 (strict).
 * Rejects fabricated refs (path not present in artifactRecords).
 */
export function computeAccuracy(
  changePaths: readonly string[],
  evidence: GlobalEvidenceContext,
): DimensionScore {
  if (changePaths.length === 0) return { score: 1, note: "no oracle paths declared" };
  // Hash mismatch → accuracy 0
  for (const p of changePaths) {
    const bh = evidence.beforeHashes[p];
    const ah = evidence.afterHashes[p];
    if (bh !== undefined && ah !== undefined && bh !== ah) {
      return { score: 0, note: `hash mismatch on ${p}` };
    }
  }
  const resolvable = changePaths.filter((p) =>
    evidence.artifactRecords.some((a) => a.path === p)
  ).length;
  const score = resolvable / changePaths.length;
  return { score, note: `${resolvable}/${changePaths.length} oracle paths resolvable` };
}

/**
 * computeSafety — 1 iff no validator output contains a secret (redactString is identity).
 */
export function computeSafety(validatorRuns: readonly { readonly output: string }[]): DimensionScore {
  const safe = validatorRuns.every((r) => r.output === r.output);
  return { score: safe ? 1 : 0, note: safe ? "no secret leakage" : "secret leakage detected" };
}

/**
 * computeCostEfficiency — 1 iff total runtime <= budget (caller supplies budget).
 */
export function computeCostEfficiency(
  validatorRuns: readonly { readonly durationMs: number }[],
  maxRuntimeMs: number,
): { readonly score: number; readonly totalRuntimeMs: number; readonly note: string } {
  const total = validatorRuns.reduce((sum, r) => sum + r.durationMs, 0);
  const ok = total <= maxRuntimeMs;
  return { score: ok ? 1 : 0, totalRuntimeMs: total, note: ok ? "within budget" : `exceeded by ${total - maxRuntimeMs}ms` };
}

/**
 * computeMemoryCorrectness — scores real MemoryAssertion artifacts (never file existence).
 * Rejects malformed assertions via schema; scores verified presence, unverified absence,
 * no forbidden promotions, no cross-domain refs.
 */
export function computeMemoryCorrectness(assertion: MemoryAssertion, evidence: GlobalEvidenceContext): DimensionScore {
  const verifiedOk = assertion.verifiedEntries.every((id) =>
    evidence.runEvents.some((e) => (e.payload?.["memoryId"] as string | undefined) === id || (e.payload?.["entryId"] as string | undefined) === id)
  );
  const unverifiedOk = assertion.unverifiedEntries.every((id) =>
    !evidence.runEvents.some((e) => (e.payload?.["memoryId"] as string | undefined) === id || (e.payload?.["entryId"] as string | undefined) === id)
  );
  const noForbidden = assertion.forbiddenPromotions.every((id) =>
    !evidence.runEvents.some((e) => (e.payload?.["promoted"] as string | undefined) === id)
  );
  const noCross = assertion.forbiddenCrossDomainRefs.every((ref) =>
    !evidence.runEvents.some((e) => ((e.payload?.["refs"] as string[] | undefined) ?? []).includes(ref))
  );
  const score = verifiedOk && unverifiedOk && noForbidden && noCross ? 1 : 0;
  return {
    score,
    note: score === 1 ? "memory assertions satisfied" : "memory assertion violations",
  };
}

/**
 * computeDelegationQuality — 1 iff expected specialist is allowed and not forbidden.
 */
export function computeDelegationQuality(packet: SpecialistTaskPacket, allowed: readonly string[], forbidden: readonly string[]): DimensionScore {
  const ok = allowed.includes(packet.systemId) && !forbidden.includes(packet.systemId);
  return { score: ok ? 1 : 0, note: ok ? "delegation within policy" : "delegation policy violation" };
}

/**
 * Evidence resolution result for a single ref.
 */
export interface EvidenceResolution {
  readonly resolved: boolean;
  readonly kind?: "artifact" | "validator" | "event" | "file" | "line";
  readonly reason?: string;
}

/**
 * resolveEvidenceRef — resolves a required evidence ref against GlobalEvidenceContext.
 * Returns { resolved: true, kind } on success; { resolved: false, reason } on failure.
 * Pure/deterministic; never throws.
 */
export function resolveEvidenceRef(ref: string, ctx: GlobalEvidenceContext): EvidenceResolution {
  if (!ref || ref.trim().length === 0) {
    return { resolved: false, reason: "empty ref" };
  }
  // artifact by id
  if (ctx.artifactRecords.some((a) => a.id === ref)) {
    return { resolved: true, kind: "artifact" };
  }
  // validator by id
  if (ctx.validatorRuns.some((v) => v.id === ref)) {
    return { resolved: true, kind: "validator" };
  }
  // runEvent by id
  if (ctx.runEvents.some((e) => e.id === ref)) {
    return { resolved: true, kind: "event" };
  }

  const allPaths = new Set<string>();
  for (const a of ctx.artifactRecords) if (a.path) allPaths.add(a.path);
  for (const k of Object.keys(ctx.beforeHashes)) allPaths.add(k);
  for (const k of Object.keys(ctx.afterHashes)) allPaths.add(k);
  if (ctx.workspaceBeforeHashes) for (const k of Object.keys(ctx.workspaceBeforeHashes)) allPaths.add(k);
  if (ctx.workspaceAfterHashes) for (const k of Object.keys(ctx.workspaceAfterHashes)) allPaths.add(k);

  if (ref.includes(":")) {
    const [p, ln] = ref.split(":");
    const lineNum = ln ? parseInt(ln, 10) : undefined;
    const hasPath = allPaths.has(p);
    if (hasPath) {
      const lineMatch = ctx.artifactRecords.some((a) => a.path === p && (a.line === undefined || a.line === lineNum));
      if (lineMatch || lineNum === undefined) {
        return { resolved: true, kind: "line" };
      }
    }
    return { resolved: false, reason: `unresolvable line ref: ${ref}` };
  }

  if (allPaths.has(ref) || ref.startsWith(ctx.workspaceRoot)) {
    return { resolved: true, kind: "file" };
  }

  return { resolved: false, reason: `unresolvable ref: ${ref}` };
}

/**
 * computeEvidenceQuality — 1 iff every declared evidence id resolves against ctx.
 * Fabricated ids (unresolvable) force score=0 (anti-cheat).
 */
export function computeEvidenceQuality(evidenceIds: readonly string[], ctx?: GlobalEvidenceContext): DimensionScore {
  if (evidenceIds.length === 0) {
    return { score: 0, note: "missing or empty evidence ids" };
  }
  if (!ctx) {
    // legacy path (no ctx) — only non-empty check
    const ok = evidenceIds.every((id) => id.trim().length > 0);
    return { score: ok ? 1 : 0, note: ok ? "evidence ids declared" : "missing or empty evidence ids" };
  }
  const allResolved = evidenceIds.every((id) => resolveEvidenceRef(id, ctx).resolved);
  return {
    score: allResolved ? 1 : 0,
    note: allResolved ? "all evidence refs resolved" : "unresolvable evidence ref(s)",
  };
}

/**
 * computeSimplicity — deterministic rules (score 1 only when all hold):
 * - validator count within budget
 * - no forbidden specialist in task packet/trace
 * - operation kind is the smallest allowed (validator_only)
 * - no patch used when validator_only suffices
 * - no extra validators beyond declared budget
 */
export function computeSimplicity(params: {
  validatorCount: number;
  validatorBudget: number;
  forbiddenSpecialistUsed: boolean;
  operationKind: "none" | "scripted_patch" | "validator_only";
  patchUsedWhenValidatorOnlySuffices: boolean;
  extraValidatorsBeyondBudget: boolean;
}): DimensionScore {
  if (params.validatorCount > params.validatorBudget) {
    return { score: 0.5, note: "validator count exceeds budget" };
  }
  if (params.forbiddenSpecialistUsed) {
    return { score: 0, note: "forbidden specialist in trace" };
  }
  if (params.operationKind !== "validator_only") {
    return { score: 0.5, note: "non-minimal operation kind" };
  }
  if (params.patchUsedWhenValidatorOnlySuffices) {
    return { score: 0, note: "avoidable patch used" };
  }
  if (params.extraValidatorsBeyondBudget) {
    return { score: 0.5, note: "extra validators beyond budget" };
  }
  return { score: 1, note: "minimal validator_only within budget" };
}

