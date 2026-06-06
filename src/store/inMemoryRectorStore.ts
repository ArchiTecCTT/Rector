import {
  ArtifactSchema,
  ConversationSchema,
  MessageSchema,
  RunEventSchema,
  RunSchema,
  type Artifact,
  type Conversation,
  type CreateArtifactInput,
  type CreateConversationInput,
  type CreateMessageInput,
  type CreateRunInput,
  type Message,
  type Run,
  type RunEvent,
  type UpdateArtifactInput,
  type UpdateConversationInput,
  type UpdateMessageInput,
  type UpdateRunInput,
} from "./schemas";
import type { RectorStore } from "./index";

type IdPrefix = "conv" | "msg" | "run" | "art";

export type InMemoryRectorStoreOptions = {
  now?: () => string;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryRectorStore implements RectorStore {
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, Message>();
  private runs = new Map<string, Run>();
  private events = new Map<string, RunEvent>();
  private artifacts = new Map<string, Artifact>();
  private counters: Record<IdPrefix, number> = {
    conv: 0,
    msg: 0,
    run: 0,
    art: 0,
  };

  constructor(private readonly options: InMemoryRectorStoreOptions = {}) {}

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const now = this.now();
    const conversation = ConversationSchema.parse({
      ...clone(input),
      id: this.nextId("conv"),
      createdAt: now,
      updatedAt: now,
    });
    this.conversations.set(conversation.id, clone(conversation));
    return clone(conversation);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return this.cloneFromMap(this.conversations, id);
  }

  /**
   * Lists conversations.
   * Returns conversations in insertion/creation order.
   */
  async listConversations(workspaceId?: string): Promise<Conversation[]> {
    return Array.from(this.conversations.values())
      .filter((conversation) => workspaceId === undefined || conversation.workspaceId === workspaceId)
      .map(clone);
  }

  async updateConversation(id: string, patch: UpdateConversationInput): Promise<Conversation | undefined> {
    const current = this.conversations.get(id);
    if (!current) return undefined;

    const updated = ConversationSchema.parse({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    });
    this.conversations.set(id, clone(updated));
    return clone(updated);
  }

  /**
   * Deletes a conversation.
   * Note: This is a shallow deletion and does not cascade-delete associated messages, runs, or events.
   */
  async deleteConversation(id: string): Promise<boolean> {
    return this.conversations.delete(id);
  }

  async createMessage(input: CreateMessageInput): Promise<Message> {
    const message = MessageSchema.parse({
      ...clone(input),
      id: this.nextId("msg"),
      createdAt: this.now(),
    });
    this.messages.set(message.id, clone(message));
    return clone(message);
  }

  async getMessage(id: string): Promise<Message | undefined> {
    return this.cloneFromMap(this.messages, id);
  }

  /**
   * Lists messages.
   * Returns messages in insertion/creation order.
   */
  async listMessages(conversationId?: string): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter((message) => conversationId === undefined || message.conversationId === conversationId)
      .map(clone);
  }

  async updateMessage(id: string, patch: UpdateMessageInput): Promise<Message | undefined> {
    const current = this.messages.get(id);
    if (!current) return undefined;

    const updated = MessageSchema.parse({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      createdAt: current.createdAt,
    });
    this.messages.set(id, clone(updated));
    return clone(updated);
  }

  /**
   * Deletes a message.
   * Note: This is a shallow deletion and does not cascade-delete other related entities.
   */
  async deleteMessage(id: string): Promise<boolean> {
    return this.messages.delete(id);
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const now = this.now();
    const run = RunSchema.parse({
      ...clone(input),
      id: this.nextId("run"),
      createdAt: now,
      updatedAt: now,
    });
    this.runs.set(run.id, clone(run));
    return clone(run);
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.cloneFromMap(this.runs, id);
  }

  /**
   * Lists runs.
   * Returns runs in insertion/creation order.
   */
  async listRuns(conversationId?: string): Promise<Run[]> {
    return Array.from(this.runs.values())
      .filter((run) => conversationId === undefined || run.conversationId === conversationId)
      .map(clone);
  }

  async updateRun(id: string, patch: UpdateRunInput): Promise<Run | undefined> {
    const current = this.runs.get(id);
    if (!current) return undefined;

    const updated = RunSchema.parse({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    });
    this.runs.set(id, clone(updated));
    return clone(updated);
  }

  /**
   * Deletes a run.
   * Note: This is a shallow deletion and does not cascade-delete associated run events.
   */
  async deleteRun(id: string): Promise<boolean> {
    return this.runs.delete(id);
  }

  /**
   * Atomically commits a run update and appends a run transition event.
   * Ensures that if the event append fails (e.g. duplicate event ID), the run remains unchanged.
   */
  async commitRunTransition(
    runId: string,
    patch: UpdateRunInput,
    event: RunEvent
  ): Promise<{ run: Run; event: RunEvent }> {
    const current = this.runs.get(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }

    const updated = RunSchema.parse({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    });

    const parsedEvent = RunEventSchema.parse(clone(event));
    if (this.events.has(parsedEvent.id)) {
      throw new Error(`Duplicate event ID: ${parsedEvent.id}`);
    }

    this.runs.set(runId, clone(updated));
    this.events.set(parsedEvent.id, clone(parsedEvent));

    return {
      run: clone(updated),
      event: clone(parsedEvent),
    };
  }

  /**
   * Appends an event to the run's event log.
   * Rejects events with duplicate IDs to preserve event log integrity.
   */
  async appendEvent(event: RunEvent): Promise<RunEvent> {
    const parsed = RunEventSchema.parse(clone(event));
    if (this.events.has(parsed.id)) {
      throw new Error(`Duplicate event ID: ${parsed.id}`);
    }
    this.events.set(parsed.id, clone(parsed));
    return clone(parsed);
  }

  async getEvent(id: string): Promise<RunEvent | undefined> {
    return this.cloneFromMap(this.events, id);
  }

  /**
   * Lists events.
   * Returns events in insertion order.
   */
  async listEvents(runId?: string): Promise<RunEvent[]> {
    return Array.from(this.events.values())
      .filter((event) => runId === undefined || event.runId === runId)
      .map(clone);
  }

  async deleteEvent(id: string): Promise<boolean> {
    return this.events.delete(id);
  }

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const artifact = ArtifactSchema.parse({
      ...clone(input),
      id: this.nextId("art"),
      createdAt: this.now(),
    });
    this.artifacts.set(artifact.id, clone(artifact));
    return clone(artifact);
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    return this.cloneFromMap(this.artifacts, id);
  }

  /**
   * Lists artifacts.
   * Returns artifacts in insertion/creation order.
   */
  async listArtifacts(kind?: string): Promise<Artifact[]> {
    return Array.from(this.artifacts.values())
      .filter((artifact) => kind === undefined || artifact.kind === kind)
      .map(clone);
  }

  async updateArtifact(id: string, patch: UpdateArtifactInput): Promise<Artifact | undefined> {
    const current = this.artifacts.get(id);
    if (!current) return undefined;

    const updated = ArtifactSchema.parse({
      ...clone(current),
      ...clone(patch),
      id: current.id,
      createdAt: current.createdAt,
    });
    this.artifacts.set(id, clone(updated));
    return clone(updated);
  }

  async deleteArtifact(id: string): Promise<boolean> {
    return this.artifacts.delete(id);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private nextId(prefix: IdPrefix): string {
    this.counters[prefix] += 1;
    return `${prefix}-${this.counters[prefix]}`;
  }

  private cloneFromMap<T>(map: Map<string, T>, id: string): T | undefined {
    const value = map.get(id);
    return value === undefined ? undefined : clone(value);
  }
}
