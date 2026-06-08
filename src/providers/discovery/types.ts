import { z } from "zod";

import { ProviderKindSchema } from "../config";

/**
 * Model discovery data models (design section C — Data Models).
 *
 * This module defines the provider-agnostic shapes the Model_Discovery_Service
 * produces and returns:
 *
 * - {@link ModelCandidateSchema} — the single normalized description of a
 *   discoverable model that every Discovery_Adapter maps its raw provider
 *   entries into, so the UI and routing logic never branch per provider
 *   (Requirement 11).
 * - {@link DiscoveryErrorSchema} — a classified, redacted failure value
 *   (Requirement 18.1, 18.2).
 * - {@link DiscoveryResultSchema} — the discriminated union returned for every
 *   discovery request (Requirement 10, 17).
 *
 * All shapes are Zod schemas with `z.infer` types, consistent with the rest of
 * the codebase (`src/providers/config.ts`, `src/store/schemas.ts`). Discovery
 * never stores or returns a secret value; error messages are routed through the
 * Redaction_Layer before they reach these shapes (Requirement 18.2, 18.3).
 */

/** A non-empty string, the convention used across the provider/store schemas. */
const NonEmptyStringSchema = z.string().min(1);

/**
 * Provider-specific scope coordinates for a candidate. Every sub-field is
 * optional and present only when the Discovery_Adapter knows it
 * (Requirement 11.2).
 */
export const ModelCandidateScopeSchema = z
  .object({
    accountId: z.string().optional(),
    region: z.string().optional(),
    endpoint: z.string().optional(),
    azureResource: z.string().optional(),
    subscriptionId: z.string().optional(),
    resourceGroup: z.string().optional(),
  })
  .strict();
export type ModelCandidateScope = z.infer<typeof ModelCandidateScopeSchema>;

/**
 * The lifecycle status of a candidate. Accepts the well-known values
 * `active`, `preview`, and `deprecated`, or any other provider-reported,
 * non-empty string (Requirement 11.4).
 */
export const ModelLifecycleSchema = z.union([
  z.enum(["active", "preview", "deprecated"]),
  z.string().min(1),
]);
export type ModelLifecycle = z.infer<typeof ModelLifecycleSchema>;

/**
 * The normalized, provider-agnostic description of a discoverable model
 * (Requirement 11). Required fields are always present; optional fields appear
 * only when the Discovery_Adapter provides them (Requirement 11.3).
 */
export const ModelCandidateSchema = z
  .object({
    // Required fields (Requirement 11.1).
    /** Id of the Provider_Config_Record this candidate was discovered for. */
    providerId: NonEmptyStringSchema,
    /** Provider kind, mirrored from the record for per-kind UI/routing. */
    kind: ProviderKindSchema,
    /** Provider-specific scope coordinates; sub-fields optional (Req 11.2). */
    scope: ModelCandidateScopeSchema,
    /** Human-facing label for the candidate. */
    displayName: NonEmptyStringSchema,
    /** Capability tags such as `text-generation`, `chat`, `embeddings` (Req 11.5). */
    capabilities: z.array(NonEmptyStringSchema),
    /** Whether using this candidate requires a deployment (e.g. Azure). */
    requiresDeployment: z.boolean(),
    /** Whether using this candidate requires a region. */
    requiresRegion: z.boolean(),
    /** Adapter/source label that produced this candidate. */
    source: NonEmptyStringSchema,
    /** Timestamp of the discovery result that produced this candidate. */
    lastRefreshedAt: z.string().datetime(),

    // Optional fields (Requirement 11.3).
    modelId: z.string().optional(),
    deploymentId: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    pricing: z
      .object({
        inputPer1k: z.number().optional(),
        outputPer1k: z.number().optional(),
        currency: z.string().optional(),
      })
      .optional(),
    lifecycle: ModelLifecycleSchema.optional(),
  })
  .strict();
export type ModelCandidate = z.infer<typeof ModelCandidateSchema>;

/**
 * The classified failure categories discovery can return instead of a raw
 * provider error body (Requirement 18.1). `not_found` is used when no
 * Provider_Config_Record exists (Requirement 10.3, 17.4);
 * `requires_management_plane` is used when Azure deployment enumeration is
 * requested (Requirement 15.4).
 */
export const DiscoveryErrorCategorySchema = z.enum([
  "not_found",
  "auth_invalid",
  "endpoint_invalid",
  "unsupported_response",
  "network_error",
  "rate_limited",
  "requires_management_plane",
  "unknown",
]);
export type DiscoveryErrorCategory = z.infer<typeof DiscoveryErrorCategorySchema>;

/**
 * A classified, redacted discovery failure. The `message` is always routed
 * through the Redaction_Layer and never contains a raw provider body or a
 * secret value (Requirement 18.1, 18.2).
 */
export const DiscoveryErrorSchema = z
  .object({
    category: DiscoveryErrorCategorySchema,
    message: z.string(),
  })
  .strict();
export type DiscoveryError = z.infer<typeof DiscoveryErrorSchema>;

/**
 * The result of a discovery request: a discriminated union on `ok`. A success
 * carries the normalized candidates; a failure carries a classified, redacted
 * error. Both carry the `providerId` and the `lastRefreshedAt` of the result
 * (Requirement 10, 17).
 */
export const DiscoveryResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      providerId: NonEmptyStringSchema,
      candidates: z.array(ModelCandidateSchema),
      lastRefreshedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      providerId: NonEmptyStringSchema,
      error: DiscoveryErrorSchema,
      lastRefreshedAt: z.string().datetime(),
    })
    .strict(),
]);
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;
