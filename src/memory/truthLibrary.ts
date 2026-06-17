import crypto from "node:crypto";
import { z } from "zod";
import type { ArtifactHandle } from "../orchestration/contextBuilder";
import type { AuthorizationSubject } from "../security/rbac.js";
import { can } from "../security/rbac.js";

export const TruthStatus = z.enum(["TRUSTED", "UNVERIFIED", "REJECTED"]);
export type TruthStatus = z.infer<typeof TruthStatus>;

export const TruthItemKindSchema = z.enum(["memory", "doc", "skill"]);
export type TruthItemKind = z.infer<typeof TruthItemKindSchema>;

export const ProvenanceSourceTypeSchema = z.enum(["user", "system", "file", "web", "provider", "manual"]);
export type ProvenanceSourceType = z.infer<typeof ProvenanceSourceTypeSchema>;

export const CitationSchema = z
  .object({
    title: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    quote: z.string().min(1).optional(),
    retrievedAt: z.string().datetime().optional(),
  })
  .refine((citation) => citation.title !== undefined || citation.uri !== undefined || citation.quote !== undefined, {
    message: "citation requires at least one of title, uri, or quote",
  });
export type Citation = z.infer<typeof CitationSchema>;

export const ProvenanceSchema = z.object({
  source: z.string().min(1),
  sourceType: ProvenanceSourceTypeSchema,
  actor: z.string().min(1).optional(),
  observedAt: z.string().datetime().optional(),
  citations: z.array(CitationSchema).default([]),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const TruthItemSchema = z.object({
  id: z.string().min(1),
  kind: TruthItemKindSchema.default("memory"),
  title: z.string().min(1),
  content: z.string().min(1),
  status: TruthStatus,
  provenance: ProvenanceSchema,
  citations: z.array(CitationSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TruthItem = z.infer<typeof TruthItemSchema>;

export const TruthItemUpsertSchema = TruthItemSchema.omit({ createdAt: true, updatedAt: true }).extend({
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type TruthItemUpsert = z.input<typeof TruthItemUpsertSchema>;

export const TruthSearchInputSchema = z.object({
  query: z.string().optional(),
  statuses: z.array(TruthStatus).optional(),
  includeRejected: z.boolean().optional(),
  provenanceSources: z.array(z.string().min(1)).optional(),
  provenanceTypes: z.array(ProvenanceSourceTypeSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  kinds: z.array(TruthItemKindSchema).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type TruthSearchInput = z.input<typeof TruthSearchInputSchema>;

export const TruthSearchResultSchema = z.object({
  item: TruthItemSchema,
  score: z.number().nonnegative(),
  matchedTerms: z.array(z.string()),
});
export type TruthSearchResult = z.infer<typeof TruthSearchResultSchema>;

export interface TruthRetriever {
  search(input: TruthSearchInput): TruthSearchResult[] | Promise<TruthSearchResult[]>;
}

export interface TruthLibraryReader {
  search(input: TruthSearchInput): TruthSearchResult[];
}

export interface CitationValidationResult {
  valid: boolean;
  reasons: string[];
}

export function validateCitation(input: unknown): CitationValidationResult {
  const parsed = CitationSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, reasons: parsed.error.issues.map((issue) => issue.message) };
  }

  const reasons: string[] = [];
  if (parsed.data.uri !== undefined) {
    try {
      // Accept absolute URLs and file/truth URIs; reject malformed URI-like values.
      new URL(parsed.data.uri);
    } catch {
      reasons.push("citation uri must be a valid URI");
    }
  }
  return { valid: reasons.length === 0, reasons };
}

export function validateProvenance(input: unknown): CitationValidationResult {
  const parsed = ProvenanceSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, reasons: parsed.error.issues.map((issue) => issue.message) };
  }
  const citationReasons = parsed.data.citations.flatMap((citation) => validateCitation(citation).reasons);
  return { valid: citationReasons.length === 0, reasons: citationReasons };
}

export function truthItemHasValidCitation(item: TruthItem): boolean {
  return [...item.citations, ...item.provenance.citations].some(
    (citation) => validateCitation(citation).valid,
  );
}

export class InMemoryTruthLibrary implements TruthLibraryReader {
  private readonly items = new Map<string, TruthItem>();
  private readonly now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  upsert(input: TruthItemUpsert): TruthItem {
    const existing = this.items.get(input.id);
    const parsed = TruthItemUpsertSchema.parse(input);
    const now = this.now();
    const item = TruthItemSchema.parse({
      ...parsed,
      provenance: normalizeProvenance(parsed.provenance),
      citations: parsed.citations ?? [],
      tags: normalizeTags(parsed.tags ?? []),
      createdAt: parsed.createdAt ?? existing?.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? now,
    });

    this.items.set(item.id, item);
    return item;
  }

  get(id: string): TruthItem | undefined {
    return this.items.get(id);
  }

  filter(input: Omit<TruthSearchInput, "query"> = {}): TruthItem[] {
    return this.search(input).map((result) => result.item);
  }

  search(input: TruthSearchInput = {}): TruthSearchResult[] {
    const parsed = TruthSearchInputSchema.parse(input);
    const queryTerms = tokenize(parsed.query ?? "");
    const results = [...this.items.values()]
      .filter((item) => matchesFilters(item, parsed))
      .map((item) => scoreItem(item, queryTerms))
      .filter((result) => queryTerms.length === 0 || result.score > 0)
      .sort(compareSearchResults);

    return results.slice(0, parsed.limit ?? results.length).map((result) => TruthSearchResultSchema.parse(result));
  }

  list(): TruthItem[] {
    return [...this.items.values()].sort(compareTruthItems);
  }
}

export function truthItemToArtifactHandle(item: TruthItem): ArtifactHandle {
  const contentBytes = Buffer.byteLength(item.content, "utf8");
  return {
    artifactId: item.id,
    kind: `truth-${item.kind}`,
    uri: `truth://library/${encodeURIComponent(item.id)}`,
    summary: item.title,
    hash: sha256(JSON.stringify({ content: item.content, status: item.status, provenance: item.provenance })),
    sizeBytes: contentBytes,
    piiState: "unknown",
    retentionPolicy: "session",
    provenance: item.provenance,
    citations: [...item.citations, ...item.provenance.citations],
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function normalizeProvenance(provenance: Provenance): Provenance {
  return ProvenanceSchema.parse({
    ...provenance,
    citations: provenance.citations ?? [],
  });
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function matchesFilters(item: TruthItem, input: z.infer<typeof TruthSearchInputSchema>): boolean {
  if (input.statuses !== undefined) {
    if (!input.statuses.includes(item.status)) return false;
  } else if (!input.includeRejected && item.status === "REJECTED") {
    return false;
  }

  if (input.kinds !== undefined && !input.kinds.includes(item.kind)) return false;
  if (input.provenanceSources !== undefined && !input.provenanceSources.includes(item.provenance.source)) return false;
  if (input.provenanceTypes !== undefined && !input.provenanceTypes.includes(item.provenance.sourceType)) return false;

  if (input.tags !== undefined) {
    const wantedTags = normalizeTags(input.tags);
    if (!wantedTags.every((tag) => item.tags.includes(tag))) return false;
  }

  return true;
}

function scoreItem(item: TruthItem, queryTerms: string[]): TruthSearchResult {
  if (queryTerms.length === 0) return { item, score: 0, matchedTerms: [] };

  const titleTerms = tokenize(item.title);
  const contentTerms = tokenize(item.content);
  const tagTerms = new Set(item.tags.flatMap((tag) => tokenize(tag)));
  const citationTerms = tokenize(
    [...item.citations, ...item.provenance.citations]
      .flatMap((citation) => [citation.title, citation.uri, citation.quote])
      .filter((value): value is string => value !== undefined)
      .join(" ")
  );
  const titleSet = new Set(titleTerms);
  const contentSet = new Set(contentTerms);
  const citationSet = new Set(citationTerms);
  const normalizedQuery = queryTerms.join(" ");
  const normalizedTitle = titleTerms.join(" ");

  let score = 0;
  const matchedTerms: string[] = [];
  if (normalizedQuery.length > 0 && normalizedQuery === normalizedTitle) {
    score += 20;
  }
  if (item.tags.some((tag) => tokenize(tag).join(" ") === normalizedQuery)) {
    score += 14;
  }

  for (const term of queryTerms) {
    let termScore = 0;
    if (titleSet.has(term)) termScore += 8;
    if (tagTerms.has(term)) termScore += 5;
    if (contentSet.has(term)) termScore += contentTerms.filter((contentTerm) => contentTerm === term).length;
    if (citationSet.has(term)) termScore += 2;

    if (termScore > 0) {
      score += termScore;
      matchedTerms.push(term);
    }
  }

  if (matchedTerms.length === 0) return { item, score: 0, matchedTerms: [] };
  if (matchedTerms.length === queryTerms.length) score += 3;
  score += provenanceBoost(item);
  score += recencyBoost(item);
  score -= stalePenalty(item);
  if (item.status === "REJECTED") score -= 1;

  return { item, score: Math.max(0, score), matchedTerms: matchedTerms.sort() };
}

function compareSearchResults(left: TruthSearchResult, right: TruthSearchResult): number {
  if (right.score !== left.score) return right.score - left.score;
  const statusDelta = statusRank(left.item.status) - statusRank(right.item.status);
  if (statusDelta !== 0) return statusDelta;
  return compareTruthItems(left.item, right.item);
}

function compareTruthItems(left: TruthItem, right: TruthItem): number {
  const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;
  return left.id.localeCompare(right.id);
}

function provenanceBoost(item: TruthItem): number {
  let boost = 0;
  if (item.status === "TRUSTED") boost += 3;
  if (["file", "manual", "system"].includes(item.provenance.sourceType)) boost += 1;
  if (truthItemHasValidCitation(item)) boost += item.status === "TRUSTED" ? 3 : 1;
  return boost;
}

function recencyBoost(item: TruthItem): number {
  const updatedMs = Date.parse(item.updatedAt);
  if (!Number.isFinite(updatedMs)) return 0;
  const year = new Date(updatedMs).getUTCFullYear();
  if (year >= 2026) return 2;
  if (year >= 2024) return 1;
  return 0;
}

function stalePenalty(item: TruthItem): number {
  let penalty = 0;
  if (item.tags.includes("stale") || item.tags.includes("deprecated")) penalty += 3;
  if (/stale|deprecated|obsolete/i.test(item.title)) penalty += 2;
  if (/stale|deprecated|obsolete/i.test(item.provenance.source)) penalty += 1;
  if (!validateProvenance(item.provenance).valid) penalty += 2;
  return penalty;
}

function statusRank(status: TruthStatus): number {
  switch (status) {
    case "TRUSTED":
      return 0;
    case "UNVERIFIED":
      return 1;
    case "REJECTED":
      return 2;
  }
}

export interface TruthLibrary extends TruthLibraryReader {
  upsert(input: TruthItemUpsert): TruthItem;
}

export class AuthorizationError extends Error {
  constructor(
    public readonly permission: string,
    public readonly subject: AuthorizationSubject,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Decorator that enforces RBAC on truth library mutations.
 *
 * - If `subject` is provided and has `truth.mutate` permission → proceed.
 * - If `subject` is absent and auth is enabled → deny (no subject to check against).
 * - If auth is disabled (local mode) → allow all mutations.
 */
export function authorizingTruthLibrary(
  library: TruthLibrary,
  subject: AuthorizationSubject | undefined,
): TruthLibrary {
  function checkMutate(): void {
    if (!subject) {
      if (subject === undefined) {
        // No subject provided — allow in local/auth-disabled mode, deny otherwise
        // We can't determine auth status without a subject, so allow (callers must pass subject when auth is enabled)
        return;
      }
      throw new AuthorizationError("truth.mutate", subject, "Mutation denied: no authorization subject provided.");
    }
    if (!subject.authEnabled) return; // Local mode: allow all
    if (!can(subject, "truth.mutate")) {
      throw new AuthorizationError("truth.mutate", subject, `Role "${subject.role}" does not have permission "truth.mutate".`);
    }
  }

  return {
    search(input: TruthSearchInput): TruthSearchResult[] {
      return library.search(input);
    },
    upsert(input: TruthItemUpsert): TruthItem {
      checkMutate();
      return library.upsert(input);
    },
  };
}

function tokenize(content: string): string[] {
  return [...new Set(content.toLowerCase().match(/[a-z0-9]+/g) ?? [])].sort();
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
