import crypto from "node:crypto";
import { z } from "zod";
import type { RectorStore } from "../store";
import type { Artifact, Conversation, Message } from "../store/schemas";
import { truthItemToArtifactHandle, type TruthLibraryReader, type TruthSearchResult } from "../memory";
import type { MemoryEntry } from "../store";
import { redactString } from "../security/redaction";
import { TriageResultSchema, type TriageResult } from "./triage";

const DEFAULT_ARTIFACT_THRESHOLD_BYTES = 4096;
const USER_INTENT_MAX_CHARS = 240;
const MEMORY_CONTEXT_MAX_CHARS = 140;

export const ContextCitationSchema = z.object({
  title: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  quote: z.string().min(1).optional(),
  retrievedAt: z.string().datetime().optional(),
});
export type ContextCitation = z.infer<typeof ContextCitationSchema>;

export const ContextProvenanceSchema = z.object({
  source: z.string().min(1),
  sourceType: z.string().min(1),
  actor: z.string().min(1).optional(),
  observedAt: z.string().datetime().optional(),
});
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;

export const ContextBudgetSchema = z.object({
  maxInlineChars: z.number().int().positive(),
  maxMemoryEntries: z.number().int().nonnegative(),
  maxArtifactHandles: z.number().int().nonnegative(),
  maxProviderNotes: z.number().int().nonnegative(),
  maxToolNotes: z.number().int().nonnegative(),
});
export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = ContextBudgetSchema.parse({
  maxInlineChars: 8_000,
  maxMemoryEntries: 8,
  maxArtifactHandles: 12,
  maxProviderNotes: 8,
  maxToolNotes: 8,
});

export const ArtifactHandleSchema = z.object({
  artifactId: z.string().min(1),
  kind: z.string().min(1),
  uri: z.string().min(1),
  summary: z.string(),
  hash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  piiState: z.string().min(1),
  retentionPolicy: z.string().min(1),
  provenance: ContextProvenanceSchema.optional(),
  citations: z.array(ContextCitationSchema).optional(),
  status: z.enum(["TRUSTED", "UNVERIFIED", "REJECTED", "STALE"]).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  rankScore: z.number().optional(),
  matchedTerms: z.array(z.string().min(1)).optional(),
});
export type ArtifactHandle = z.infer<typeof ArtifactHandleSchema>;

export const InlineContextSchema = z.object({
  kind: z.string().min(1),
  summary: z.string(),
  content: z.string(),
  hash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  provenance: ContextProvenanceSchema.optional(),
  citations: z.array(ContextCitationSchema).optional(),
});
export type InlineContext = z.infer<typeof InlineContextSchema>;

export const ContextPackSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  userIntentSummary: z.string(),
  conversationRef: z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    workspaceId: z.string().optional(),
  }),
  messageRefs: z.array(
    z.object({
      id: z.string().min(1),
      role: z.string().min(1),
      status: z.string().min(1),
      runId: z.string().optional(),
      createdAt: z.string().datetime(),
    })
  ),
  relevantDocs: z.array(ArtifactHandleSchema),
  relevantMemory: z.array(ArtifactHandleSchema),
  constraints: z.array(z.string().min(1)),
  availableProviders: z.object({
    configured: z.array(z.string().min(1)),
    unavailable: z.array(z.string().min(1)),
    notes: z.array(z.string().min(1)),
  }),
  availableTools: z.object({
    names: z.array(z.string().min(1)),
    notes: z.array(z.string().min(1)),
  }),
  riskFlags: z.array(z.string().min(1)),
  triage: TriageResultSchema,
  artifactHandles: z.array(ArtifactHandleSchema),
  inlineContext: z.array(InlineContextSchema),
  contextBudget: ContextBudgetSchema.optional(),
  /** Time-aware summaries from memory (Chunk 27). */
  memoryContext: z.array(z.string()).optional(),
  /** Decomposed sub-goals for high-complexity external runs (Chunk 32 / Step 7). */
  subGoals: z.array(z.string().min(1)).optional(),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

