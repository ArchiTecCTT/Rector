import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactString } from "../security/redaction";
import { ensureRestrictedDir } from "../security/filePermissions";
import {
  MemoryProviderStateSchema,
  emptyMemoryProviderState,
  type MemoryProviderRecord,
  type MemoryProviderState,
} from "./memoryConfig";

/**
 * Memory Config Store (Chunk 34, mirroring Provider_Config_Store design C2).
 *
 * Persists and retrieves {@link MemoryProviderRecord}s — **non-secret
 * configuration only**. Secrets live in the (reused) encrypted `Secret_Store`;
 * this store is deliberately independent of `RectorStore` (which owns
 * conversations/runs + the durable "memories" table for sqlite/tidb) so the
 * existing schema and neuro memory call sites are not forced to change.
 *
 * The local backing uses the exact same atomic temp-file + `rename` write
 * technique as ProviderConfigStore and SecretStore so a failed write leaves the
 * prior persisted state fully intact.
 *
 * An in-memory backing is provided for deterministic tests (and for the
 * local baseline when we want to avoid disk in certain property tests).
 */

/**
 * The result of a {@link MemoryConfigStore} operation.
 *
 * A discriminated union mirroring `ProviderConfigResult` / `SecretStoreResult`.
 * Callers branch on `ok`. On failure, `error` is a human-language message
 * already routed through the `Redaction_Layer`.
 */
export type MemoryConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * The store contract. Reads return the full state; mutations report
 * success/failure and never throw for an operational error (consistent with
 * the provider config store).
 */
export interface MemoryConfigStore {
  /** Return the current persisted state (or a fresh empty state with no active provider). */
  getState(): Promise<MemoryProviderState>;

  /** Create or replace a memory provider record by its `id`. */
  upsertMemoryProvider(rec: MemoryProviderRecord): Promise<MemoryConfigResult<MemoryProviderRecord>>;

  /** Remove the record with `id` (and clear it as active if it was selected). */
  removeMemoryProvider(id: string): Promise<MemoryConfigResult<void>>;

  /** Designate (or clear, with `null`) the active memory provider for neuro/agent memory features. */
  setActiveMemoryProvider(providerId: string | null): Promise<MemoryConfigResult<void>>;
}

/**
 * The minimal filesystem surface the local backing depends on, injectable so
 * tests can supply an in-memory double and exercise failure paths
 * deterministically without touching disk (exact same contract as ProviderConfigFs).
 */
export interface MemoryConfigFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

/** Construction options for {@link createLocalMemoryConfigStore}. */
export interface LocalMemoryConfigStoreOptions {
  /** Backing file path, e.g. `.rector/memory-providers.json`. */
  filePath: string;
  /** Injectable filesystem (defaults to a `node:fs/promises`-backed adapter). */
  fsImpl?: MemoryConfigFs;
}

/** Default filesystem adapter over `node:fs/promises` (identical to provider config). */
function defaultMemoryConfigFs(): MemoryConfigFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await writeFile(path, data, "utf8");
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      await rename(fromPath, toPath);
    },
    async mkdir(dirPath: string): Promise<void> {
      ensureRestrictedDir(dirPath);
    },
  };
}

/** Redact any error into a safe, secret-free message (same helper pattern). */
function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

/**
 * Drop a removed provider id if it was the active one.
 */
function pruneActiveMemoryProvider(state: MemoryProviderState, removedId: string): MemoryProviderState {
  if (state.activeMemoryProviderId === removedId) {
    const { activeMemoryProviderId, ...rest } = state;
    return { ...rest, activeMemoryProviderId: undefined };
  }
  return state;
}

/**
 * Create the local development {@link MemoryConfigStore} backing.
 *
 * Persists non-secret configuration as JSON under `.rector/memory-providers.json`,
 * validated on read, and writes atomically (temp file + rename) so a failure
 * before the rename leaves the existing file untouched.
 */
export function createLocalMemoryConfigStore(
  options: LocalMemoryConfigStoreOptions,
): MemoryConfigStore {
  const { filePath } = options;
  const fsImpl = options.fsImpl ?? defaultMemoryConfigFs();

  async function readState(): Promise<MemoryProviderState> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") {
      return emptyMemoryProviderState();
    }
    const parsed = MemoryProviderStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Treat unreadable/invalid backing as empty (same tolerance as provider config + secret store).
      return emptyMemoryProviderState();
    }
    return parsed.data;
  }

  async function writeState(state: MemoryProviderState): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const serialized = JSON.stringify(state, null, 2);
    await fsImpl.writeFile(tempPath, serialized);
    await fsImpl.rename(tempPath, filePath);
  }

  return {
    async getState(): Promise<MemoryProviderState> {
      try {
        return await readState();
      } catch {
        return emptyMemoryProviderState();
      }
    },

    async upsertMemoryProvider(
      rec: MemoryProviderRecord,
    ): Promise<MemoryConfigResult<MemoryProviderRecord>> {
      try {
        const state = await readState();
        const providers = [...state.providers];
        const index = providers.findIndex((existing) => existing.id === rec.id);
        if (index >= 0) {
          providers[index] = rec;
        } else {
          providers.push(rec);
        }
        const next: MemoryProviderState = { ...state, providers };
        await writeState(next);
        return { ok: true, value: rec };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async removeMemoryProvider(id: string): Promise<MemoryConfigResult<void>> {
      try {
        const state = await readState();
        const providers = state.providers.filter((existing) => existing.id !== id);
        const next: MemoryProviderState = pruneActiveMemoryProvider(
          { ...state, providers },
          id,
        );
        await writeState(next);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async setActiveMemoryProvider(
      providerId: string | null,
    ): Promise<MemoryConfigResult<void>> {
      try {
        const state = await readState();
        const next: MemoryProviderState = {
          ...state,
          activeMemoryProviderId: providerId ?? undefined,
        };
        await writeState(next);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}

/**
 * Create an in-memory {@link MemoryConfigStore} for tests.
 * Holds state in a closure (no disk) while preserving the same mutation
 * semantics (including clearing active when the active record is removed).
 */
export function createInMemoryMemoryConfigStore(
  initial?: MemoryProviderState,
): MemoryConfigStore {
  let state: MemoryProviderState = initial
    ? MemoryProviderStateSchema.parse(initial)
    : emptyMemoryProviderState();

  return {
    async getState(): Promise<MemoryProviderState> {
      return structuredClone(state);
    },

    async upsertMemoryProvider(
      rec: MemoryProviderRecord,
    ): Promise<MemoryConfigResult<MemoryProviderRecord>> {
      const providers = [...state.providers];
      const index = providers.findIndex((existing) => existing.id === rec.id);
      if (index >= 0) {
        providers[index] = rec;
      } else {
        providers.push(rec);
      }
      state = { ...state, providers };
      return { ok: true, value: rec };
    },

    async removeMemoryProvider(id: string): Promise<MemoryConfigResult<void>> {
      const providers = state.providers.filter((existing) => existing.id !== id);
      state = pruneActiveMemoryProvider({ ...state, providers }, id);
      return { ok: true, value: undefined };
    },

    async setActiveMemoryProvider(
      providerId: string | null,
    ): Promise<MemoryConfigResult<void>> {
      state = {
        ...state,
        activeMemoryProviderId: providerId ?? undefined,
      };
      return { ok: true, value: undefined };
    },
  };
}
