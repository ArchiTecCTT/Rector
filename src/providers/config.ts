import { z } from "zod";

/**
 * Provider configuration data model (design section C1).
 *
 * This module defines the **non-secret** shape of a configured provider
 * deployment. A {@link ProviderConfigRecord} references its secret by
 * {@link ProviderConfigRecord.secretRef} only — it NEVER carries a secret value.
 * Secrets live exclusively in the encrypted `Secret_Store`
 * (`src/security/secretStore.ts`); keeping them physically out of this store is
 * the basis for the config/secret-separation invariant (Requirements 11.6, 13.6).
 *
 * All shapes are expressed as Zod schemas (consistent with the rest of the
 * codebase) with their TypeScript types derived via `z.infer`, so the same
 * definition validates persisted JSON and types the in-memory model.
 */

/** A non-empty string, the convention used across the store schemas. */
const NonEmptyStringSchema = z.string().min(1);

/**
 * The provider adapter a record selects. Each value maps to a concrete
 * `LLMProvider` implementation at construction time. `openai-compatible`
 * targets any user-supplied OpenAI-compatible `/chat/completions` endpoint.
 */
export const PROVIDER_KINDS = ["together", "cloudflare", "azure-openai", "openai-compatible"] as const;

export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * The model roles the Active_Route_Map can address. `flagship` selects the
 * high-capability tier; `slm` selects the small/fast tier (Requirement 14).
 */
export const PROVIDER_MODEL_ROLES = ["flagship", "slm"] as const;

export const ProviderModelRoleSchema = z.enum(PROVIDER_MODEL_ROLES);
export type ProviderModelRole = z.infer<typeof ProviderModelRoleSchema>;

/** Azure OpenAI-specific, non-secret deployment coordinates. */
export const AzureProviderConfigSchema = z
  .object({
    endpoint: NonEmptyStringSchema.optional(),
    apiVersion: NonEmptyStringSchema.optional(),
    deployment: NonEmptyStringSchema.optional(),
  })
  .strict();
export type AzureProviderConfig = z.infer<typeof AzureProviderConfigSchema>;

/** Cloudflare Workers AI-specific, non-secret deployment coordinates. */
export const CloudflareProviderConfigSchema = z
  .object({
    accountId: NonEmptyStringSchema.optional(),
  })
  .strict();
export type CloudflareProviderConfig = z.infer<typeof CloudflareProviderConfigSchema>;

/**
 * Per-role model id overrides for a record (e.g. distinct flagship vs. SLM
 * model ids served by the same deployment).
 */
export const ProviderModelMapSchema = z
  .object({
    flagship: NonEmptyStringSchema.optional(),
    slm: NonEmptyStringSchema.optional(),
  })
  .strict();
export type ProviderModelMap = z.infer<typeof ProviderModelMapSchema>;

/**
 * A persisted, non-secret configuration entry describing one configured
 * provider deployment.
 *
 * The record holds a {@link ProviderConfigRecord.secretRef} (a `Secret_Store`
 * key) and never the secret value itself. `headers` is restricted to
 * non-secret custom headers; secret material must always flow through the
 * `Secret_Store` instead.
 */
export const ProviderConfigRecordSchema = z
  .object({
    /** Stable id, e.g. `"openai-compatible:my-proxy"`. */
    id: NonEmptyStringSchema,
    /** Selects the adapter used to construct the provider. */
    kind: ProviderKindSchema,
    /** User-facing display name. */
    label: NonEmptyStringSchema,
    /** Base URL for openai-compatible / together / azure deployments. */
    baseUrl: NonEmptyStringSchema.optional(),
    /** Model id (openai-compatible) or default/flagship model. */
    model: NonEmptyStringSchema.optional(),
    /** Optional per-role model id overrides. */
    models: ProviderModelMapSchema.optional(),
    /**
     * Manual_Model_List: user-entered model identifiers persisted on the
     * record. Used as a discovery fallback for `openai-compatible` providers and
     * as selectable model identifiers the Active_Route_Map may designate for the
     * `flagship` / `slm` roles (Requirements 3.3, 3.8). Non-secret: this list
     * never carries secret material.
     */
    manualModels: z.array(NonEmptyStringSchema).optional(),
    /** Azure OpenAI-specific coordinates. */
    azure: AzureProviderConfigSchema.optional(),
    /** Cloudflare Workers AI-specific coordinates. */
    cloudflare: CloudflareProviderConfigSchema.optional(),
    /** Optional, non-secret custom request headers. */
    headers: z.record(z.string()).optional(),
    /** `Secret_Store` key for this record's secret. NEVER the value itself. */
    secretRef: NonEmptyStringSchema,
    /**
     * Optional additional Secret_Store keys for this provider's credential pool.
     * Values are secret references only, never secret material.
     */
    additionalSecretRefs: z.array(NonEmptyStringSchema).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderConfigRecord = z.infer<typeof ProviderConfigRecordSchema>;

/** The Active_Route_Map: a role → provider id mapping (Requirement 14). */
export const ActiveRouteMapSchema = z
  .object({
    flagship: NonEmptyStringSchema.optional(),
    slm: NonEmptyStringSchema.optional(),
  })
  .strict();
export type ActiveRouteMap = z.infer<typeof ActiveRouteMapSchema>;

/** The on-disk format version, so the persisted shape can evolve unambiguously. */
export const PROVIDER_CONFIG_VERSION = 1 as const;

/**
 * The full persisted state of the Provider_Config_Store: the version tag, the
 * list of non-secret records, and the Active_Route_Map.
 */
export const ProviderConfigStateSchema = z
  .object({
    version: z.literal(PROVIDER_CONFIG_VERSION),
    providers: z.array(ProviderConfigRecordSchema),
    activeRoutes: ActiveRouteMapSchema,
  })
  .strict();
export type ProviderConfigState = z.infer<typeof ProviderConfigStateSchema>;

/** A fresh, empty state used when no backing file exists yet. */
export function emptyProviderConfigState(): ProviderConfigState {
  return { version: PROVIDER_CONFIG_VERSION, providers: [], activeRoutes: {} };
}
