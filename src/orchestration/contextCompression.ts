import crypto from "node:crypto";
import { z } from "zod";
import type { RectorStore } from "../store";
import type { Artifact, Conversation, Message, RunEvent } from "../store/schemas";
import { redactString, redactSecrets } from "../security/redaction";
import { ContextPackSchema, summarize, type ArtifactHandle, type ContextPack, type InlineContext } from "./contextBuilder";
import {
  DEFAULT_PROMPT_TIER_BUDGET,
  PromptTierBudgetSchema,
  measureContextTierChars,
  type PromptTierBudget,
} from "./promptTiers";

export const ContextPressureResultSchema = z.object({
  exceeded: z.boolean(),
  tier: z.enum(["context", "volatile"]),
  usedChars: z.number().int().nonnegative(),
  capChars: z.number().int().positive(),
  overByChars: z.number().int().nonnegative(),
});
export type ContextPressureResult = z.infer<typeof ContextPressureResultSchema>;

export interface CompressionInput {
  conversationId: string;
  runId: string;
  contextPack: ContextPack;
  store: RectorStore;
  maxRecentMessages?: number;
  now?: () => string;
  tierBudget?: Partial<PromptTierBudget>;
}

export interface CompressionResult {
  childConversationId: string;
  summaryArtifactId: string;
  newContextPack: ContextPack;
}

export function evaluateContextPressure(
  pack: ContextPack,
  budget: Partial<PromptTierBudget> = {},
): ContextPressureResult {
  const tierBudget = PromptTierBudgetSchema.parse({ ...DEFAULT_PROMPT_TIER_BUDGET, ...budget });
  const usedChars = measureContextTierChars({ contextPack: pack, tierBudget });
  return ContextPressureResultSchema.parse({
    exceeded: usedChars > tierBudget.maxContextChars,
    tier: "context",
    usedChars,
    capChars: tierBudget.maxContextChars,
    overByChars: Math.max(0, usedChars - tierBudget.maxContextChars),
  });
}

export async function compressContextLineage(input: CompressionInput): Promise<CompressionResult> {
  const { store, conversationId, runId, contextPack } = input;
  const parent = await store.getConversation(conversationId);
  if (!parent) throw new Error(`Conversation not found for context compression: ${redactString(conversationId)}`);

  const maxRecentMessages = input.maxRecentMessages ?? 4;
  const allParentMessages = await store.listMessages(conversationId);
  const recentMessages = allParentMessages.slice(Math.max(0, allParentMessages.length - maxRecentMessages));
  const summary = summarizeDeterministic(recentMessages, contextPack.inlineContext);
  const hash = sha256(summary);
  const artifact = await store.createArtifact({
    kind: "CONTEXT_SUMMARY",
    uri: `context-summary://${runId}/${hash}`,
    summary: summarize(summary, 240),
    hash,
    sizeBytes: Buffer.byteLength(summary, "utf8"),
    piiState: "redacted",
    retentionPolicy: "session",
    metadata: {
      method: "deterministic",
      parentConversationId: conversationId,
      runId,
      content: summary,
      contentEncoding: "utf8",
      provenance: {
        source: "contextCompression",
        sourceType: "system",
        observedAt: input.now?.() ?? new Date().toISOString(),
      },
    },
  });

  const child = await store.createConversation({
    title: childTitle(parent),
    workspaceId: parent.workspaceId,
    parentConversationId: parent.id,
    compressionGeneration: (parent.compressionGeneration ?? 0) + 1,
    compressionSummaryArtifactId: artifact.id,
    retentionPolicy: parent.retentionPolicy,
  });

  const summaryMessage = await store.createMessage({
    conversationId: child.id,
    role: "system",
    content: `Context summary artifact ${artifact.id}: ${summary}`,
    status: "compressed",
    runId,
    redactionState: "redacted",
  });
  const copiedMessages: Message[] = [];
  for (const message of recentMessages) {
    copiedMessages.push(
      await store.createMessage({
        conversationId: child.id,
        role: message.role,
        content: redactString(message.content),
        status: message.status,
        runId: message.runId,
        redactionState: "redacted",
        source: message.source,
      }),
    );
  }

  const summaryHandle = artifactToHandle(artifact);
  const newContextPack = ContextPackSchema.parse({
    ...contextPack,
    id: `ctx-${sha256(`${child.id}:${artifact.id}:${summaryMessage.id}`).slice(0, 16)}`,
    conversationRef: {
      id: child.id,
      title: child.title,
      workspaceId: child.workspaceId,
    },
    messageRefs: [summaryMessage, ...copiedMessages].map((message) => ({
      id: message.id,
      role: message.role,
      status: message.status,
      runId: message.runId,
      createdAt: message.createdAt,
    })),
    artifactHandles: [summaryHandle, ...contextPack.artifactHandles],
    inlineContext: [
      {
        kind: "CONTEXT_SUMMARY",
        summary: artifact.summary,
        content: summary,
        hash,
        sizeBytes: Buffer.byteLength(summary, "utf8"),
        provenance: { source: "contextCompression", sourceType: "system" },
      },
      ...contextPack.inlineContext.slice(0, 2),
    ],
    compressionRecommended: false,
  });

  await store.appendEvent(contextCompressedEvent(runId, parent, child, artifact, input.now));

  return {
    childConversationId: child.id,
    summaryArtifactId: artifact.id,
    newContextPack,
  };
}

export function summarizeDeterministic(
  messages: Pick<Message, "role" | "content" | "createdAt">[],
  inlineContext: Pick<InlineContext, "kind" | "summary" | "content">[],
  maxChars = 2_000,
): string {
  const messageLines = messages.map((message) => {
    const content = redactString(message.content).replace(/\s+/g, " ").trim();
    return `- ${message.role} at ${message.createdAt}: ${content.slice(0, 280)}`;
  });
  const contextLines = inlineContext.map((entry) => {
    const content = redactString(entry.content).replace(/\s+/g, " ").trim();
    return `- ${entry.kind}: ${redactString(entry.summary)} ${content.slice(0, 280)}`;
  });
  const summary = [
    "Deterministic context compression summary.",
    "Recent messages:",
    ...(messageLines.length ? messageLines : ["- No recent messages were available."]),
    "Inline context:",
    ...(contextLines.length ? contextLines : ["- No inline context was available."]),
  ].join("\n");
  return capText(summary, maxChars);
}

function contextCompressedEvent(
  runId: string,
  parent: Conversation,
  child: Conversation,
  artifact: Artifact,
  now?: () => string,
): RunEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    runId,
    type: "CONTEXT_COMPRESSED",
    phase: "CONTEXT_BUILDING",
    payload: redactSecrets({
      parentConversationId: parent.id,
      childConversationId: child.id,
      summaryArtifactId: artifact.id,
      method: "deterministic",
      compressionGeneration: child.compressionGeneration,
    }),
    createdAt: now?.() ?? new Date().toISOString(),
  };
}

function childTitle(parent: Conversation): string {
  const generation = (parent.compressionGeneration ?? 0) + 1;
  return `${parent.title} (compressed ${generation})`;
}

function artifactToHandle(artifact: Artifact): ArtifactHandle {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    summary: artifact.summary,
    hash: artifact.hash,
    sizeBytes: artifact.sizeBytes,
    piiState: artifact.piiState,
    retentionPolicy: artifact.retentionPolicy,
    provenance: { source: "contextCompression", sourceType: "system" },
    createdAt: artifact.createdAt,
  };
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