export type ContextMaterial = {
  artifactHandle?: ArtifactHandle;
  inlineContent?: InlineContext;
};

export type ContextMaterialInput = {
  kind: string;
  content: string;
  summary?: string;
  thresholdBytes?: number;
  piiState?: string;
  retentionPolicy?: string;
  provenance?: ContextProvenance;
  citations?: ContextCitation[];
};

export async function createContextMaterial(
  store: RectorStore,
  input: ContextMaterialInput
): Promise<ContextMaterial> {
  const safeContent = redactString(input.content);
  const sizeBytes = Buffer.byteLength(safeContent, "utf8");
  const hash = sha256(safeContent);
  const summary = input.summary ? redactString(input.summary) : summarize(safeContent);
  const threshold = input.thresholdBytes ?? DEFAULT_ARTIFACT_THRESHOLD_BYTES;

  if (sizeBytes <= threshold) {
    return {
      inlineContent: InlineContextSchema.parse({
        kind: input.kind,
        summary,
        content: safeContent,
        hash,
        sizeBytes,
        provenance: input.provenance,
        citations: input.citations,
      }),
    };
  }

  const artifact = await store.createArtifact({
    kind: input.kind,
    uri: `memory://artifacts/${hash}`,
    summary,
    hash,
    sizeBytes,
    piiState: input.piiState ?? "unknown",
    retentionPolicy: input.retentionPolicy ?? "session",
    metadata: {
      storage: "in-memory",
      content: safeContent,
      contentEncoding: "utf8",
      provenance: input.provenance,
      citations: input.citations,
    },
  });

  return { artifactHandle: artifactToHandle(artifact) };
}

export type BuildContextPackInput = {
  conversation: Conversation;
  messages: Message[];
  userMessage: Message;
  triage: TriageResult;
  materials?: ContextMaterial[];
  constraints?: string[];
  relevantDocs?: ArtifactHandle[];
  relevantMemory?: ArtifactHandle[];
  truthLibrary?: TruthLibraryReader;
  truthQuery?: string;
  truthSearchLimit?: number;
  providerInfo?: ContextPack["availableProviders"];
  toolInfo?: ContextPack["availableTools"];
  now?: () => string;
  contextBudget?: Partial<ContextBudget>;
  /** Time-aware memory entries from episodic/core for injection (Chunk 27). */
  memoryEntries?: MemoryEntry[];
};

export async function buildContextPack(
  store: RectorStore,
  input: BuildContextPackInput
): Promise<ContextPack> {
  const budget = resolveContextBudget(input.contextBudget);
  const createdAt = input.now?.() ?? new Date().toISOString();
  const truthQuery = input.truthQuery ?? input.userMessage.content;
  const materialContext = await boundContextMaterials(store, input.materials ?? [], budget);
  const relevantDocLimit = Math.min(budget.maxArtifactHandles, input.truthSearchLimit ?? budget.maxArtifactHandles);
  const relevantMemoryLimit = Math.min(budget.maxMemoryEntries, input.truthSearchLimit ?? budget.maxMemoryEntries);
  const localRelevantDocs = input.relevantDocs
    ? rankArtifactHandles(input.relevantDocs, truthQuery, createdAt, relevantDocLimit)
    : searchTruthLibrary(input.truthLibrary, truthQuery, "doc", relevantDocLimit, createdAt);
  const localRelevantMemory = input.relevantMemory
    ? rankArtifactHandles(input.relevantMemory, truthQuery, createdAt, relevantMemoryLimit)
    : searchTruthLibrary(input.truthLibrary, truthQuery, "memory", relevantMemoryLimit, createdAt);

  // Time-aware memory context (Chunk 27 / Step 2). Formats entries like "3 days ago you noted: ..."
  const rankedMemoryEntries = rankMemoryEntries(input.memoryEntries ?? [], truthQuery, createdAt, budget.maxMemoryEntries);
  const memoryContext = rankedMemoryEntries.map((mem) => formatMemoryContext(mem, createdAt));

  const providerInfo = boundProviderInfo(
    input.providerInfo ?? {
      configured: [],
      unavailable: [],
      notes: ["provider inventory placeholder; no provider calls in chunk 8"],
    },
    budget
  );
  const toolInfo = boundToolInfo(
    input.toolInfo ?? {
      names: [],
      notes: ["tool inventory placeholder; no tool execution in chunk 8 context pack"],
    },
    budget
  );

  const pack = {
    id: `ctx-${sha256(`${input.conversation.id}:${input.userMessage.id}:${input.userMessage.createdAt}`).slice(0, 16)}`,
    createdAt,
    userIntentSummary: summarize(redactString(input.userMessage.content), USER_INTENT_MAX_CHARS),
    conversationRef: {
      id: input.conversation.id,
      title: input.conversation.title,
      workspaceId: input.conversation.workspaceId,
    },
    messageRefs: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      status: message.status,
      runId: message.runId,
      createdAt: message.createdAt,
    })),
    relevantDocs: localRelevantDocs,
    relevantMemory: localRelevantMemory,
    constraints: input.constraints ?? defaultConstraints(),
    availableProviders: providerInfo,
    availableTools: toolInfo,
    riskFlags: [...new Set(input.triage.riskFlags)].sort(),
    triage: input.triage,
    artifactHandles: materialContext.artifactHandles,
    inlineContext: materialContext.inlineContext,
    contextBudget: budget,
    ...(memoryContext.length > 0 ? { memoryContext } : {}),
  };

  return ContextPackSchema.parse(pack);
}

