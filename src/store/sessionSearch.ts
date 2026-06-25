import { z } from "zod";
import { redactString } from "../security/redaction";
import type { Conversation, Message } from "./schemas";
import type { RectorStore } from ".";

export const DEFAULT_SESSION_SEARCH_LIMIT = 20;
export const MAX_SESSION_SEARCH_LIMIT = 50;
export const MAX_SESSION_SEARCH_QUERY_LENGTH = 500;
export const MAX_SESSION_SEARCH_SNIPPET_LENGTH = 300;

export const SessionSearchHitSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  title: z.string(),
  snippet: z.string().max(MAX_SESSION_SEARCH_SNIPPET_LENGTH),
  score: z.number().nonnegative(),
  matchedAt: z.string().datetime(),
  compressionGeneration: z.number().int().nonnegative(),
  parentConversationId: z.string().optional(),
});
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;

export interface SessionSearchQuery {
  query: string;
  workspaceId: string;
  limit?: number;
}

export interface BuildSessionSearchHitInput {
  conversation: Conversation;
  message?: Message;
  content?: string;
  query: string;
  baseScore?: number;
}

function byMatchedAtDesc(a: SessionSearchHit, b: SessionSearchHit): number {
  const dateDiff = Date.parse(b.matchedAt) - Date.parse(a.matchedAt);
  if (dateDiff !== 0) return dateDiff;
  return a.conversationId.localeCompare(b.conversationId);
}

export function compareSessionSearchHits(a: SessionSearchHit, b: SessionSearchHit): number {
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) return scoreDiff;
  return byMatchedAtDesc(a, b);
}

export function normalizeSessionSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return DEFAULT_SESSION_SEARCH_LIMIT;
  return Math.min(MAX_SESSION_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

export function normalizeSessionSearchQuery(query: string): string {
  return query.trim();
}

export function toFts5Query(query: string): string {
  const terms = normalizeSessionSearchQuery(query)
    .match(/[A-Za-z0-9_]+/g)
    ?.map((term) => term.toLowerCase())
    .filter((term) => term.length > 0 && term.length <= 64);

  return terms && terms.length > 0 ? terms.map((term) => `${term}*`).join(" ") : "";
}

export function redactedIndexContent(content: string): string {
  try {
    const redacted = redactString(content);
    return redacted.length > 0 ? redacted : "[EMPTY]";
  } catch {
    return "[REDACTION_FAILED]";
  }
}

export function buildSessionSnippet(content: string, query: string): string {
  const redacted = redactedIndexContent(content).replace(/\s+/g, " ").trim();
  if (redacted.length <= MAX_SESSION_SEARCH_SNIPPET_LENGTH) return redacted;

  const needle = normalizeSessionSearchQuery(query).toLowerCase();
  const haystack = redacted.toLowerCase();
  const matchIndex = needle ? haystack.indexOf(needle) : -1;
  const prefix = "...";
  const suffix = "...";
  const budget = MAX_SESSION_SEARCH_SNIPPET_LENGTH - prefix.length - suffix.length;
  let start = matchIndex >= 0 ? Math.max(0, matchIndex - Math.floor(budget / 2)) : 0;
  start = Math.max(0, Math.min(start, Math.max(0, redacted.length - budget)));
  const end = Math.min(redacted.length, start + budget);

  const left = start > 0 ? prefix : "";
  const right = end < redacted.length ? suffix : "";
  const innerBudget = MAX_SESSION_SEARCH_SNIPPET_LENGTH - left.length - right.length;
  return `${left}${redacted.slice(start, start + innerBudget)}${right}`;
}

export function buildSessionSearchHit(input: BuildSessionSearchHitInput): SessionSearchHit {
  const { conversation, message, query } = input;
  const baseScore = Math.max(0, input.baseScore ?? 1);
  const matchedAt = message?.createdAt ?? conversation.updatedAt;
  const recencyBoost = Math.max(0, Date.parse(matchedAt) || 0) / 10_000_000_000_000;
  return SessionSearchHitSchema.parse({
    conversationId: conversation.id,
    messageId: message?.id,
    title: redactString(conversation.title),
    snippet: buildSessionSnippet(input.content ?? message?.content ?? "", query),
    score: Math.max(0, baseScore + recencyBoost),
    matchedAt,
    compressionGeneration: conversation.compressionGeneration ?? 0,
    parentConversationId: conversation.parentConversationId,
  });
}

export async function keywordSearchConversations(
  store: RectorStore,
  input: SessionSearchQuery,
): Promise<SessionSearchHit[]> {
  const query = normalizeSessionSearchQuery(input.query);
  const limit = normalizeSessionSearchLimit(input.limit);
  const conversations = await store.listConversations(input.workspaceId);

  if (!query) {
    const hits: SessionSearchHit[] = [];
    for (const conversation of conversations) {
      const messages = await store.listMessages(conversation.id);
      const latestMessage = messages.at(-1);
      hits.push(
        buildSessionSearchHit({
          conversation,
          message: latestMessage,
          content: latestMessage?.content ?? conversation.title,
          query,
          baseScore: 0,
        }),
      );
    }
    return hits.sort(byMatchedAtDesc).slice(0, limit);
  }

  const q = query.toLowerCase();
  const hits: SessionSearchHit[] = [];
  for (const conversation of conversations) {
    const messages = await store.listMessages(conversation.id);
    for (const message of messages) {
      const redactedContent = redactedIndexContent(message.content);
      if (!redactedContent.toLowerCase().includes(q)) continue;
      hits.push(
        buildSessionSearchHit({
          conversation,
          message,
          content: redactedContent,
          query,
          baseScore: 1,
        }),
      );
    }
  }

  return hits.sort(compareSessionSearchHits).slice(0, limit);
}

export async function searchSessions(
  store: RectorStore,
  input: SessionSearchQuery,
): Promise<SessionSearchHit[]> {
  const query = {
    ...input,
    query: normalizeSessionSearchQuery(input.query),
    limit: normalizeSessionSearchLimit(input.limit),
  };
  if (store.searchConversations) return store.searchConversations(query);
  return keywordSearchConversations(store, query);
}
