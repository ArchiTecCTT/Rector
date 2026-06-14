import type {
  CreateMemoryEntryInput,
  MemoryEntry,
  MemoryLayer,
  UpdateMemoryEntryInput,
} from "../store/schemas";
import { MemoryEntrySchema } from "../store/schemas";
import {
  compareMemoryPruneCandidates,
  compareMemorySearchResults,
  memoryPruneScore,
  normalizeMemorySearchLimit,
  sanitizeCreateMemoryEntryInput,
  sanitizeUpdateMemoryEntryInput,
} from "./entryUtils";

/**
 * MemoryProvider (Chunk 34 runtime interface).
 *
 * The pluggable contract for "agent memory" backends used by neuro features
 * (notes, episodic context for preprocessor/planner/contextBuilder, prune,
 * future ponder/subconscious input, etc.).
 *
 * This is intentionally separate from RectorStore (which owns convos/runs +
 * the durable "memories" table for sqlite/tidb drivers). A MemoryProvider can
 * be local-inmemory (default, identical to pre-34), local-sqlite (delegating
 * to the now-implemented sql memory methods), or an external service (Mem0,
 * TiDB memory, etc.).
 *
 * All implementations must:
 * - Respect redaction on content (callers are also responsible).
 * - Support an optional deterministic `now` for tests.
 * - Be safe to use in Local_Mode (no network, no secrets for the default).
 */

export interface MemoryProvider {
  readonly kind: string;
  readonly id: string; // the record id that produced this instance

  createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
  listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]>;
  updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined>;
  deleteMemoryEntry(id: string): Promise<boolean>;

  searchMemory(
    query?: string,
    options?: { layer?: MemoryLayer; limit?: number },
  ): Promise<MemoryEntry[]>;

  pruneMemory(options?: {
    targetLayer?: MemoryLayer;
    maxEntries?: number;
  }): Promise<{ pruned: number; summarized: number }>;

  /** Optional hook for providers that want to validate their (non-secret) config at construction time. */
  validateConfig?(): void;

  /** Metadata for observability / traces. */
  readonly metadata: {
    id: string;
    kind: string;
    label?: string;
  };
}

/**
 * Options for constructing a LocalMemoryProvider (or other impls).
 */
export interface MemoryProviderOptions {
  id: string;
  kind: string;
  label?: string;
  /** Injectable clock for deterministic tests (defaults to ISO now). */
  now?: () => string;
}

/**
 * LocalMemoryProvider — the default zero-config, zero-network implementation.
 *
 * For kind === 'local-inmemory': pure in-memory Map (exact reproduction of the
 * Chunk 27 logic that lived in InMemoryRectorStore so that notes, context
 * enrichment, prune scoring, auto core summaries, time fields, etc. behave
 * identically for the local baseline).
 *
 * For kind === 'local-sqlite-mem': delegates the 7 methods to a provided
 * (or internally constructed) RectorStore that has the memory methods
 * (post the Chunk 27 backfill into SqlRectorStore). This gives durable local
 * memory without requiring an external service.
 *
 * All other kinds should be provided by the bridge as stubs or real adapters.
 */
