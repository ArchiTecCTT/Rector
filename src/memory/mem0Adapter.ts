import { createRequire } from "node:module";

import type { MemoryProvider } from "./provider";
import {
  classifyAdapterError,
  mapToMemoryEntry,
  memoryEntryToMetadata,
  metadataToMemoryFields,
  redactMemoryContent,
  type MemoryAdapterDeps,
} from "./adapterBase";
import {
  compareMemoryPruneCandidates,
  compareMemorySearchResults,
  memoryPruneScore,
  normalizeMemorySearchLimit,
  sanitizeCreateMemoryEntryInput,
  sanitizeUpdateMemoryEntryInput,
} from "./entryUtils";
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
  let mod: any;
  try {
    mod = requireFromHere(OPTIONAL_MEM0_CLIENT);
  } catch {
    throw new Error(
      `The Mem0 memory path requires the optional "${OPTIONAL_MEM0_CLIENT}" dependency, which is ` +
        `not installed. Run \`npm install ${OPTIONAL_MEM0_CLIENT}\` to enable Mem0 memory, or ` +
        `use a local provider (in-memory or local-sqlite-mem) instead (no cloud account or network required).`,
    );
  }
  const MemoryClient = (typeof mod === "function" ? mod : mod.default) as
    | (new (opts: { apiKey: string }) => Mem0Client)
    | undefined;
  if (typeof MemoryClient !== "function") {
    throw new Error(
      `The Mem0 memory path requires the optional "${OPTIONAL_MEM0_CLIENT}" dependency, which is ` +
        `not installed. Run \`npm install ${OPTIONAL_MEM0_CLIENT}\` to enable Mem0 memory, or ` +
        `use a local provider (in-memory or local-sqlite-mem) instead (no cloud account or network required).`,
    );
  }
  return (apiKey: string) => new MemoryClient({ apiKey });
}

function defaultClientFactory(apiKey: string): Mem0Client {
  return loadMem0ClientFactory()(apiKey);
}

function normalizeRecord(raw: unknown): Mem0MemoryRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;

  // Some SDK versions wrap the actual record under `memory` or `data`.
  if (record.memory && typeof record.memory === "object") {
    return normalizeRecord(record.memory);
  }
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return normalizeRecord(record.data);
  }

  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  return {
    id: record.id,
    memory: typeof record.memory === "string" ? record.memory : undefined,
    content: typeof record.content === "string" ? record.content : undefined,
    metadata:
      record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined,
    created_at: typeof record.created_at === "string" ? record.created_at : undefined,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : undefined,
  };
}

