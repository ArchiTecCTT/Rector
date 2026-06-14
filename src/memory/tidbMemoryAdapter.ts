import type { MemoryProvider } from "./provider";
import { classifyAdapterError } from "./adapterBase";
import type { MemoryProviderConfig, MemoryProviderRecord } from "../providers/memoryConfig";
import { SqlRectorStore } from "../store/sqlRectorStore";
import { createTiDBDriver } from "../store/tidbRectorStore";
import type {
  CreateMemoryEntryInput,
  MemoryEntry,
  MemoryLayer,
  UpdateMemoryEntryInput,
} from "../store/schemas";

type MemoryDelegate = {
  createMemoryEntry(i: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
  listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]>;
  updateMemoryEntry(id: string, p: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined>;
  deleteMemoryEntry(id: string): Promise<boolean>;
  searchMemory(q?: string, o?: { layer?: MemoryLayer; limit?: number }): Promise<MemoryEntry[]>;
  pruneMemory(o?: { targetLayer?: MemoryLayer; maxEntries?: number }): Promise<{ pruned: number; summarized: number }>;
};

export interface TiDBMemoryProviderOptions {
  id: string;
  kind?: string;
  label?: string;
  config?: MemoryProviderConfig;
  secret?: string;
  now?: () => string;
  /** Injectable delegate for tests (skips TiDB driver construction). */
  delegateStore?: MemoryDelegate;
}

function parseHostPort(baseUrl: string): { host: string; port: number } {
  const stripped = baseUrl.replace(/^https?:\/\//, "").split("/")[0];
  const [host, portStr] = stripped.split(":");
  const port = portStr ? Number(portStr) : 4000;
  if (!host || !Number.isFinite(port)) {
    throw new Error("Invalid TiDB baseUrl.");
  }
  return { host, port };
}

function buildDelegateFromConfig(
  config: MemoryProviderConfig | undefined,
  secret: string | undefined,
  now?: () => string,
): MemoryDelegate {
  const baseUrl = config?.baseUrl?.trim();
  const accountId = config?.accountId?.trim();
  const database = config?.database?.trim();
  const password = secret?.trim();

  if (!baseUrl || !accountId || !database || !password) {
    throw new Error(
      "tidb-memory requires config.baseUrl, config.accountId, config.database, and a non-empty secret.",
    );
  }

  const { host, port } = parseHostPort(baseUrl);
  const driver = createTiDBDriver({
    host,
    port,
    user: accountId,
    password,
    database,
    tls: config?.options?.tls !== false,
  });

  return new SqlRectorStore({ driver, now });
}

/**
 * TiDB Cloud memory adapter — delegates all 7 MemoryProvider methods to a
 * {@link SqlRectorStore} built from the record's non-secret config + secret.
 */
export class TiDBMemoryProvider implements MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };

  private readonly delegate: MemoryDelegate;

  constructor(options: TiDBMemoryProviderOptions) {
    this.id = options.id;
    this.kind = options.kind ?? "tidb-memory";
    this.metadata = { id: options.id, kind: this.kind, label: options.label };

    if (options.delegateStore) {
      this.delegate = options.delegateStore;
    } else {
      try {
        this.delegate = buildDelegateFromConfig(options.config, options.secret, options.now);
      } catch (error) {
        throw classifyAdapterError(error, "TiDB memory provider construction failed");
      }
    }
  }

  static fromRecord(
    record: MemoryProviderRecord,
    secret: string | undefined,
    options: { now?: () => string; delegateStore?: MemoryDelegate } = {},
  ): TiDBMemoryProvider {
    return new TiDBMemoryProvider({
      id: record.id,
      kind: record.kind,
      label: record.label,
      config: record.config,
      secret,
      now: options.now,
      delegateStore: options.delegateStore,
    });
  }

  validateConfig(): void {
    if (!this.delegate) {
      throw new Error("TiDB memory provider delegate is not configured.");
    }
  }

  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    return this.delegate.createMemoryEntry(input);
  }

  async getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
    return this.delegate.getMemoryEntry(id);
  }

  async listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]> {
    return this.delegate.listMemoryEntries(layer);
  }

  async updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined> {
    return this.delegate.updateMemoryEntry(id, patch);
  }

  async deleteMemoryEntry(id: string): Promise<boolean> {
    return this.delegate.deleteMemoryEntry(id);
  }

  async searchMemory(
    query?: string,
    options?: { layer?: MemoryLayer; limit?: number },
  ): Promise<MemoryEntry[]> {
    return this.delegate.searchMemory(query, options);
  }

  async pruneMemory(options?: { targetLayer?: MemoryLayer; maxEntries?: number }): Promise<{
    pruned: number;
    summarized: number;
  }> {
    return this.delegate.pruneMemory(options);
  }
}