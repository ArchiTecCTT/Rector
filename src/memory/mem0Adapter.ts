import { createRequire } from "node:module";

import type { MemoryProvider } from "./provider";
import {
  classifyAdapterError,
  mapToMemoryEntry,
  memoryEntryToMetadata,
  metadataToMemoryFields,
  type MemoryAdapterDeps,
} from "./adapterBase";
import { evaluateMemoryBudget, MEMORY_OP_COST_USD, type MemoryBudgetOperation } from "./budget";
import { defaultMemoryBudgetRun } from "./defaultRun";
import type { MemoryProviderConfig } from "../providers/memoryConfig";
import type {
  CreateMemoryEntryInput,
  MemoryEntry,
  MemoryLayer,
  Run,
  UpdateMemoryEntryInput,
} from "../store/schemas";

// ---------------------------------------------------------------------------
// Mem0 client surface (declared locally — optional dep not in module graph)
// ---------------------------------------------------------------------------

export interface Mem0MemoryRecord {
  id: string;
  memory?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface Mem0Client {
  add(
    messages: Array<{ role: string; content: string }>,
    options?: { userId?: string; metadata?: Record<string, unknown> },
  ): Promise<{ id?: string; results?: Array<{ id: string }> } | Mem0MemoryRecord[]>;
  search(
    query: string,
    options?: { filters?: Record<string, unknown>; limit?: number },
  ): Promise<{ results: Mem0MemoryRecord[] } | Mem0MemoryRecord[]>;
  get(id: string): Promise<Mem0MemoryRecord | null | undefined>;
  getAll(options?: { filters?: Record<string, unknown> }): Promise<{ results: Mem0MemoryRecord[] } | Mem0MemoryRecord[]>;
  update(id: string, content: string, options?: { metadata?: Record<string, unknown> }): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

export type Mem0ClientFactory = (apiKey: string) => Mem0Client;

const OPTIONAL_MEM0_CLIENT = "mem0ai";

function loadMem0ClientFactory(): Mem0ClientFactory {
  const requireFromHere = createRequire(import.meta.url);
  try {
    const mod = requireFromHere(OPTIONAL_MEM0_CLIENT) as
      | { default?: new (opts: { apiKey: string }) => Mem0Client }
      | (new (opts: { apiKey: string }) => Mem0Client);
    const MemoryClient = (typeof mod === "function" ? mod : mod.default) as
      | (new (opts: { apiKey: string }) => Mem0Client)
      | undefined;
    if (typeof MemoryClient !== "function") {
      throw new Error("module did not export MemoryClient");
    }
    return (apiKey: string) => new MemoryClient({ apiKey });
  } catch {
    throw new Error(
      `The Mem0 memory path requires the optional "${OPTIONAL_MEM0_CLIENT}" dependency, which is ` +
        `not installed. Run \`npm install ${OPTIONAL_MEM0_CLIENT}\` to enable Mem0 memory, or ` +
        `use a local provider (in-memory or local-sqlite-mem) instead (no cloud account or network required).`,
    );
  }
}

function defaultClientFactory(apiKey: string): Mem0Client {
  return loadMem0ClientFactory()(apiKey);
}

function unwrapResults(payload: { results: Mem0MemoryRecord[] } | Mem0MemoryRecord[]): Mem0MemoryRecord[] {
  return Array.isArray(payload) ? payload : payload.results ?? [];
}

function recordContent(record: Mem0MemoryRecord): string {
  return record.memory ?? record.content ?? "";
}

export interface Mem0MemoryProviderOptions extends MemoryAdapterDeps<Mem0Client> {
  id: string;
  kind?: string;
  label?: string;
  apiKey: string;
  config?: MemoryProviderConfig;
  now?: () => string;
  run?: Run;
  clientFactory?: Mem0ClientFactory;
}

/**
 * Mem0 cloud memory adapter. Lazy-requires `mem0ai` at first use; tests inject
 * a deterministic client factory to avoid network and optional deps.
 */
export class Mem0MemoryProvider implements MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };

  private readonly apiKey: string;
  private readonly nowFn: () => string;
  private readonly run: Run;
  private readonly clientFactory: Mem0ClientFactory;
  private readonly scopeUserId: string;
  private client: Mem0Client | undefined;

  constructor(options: Mem0MemoryProviderOptions) {
    this.id = options.id;
    this.kind = options.kind ?? "mem0";
    this.metadata = { id: options.id, kind: this.kind, label: options.label };
    this.apiKey = options.apiKey;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.run = options.run ?? defaultMemoryBudgetRun();
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.scopeUserId = `rector:${options.id}`;
  }

