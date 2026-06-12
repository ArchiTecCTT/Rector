import {
  ArtifactSchema,
  ConversationSchema,
  MemoryEntrySchema,
  MessageSchema,
  RunEventSchema,
  RunSchema,
  type Artifact,
  type Conversation,
  type CreateArtifactInput,
  type CreateConversationInput,
  type CreateMemoryEntryInput,
  type CreateMessageInput,
  type CreateRunInput,
  type MemoryEntry,
  type MemoryLayer,
  type Message,
  type Run,
  type RunEvent,
  type UpdateArtifactInput,
  type UpdateConversationInput,
  type UpdateMemoryEntryInput,
  type UpdateMessageInput,
  type UpdateRunInput,
} from "./schemas";
import type { RectorStore } from "./index";
import {
  compareMemoryPruneCandidates,
  compareMemorySearchResults,
  memoryPruneScore,
  normalizeMemorySearchLimit,
  sanitizeCreateMemoryEntryInput,
  sanitizeUpdateMemoryEntryInput,
} from "../memory/entryUtils";

type IdPrefix = "conv" | "msg" | "run" | "art" | "mem";

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
  private memories = new Map<string, MemoryEntry>();
  private counters: Record<IdPrefix, number> = {
    conv: 0,
    msg: 0,
    run: 0,
    art: 0,
    mem: 0,
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

  // === Advanced Memory (Chunk 27 / neuro-symbolic Step 2) ===
  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    const now = this.now();
    const sanitized = sanitizeCreateMemoryEntryInput(input);
    const entry = MemoryEntrySchema.parse({
      ...clone(sanitized),
      id: this.nextId("mem"),
      accessCount: sanitized.accessCount ?? 0,
      lastMentioned: sanitized.lastMentioned ?? now,
      timestamp: sanitized.timestamp ?? now,
      tags: sanitized.tags ?? [],
      metadata: sanitized.metadata ?? {},
    });
    this.memories.set(entry.id, clone(entry));
    return clone(entry);
  }

  async getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
    return this.cloneFromMap(this.memories, id);
  }

  async listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    return Array.from(this.memories.values())
      .filter((e) => layer === undefined || e.layer === layer)
      .map(clone);
  }

  async updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined> {
    const current = this.memories.get(id);
    if (!current) return undefined;

    const updated = MemoryEntrySchema.parse({
      ...clone(current),
      ...clone(sanitizeUpdateMemoryEntryInput(patch)),
      id: current.id,
    });
    this.memories.set(id, clone(updated));
    return clone(updated);
  }

  async deleteMemoryEntry(id: string): Promise<boolean> {
    return this.memories.delete(id);
  }

  async searchMemory(query?: string, options: { layer?: MemoryLayer; limit?: number } = {}): Promise<MemoryEntry[]> {
    const { layer } = options;
    const limit = normalizeMemorySearchLimit(options.limit);
    let results = Array.from(this.memories.values());

    if (layer) {
      results = results.filter((e) => e.layer === layer);
    }

    if (query && query.trim()) {
      const q = query.toLowerCase();
      results = results.filter((e) =>
        e.content.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)) ||
        (e.source && e.source.toLowerCase().includes(q))
      );
    }

    results.sort(compareMemorySearchResults);

    return results.slice(0, limit).map(clone);
  }

  async pruneMemory(options: { targetLayer?: MemoryLayer; maxEntries?: number } = {}): Promise<{ pruned: number; summarized: number }> {
    const { targetLayer = "episodic", maxEntries = 100 } = options;
    const layerEntries = Array.from(this.memories.values()).filter((e) => e.layer === targetLayer);

    if (layerEntries.length <= maxEntries) {
      return { pruned: 0, summarized: 0 };
    }

    const pruneNow = this.now();
    const scored = layerEntries.map((entry) => ({ entry, score: memoryPruneScore(entry, pruneNow) }));

    scored.sort(compareMemoryPruneCandidates); // lowest first

    let pruned = 0;
    let summarized = 0;
    const toPrune = scored.slice(0, Math.max(0, layerEntries.length - maxEntries));

    for (const { entry } of toPrune) {
      // Simple "summarize" for alpha: if high enough access, move a stub summary to core
      if (entry.accessCount > 2 && entry.layer === "episodic") {
        const summaryContent = `[summary] ${entry.content.slice(0, 120)}... (from ${entry.timestamp})`;
        await this.createMemoryEntry({
          layer: "core",
          content: summaryContent,
          timestamp: this.now(),
          tags: [...entry.tags, "auto-summary"],
          source: "prune",
          metadata: { originalId: entry.id, originalLayer: entry.layer },
        });
        summarized++;
      }
      this.memories.delete(entry.id);
      pruned++;
    }

    return { pruned, summarized };
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
