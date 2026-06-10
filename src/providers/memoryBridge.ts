import type { SecretStore } from "../security/secretStore";
import type { MemoryProvider } from "../memory/provider";
import { LocalMemoryProvider, ExternalMemoryProviderStub } from "../memory/provider";
import type { MemoryConfigStore } from "./memoryConfigStore";
import type { MemoryProviderRecord } from "./memoryConfig";

/**
 * Memory Bridge (Chunk 34).
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
  delegateStoreForLocalSqliteMem?: any;
}

/**
 * Resolve the active MemoryProvider from the persisted config + secrets.
 *
 * - If mode === 'local' or there is no active record or the active kind is a
 *   local-* kind: return a LocalMemoryProvider (pure inmem by default, or
 *   delegating if delegateStoreForLocalSqliteMem is supplied).
 * - For external kinds: read the secret (transiently), construct the appropriate
 *   provider (stub in this chunk). Any construction or secret read error
 *   falls back to local-inmemory (redacted).
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
      // Local kinds: never touch the secret store.
      const delegate = record.kind === "local-sqlite-mem" ? options.delegateStoreForLocalSqliteMem : undefined;
      return new LocalMemoryProvider({
        id: record.id,
        kind: record.kind,
        label: record.label,
        now,
        delegate,
      });
    }

    // External kind (mem0, tidb-memory, chroma, ...).
    // Read secret only transiently for construction.
    const secretResult = await secrets.getSecret(record.secretRef);
    const secret = secretResult.ok ? secretResult.value : undefined;

    // In this chunk we only have the safe stub for external memory providers.
    // Real adapters can be swapped in later (the stub accepts the secret at
    // construction but ignores it until a real implementation is provided).
    const provider = new ExternalMemoryProviderStub({
      id: record.id,
      kind: record.kind,
      label: record.label,
    });

    // Stubs accept (and ignore) the secret for now; a real impl would use it.
    // We still call validateConfig if present (no-op on stub).
    provider.validateConfig?.();

    return provider;
  } catch (error) {
    // Any failure (bad secret read, bad record, etc.) → redacted local fallback.
    // The caller sees a usable local memory provider; the error is already
    // redacted by the SecretStore / config layer.
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
