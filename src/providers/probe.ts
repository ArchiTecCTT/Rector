import { z } from "zod";

/**
 * Model probe data models (design section D — Data Models, Requirement 23).
 *
 * The Model_Probe is the single, cheap, model-or-deployment-aware test
 * invocation the Setup_UI runs against a selected Model_Candidate before saving
 * an Active_Route_Map entry. When that probe fails, the Connection_Test_Service
 * classifies the failure into a {@link ProbeErrorCategory} (Requirement 23.1,
 * 23.2) and returns a {@link ProbeResult} whose `message` has already been
 * routed through the Redaction_Layer (Requirement 23.3).
 *
 * All shapes are Zod schemas with `z.infer` types, consistent with the rest of
 * the codebase (`src/providers/config.ts`, `src/providers/discovery/types.ts`,
 * `src/store/schemas.ts`). The probe never stores, logs, or returns a secret
 * value, and the returned message never carries a raw provider error body.
 */

/**
 * The classified outcome of a failed Model_Probe (Requirement 23.2). Each
 * category tells the user which part of their configuration to fix:
 *
 * - `auth_invalid` — the API key or credential was rejected.
 * - `endpoint_invalid` — the endpoint or base URL is wrong or unreachable.
 * - `region_unsupported` — the region or location does not support the model.
 * - `deployment_not_found` — the named deployment does not exist.
 * - `model_access_missing` — the account lacks access or an agreement for the model.
 * - `quota_exceeded` — a quota or rate limit was hit.
 * - `parameter_incompatible` — a request parameter is not supported by the model.
 * - `content_rejected` — the probe content tripped a content/safety filter.
 * - `unknown` — an unclassified provider error.
 */
export const ProbeErrorCategorySchema = z.enum([
  "auth_invalid",
  "endpoint_invalid",
  "region_unsupported",
  "deployment_not_found",
  "model_access_missing",
  "quota_exceeded",
  "parameter_incompatible",
  "content_rejected",
  "unknown",
]);
export type ProbeErrorCategory = z.infer<typeof ProbeErrorCategorySchema>;

/**
 * The result of a Model_Probe. On success `ok` is true and no `category` is
 * present; on failure `ok` is false and `category` carries the classified
 * {@link ProbeErrorCategory} (Requirement 23.1). The `message` is always routed
 * through the Redaction_Layer and never contains a raw provider body or a
 * secret value (Requirement 23.3).
 */
export const ProbeResultSchema = z
  .object({
    ok: z.boolean(),
    category: ProbeErrorCategorySchema.optional(),
    message: z.string(),
  })
  .strict();
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
