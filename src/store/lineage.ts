import { redactString } from "../security/redaction";
import type { Conversation } from "./schemas";
import type { RectorStore } from ".";

export const MAX_CONVERSATION_LINEAGE_DEPTH = 10;

export class ConversationLineageError extends Error {
  readonly name = "ConversationLineageError";
}

export interface ValidateParentConversationOptions {
  workspaceId?: string;
  maxDepth?: number;
}

export async function validateParentConversation(
  store: Pick<RectorStore, "getConversation">,
  childId: string,
  parentId: string,
  options: ValidateParentConversationOptions = {},
): Promise<void> {
  const maxDepth = options.maxDepth ?? MAX_CONVERSATION_LINEAGE_DEPTH;
  let current = await store.getConversation(parentId);
  if (!current) {
    throw new ConversationLineageError(`Parent conversation not found: ${redactString(parentId)}`);
  }
  if (options.workspaceId && current.workspaceId !== options.workspaceId) {
    throw new ConversationLineageError("Parent conversation must belong to the same workspace");
  }

  let depth = 0;
  const seen = new Set<string>();
  while (current) {
    if (current.id === childId || seen.has(current.id)) {
      throw new ConversationLineageError("Conversation lineage cycle detected");
    }
    seen.add(current.id);
    depth += 1;
    if (depth >= maxDepth) {
      throw new ConversationLineageError(`Conversation lineage exceeds maximum depth ${maxDepth}`);
    }
    if (!current.parentConversationId) return;
    current = await store.getConversation(current.parentConversationId);
    if (!current) {
      throw new ConversationLineageError("Conversation lineage references a missing parent");
    }
    if (options.workspaceId && current.workspaceId !== options.workspaceId) {
      throw new ConversationLineageError("Conversation lineage crosses workspace boundaries");
    }
  }
}

export async function getConversationLineage(
  store: Pick<RectorStore, "getConversation">,
  conversationId: string,
  options: { maxDepth?: number } = {},
): Promise<Conversation[]> {
  const maxDepth = options.maxDepth ?? MAX_CONVERSATION_LINEAGE_DEPTH;
  const lineage: Conversation[] = [];
  const seen = new Set<string>();
  let current = await store.getConversation(conversationId);

  while (current) {
    if (seen.has(current.id)) {
      throw new ConversationLineageError("Conversation lineage cycle detected");
    }
    seen.add(current.id);
    lineage.push(current);
    if (lineage.length > maxDepth) {
      throw new ConversationLineageError(`Conversation lineage exceeds maximum depth ${maxDepth}`);
    }
    if (!current.parentConversationId) break;
    current = await store.getConversation(current.parentConversationId);
    if (!current) {
      throw new ConversationLineageError("Conversation lineage references a missing parent");
    }
  }

  return lineage.reverse();
}
