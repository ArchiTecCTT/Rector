import { z } from "zod";

/**
 * Memory Provider configuration data model (Chunk 34).
 *
 * Mirrors the proven ProviderConfigRecord + ProviderConfigState pattern from
 * src/providers/config.ts but for pluggable agent memory backends (local in-memory,
 * local-sqlite, Mem0, TiDB Cloud memory, future options). Non-secret records only.
 * Secrets live exclusively in the (reused) Secret_Store via secretRef.
 *
 * This enables the hassle-free web-UI configuration of "agent memory database
 * provider" (local or Mem0/TiDB cloud) per the user vision and the "New risk
 * from user vision: Pluggable memory providers via UI" concern.
 *
 * All shapes use Zod (consistent with the rest of the codebase).
 */

/** A non-empty string, the convention used across the store schemas. */
const NonEmptyStringSchema = z.string().min(1);

/**
 * Supported memory provider kinds for v1 of the pluggable layer.
 * - local-inmemory: pure in-memory (default, zero-config, identical to pre-34 Chunk 27 behavior)
 * - local-sqlite-mem: durable local file (delegates to SqlRectorStore memory methods post-Chunk-27 backfill)
 * - mem0, tidb-memory, chroma: external / cloud (stubs in this chunk; real adapters later via credits)
 */
export const MEMORY_PROVIDER_KINDS = [
  "local-inmemory",
  "local-sqlite-mem",
  "mem0",
  "tidb-memory",
  "chroma",
] as const;

export const MemoryProviderKindSchema = z.enum(MEMORY_PROVIDER_KINDS);
export type MemoryProviderKind = z.infer<typeof MemoryProviderKindSchema>;

/**
 * Generic per-kind configuration block (non-secret coordinates).
 * Individual kinds can extend/validate their own shape at construction time in the bridge.
 * Kept loose here so new kinds can be added without schema changes in v1.
 */
export const MemoryProviderConfigSchema = z
  .object({
    baseUrl: NonEmptyStringSchema.optional(),
    accountId: NonEmptyStringSchema.optional(),
    database: NonEmptyStringSchema.optional(),
    options: z.record(z.unknown()).optional(),
  })
  .strict()
  .optional();

export type MemoryProviderConfig = z.infer<typeof MemoryProviderConfigSchema>;

/**
 * A persisted, non-secret configuration entry describing one configured
 * memory provider backend.
 *
 * The record holds a {@link MemoryProviderRecord.secretRef} (a Secret_Store key)
 * and NEVER the secret value itself. This is the basis for the config/secret
 * separation invariant (same as Provider_Config_Store).
 */
export const MemoryProviderRecordSchema = z
  .object({
    /** Stable id, e.g. "mem0:team-prod" or "local-inmemory:default". */
    id: NonEmptyStringSchema,
    /** Selects the adapter / backend implementation. */
    kind: MemoryProviderKindSchema,
    /** User-facing display name shown in UI. */
    label: NonEmptyStringSchema,
    /** Kind-specific non-secret coordinates (baseUrl, account, options, etc.). */
    config: MemoryProviderConfigSchema,
    /** Secret_Store key for this record's secret (API key, connection password, etc.). NEVER the value. */
    secretRef: NonEmptyStringSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MemoryProviderRecord = z.infer<typeof MemoryProviderRecordSchema>;

/** The on-disk format version so the persisted shape can evolve unambiguously. */
export const MEMORY_PROVIDER_CONFIG_VERSION = 1 as const;

/**
 * The full persisted state of the Memory Config Store: version, list of records,
 * and the id of the currently active memory provider (single active for neuro/agent memory).
 */
export const MemoryProviderStateSchema = z
  .object({
    version: z.literal(MEMORY_PROVIDER_CONFIG_VERSION),
    providers: z.array(MemoryProviderRecordSchema),
    activeMemoryProviderId: NonEmptyStringSchema.optional(),
  })
  .strict();

export type MemoryProviderState = z.infer<typeof MemoryProviderStateSchema>;

/** A fresh, empty state used when no backing file exists yet (default = local-inmemory). */
export function emptyMemoryProviderState(): MemoryProviderState {
  return {
    version: MEMORY_PROVIDER_CONFIG_VERSION,
    providers: [],
    activeMemoryProviderId: undefined,
  };
}

/**
 * Helper to create a minimal local-inmemory default record (used for bootstrap defaults
 * and tests when no user configuration exists). The caller is responsible for timestamps.
 */
export function makeDefaultLocalInMemoryRecord(now: string): MemoryProviderRecord {
  return {
    id: "local-inmemory:default",
    kind: "local-inmemory",
    label: "Local (in-memory)",
    config: {},
    secretRef: "memory:local-inmemory:default", // never actually used; presence check only for local default
    createdAt: now,
    updatedAt: now,
  };
}