  validateConfig(): void {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error("Mem0 memory provider requires an API key (secretRef must resolve to a non-empty value).");
    }
  }

  private getClient(): Mem0Client {
    if (!this.client) {
      try {
        this.client = this.clientFactory(this.apiKey);
      } catch (error) {
        throw classifyAdapterError(error, "Mem0 client initialization failed");
      }
    }
    return this.client;
  }

  private assertBudget(op: MemoryBudgetOperation): void {
    const decision = evaluateMemoryBudget(this.run, {
      estimatedUsd: MEMORY_OP_COST_USD[op],
      provider: this.kind,
    });
    if (decision.status === "denied") {
      throw classifyAdapterError(new Error(decision.reasons.join("; ")), "Memory budget denied");
    }
  }

  private toEntry(record: Mem0MemoryRecord): MemoryEntry {
    const fields = metadataToMemoryFields(record.metadata, this.nowFn());
    return mapToMemoryEntry(
      {
        id: record.id,
        layer: fields.layer,
        content: recordContent(record),
        timestamp: fields.timestamp ?? record.created_at,
        lastMentioned: fields.lastMentioned ?? record.updated_at ?? record.created_at,
        accessCount: fields.accessCount,
        tags: fields.tags,
        source: fields.source,
        metadata: fields.extraMetadata,
      },
      this.nowFn,
    );
  }

  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    this.assertBudget("create");
    const now = this.nowFn();
    const metadata = memoryEntryToMetadata({
      layer: input.layer,
      timestamp: input.timestamp ?? now,
      lastMentioned: input.lastMentioned ?? now,
      accessCount: input.accessCount ?? 0,
      tags: input.tags ?? [],
      source: input.source,
      metadata: input.metadata ?? {},
    });
    try {
      const client = this.getClient();
      const result = await client.add(
        [{ role: "user", content: input.content }],
        { userId: this.scopeUserId, metadata },
      );
      const records = unwrapResults(result as { results: Mem0MemoryRecord[] } | Mem0MemoryRecord[]);
      const created = records[0];
      if (created?.id) {
        const entry = this.toEntry(created);
        if (!entry.content && input.content) {
          return mapToMemoryEntry({ ...entry, content: input.content }, this.nowFn);
        }
        return entry;
      }
      const id = (result as { id?: string }).id ?? `mem0-${Date.now().toString(36)}`;
      return mapToMemoryEntry(
        {
          id,
          layer: input.layer,
          content: input.content,
          timestamp: input.timestamp ?? now,
          lastMentioned: input.lastMentioned ?? now,
          accessCount: input.accessCount ?? 0,
          tags: input.tags ?? [],
          source: input.source,
          metadata: input.metadata ?? {},
        },
        this.nowFn,
      );
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 createMemoryEntry failed");
    }
  }

  async getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
    this.assertBudget("read");
    try {
      const record = await this.getClient().get(id);
      if (!record) return undefined;
      return this.toEntry(record);
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 getMemoryEntry failed");
    }
  }

  async listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    this.assertBudget("list");
    try {
      const payload = await this.getClient().getAll({ filters: { user_id: this.scopeUserId } });
      let entries = unwrapResults(payload).map((r) => this.toEntry(r));
      if (layer) entries = entries.filter((e) => e.layer === layer);
      return entries;
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 listMemoryEntries failed");
    }
  }

  async updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined> {
    this.assertBudget("update");
    const current = await this.getMemoryEntry(id);
    if (!current) return undefined;
    const updated = { ...current, ...patch, id: current.id };
    const metadata = memoryEntryToMetadata(updated);
    try {
      await this.getClient().update(id, updated.content, { metadata });
      return mapToMemoryEntry(updated, this.nowFn);
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 updateMemoryEntry failed");
    }
  }

  async deleteMemoryEntry(id: string): Promise<boolean> {
    this.assertBudget("delete");
    try {
      await this.getClient().delete(id);
      return true;
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 deleteMemoryEntry failed");
    }
  }

  async searchMemory(
    query?: string,
    options: { layer?: MemoryLayer; limit?: number } = {},
  ): Promise<MemoryEntry[]> {
    this.assertBudget("search");
    const { layer, limit = 20 } = options;
    try {
      let entries: MemoryEntry[];
      if (query && query.trim()) {
        const payload = await this.getClient().search(query, {
          filters: { user_id: this.scopeUserId },
          limit,
        });
        entries = unwrapResults(payload).map((r) => this.toEntry(r));
      } else {
        entries = await this.listMemoryEntries(layer);
      }
      if (layer) entries = entries.filter((e) => e.layer === layer);
      entries.sort((a, b) => {
        const scoreA = a.accessCount * 2 + (Date.parse(a.lastMentioned) || 0);
        const scoreB = b.accessCount * 2 + (Date.parse(b.lastMentioned) || 0);
        return scoreB - scoreA;
      });
      return entries.slice(0, limit);
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 searchMemory failed");
    }
  }

  async pruneMemory(options: { targetLayer?: MemoryLayer; maxEntries?: number } = {}): Promise<{
    pruned: number;
    summarized: number;
  }> {
    this.assertBudget("prune");
    const { targetLayer = "episodic", maxEntries = 100 } = options;
    const layerEntries = await this.listMemoryEntries(targetLayer);
    if (layerEntries.length <= maxEntries) {
      return { pruned: 0, summarized: 0 };
    }

    const now = Date.now();
    const scored = layerEntries.map((entry) => {
      const ageMs = now - (Date.parse(entry.timestamp) || now);
      const recency = Math.max(0, 100 - Math.floor(ageMs / (1000 * 60 * 60 * 24)));
      const accessBonus = Math.min(entry.accessCount * 3, 50);
      const noteBonus = entry.source === "user-note" || entry.tags.includes("note") ? 30 : 0;
      return { entry, score: recency + accessBonus + noteBonus };
    });
    scored.sort((a, b) => a.score - b.score);

    let pruned = 0;
    let summarized = 0;
    const toPrune = scored.slice(0, Math.max(0, layerEntries.length - maxEntries));

    for (const { entry } of toPrune) {
      if (entry.accessCount > 2 && entry.layer === "episodic") {
        await this.createMemoryEntry({
          layer: "core",
          content: `[summary] ${entry.content.slice(0, 120)}... (from ${entry.timestamp})`,
          timestamp: this.nowFn(),
          tags: [...entry.tags, "auto-summary"],
          source: "prune",
          metadata: { originalId: entry.id, originalLayer: entry.layer },
        });
        summarized++;
      }
      await this.deleteMemoryEntry(entry.id);
      pruned++;
    }

    return { pruned, summarized };
  }
}