import type { SecretStore } from "../security/secretStore";
import type { MemoryProvider } from "../memory/provider";
import { LocalMemoryProvider, ExternalMemoryProviderStub } from "../memory/provider";
import { getMemoryProviderRegistry } from "../modules/builtin/memoryProviderModules";
import type { MemoryConfigStore } from "./memoryConfigStore";
import type { MemoryProviderRecord } from "./memoryConfig";
import type { Run } from "../store/schemas";

/**
 * Memory Bridge (Chunk 34 + 35).
 *
 * Resolves a persisted MemoryProviderRecord (from MemoryConfigStore) + its
 * secret (from the shared SecretStore) into a live {@link MemoryProvider}
 * instance that the neuro memory paths (notes, context, future ponder) can use.
 *
 * Design mirrors Config_Bridge / buildConfiguredRouter but simpler:
 * - Single active memory provider (no roles like flagship/slm).
 * - Strong local-mode + default-kind guard: Local_Mode and the "local-inmemory"
 *   default NEVER read secrets and NEVER perform network.
 * - All errors that could contain secrets are redacted before surfacing.
 * - Graceful fallback to a pure local-inmemory provider on any failure
 *   (so the system stays usable even if a cloud memory config is bad).
 */

export interface ResolveMemoryProviderOptions {
  /** "local" forces pure local-inmemory with zero secret reads / network. */
  mode?: "local" | "external";
  /** Injectable now for deterministic tests (passed through to LocalMemoryProvider). */
  now?: () => string;
  /** For tests that want to inject a pre-built delegate (e.g. a real SqlRectorStore). */
  delegateStoreForLocalSqliteMem?: unknown;
  /** Optional run context for memory-provider budget preflight. */
  run?: Run;
}

/**
 * Build a {@link MemoryProvider} from a single persisted record + secret.
 * Local kinds never read secrets. External kinds construct real adapters (Chunk 35)
 * or fall back to stubs for unknown kinds.
 */
export function buildMemoryProviderFromRecord(
  record: MemoryProviderRecord,
  secret: string | undefined,
  options: ResolveMemoryProviderOptions = {},
): MemoryProvider {
  const now = options.now;

  if (record.kind === "local-inmemory" || record.kind === "local-sqlite-mem") {
    const delegate = record.kind === "local-sqlite-mem" ? options.delegateStoreForLocalSqliteMem : undefined;
    return new LocalMemoryProvider({
      id: record.id,
      kind: record.kind,
      label: record.label,
      now,
      delegate,
    });
  }

  const built = getMemoryProviderRegistry().build(record, secret, options);
  if (built) {
    return built;
  }

  return new ExternalMemoryProviderStub({
    id: record.id,
    kind: record.kind,
    label: record.label,
  });
}

/**
 * Resolve a single memory provider by id for connection testing (mirrors
 * {@link resolveTestProvider} in configBridge). Returns `undefined` when no
 * persisted record matches the id. Does NOT fall back to local-inmemory — the
 * caller treats a missing record as not-found and build/validation failures as
 * `CONFIG_INVALID`.
 */
export async function resolveTestMemoryProvider(
  providerId: string,
  configStore: MemoryConfigStore,
  secrets: SecretStore,
  options: ResolveMemoryProviderOptions = {},
): Promise<MemoryProvider | undefined> {
  const state = await configStore.getState();
  const record = state.providers.find((p) => p.id === providerId);
  if (!record) return undefined;

  if (record.kind === "local-inmemory" || record.kind === "local-sqlite-mem") {
    return buildMemoryProviderFromRecord(record, undefined, options);
  }

  const secretResult = await secrets.getSecret(record.secretRef);
  const secret = secretResult.ok ? secretResult.value : undefined;
  return buildMemoryProviderFromRecord(record, secret, options);
}

/**
 * Resolve the active MemoryProvider from the persisted config + secrets.
 *
 * - If mode === 'local' or there is no active record or the active kind is a
 *   local-* kind: return a LocalMemoryProvider (pure inmem by default, or
 *   delegating if delegateStoreForLocalSqliteMem is supplied).
 * - For external kinds: read the secret (transiently), construct the appropriate
 *   provider via {@link buildMemoryProviderFromRecord}. Any construction or
 *   secret read error falls back to local-inmemory (redacted).
 */
export async function resolveActiveMemoryProvider(
  configStore: MemoryConfigStore,
  secrets: SecretStore,
  options: ResolveMemoryProviderOptions = {},
): Promise<MemoryProvider> {
  const mode = options.mode ?? "external";
  const now = options.now;

  // Local mode or no config store: always safe local default.
  if (mode === "local") {
    return new LocalMemoryProvider({
      id: "local-inmemory:default",
      kind: "local-inmemory",
      label: "Local (in-memory)",
      now,
    });
  }

  try {
    const state = await configStore.getState();
    const activeId = state.activeMemoryProviderId;

    if (!activeId) {
      // No active selection → default local (zero config, zero secret).
      return new LocalMemoryProvider({
        id: "local-inmemory:default",
        kind: "local-inmemory",
        label: "Local (in-memory)",
        now,
      });
    }

    const record: MemoryProviderRecord | undefined = state.providers.find((p) => p.id === activeId);
    if (!record) {
      // Active id points at nothing (stale) → safe local fallback.
      return new LocalMemoryProvider({
        id: "local-inmemory:default",
        kind: "local-inmemory",
        label: "Local (in-memory)",
        now,
      });
    }

    if (record.kind === "local-inmemory" || record.kind === "local-sqlite-mem") {
      return buildMemoryProviderFromRecord(record, undefined, options);
    }

    // External kind (mem0, tidb-memory, chroma, ...).
    // Read secret only transiently for construction.
    const secretResult = await secrets.getSecret(record.secretRef);
    const secret = secretResult.ok ? secretResult.value : undefined;

    try {
      return buildMemoryProviderFromRecord(record, secret, options);
    } catch {
      // Adapter construction failure (missing secret, bad config, missing optional dep)
      // → graceful local fallback so the system stays usable.
      return new LocalMemoryProvider({
        id: "local-inmemory:default",
        kind: "local-inmemory",
        label: "Local (in-memory)",
        now,
      });
    }
  } catch {
    // Any failure (bad secret read, bad record, etc.) → redacted local fallback.
    return new LocalMemoryProvider({
      id: "local-inmemory:default",
      kind: "local-inmemory",
      label: "Local (in-memory)",
      now,
    });
  }
}

/**
 * Convenience for tests or places that want an explicit pure local provider
 * without going through the stores.
 */
export function createPureLocalMemoryProvider(opts?: {
  id?: string;
  label?: string;
  now?: () => string;
}): MemoryProvider {
  return new LocalMemoryProvider({
    id: opts?.id ?? "local-inmemory:default",
    kind: "local-inmemory",
    label: opts?.label ?? "Local (in-memory)",
    now: opts?.now,
  });
}