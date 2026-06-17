import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactString } from "../security/redaction";
import { ensureRestrictedDir } from "../security/filePermissions";
import {
  ProviderConfigStateSchema,
  emptyProviderConfigState,
  type ActiveRouteMap,
  type ProviderConfigRecord,
  type ProviderConfigState,
  type ProviderModelRole,
} from "./config";

/**
 * Provider_Config_Store (design section C2).
 *
 * Persists and retrieves {@link ProviderConfigRecord}s — **non-secret
 * configuration only**. Secrets live in the encrypted `Secret_Store`; this
 * store is deliberately independent of `RectorStore` (which owns
 * conversations/runs/events) so the existing schema is untouched.
 *
 * The local backing mirrors `src/security/secretStore.ts`'s injectable-fs
 * pattern and its atomic temp-file + `rename` write technique, so a failed
 * write leaves the prior persisted state fully intact (Requirement 11.7, the
 * basis for the atomic-persistence invariant). An in-memory backing is provided
 * for deterministic tests.
 */

/**
 * The result of a {@link ProviderConfigStore} operation.
 *
 * A discriminated union mirroring `SecretStoreResult`: callers branch on `ok`.
 * On failure, `error` is a human-language message already routed through the
 * `Redaction_Layer`.
 */
export type ProviderConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * The narrow slice of the `Discovery_Cache` the store depends on to evict stale
 * entries (Requirement 16.3). Only {@link DiscoveryCache.invalidate} is needed,
 * so the store stays decoupled from the cache's `get`/`set`/TTL machinery and a
 * test can inject a trivial double. Implemented by the real `DiscoveryCache`
 * from `./discovery/cache`.
 */
export interface DiscoveryCacheInvalidator {
  /** Evict any cached discovery result for `providerId`. */
  invalidate(providerId: string): void;
}

/**
 * The store contract (design C2). Reads return the full state; mutations report
 * success/failure and never throw for an operational error.
 */
export interface ProviderConfigStore {
  /** Return the current persisted state (or a fresh empty state). */
  getState(): Promise<ProviderConfigState>;
  /** Create or replace a record by its `id`. */
  upsertProvider(rec: ProviderConfigRecord): Promise<ProviderConfigResult<ProviderConfigRecord>>;
  /** Remove the record with `id` (and drop it from any active route). */
  removeProvider(id: string): Promise<ProviderConfigResult<void>>;
  /** Designate (or clear, with `null`) the provider serving a model role. */
  setActiveRoute(role: ProviderModelRole, providerId: string | null): Promise<ProviderConfigResult<void>>;
}

/**
 * The minimal filesystem surface the local backing depends on, injectable so
 * tests can supply an in-memory double and exercise failure paths
 * deterministically without touching disk.
 *
 * `readFile` resolves to `undefined` when the file does not yet exist (a fresh
 * store) and rejects for any other read error. Writes go through a temp file +
 * `rename` so a persisted file is never left partially written.
 */
export interface ProviderConfigFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

/** Construction options for {@link createLocalProviderConfigStore}. */
export interface LocalProviderConfigStoreOptions {
  /** Backing file path, e.g. `.rector/providers.json`. */
  filePath: string;
  /** Injectable filesystem (defaults to a `node:fs/promises`-backed adapter). */
  fsImpl?: ProviderConfigFs;
  /**
   * Optional Discovery_Cache to evict on every mutation, so a configuration or
   * scope change re-discovers a Provider's models on the next read
   * (Requirement 16.3). When omitted the store behaves exactly as before.
   */
  cache?: DiscoveryCacheInvalidator;
}

