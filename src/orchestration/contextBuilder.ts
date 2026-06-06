import crypto from "node:crypto";
import { z } from "zod";
import type { RectorStore } from "../store";
import type { Artifact, Conversation, Message } from "../store/schemas";
import { truthItemToArtifactHandle, type TruthLibraryReader } from "../memory";
import { TriageResultSchema, type TriageResult } from "./triage";

const DEFAULT_ARTIFACT_THRESHOLD_BYTES = 4096;
const USER_INTENT_MAX_CHARS = 240;

export const ArtifactHandleSchema = z.object({
  artifactId: z.string().min(1),
  kind: z.string().min(1),
  uri: z.string().min(1),
  summary: z.string(),
  hash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  piiState: z.string().min(1),
  retentionPolicy: z.string().min(1),
});
export type ArtifactHandle = z.infer<typeof ArtifactHandleSchema>;

export const InlineContextSchema = z.object({
  kind: z.string().min(1),
  summary: z.string(),
  content: z.string(),
  hash: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
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
};

export async function createContextMaterial(
  store: RectorStore,
  input: ContextMaterialInput
): Promise<ContextMaterial> {
  const sizeBytes = Buffer.byteLength(input.content, "utf8");
  const hash = sha256(input.content);
  const summary = input.summary ?? summarize(input.content);
  const threshold = input.thresholdBytes ?? DEFAULT_ARTIFACT_THRESHOLD_BYTES;

  if (sizeBytes <= threshold) {
    return {
      inlineContent: InlineContextSchema.parse({
        kind: input.kind,
        summary,
        content: input.content,
        hash,
        sizeBytes,
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
      content: input.content,
      contentEncoding: "utf8",
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
};

export async function buildContextPack(
  _store: RectorStore,
  input: BuildContextPackInput
): Promise<ContextPack> {
  const materials = input.materials ?? [];
  const artifactHandles = materials.flatMap((material) => (material.artifactHandle ? [material.artifactHandle] : []));
  const inlineContext = materials.flatMap((material) => (material.inlineContent ? [material.inlineContent] : []));
  const riskFlags = [...new Set(input.triage.riskFlags)];
  const truthQuery = input.truthQuery ?? input.userMessage.content;
  const localRelevantDocs = input.relevantDocs ?? searchTruthLibrary(input.truthLibrary, truthQuery, "doc", input.truthSearchLimit);
  const localRelevantMemory =
    input.relevantMemory ?? searchTruthLibrary(input.truthLibrary, truthQuery, "memory", input.truthSearchLimit);

  const pack = {
    id: `ctx-${sha256(`${input.conversation.id}:${input.userMessage.id}:${input.userMessage.createdAt}`).slice(0, 16)}`,
    createdAt: input.now?.() ?? new Date().toISOString(),
    userIntentSummary: summarize(input.userMessage.content, USER_INTENT_MAX_CHARS),
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
    availableProviders: input.providerInfo ?? {
      configured: [],
      unavailable: [],
      notes: ["provider inventory placeholder; no provider calls in chunk 8"],
    },
    availableTools: input.toolInfo ?? {
      names: [],
      notes: ["tool inventory placeholder; no tool execution in chunk 8 context pack"],
    },
    riskFlags,
    triage: input.triage,
    artifactHandles,
    inlineContext,
  };

  return ContextPackSchema.parse(pack);
}

export function summarize(content: string, maxChars = 160): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function artifactToHandle(artifact: Artifact): ArtifactHandle {
  return ArtifactHandleSchema.parse({
    artifactId: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    summary: artifact.summary,
    hash: artifact.hash,
    sizeBytes: artifact.sizeBytes,
    piiState: artifact.piiState,
    retentionPolicy: artifact.retentionPolicy,
  });
}

function searchTruthLibrary(
  truthLibrary: TruthLibraryReader | undefined,
  query: string,
  kind: "doc" | "memory",
  limit = 5
): ArtifactHandle[] {
  if (truthLibrary === undefined) return [];
  return truthLibrary
    .search({ query, kinds: [kind], limit })
    .map((result) => truthItemToArtifactHandle(result.item));
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
