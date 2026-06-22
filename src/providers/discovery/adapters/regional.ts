import type { DiscoveryError } from "../types";

/**
 * OPTIONAL Regional_Discovery scaffold (Area E, ORN-61 — Requirement 26).
 *
 * ⚠️ SCAFFOLD / OPTIONAL — this module is intentionally NOT a registered
 * {@link import("./index").DiscoveryAdapter} and is NOT wired into the
 * Model_Discovery_Service registry or any live service. It exists so the
 * regional follow-up (Azure management-plane deployment enumeration and AWS
 * Bedrock region-scoped availability) has a precise, mockable starting point
 * without blocking the shipping discovery foundation (Requirement 26.1). The
 * full design lives in `docs/architecture/regional-discovery.md`.
 *
 * Two guarantees this scaffold upholds:
 *
 * - It NEVER performs a live cloud call. Every cloud API it touches is reached
 *   through an injected {@link RegionalCloudClient}, so tests mock it and the
 *   suite stays hermetic — no live Azure management-plane or AWS Bedrock call
 *   ever occurs (Requirement 26.3).
 * - Its runtime classification distinguishes an **invalid key** from a
 *   **region**, **deployment**, or **model** unavailability, mapping each to a
 *   distinct classified {@link RegionalDiscoveryError} rather than surfacing a
 *   raw provider body (Requirement 26.2). The foundation's
 *   {@link DiscoveryError} category set has no region/deployment/model-
 *   unavailability members, so the scaffold carries its own richer category
 *   enum here rather than widening (and destabilizing) the shipped foundation
 *   contract; {@link toDiscoveryError} maps back to the foundation shape for
 *   interoperability when a future adapter is wired in.
 */

/**
 * The distinct failure states regional discovery must tell apart
 * (Requirement 26.2). Unlike the foundation's {@link DiscoveryError} category,
 * this enum separates the three availability failures from one another so a
 * user can tell a credential problem from an availability problem, and tell the
 * three availability problems apart.
 */
export type RegionalDiscoveryFailureCategory =
  | "auth_invalid"
  | "region_unavailable"
  | "deployment_unavailable"
  | "model_unavailable"
  | "unknown";

/**
 * A classified, redaction-safe regional discovery failure. The `message` is a
 * static, scaffold-authored string — it never embeds a raw provider error body
 * or a secret value (Requirement 18.2 analog, Requirement 26.2).
 */
export interface RegionalDiscoveryError {
  category: RegionalDiscoveryFailureCategory;
  message: string;
}

/**
 * The coordinates a regional discovery request targets. Optional because the
 * scaffold serves both the Azure management-plane case (subscription/resource/
 * deployment) and the Bedrock case (region/model), which carry different
 * subsets of these fields.
 */
export interface RegionalDiscoveryRequest {
  /** Target region (e.g. Azure `location` or a Bedrock region). */
  region?: string;
  /** Azure deployment name the user would call at inference time. */
  deployment?: string;
  /** Base model id whose availability/access is being checked. */
  modelId?: string;
}

/** A normalized, scaffold-level descriptor of a regionally discovered model. */
export interface RegionalModelDescriptor {
  modelId: string;
  region: string;
  /** Present for Azure management-plane deployment enumeration. */
  deploymentId?: string;
  /**
   * Whether the account may actually invoke this model in this region. Mirrors
   * the Bedrock `GetFoundationModelAvailability` readiness check: a model can
   * appear in a listing yet still require an access grant.
   */
  available: boolean;
}

/**
 * The error shape a cloud SDK/API surfaces. Modeled defensively — every field
 * is optional — because the scaffold must classify whatever the injected client
 * raises without assuming a single provider's error contract. This carries only
 * non-sensitive classification signals (`statusCode`, `code`), never a raw body.
 */
export interface RegionalCloudApiError {
  /** HTTP-style status code, when the cloud client exposes one. */
  statusCode?: number;
  /** Provider error code string (e.g. `DeploymentNotFound`), when present. */
  code?: string;
}

/**
 * The injected cloud API boundary. A real implementation would wrap the Azure
 * management plane (ARM) or the AWS Bedrock control-plane SDK; in tests it is a
 * mock, so no live cloud call is ever made (Requirement 26.3). The scaffold
 * depends ONLY on this interface — it never constructs a network client itself.
 */
export interface RegionalCloudClient {
  /**
   * Enumerate regionally available models for the given request. Implementations
   * reject with a {@link RegionalCloudApiError}-shaped error on failure; the
   * scaffold classifies that rejection rather than letting it escape.
   */
  listRegionalModels(request: RegionalDiscoveryRequest): Promise<RegionalModelDescriptor[]>;
}

/** The outcome of a regional discovery run: descriptors, or a classified error. */
export type RegionalDiscoveryResult =
  | { ok: true; models: RegionalModelDescriptor[] }
  | { ok: false; error: RegionalDiscoveryError };

/** Coerce an unknown thrown value into the inspectable cloud-error shape. */
function asCloudApiError(error: unknown): RegionalCloudApiError {
  const record = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const statusCode = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const code = typeof record.code === "string" ? record.code : undefined;
  return { statusCode, code };
}