/** Default filesystem adapter over `node:fs/promises`. */
function defaultProviderConfigFs(): ProviderConfigFs {
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

/** Redact any error into a safe, secret-free message. */
function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

/**
 * Drop a removed provider id from the Active_Route_Map so a deleted provider is
 * never left designated for a role.
 */
function pruneActiveRoutes(routes: ActiveRouteMap, removedId: string): ActiveRouteMap {
  const next: ActiveRouteMap = { ...routes };
  for (const role of Object.keys(next) as ProviderModelRole[]) {
    if (next[role] === removedId) delete next[role];
  }
  return next;
}

/**
 * Create the local development {@link ProviderConfigStore} backing.
 *
 * Persists non-secret configuration as JSON, validated on read with the
 * {@link ProviderConfigStateSchema}, and writes atomically (temp file +
 * `rename`) so a failure before the rename leaves the existing file untouched.
 * All disk access flows through the injectable {@link ProviderConfigFs}.
 */
export function createLocalProviderConfigStore(
  options: LocalProviderConfigStoreOptions,
): ProviderConfigStore {
  const { filePath } = options;
  const fsImpl = options.fsImpl ?? defaultProviderConfigFs();
  const cache = options.cache;

  async function readState(): Promise<ProviderConfigState> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") {
      return emptyProviderConfigState();
    }
    const parsed = ProviderConfigStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // An unreadable/invalid backing is treated as empty rather than throwing,
      // matching the Secret_Store's tolerance for a fresh/garbled file.
      return emptyProviderConfigState();
    }
    return parsed.data;
  }

  /**
   * Persist `state` atomically: serialize to a temp sibling, then rename over
   * the target. A failure before the rename leaves the existing file untouched,
   * so no partial/corrupted state is ever observed (Requirement 11.7).
   */
  async function writeState(state: ProviderConfigState): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    const serialized = JSON.stringify(state, null, 2);
    await fsImpl.writeFile(tempPath, serialized);
    await fsImpl.rename(tempPath, filePath);
  }

  return {
    async getState(): Promise<ProviderConfigState> {
      try {
        return await readState();
      } catch {
        // A read failure reports the empty state rather than surfacing an error.
        return emptyProviderConfigState();
      }
    },

    async upsertProvider(
      rec: ProviderConfigRecord,
    ): Promise<ProviderConfigResult<ProviderConfigRecord>> {
      try {
        const state = await readState();
        const providers = [...state.providers];
        const index = providers.findIndex((existing) => existing.id === rec.id);
        if (index >= 0) {
          providers[index] = rec;
        } else {
          providers.push(rec);
        }
        // Build the next state in a fresh object so a write failure never
        // mutates the on-disk state until the atomic rename succeeds.
        const next: ProviderConfigState = { ...state, providers };
        await writeState(next);
        // Evict so the next discovery read re-runs against the changed config
        // (Requirement 16.3). Only after the atomic write commits.
        cache?.invalidate(rec.id);
        return { ok: true, value: rec };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async removeProvider(id: string): Promise<ProviderConfigResult<void>> {
      try {
        const state = await readState();
        const providers = state.providers.filter((existing) => existing.id !== id);
        const next: ProviderConfigState = {
          ...state,
          providers,
          activeRoutes: pruneActiveRoutes(state.activeRoutes, id),
        };
        await writeState(next);
        // Evict the removed Provider's discovery result (Requirement 16.3).
        cache?.invalidate(id);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async setActiveRoute(
      role: ProviderModelRole,
      providerId: string | null,
    ): Promise<ProviderConfigResult<void>> {
      try {
        const state = await readState();
        const previousId = state.activeRoutes[role];
        const activeRoutes: ActiveRouteMap = { ...state.activeRoutes };
        if (providerId === null) {
          delete activeRoutes[role];
        } else {
          activeRoutes[role] = providerId;
        }
        const next: ProviderConfigState = { ...state, activeRoutes };
        await writeState(next);
        // A route change is a scope change for every Provider it touches: the
        // newly designated one and the one it replaced (Requirement 16.3).
        if (previousId) cache?.invalidate(previousId);
        if (providerId) cache?.invalidate(providerId);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}

/**
 * Create an in-memory {@link ProviderConfigStore} for tests. Holds state in a
 * closure (no disk, no fs double needed) while preserving the same mutation
 * semantics — including pruning removed providers from active routes and
 * evicting an injected Discovery_Cache on every mutation (Requirement 16.3).
 */
export function createInMemoryProviderConfigStore(
  initial?: ProviderConfigState,
  options: { cache?: DiscoveryCacheInvalidator } = {},
): ProviderConfigStore {
  let state: ProviderConfigState = initial
    ? ProviderConfigStateSchema.parse(initial)
    : emptyProviderConfigState();
  const cache = options.cache;

  return {
    async getState(): Promise<ProviderConfigState> {
      return structuredClone(state);
    },

    async upsertProvider(
      rec: ProviderConfigRecord,
    ): Promise<ProviderConfigResult<ProviderConfigRecord>> {
      const providers = [...state.providers];
      const index = providers.findIndex((existing) => existing.id === rec.id);
      if (index >= 0) {
        providers[index] = rec;
      } else {
        providers.push(rec);
      }
      state = { ...state, providers };
      cache?.invalidate(rec.id);
      return { ok: true, value: rec };
    },

    async removeProvider(id: string): Promise<ProviderConfigResult<void>> {
      state = {
        ...state,
        providers: state.providers.filter((existing) => existing.id !== id),
        activeRoutes: pruneActiveRoutes(state.activeRoutes, id),
      };
      cache?.invalidate(id);
      return { ok: true, value: undefined };
    },

    async setActiveRoute(
      role: ProviderModelRole,
      providerId: string | null,
    ): Promise<ProviderConfigResult<void>> {
      const previousId = state.activeRoutes[role];
      const activeRoutes: ActiveRouteMap = { ...state.activeRoutes };
      if (providerId === null) {
        delete activeRoutes[role];
      } else {
        activeRoutes[role] = providerId;
      }
      state = { ...state, activeRoutes };
      if (previousId) cache?.invalidate(previousId);
      if (providerId) cache?.invalidate(providerId);
      return { ok: true, value: undefined };
    },
  };
}