export function summarize(content: string, maxChars = 160): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function resolveContextBudget(input: Partial<ContextBudget> | undefined): ContextBudget {
  return ContextBudgetSchema.parse({ ...DEFAULT_CONTEXT_BUDGET, ...(input ?? {}) });
}

async function boundContextMaterials(
  store: RectorStore,
  materials: ContextMaterial[],
  budget: ContextBudget
): Promise<{ artifactHandles: ArtifactHandle[]; inlineContext: InlineContext[] }> {
  const artifactHandles: ArtifactHandle[] = [];
  const inlineContext: InlineContext[] = [];
  let inlineChars = 0;

  for (const material of materials) {
    if (material.artifactHandle && artifactHandles.length < budget.maxArtifactHandles) {
      artifactHandles.push(ArtifactHandleSchema.parse(material.artifactHandle));
    }

    if (!material.inlineContent) continue;
    const safeInline = redactInlineContext(material.inlineContent);
    if (inlineChars + safeInline.content.length <= budget.maxInlineChars) {
      inlineContext.push(safeInline);
      inlineChars += safeInline.content.length;
      continue;
    }

    if (artifactHandles.length >= budget.maxArtifactHandles) continue;
    const externalized = await store.createArtifact({
      kind: safeInline.kind,
      uri: `memory://artifacts/${safeInline.hash}`,
      summary: safeInline.summary,
      hash: safeInline.hash,
      sizeBytes: safeInline.sizeBytes,
      piiState: "redacted",
      retentionPolicy: "session",
      metadata: {
        storage: "in-memory",
        externalizedFrom: "inline-context-budget",
        content: safeInline.content,
        contentEncoding: "utf8",
        provenance: safeInline.provenance,
        citations: safeInline.citations,
      },
    });
    artifactHandles.push(artifactToHandle(externalized));
  }

  return {
    artifactHandles: artifactHandles.slice(0, budget.maxArtifactHandles),
    inlineContext,
  };
}

function redactInlineContext(inline: InlineContext): InlineContext {
  const content = redactString(inline.content);
  const summary = redactString(inline.summary);
  return InlineContextSchema.parse({
    ...inline,
    summary,
    content,
    hash: sha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  });
}

function artifactToHandle(artifact: Artifact): ArtifactHandle {
  const metadata = recordFrom(artifact.metadata);
  return ArtifactHandleSchema.parse({
    artifactId: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    summary: redactString(artifact.summary),
    hash: artifact.hash,
    sizeBytes: artifact.sizeBytes,
    piiState: artifact.piiState,
    retentionPolicy: artifact.retentionPolicy,
    provenance: parseOptionalProvenance(metadata?.provenance),
    citations: parseOptionalCitations(metadata?.citations),
    createdAt: artifact.createdAt,
  });
}

