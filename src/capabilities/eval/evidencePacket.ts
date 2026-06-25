import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION = "rector.capability.evidence.v1";

const NonEmptyTextSchema = z.string().min(1);

export const CapabilityEvidenceKindSchema = z.enum([
  "code_reference",
  "log_excerpt",
  "diagnostic",
  "diff_hunk",
  "summary",
  "warning",
]);

export const CapabilityEvidenceRelevanceSchema = z.enum(["low", "medium", "high"]);

// A line range is a pair: lineStart and lineEnd must both be present or both absent, and when
// both are present lineEnd must be >= lineStart (a positive, well-ordered range).
export const CapabilityEvidenceItemSchema = z
  .object({
    kind: CapabilityEvidenceKindSchema,
    path: NonEmptyTextSchema.optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    symbol: NonEmptyTextSchema.optional(),
    excerpt: NonEmptyTextSchema.optional(),
    relevance: CapabilityEvidenceRelevanceSchema,
    confidence: z.number().min(0).max(1),
    rawArtifactRef: NonEmptyTextSchema,
  })
  .strict()
  .refine(lineRangePaired, {
    message: "lineStart and lineEnd must both be present or both absent",
    path: ["lineStart"],
  })
  .refine(lineRangeOrdered, {
    message: "lineEnd must be >= lineStart",
    path: ["lineEnd"],
  });

export const CapabilityCoverageSchema = z
  .object({
    coveredMustContain: z.array(NonEmptyTextSchema),
    missingMustContain: z.array(NonEmptyTextSchema),
    forbiddenHits: z.array(NonEmptyTextSchema),
    unresolvedArtifactRefs: z.array(NonEmptyTextSchema),
    unresolvedFileRefs: z.array(NonEmptyTextSchema),
    outOfBoundsLineRefs: z.array(NonEmptyTextSchema),
    passed: z.boolean(),
  })
  .strict();

export const CapabilityEvidencePacketSchema = z
  .object({
    schemaVersion: z.literal(CAPABILITY_EVIDENCE_PACKET_SCHEMA_VERSION),
    capabilityId: NonEmptyTextSchema,
    caseId: NonEmptyTextSchema.optional(),
    summary: NonEmptyTextSchema,
    evidence: z.array(CapabilityEvidenceItemSchema),
    coverage: CapabilityCoverageSchema,
    warnings: z.array(NonEmptyTextSchema).default([]),
    rawArtifactRefs: z.array(NonEmptyTextSchema),
  })
  .strict();

export type CapabilityEvidenceItem = Readonly<z.infer<typeof CapabilityEvidenceItemSchema>>;
export type CapabilityEvidenceKind = z.infer<typeof CapabilityEvidenceKindSchema>;
export type CapabilityEvidenceRelevance = z.infer<typeof CapabilityEvidenceRelevanceSchema>;
export type CapabilityCoverage = Readonly<z.infer<typeof CapabilityCoverageSchema>>;
export type CapabilityEvidencePacket = Readonly<z.infer<typeof CapabilityEvidencePacketSchema>>;

export interface EvidenceCoverageOracle {
  readonly mustContain: readonly string[];
  readonly mustNotContain: readonly string[];
}

export interface EvidenceCoverageContext {
  readonly rawArtifactRefs: ReadonlySet<string>;
  readonly fixtureRoot?: string;
}

export type EvidenceCoverageResult = {
  readonly passed: boolean;
  readonly coverage: CapabilityCoverage;
};

function lineRangePaired(item: { readonly lineStart?: number; readonly lineEnd?: number }): boolean {
  return (item.lineStart === undefined) === (item.lineEnd === undefined);
}

function lineRangeOrdered(item: { readonly lineStart?: number; readonly lineEnd?: number }): boolean {
  if (item.lineStart === undefined || item.lineEnd === undefined) return true;
  return item.lineEnd >= item.lineStart;
}

function evidenceItemText(item: CapabilityEvidenceItem): string {
  return [item.excerpt, item.symbol, item.path].filter((value): value is string => typeof value === "string").join("\n");
}

function countLines(content: string): number {
  return content.trimEnd().split("\n").length;
}

/**
 * Proves a capability evidence packet actually covers its oracle: every `oracle.mustContain` is
 * represented by at least one evidence item, no `oracle.mustNotContain` content appears in the
 * packet, every raw artifact ref resolves against the supplied ref set, and every file/line ref
 * resolves under `fixtureRoot` where a fixture root is supplied. This is the anti-cheat the
 * capability runner (todo 7/11) depends on: a too-small but incomplete packet FAILS here even
 * when its compression ratio would be high, because coverage is computed from the evidence items
 * themselves rather than trusted from the packet's embedded `coverage` claim.
 *
 * When `fixtureRoot` is provided, evidence item paths are resolved relative to it and MUST stay
 * inside it (path traversal is rejected as an unresolved file ref, never followed).
 */
export async function validateEvidenceCoverage(
  packet: CapabilityEvidencePacket,
  oracle: EvidenceCoverageOracle,
  context: EvidenceCoverageContext,
): Promise<EvidenceCoverageResult> {
  const coveredMustContain: string[] = [];
  const missingMustContain: string[] = [];
  const forbiddenHits: string[] = [];
  const unresolvedArtifactRefs: string[] = [];
  const unresolvedFileRefs: string[] = [];
  const outOfBoundsLineRefs: string[] = [];

  const evidenceTexts = packet.evidence.map(evidenceItemText);

  for (const expected of oracle.mustContain) {
    if (evidenceTexts.some((text) => text.includes(expected))) {
      coveredMustContain.push(expected);
    } else {
      missingMustContain.push(expected);
    }
  }

  const packetText = [packet.summary, ...evidenceTexts].join("\n");
  for (const forbidden of oracle.mustNotContain) {
    if (packetText.includes(forbidden)) {
      forbiddenHits.push(forbidden);
    }
  }

  for (const item of packet.evidence) {
    if (!context.rawArtifactRefs.has(item.rawArtifactRef)) {
      unresolvedArtifactRefs.push(item.rawArtifactRef);
    }
    if (item.path !== undefined && context.fixtureRoot !== undefined) {
      const rootResolved = path.resolve(context.fixtureRoot);
      const resolved = path.resolve(rootResolved, item.path);
      const withinRoot = resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
      if (!withinRoot) {
        unresolvedFileRefs.push(item.path);
      } else {
        try {
          const content = await fs.readFile(resolved, "utf8");
          if (item.lineStart !== undefined && item.lineEnd !== undefined) {
            if (item.lineEnd > countLines(content)) {
              outOfBoundsLineRefs.push(`${item.path}:${item.lineStart}-${item.lineEnd}`);
            }
          }
        } catch {
          unresolvedFileRefs.push(item.path);
        }
      }
    }
  }

  for (const ref of packet.rawArtifactRefs) {
    if (!context.rawArtifactRefs.has(ref)) {
      unresolvedArtifactRefs.push(ref);
    }
  }

  const passed =
    missingMustContain.length === 0 &&
    forbiddenHits.length === 0 &&
    unresolvedArtifactRefs.length === 0 &&
    unresolvedFileRefs.length === 0 &&
    outOfBoundsLineRefs.length === 0;

  const coverage = CapabilityCoverageSchema.parse({
    coveredMustContain,
    missingMustContain,
    forbiddenHits,
    unresolvedArtifactRefs,
    unresolvedFileRefs,
    outOfBoundsLineRefs,
    passed,
  });

  return { passed, coverage };
}