export class LocalMemoryProvider implements MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };

  private readonly nowFn: () => string;
  private readonly memories = new Map<string, MemoryEntry>();
  private seq = 0;

  // When delegating (local-sqlite-mem), we forward to this store's memory surface.
  private readonly delegateStore?: {
    createMemoryEntry(i: CreateMemoryEntryInput): Promise<MemoryEntry>;
    getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
    listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]>;
    updateMemoryEntry(id: string, p: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined>;
    deleteMemoryEntry(id: string): Promise<boolean>;
    searchMemory(q?: string, o?: { layer?: MemoryLayer; limit?: number }): Promise<MemoryEntry[]>;
    pruneMemory(o?: { targetLayer?: MemoryLayer; maxEntries?: number }): Promise<{ pruned: number; summarized: number }>;
  };

  constructor(options: MemoryProviderOptions & { delegate?: any }) {
    this.id = options.id;
    this.kind = options.kind;
    this.metadata = { id: options.id, kind: options.kind, label: options.label };
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.delegateStore = options.delegate;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`;
  }

  private clone<T>(v: T): T {
    return structuredClone(v);
  }

  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    const sanitized = sanitizeCreateMemoryEntryInput(input);
    if (this.delegateStore) {
      return this.delegateStore.createMemoryEntry(sanitized);
    }
    const now = this.nowFn();
    const entry = MemoryEntrySchema.parse({
      ...this.clone(sanitized),
      id: this.nextId("mem"),
      accessCount: sanitized.accessCount ?? 0,
      lastMentioned: sanitized.lastMentioned ?? now,
      timestamp: sanitized.timestamp ?? now,
      tags: sanitized.tags ?? [],
      metadata: sanitized.metadata ?? {},
    });
    this.memories.set(entry.id, this.clone(entry));
    return this.clone(entry);
  }

  async getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
    if (this.delegateStore) return this.delegateStore.getMemoryEntry(id);
    const e = this.memories.get(id);
    return e ? this.clone(e) : undefined;
  }

  async listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    if (this.delegateStore) return this.delegateStore.listMemoryEntries(layer);
    return Array.from(this.memories.values())
      .filter((e) => layer === undefined || e.layer === layer)
      .map((e) => this.clone(e));
  }

  async updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined> {
    if (this.delegateStore) return this.delegateStore.updateMemoryEntry(id, patch);
    const current = this.memories.get(id);
    if (!current) return undefined;
    const updated = MemoryEntrySchema.parse({
      ...this.clone(current),
      ...this.clone(sanitizeUpdateMemoryEntryInput(patch)),
      id: current.id,
    });
    this.memories.set(id, this.clone(updated));
    return this.clone(updated);
  }

  async deleteMemoryEntry(id: string): Promise<boolean> {
    if (this.delegateStore) return this.delegateStore.deleteMemoryEntry(id);
    return this.memories.delete(id);
  }

  async searchMemory(
    query?: string,
    options: { layer?: MemoryLayer; limit?: number } = {},
  ): Promise<MemoryEntry[]> {
    if (this.delegateStore) return this.delegateStore.searchMemory(query, options);

    const { layer } = options;
    const limit = normalizeMemorySearchLimit(options.limit);
    let results = Array.from(this.memories.values());

    if (layer) results = results.filter((e) => e.layer === layer);

    if (query && query.trim()) {
      const q = query.toLowerCase();
      results = results.filter(
        (e) =>
          e.content.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)) ||
          (e.source && e.source.toLowerCase().includes(q)),
      );
    }

    results.sort(compareMemorySearchResults);

    return results.slice(0, limit).map((e) => this.clone(e));
  }

  async pruneMemory(options: { targetLayer?: MemoryLayer; maxEntries?: number } = {}): Promise<{
    pruned: number;
    summarized: number;
  }> {
    if (this.delegateStore) return this.delegateStore.pruneMemory(options);

    const { targetLayer = "episodic", maxEntries = 100 } = options;
    const layerEntries = Array.from(this.memories.values()).filter((e) => e.layer === targetLayer);

    if (layerEntries.length <= maxEntries) {
      return { pruned: 0, summarized: 0 };
    }

    const pruneNow = this.nowFn();
    const scored = layerEntries.map((entry) => ({ entry, score: memoryPruneScore(entry, pruneNow) }));

    scored.sort(compareMemoryPruneCandidates); // lowest first (most prunable)

    let pruned = 0;
    let summarized = 0;
    const toPrune = scored.slice(0, Math.max(0, layerEntries.length - maxEntries));

    for (const { entry } of toPrune) {
      if (entry.accessCount > 2 && entry.layer === "episodic") {
        const summaryContent = `[summary] ${entry.content.slice(0, 120)}... (from ${entry.timestamp})`;
        await this.createMemoryEntry({
          layer: "core",
          content: summaryContent,
          timestamp: this.nowFn(),
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

  validateConfig(): void {
    // Local kinds are always valid (no external creds required for the default).
  }
}

/**
 * Minimal stub for external memory providers (Mem0, TiDB memory, etc.).
 * Construction succeeds (so the UI can save the record), but any actual
 * memory operation throws a clear, redacted error until a real adapter is
 * supplied (via stack credits or later chunk).
 */
export class ExternalMemoryProviderStub implements MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };

  private readonly labelForError: string;

  constructor(opts: { id: string; kind: string; label?: string }) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.metadata = { id: opts.id, kind: opts.kind, label: opts.label };
    this.labelForError = opts.label || opts.kind;
  }

  private notImplemented(): never {
    throw new Error(
      `Memory provider "${this.labelForError}" (${this.kind}) is not fully implemented in this build. ` +
        `Configure a local provider (in-memory or local-sqlite-mem) or provide the optional client + credentials via the UI.`,
    );
  }

  async createMemoryEntry(): Promise<MemoryEntry> {
    this.notImplemented();
  }
  async getMemoryEntry(): Promise<MemoryEntry | undefined> {
    this.notImplemented();
  }
  async listMemoryEntries(): Promise<MemoryEntry[]> {
    this.notImplemented();
  }
  async updateMemoryEntry(): Promise<MemoryEntry | undefined> {
    this.notImplemented();
  }
  async deleteMemoryEntry(): Promise<boolean> {
    this.notImplemented();
  }
  async searchMemory(): Promise<MemoryEntry[]> {
    this.notImplemented();
  }
  async pruneMemory(): Promise<{ pruned: number; summarized: number }> {
    this.notImplemented();
  }
  validateConfig(): void {
    // Stubs accept any config at save time; real validation happens on first use or via test-connection.
  }
}