function searchTruthLibrary(
  truthLibrary: TruthLibraryReader | undefined,
  query: string,
  kind: "doc" | "memory",
  limit: number,
  nowIso: string
): ArtifactHandle[] {
  if (truthLibrary === undefined || limit <= 0) return [];
  const searchLimit = Math.max(limit, Math.min(100, limit * 4));
  const results = truthLibrary.search({ query, kinds: [kind], limit: searchLimit });
  return rankTruthResults(results, query, nowIso, limit);
}

function rankTruthResults(results: TruthSearchResult[], query: string, nowIso: string, limit: number): ArtifactHandle[] {
  return results
    .map((result) => {
      const base = truthItemToArtifactHandle(result.item);
      const terms = tokenize(query);
      const score =
        result.score +
        scoreTextMatch(`${result.item.title} ${result.item.content} ${result.item.tags.join(" ")}`, terms) +
        statusBoost(result.item.status) +
        recencyBoost(result.item.updatedAt, nowIso) +
        provenanceBoost(result.item.provenance.sourceType) +
        stalePenalty(result.item.updatedAt, nowIso);
      return ArtifactHandleSchema.parse({
        ...base,
        provenance: result.item.provenance,
        citations: [...result.item.citations, ...result.item.provenance.citations],
        status: result.item.status,
        createdAt: result.item.createdAt,
        updatedAt: result.item.updatedAt,
        rankScore: score,
        matchedTerms: result.matchedTerms,
      });
    })
    .sort(compareRankedArtifactHandles)
    .slice(0, limit);
}

function rankArtifactHandles(handles: ArtifactHandle[], query: string, nowIso: string, limit: number): ArtifactHandle[] {
  if (limit <= 0) return [];
  const terms = tokenize(query);
  return handles
    .map((handle) => {
      const score =
        scoreTextMatch(`${handle.kind} ${handle.summary} ${handle.uri} ${handle.provenance?.source ?? ""}`, terms) +
        statusBoost(handle.status) +
        recencyBoost(handle.updatedAt ?? handle.provenance?.observedAt, nowIso) +
        provenanceBoost(handle.provenance?.sourceType) +
        stalePenalty(handle.updatedAt ?? handle.provenance?.observedAt, nowIso);
      return ArtifactHandleSchema.parse({
        ...handle,
        summary: redactString(handle.summary),
        rankScore: score,
        matchedTerms: terms.filter((term) => `${handle.kind} ${handle.summary} ${handle.uri}`.toLowerCase().includes(term)),
      });
    })
    .sort(compareRankedArtifactHandles)
    .slice(0, limit);
}