function unwrapResults(payload: unknown): Mem0MemoryRecord[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      const normalized = normalizeRecord(item);
      return normalized ? [normalized] : [];
    });
  }
  if (!payload || typeof payload !== "object") return [];
  const objectPayload = payload as Record<string, unknown>;
  if (Array.isArray(objectPayload.results)) return unwrapResults(objectPayload.results);
  if (Array.isArray(objectPayload.memories)) return unwrapResults(objectPayload.memories);
  if (Array.isArray(objectPayload.data)) return unwrapResults(objectPayload.data);
  const normalized = normalizeRecord(objectPayload);
  return normalized ? [normalized] : [];
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

  /**
   * Best-effort API key buffer. V8 may have copied the original string into
   * internal structures before we receive it, so zeroing the buffer does NOT
   * guarantee the key is fully purged from memory. This is a defence-in-depth
   * measure — the known Node.js / V8 limitation is documented.
   */
  private readonly apiKeyBuffer: Buffer;
  private readonly nowFn: () => string;
  private readonly run: Run;
  private readonly clientFactory: Mem0ClientFactory;
  private readonly scopeUserId: string;
  private client: Mem0Client | undefined;

  constructor(options: Mem0MemoryProviderOptions) {
    this.id = options.id;
    this.kind = options.kind ?? "mem0";
    this.metadata = { id: options.id, kind: this.kind, label: options.label };
    this.apiKeyBuffer = Buffer.from(options.apiKey, "utf8");
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.run = options.run ?? defaultMemoryBudgetRun();
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.scopeUserId = `rector:${options.id}`;
  }

  /**
   * Zero the API key buffer. Best-effort: V8 may have copied the key string
   * before we received it, so this cannot guarantee full purging.
   */
  zeroKey(): void {
    this.apiKeyBuffer.fill(0);
  }

  /**
   * Close the adapter and zero the API key from memory (best-effort).
   */
  close(): void {
    this.zeroKey();
  }

  validateConfig(): void {
    if (this.apiKeyBuffer.length === 0 ||
        this.apiKeyBuffer.every((b: number) => b === 0)) {
      throw new Error("Mem0 memory provider requires an API key (secretRef must resolve to a non-empty value).");
    }
  }

  private getClient(): Mem0Client {
    if (!this.client) {
      try {
        this.client = this.clientFactory(this.apiKeyBuffer.toString("utf8"));
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
    const sanitized = sanitizeCreateMemoryEntryInput(input);
    const now = this.nowFn();
    const metadata = memoryEntryToMetadata({
      layer: sanitized.layer,
      timestamp: sanitized.timestamp ?? now,
      lastMentioned: sanitized.lastMentioned ?? now,
      accessCount: sanitized.accessCount ?? 0,
      tags: sanitized.tags ?? [],
      source: sanitized.source,
      metadata: sanitized.metadata ?? {},
    });
    try {
      const client = this.getClient();
      const result = await client.add(
        [{ role: "user", content: sanitized.content }],
        { userId: this.scopeUserId, metadata },
      );
      const records = unwrapResults(result);
      const created = records[0];
      if (created?.id) {
        const providerContent = recordContent(created);
        return mapToMemoryEntry(
          {
            id: created.id,
            layer: metadataToMemoryFields(created.metadata ?? metadata, now).layer,
            content: providerContent || sanitized.content,
            timestamp: created.created_at ?? sanitized.timestamp ?? now,
            lastMentioned: created.updated_at ?? sanitized.lastMentioned ?? created.created_at ?? now,
            accessCount: sanitized.accessCount ?? 0,
            tags: sanitized.tags ?? [],
            source: sanitized.source,
            metadata: sanitized.metadata ?? {},
          },
          this.nowFn,
        );
      }
      const id = normalizeRecord(result)?.id ?? `mem0-${Date.now().toString(36)}`;
      return mapToMemoryEntry(
        {
          id,
          layer: sanitized.layer,
          content: sanitized.content,
          timestamp: sanitized.timestamp ?? now,
          lastMentioned: sanitized.lastMentioned ?? now,
          accessCount: sanitized.accessCount ?? 0,
          tags: sanitized.tags ?? [],
          source: sanitized.source,
          metadata: sanitized.metadata ?? {},
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
      entries.sort(compareMemorySearchResults);
      return entries;
    } catch (error) {
      throw classifyAdapterError(error, "Mem0 listMemoryEntries failed");
    }
  }

  async updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined> {
    this.assertBudget("update");
    const current = await this.getMemoryEntry(id);
    if (!current) return undefined;
    const updated = mapToMemoryEntry(
      { ...current, ...sanitizeUpdateMemoryEntryInput(patch), id: current.id },
      this.nowFn,
    );
    const metadata = memoryEntryToMetadata(updated);
    try {
      await this.getClient().update(id, updated.content, { metadata });
      return updated;
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
    const { layer } = options;
    const limit = normalizeMemorySearchLimit(options.limit);
    try {
      let entries: MemoryEntry[];
      if (query && query.trim()) {
        const payload = await this.getClient().search(redactMemoryContent(query), {
          filters: { user_id: this.scopeUserId },
          limit,
        });
        entries = unwrapResults(payload).map((r) => this.toEntry(r));
      } else {
        entries = await this.listMemoryEntries(layer);
      }
      if (layer) entries = entries.filter((e) => e.layer === layer);
      entries.sort(compareMemorySearchResults);
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

    const pruneNow = this.nowFn();
    const scored = layerEntries.map((entry) => ({ entry, score: memoryPruneScore(entry, pruneNow) }));
    scored.sort(compareMemoryPruneCandidates);

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