import { createRequire } from "node:module";

import type { MemoryProvider } from "./provider";
import { validateProviderUrl, BLOCKED_HOSTNAMES, isPrivateIp } from "../security/ssrfProtection.js";
import { isIP } from "node:net";
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
// Chroma client surface (declared locally — optional dep not in module graph)
// ---------------------------------------------------------------------------

export interface ChromaQueryResult {
  ids: string[][];
  documents: (string | null)[][];
  metadatas: (Record<string, unknown> | null)[][];
  distances?: number[][];
}

export interface ChromaCollection {
  add(input: {
    ids: string[];
    documents: string[];
    metadatas?: Record<string, string | number | boolean>[];
  }): Promise<void>;
  get(input?: { ids?: string[]; where?: Record<string, unknown> }): Promise<{
    ids: string[];
    documents: (string | null)[];
    metadatas: (Record<string, unknown> | null)[];
  }>;
  query(input: {
    queryTexts: string[];
    nResults: number;
    where?: Record<string, unknown>;
  }): Promise<ChromaQueryResult>;
  update(input: {
    ids: string[];
    documents?: string[];
    metadatas?: Record<string, string | number | boolean>[];
  }): Promise<void>;
  delete(input: { ids: string[] }): Promise<void>;
}

export interface ChromaClient {
  getOrCreateCollection(input: { name: string }): Promise<ChromaCollection>;
}

export interface ChromaClientConnectOptions {
  path?: string;
  auth?: { provider: string; credentials: string };
}

export type ChromaClientFactory = (options: ChromaClientConnectOptions) => ChromaClient;

const OPTIONAL_CHROMA_CLIENT = "chromadb";

function loadChromaClientFactory(): ChromaClientFactory {
  const requireFromHere = createRequire(import.meta.url);
  try {
    const mod = requireFromHere(OPTIONAL_CHROMA_CLIENT) as {
      ChromaClient?: new (opts: ChromaClientConnectOptions) => ChromaClient;
      default?: { ChromaClient?: new (opts: ChromaClientConnectOptions) => ChromaClient };
    };
    const ChromaClientCtor = mod.ChromaClient ?? mod.default?.ChromaClient;
    if (typeof ChromaClientCtor !== "function") {
      throw new Error("module did not export ChromaClient");
    }
    return (options) => new ChromaClientCtor(options);
  } catch {
    throw new Error(
      `The Chroma memory path requires the optional "${OPTIONAL_CHROMA_CLIENT}" dependency, which is ` +
        `not installed. Run \`npm install ${OPTIONAL_CHROMA_CLIENT}\` to enable Chroma memory, or ` +
        `use a local provider (in-memory or local-sqlite-mem) instead (no cloud account or network required).`,
    );
  }
}

function defaultClientFactory(options: ChromaClientConnectOptions): ChromaClient {
  return loadChromaClientFactory()(options);
}

function collectionNameForRecord(recordId: string): string {
  const normalizedId = recordId.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, "_");
  let name = `rector-mem-${normalizedId}`.slice(0, 63);
  name = name.replace(/^[^a-zA-Z0-9]+/, "r").replace(/[^a-zA-Z0-9]+$/, "0");
  while (name.length < 3) name += "0";
  return name;
}

function validateCollectionName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$/.test(name)) {
    throw new Error("Chroma memory provider generated an invalid collection name.");
  }
  if (/\.\./.test(name)) {
    throw new Error("Chroma memory provider generated an invalid collection name.");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
    throw new Error("Chroma memory provider generated an invalid collection name.");
  }
}