function rankMemoryEntries(entries: MemoryEntry[], query: string, nowIso: string, limit: number): MemoryEntry[] {
  if (limit <= 0) return [];
  const terms = tokenize(query);
  return [...entries]
    .map((entry) => ({ entry, score: scoreMemoryEntry(entry, terms, nowIso) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const rightMentioned = right.entry.lastMentioned ?? right.entry.timestamp ?? "";
      const leftMentioned = left.entry.lastMentioned ?? left.entry.timestamp ?? "";
      const recencyDelta = rightMentioned.localeCompare(leftMentioned);
      if (recencyDelta !== 0) return recencyDelta;
      return left.entry.id.localeCompare(right.entry.id);
    })
    .slice(0, limit)
    .map((ranked) => ranked.entry);
}

function scoreMemoryEntry(entry: MemoryEntry, terms: string[], nowIso: string): number {
  const metadata = recordFrom(entry.metadata);
  return (
    scoreTextMatch(`${entry.content} ${entry.tags.join(" ")} ${entry.source ?? ""}`, terms) +
    recencyBoost(entry.lastMentioned || entry.timestamp, nowIso) +
    Math.min(3, entry.accessCount) +
    provenanceBoost(entry.source) +
    (metadata?.status === "TRUSTED" ? 4 : 0) -
    (metadata?.status === "REJECTED" ? 12 : 0) -
    (entry.tags.includes("stale") || metadata?.stale === true ? 6 : 0)
  );
}

function formatMemoryContext(mem: MemoryEntry, nowIso: string): string {
  const nowMs = Date.parse(nowIso);
  const ageMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - (Date.parse(mem.timestamp) || nowMs || Date.now());
  const days = Math.max(0, Math.floor(ageMs / (1000 * 60 * 60 * 24)));
  const timePhrase = days > 0 ? `${days} day${days === 1 ? "" : "s"} ago` : "recently";
  const prefix = mem.source === "user-note" || mem.tags.includes("note") ? "you noted" : "you";
  const short = redactString(mem.content).slice(0, MEMORY_CONTEXT_MAX_CHARS).replace(/\s+/g, " ");
  return `${timePhrase} ${prefix}: ${short}${mem.content.length > MEMORY_CONTEXT_MAX_CHARS ? "…" : ""}`;
}

function boundProviderInfo(info: ContextPack["availableProviders"], budget: ContextBudget): ContextPack["availableProviders"] {
  return {
    configured: [...info.configured].sort(),
    unavailable: [...info.unavailable].sort(),
    notes: info.notes.slice(0, budget.maxProviderNotes).map(redactString),
  };
}

function boundToolInfo(info: ContextPack["availableTools"], budget: ContextBudget): ContextPack["availableTools"] {
  return {
    names: [...info.names].sort(),
    notes: info.notes.slice(0, budget.maxToolNotes).map(redactString),
  };
}

function compareRankedArtifactHandles(left: ArtifactHandle, right: ArtifactHandle): number {
  const scoreDelta = (right.rankScore ?? 0) - (left.rankScore ?? 0);
  if (scoreDelta !== 0) return scoreDelta;
  const updatedDelta = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  if (updatedDelta !== 0) return updatedDelta;
  return left.artifactId.localeCompare(right.artifactId);
}

function scoreTextMatch(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 5 : 0), 0);
}

function recencyBoost(timestamp: string | undefined, nowIso: string): number {
  if (!timestamp) return 0;
  const nowMs = Date.parse(nowIso);
  const thenMs = Date.parse(timestamp);
  if (!Number.isFinite(nowMs) || !Number.isFinite(thenMs)) return 0;
  const days = Math.max(0, (nowMs - thenMs) / (1000 * 60 * 60 * 24));
  if (days <= 1) return 4;
  if (days <= 7) return 3;
  if (days <= 30) return 2;
  if (days <= 90) return 1;
  return 0;
}

function stalePenalty(timestamp: string | undefined, nowIso: string): number {
  if (!timestamp) return 0;
  const nowMs = Date.parse(nowIso);
  const thenMs = Date.parse(timestamp);
  if (!Number.isFinite(nowMs) || !Number.isFinite(thenMs)) return 0;
  const days = Math.max(0, (nowMs - thenMs) / (1000 * 60 * 60 * 24));
  return days > 365 ? -5 : 0;
}

function statusBoost(status: string | undefined): number {
  switch (status) {
    case "TRUSTED":
      return 4;
    case "UNVERIFIED":
      return 0;
    case "STALE":
      return -5;
    case "REJECTED":
      return -12;
    default:
      return 0;
  }
}

function provenanceBoost(sourceType: string | undefined): number {
  switch (sourceType) {
    case "user":
    case "manual":
    case "file":
    case "system":
    case "user-note":
      return 2;
    default:
      return 0;
  }
}

function tokenize(content: string): string[] {
  return [...new Set(content.toLowerCase().match(/[a-z0-9]+/g) ?? [])].sort();
}

function parseOptionalProvenance(value: unknown): ContextProvenance | undefined {
  if (!value) return undefined;
  const parsed = ContextProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseOptionalCitations(value: unknown): ContextCitation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = z.array(ContextCitationSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function defaultConstraints(): string[] {
  return [
    "No provider calls during chunk 8 triage/context baseline",
    "Do not include raw oversized content in context packs",
    "Use artifact handles for oversized context material",
  ];
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
