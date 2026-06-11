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

/**
 * The raw, internal-only signal a failed Model_Probe carries into
 * {@link classifyProbeError}. It is assembled from the thrown error (a
 * `ProviderError` from `src/providers/llm.ts`, or any other thrown value) and is
 * NEVER returned to a caller — only the derived {@link ProbeErrorCategory} and a
 * Redaction_Layer–routed message ever leave the Connection_Test_Service
 * (Requirement 23.3). The `message` is used solely for keyword classification
 * here; it must be redacted before it is placed in a {@link ProbeResult}.
 */
export interface ProbeFailureSignal {
  /** Provider error code when available (e.g. a `ProviderErrorCode`). */
  code?: string;
  /** HTTP status from the provider response, when the failure was an HTTP error. */
  status?: number;
  /** Raw error message, used only for keyword matching — never returned raw. */
  message?: string;
}

/**
 * Classify a failed Model_Probe into a {@link ProbeErrorCategory} (Requirement
 * 23.1, 23.2). This is a pure, dependency-free heuristic over the failure's HTTP
 * status, provider error code, and message keywords so the Setup_UI can tell the
 * user which part of their configuration to fix.
 *
 * The matching is ordered from most-specific to least-specific so an overlapping
 * signal lands in the most actionable bucket: a content/safety rejection and a
 * quota hit are checked before generic status codes; a deployment-not-found
 * (Azure) and a model-access/agreement gap are checked before a bare auth or
 * endpoint failure (a `403` with "no access to model" is `model_access_missing`,
 * not `auth_invalid`). Anything unrecognized falls through to `unknown`.
 *
 * The `message` is inspected here for classification only; it is never returned
 * from this function. The Connection_Test_Service routes the user-facing message
 * through the Redaction_Layer separately (Requirement 23.3).
 */
export function classifyProbeError(signal: ProbeFailureSignal): ProbeErrorCategory {
  const status = signal.status;
  const haystack = `${signal.code ?? ""} ${signal.message ?? ""}`.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((needle) => haystack.includes(needle));

  // Content / safety rejection — checked before generic 400 parameter handling
  // because a safety block is frequently surfaced as a 400.
  if (has("content filter", "content_filter", "contentfilter", "safety", "responsible ai", "content management policy", "content policy", "jailbreak")) {
    return "content_rejected";
  }

  // Quota / rate limit.
  if (status === 429 || has("quota", "rate limit", "rate_limit", "ratelimit", "too many requests", "insufficient_quota")) {
    return "quota_exceeded";
  }

  // Deployment not found (Azure) — a specific 404/CONFIG case; checked before the
  // generic endpoint branch so a named-deployment miss is not mistaken for a bad URL.
  if (
    has("deploymentnotfound", "deployment not found", "deployment does not exist", "unknown deployment", "no deployment", "deployment is not configured", "deployment env is required") ||
    (has("deployment") && (status === 404 || has("not found", "does not exist", "does not have a deployment")))
  ) {
    return "deployment_not_found";
  }

  // Region / location unsupported.
  if (has("region", "location", "not available in your", "unsupported_region", "not supported in this region", "unsupportedregion")) {
    return "region_unsupported";
  }

  // Model access or agreement missing — checked before auth so a 403 that is
  // really an access/agreement gap is routed to the actionable category.
  if (has("does not have access", "model access", "access to the model", "agreement", "not authorized to access model", "model_not_authorized", "subscribe to the model", "purchase the model", "marketplace agreement")) {
    return "model_access_missing";
  }

  // Authentication invalid.
  if (
    status === 401 ||
    status === 403 ||
    has("unauthorized", "invalid api key", "invalid_api_key", "invalid key", "authentication", "authentication_error", "invalid token", "permission denied", "permissiondenied", "forbidden", "access denied")
  ) {
    return "auth_invalid";
  }

  // Endpoint or base URL invalid / unreachable.
  if (
    status === 404 ||
    has("enotfound", "econnrefused", "getaddrinfo", "could not resolve", "name_not_resolved", "dns", "invalid url", "etimedout", "network", "endpoint", "base url", "fetch failed", "failed to fetch", "connection refused")
  ) {
    return "endpoint_invalid";
  }

  // Parameter incompatibility (typically a 400 with a request-shape complaint).
  if (
    status === 400 ||
    has("unsupported parameter", "invalid_request_error", "unsupported value", "unrecognized request argument", "unsupported_parameter", "parameter")
  ) {
    return "parameter_incompatible";
  }

  return "unknown";
}