async function validateChromaBaseUrl(baseUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Chroma memory provider requires config.baseUrl to be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Chroma memory provider requires config.baseUrl to be a valid http(s) URL.");
  }

  // Production: full SSRF validation
  if (process.env.NODE_ENV === "production") {
    await validateProviderUrl(baseUrl);
    return;
  }

  // Non-production: lightweight SSRF checks only (no DNS resolution)
  const rawHostname = parsed.hostname.replace(/^\[(.+)]$/, "$1").toLowerCase();

  // Local dev bypass: allow localhost/loopback in non-production
  const LOCAL_DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
  if (LOCAL_DEV_HOSTNAMES.has(rawHostname)) return;

  if (BLOCKED_HOSTNAMES.has(rawHostname) || BLOCKED_HOSTNAMES.has(rawHostname + ".")) {
    throw new Error(
      `SSRF protection: hostname "${rawHostname}" is blocked (cloud metadata / localhost)`
    );
  }

  if (isIP(rawHostname) !== 0) {
    const label = isPrivateIp(rawHostname);
    if (label) {
      throw new Error(
        `SSRF protection: IP address "${rawHostname}" is in a private range (${label})`
      );
    }
  }
  // Non-blocked hostname, not a raw private IP - in dev/test, allow without DNS resolution
}

function documentFromEntry(entry: MemoryEntry): string {
  return JSON.stringify({
    content: entry.content,
    layer: entry.layer,
    timestamp: entry.timestamp,
    lastMentioned: entry.lastMentioned,
    accessCount: entry.accessCount,
    tags: entry.tags,
    source: entry.source,
    metadata: entry.metadata,
  });
}

function entryFromDocument(id: string, document: string | null, metadata: Record<string, unknown> | null, now: () => string): MemoryEntry {
  if (document) {
    try {
      const parsed = JSON.parse(document) as {
        content: string;
        layer?: MemoryLayer;
        timestamp?: string;
        lastMentioned?: string;
        accessCount?: number;
        tags?: string[];
        source?: string;
        metadata?: Record<string, unknown>;
      };
      return mapToMemoryEntry({ id, ...parsed }, now);
    } catch {
      // fall through to metadata-based mapping
    }
  }
  const fields = metadataToMemoryFields(metadata ?? undefined, now());
  return mapToMemoryEntry(
    {
      id,
      layer: fields.layer,
      content: document ?? "",
      timestamp: fields.timestamp,
      lastMentioned: fields.lastMentioned,
      accessCount: fields.accessCount,
      tags: fields.tags,
      source: fields.source,
      metadata: fields.extraMetadata,
    },
    now,
  );
}

export interface ChromaMemoryProviderOptions extends MemoryAdapterDeps<ChromaClient> {
  id: string;
  kind?: string;
  label?: string;
  config?: MemoryProviderConfig;
  apiKey?: string;
  now?: () => string;
  run?: Run;
  clientFactory?: ChromaClientFactory;
}

/**
 * Chroma vector memory adapter. One collection per record id; vector search
 * powers searchMemory. NOT the truth-library ChromaMemoryAdapter in adapters.ts.
 */