/**
 * Classify a cloud API failure into one of the distinct regional failure states
 * (Requirement 26.2). The classification inspects only non-sensitive signals
 * (status code and provider error code) and is the core runtime logic this
 * scaffold exists to pin down: an invalid key, a region unavailability, a
 * deployment unavailability, and a model unavailability each resolve to a
 * different category.
 */
export function classifyRegionalError(error: unknown): RegionalDiscoveryFailureCategory {
  const { statusCode, code } = asCloudApiError(error);
  const normalizedCode = code?.toLowerCase() ?? "";

  // Invalid key / credential. Management-plane and Bedrock both surface auth
  // failures as 401/403 or an explicit credential code.
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    normalizedCode.includes("invalidapikey") ||
    normalizedCode.includes("invalidauthenticationtoken") ||
    normalizedCode.includes("authenticationfailed") ||
    normalizedCode.includes("unauthorized") ||
    normalizedCode === "accessdeniedexception"
  ) {
    return "auth_invalid";
  }

  // Region / location unavailability — the requested region is not enabled or
  // does not offer the resource type.
  if (
    normalizedCode.includes("location") ||
    normalizedCode.includes("region") ||
    normalizedCode === "skunotavailable"
  ) {
    return "region_unavailable";
  }

  // Deployment unavailability — the named Azure deployment does not exist.
  if (normalizedCode.includes("deployment")) {
    return "deployment_unavailable";
  }

  // Model unavailability — the model is not found or not accessible/granted.
  if (
    normalizedCode.includes("model") ||
    normalizedCode === "resourcenotfoundexception" ||
    (statusCode === 404 && normalizedCode === "")
  ) {
    return "model_unavailable";
  }

  return "unknown";
}

/** A short, redaction-safe message for each classified regional failure. */
function messageFor(category: RegionalDiscoveryFailureCategory): string {
  switch (category) {
    case "auth_invalid":
      return "Regional discovery credentials were rejected. Check the management-plane key or token.";
    case "region_unavailable":
      return "The requested region is not available for this resource. Choose a supported region.";
    case "deployment_unavailable":
      return "The requested deployment was not found in this resource. Verify the deployment name.";
    case "model_unavailable":
      return "The requested model is not available or not granted in this region.";
    case "unknown":
    default:
      return "Regional discovery failed for an unrecognized reason.";
  }
}

/** Build a classified, redaction-safe {@link RegionalDiscoveryError}. */
function fail(category: RegionalDiscoveryFailureCategory): RegionalDiscoveryError {
  return { category, message: messageFor(category) };
}

/**
 * Run regional discovery through the injected cloud client (Requirement 26.2,
 * 26.3). Never throws and never performs a live call: every cloud interaction
 * goes through `client`, and any rejection is classified into a distinct
 * {@link RegionalDiscoveryError} rather than escaping as a raw body.
 *
 * Distinguishes the four states the requirement calls out:
 *
 * - an **invalid key**, a **region** unavailability, and a **deployment**
 *   unavailability are detected by classifying the rejection from the cloud
 *   client (see {@link classifyRegionalError});
 * - a **model** unavailability is detected either from the rejection or from a
 *   successful listing in which the requested model is present but reports
 *   `available: false` (the Bedrock readiness-check case — a model can be
 *   listed yet still require an access grant).
 */
export async function discoverRegionalModels(
  client: RegionalCloudClient,
  request: RegionalDiscoveryRequest,
): Promise<RegionalDiscoveryResult> {
  let models: RegionalModelDescriptor[];
  try {
    models = await client.listRegionalModels(request);
  } catch (error) {
    return { ok: false, error: fail(classifyRegionalError(error)) };
  }

  // Readiness check: a listed-but-ungranted model is a model unavailability,
  // distinct from a missing deployment or an unavailable region.
  if (request.modelId !== undefined) {
    const match = models.find((model) => model.modelId === request.modelId);
    if (match === undefined || !match.available) {
      return { ok: false, error: fail("model_unavailable") };
    }
  }

  const available = models.filter((model) => model.available);
  return { ok: true, models: available };
}

/**
 * Map a scaffold-level {@link RegionalDiscoveryError} onto the foundation's
 * {@link DiscoveryError} shape, for the future point where a regional adapter is
 * wired into the Model_Discovery_Service. The foundation has no distinct
 * region/deployment/model-unavailability categories, so those collapse to
 * `requires_management_plane` (the closest foundation signal that regional
 * discovery needs more than an endpoint plus key — Requirement 15.4), while an
 * invalid key maps to `auth_invalid`.
 */
export function toDiscoveryError(error: RegionalDiscoveryError): DiscoveryError {
  switch (error.category) {
    case "auth_invalid":
      return { category: "auth_invalid", message: error.message };
    case "region_unavailable":
    case "deployment_unavailable":
    case "model_unavailable":
      return { category: "requires_management_plane", message: error.message };
    case "unknown":
    default:
      return { category: "unknown", message: error.message };
  }
}
