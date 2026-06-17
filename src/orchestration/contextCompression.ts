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
  const redactedSummary = redactString(summary);
  const redactedArtifactSummary = redactString(artifact.summary);
  const redactedCarriedContext = contextPack.inlineContext.slice(0, 2).map((entry) => ({
    ...entry,
    summary: redactString(entry.summary),
    content: redactString(entry.content),
  }));
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
        summary: redactedArtifactSummary,
        content: redactedSummary,
        hash,
        sizeBytes: Buffer.byteLength(redactedSummary, "utf8"),
        provenance: { source: "contextCompression", sourceType: "system" },
      },
      ...redactedCarriedContext,
    ],
    compressionRecommended: false,
  });

  verifyCompressedOutput(newContextPack);

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
    summary: redactString(artifact.summary),
    hash: artifact.hash,
    sizeBytes: artifact.sizeBytes,
    piiState: artifact.piiState,
    retentionPolicy: artifact.retentionPolicy,
    provenance: { source: "contextCompression", sourceType: "system" },
    createdAt: artifact.createdAt,
  };
}

/** Known secret patterns to scan for in post-compression verification. */
const SECRET_VERIFICATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, label: "OpenAI-style API key" },
  { pattern: /AKIA[A-Z0-9]{12,}/g, label: "AWS access key ID" },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, label: "PEM private key" },
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*\b/g, label: "Bearer token" },
  { pattern: /Basic\s+[A-Za-z0-9+/]+=*\b/g, label: "Basic auth credential" },
  { pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi, label: "Credential URI" },
  { pattern: /(?:api[_-]?key|token|secret|password)=[^\s,;&]+/gi, label: "Inline secret assignment" },
];

/**
 * Post-compression verification: scan the compressed context pack for known secret patterns.
 * Warns (console.warn) if any are detected — does not throw, since redaction is best-effort.
 */
export function verifyCompressedOutput(pack: ContextPack): void {
  const textsToScan: string[] = [
    ...pack.inlineContext.map((entry) => `${entry.summary ?? ""} ${entry.content ?? ""}`),
    ...pack.artifactHandles.map((handle) => handle.summary ?? ""),
  ];
  const combined = textsToScan.join("\n");
  for (const { pattern, label } of SECRET_VERIFICATION_PATTERNS) {
    // Reset regex lastIndex for patterns with /g flag
    const regex = new RegExp(pattern.source, pattern.flags);
    if (regex.test(combined)) {
      console.warn(
        `[SECURITY] Post-compression verification detected ${label} in compressed context. Redaction may be incomplete.`,
      );
    }
  }
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