export class ChromaMemoryProvider implements MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };

  private readonly nowFn: () => string;
  private readonly run: Run;
  private readonly clientFactory: ChromaClientFactory;
  private readonly chromaUrl: string;
  private readonly apiKey?: string;
  private readonly collectionName: string;
  private client: ChromaClient | undefined;
  private collection: ChromaCollection | undefined;
  private seq = 0;

  constructor(options: ChromaMemoryProviderOptions) {
    this.id = options.id;
    this.kind = options.kind ?? "chroma";
    this.metadata = { id: options.id, kind: this.kind, label: options.label };
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.run = options.run ?? defaultMemoryBudgetRun();
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.chromaUrl = options.config?.baseUrl?.trim() ?? "";
    this.apiKey = options.apiKey;
    this.collectionName = collectionNameForRecord(options.id);
  }

  validateConfig(): void {
    if (!this.chromaUrl) {
      throw new Error("Chroma memory provider requires config.baseUrl (Chroma server URL).");
    }
    // Sync pre-checks only; async SSRF check runs in getCollection() before network access
    try {
      const parsed = new URL(this.chromaUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Chroma memory provider requires config.baseUrl to be a valid http(s) URL.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Chroma memory provider")) throw err;
      throw new Error("Chroma memory provider requires config.baseUrl to be a valid http(s) URL.");
    }
    validateCollectionName(this.collectionName);
  }

  private nextId(): string {
    this.seq += 1;
    return `chroma-${Date.now().toString(36)}-${this.seq}`;
  }

  private getConnectOptions(): ChromaClientConnectOptions {
    const opts: ChromaClientConnectOptions = { path: this.chromaUrl };
    if (this.apiKey) {
      opts.auth = { provider: "token", credentials: this.apiKey };
    }
    return opts;
  }

  private async getCollection(): Promise<ChromaCollection> {
    if (this.collection) return this.collection;
    try {
      this.validateConfig();
      await validateChromaBaseUrl(this.chromaUrl);
      if (!this.client) {
        this.client = this.clientFactory(this.getConnectOptions());
      }
      this.collection = await this.client.getOrCreateCollection({ name: this.collectionName });
      return this.collection;
    } catch (error) {
      throw classifyAdapterError(error, "Chroma client initialization failed");
    }
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

  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    this.assertBudget("create");
    const sanitized = sanitizeCreateMemoryEntryInput(input);
    const now = this.nowFn();
    const entry = mapToMemoryEntry(
      {
        id: this.nextId(),
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
    try {
      const collection = await this.getCollection();
      await collection.add({
        ids: [entry.id],
        documents: [documentFromEntry(entry)],
        metadatas: [memoryEntryToMetadata(entry)],
      });
      return entry;
    } catch (error) {
      throw classifyAdapterError(error, "Chroma createMemoryEntry failed");
    }
  }

  async getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
    this.assertBudget("read");
    try {
      const result = await (await this.getCollection()).get({ ids: [id] });
      if (!result.ids.length) return undefined;
      return entryFromDocument(result.ids[0], result.documents[0], result.metadatas[0], this.nowFn);
    } catch (error) {
      throw classifyAdapterError(error, "Chroma getMemoryEntry failed");
    }
  }

  async listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    this.assertBudget("list");
    try {
      const result = await (await this.getCollection()).get(
        layer ? { where: { layer } } : undefined,
      );
      const entries = result.ids.map((id, i) =>
        entryFromDocument(id, result.documents[i], result.metadatas[i], this.nowFn),
      );
      return layer ? entries.filter((e) => e.layer === layer) : entries;
    } catch (error) {
      throw classifyAdapterError(error, "Chroma listMemoryEntries failed");
    }
  }

  async updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined> {
    this.assertBudget("update");
    const current = await this.getMemoryEntry(id);
    if (!current) return undefined;
    const updated = mapToMemoryEntry({ ...current, ...sanitizeUpdateMemoryEntryInput(patch), id: current.id }, this.nowFn);
    try {
      await (await this.getCollection()).update({
        ids: [id],
        documents: [documentFromEntry(updated)],
        metadatas: [memoryEntryToMetadata(updated)],
      });
      return updated;
    } catch (error) {
      throw classifyAdapterError(error, "Chroma updateMemoryEntry failed");
    }
  }

  async deleteMemoryEntry(id: string): Promise<boolean> {
    this.assertBudget("delete");
    try {
      await (await this.getCollection()).delete({ ids: [id] });
      return true;
    } catch (error) {
      throw classifyAdapterError(error, "Chroma deleteMemoryEntry failed");
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
      const collection = await this.getCollection();
      if (query && query.trim()) {
        const result = await collection.query({
          queryTexts: [redactMemoryContent(query)],
          nResults: limit,
          where: layer ? { layer } : undefined,
        });
        const ids = result.ids[0] ?? [];
        const docs = result.documents[0] ?? [];
        const metas = result.metadatas[0] ?? [];
        const distances = result.distances?.[0] ?? [];
        return ids
          .map((id, i) => ({
            entry: entryFromDocument(id, docs[i] ?? null, metas[i] ?? null, this.nowFn),
            distance: Number.isFinite(distances[i]) ? distances[i] : Number.POSITIVE_INFINITY,
            index: i,
          }))
          .filter(({ entry }) => layer === undefined || entry.layer === layer)
          .sort((left, right) => left.distance - right.distance || left.index - right.index)
          .slice(0, limit)
          .map(({ entry }) => entry);
      }
      return this.listMemoryEntries(layer).then((entries) => entries.slice(0, limit));
    } catch (error) {
      throw classifyAdapterError(error, "Chroma searchMemory failed");
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