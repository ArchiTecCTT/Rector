import type {
  Artifact,
  Conversation,
  CreateArtifactInput,
  CreateConversationInput,
  CreateMessageInput,
  CreateRunInput,
  Message,
  Run,
  RunEvent,
  UpdateArtifactInput,
  UpdateConversationInput,
  UpdateMessageInput,
  UpdateRunInput,
} from "./schemas";

export * from "./schemas";
export * from "./inMemoryRectorStore";
export * from "./sqlRectorStore";

/**
 * The store contract shared by every Rector store implementation.
 *
 * Extracted byte-for-byte from the existing public async method surface of
 * `InMemoryRectorStore` so the in-memory store implements it without a single
 * signature change and remains the default and the test baseline.
 */
export interface RectorStore {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;
  listConversations(workspaceId?: string): Promise<Conversation[]>;
  updateConversation(id: string, patch: UpdateConversationInput): Promise<Conversation | undefined>;
  deleteConversation(id: string): Promise<boolean>;

  createMessage(input: CreateMessageInput): Promise<Message>;
  getMessage(id: string): Promise<Message | undefined>;
  listMessages(conversationId?: string): Promise<Message[]>;
  updateMessage(id: string, patch: UpdateMessageInput): Promise<Message | undefined>;
  deleteMessage(id: string): Promise<boolean>;

  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(conversationId?: string): Promise<Run[]>;
  updateRun(id: string, patch: UpdateRunInput): Promise<Run | undefined>;
  deleteRun(id: string): Promise<boolean>;
  commitRunTransition(
    runId: string,
    patch: UpdateRunInput,
    event: RunEvent
  ): Promise<{ run: Run; event: RunEvent }>;

  appendEvent(event: RunEvent): Promise<RunEvent>;
  getEvent(id: string): Promise<RunEvent | undefined>;
  listEvents(runId?: string): Promise<RunEvent[]>;
  deleteEvent(id: string): Promise<boolean>;

  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  listArtifacts(kind?: string): Promise<Artifact[]>;
  updateArtifact(id: string, patch: UpdateArtifactInput): Promise<Artifact | undefined>;
  deleteArtifact(id: string): Promise<boolean>;
}
