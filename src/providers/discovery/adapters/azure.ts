import type { AzureProviderConfig } from "../../config";
import type { DiscoveryError, ModelCandidate } from "../types";
import {
  normalizeCandidate,
  type AdapterContext,
  type AdapterResult,
  type DiscoveryAdapter,
  type NormalizeContext,
} from "./index";

/**
 * Azure OpenAI Discovery_Adapter (design section C — `adapters/azure.ts`,
 * Requirement 15).
 *
 * Azure OpenAI separates two control surfaces:
 *
 * - the **data plane** (`{endpoint}/openai/...`), reachable with an endpoint +
 *   API key, which lists the *catalog* models available to the resource; and
 * - the **management plane** (ARM), which is the only surface that can
 *   enumerate the resource's *deployments* and requires separate ARM
 *   (subscription/resource-group) authentication.
 *
 * This adapter therefore discovers honestly rather than fabricating deployment
 * ids it cannot know (Requirement 15):
 *
 * - it requests the data-plane model list at
 *   `GET {endpoint}/openai/models?api-version=2024-10-21` (Requirement 15.1);
 * - it sets `requiresDeployment: true` on every returned candidate, because an
 *   Azure model is only usable once mapped to a deployment (Requirement 15.2);
 * - it NEVER emits a `deploymentId` — an endpoint + key cannot enumerate
 *   deployments, so any deployment-shaped field on a raw entry is stripped
 *   before normalization and defensively removed afterwards (Requirement 15.3);
 * - when *deployment enumeration* is requested it does not pretend to satisfy
 *   it from the data plane; it returns a classified `requires_management_plane`
 *   error explaining that deployment auto-discovery requires management-plane
 *   (ARM) authentication (Requirement 15.4).
 *
 * **Deployment-enumeration signal.** {@link AdapterContext} models discovery as
 * a data-plane catalog read and carries no "enumerate deployments" flag, and
 * the shared adapter contract in `adapters/index.ts` is intentionally not
 * modified here. So this adapter documents its own convention using the only
 * per-record, non-secret extension surface available — the record's `headers`
 * map: when {@link ENUMERATE_DEPLOYMENTS_HEADER} is present with a truthy value
 * the call is treated as a deployment-enumeration request and short-circuits to
 * the `requires_management_plane` error before any network access. The sentinel
 * header is a control flag only and is never forwarded to Azure.
 *
 * Like every Discovery_Adapter it is defensive by construction: it never throws
 * on a missing endpoint, a transport failure, or a malformed payload, returning
 * a classified, redacted {@link DiscoveryError} instead (Requirement 14.2,
 * 14.3, 18.1). All network access goes through the injected `ctx.fetchImpl` so
 * tests stay hermetic (Requirement 29).
 */

/** Source label stamped onto every candidate this adapter produces. */
const SOURCE = "azure-openai";

/**
 * The data-plane API version requested by default (Requirement 15.1). A record
 * may override it via its Azure config, but discovery defaults to the
 * requirement-specified version.
 */
const DEFAULT_API_VERSION = "2024-10-21";

/**
 * Sentinel header on the non-secret {@link import("../../config").ProviderConfigRecord.headers}
 * map that requests deployment enumeration. Present + truthy means "enumerate
 * deployments", which the data plane cannot satisfy (Requirement 15.4). This
 * header is a control flag only and is never sent to Azure.
 */
const ENUMERATE_DEPLOYMENTS_HEADER = "x-rector-azure-enumerate-deployments";

/** Deployment-shaped keys stripped from raw entries so no `deploymentId` is ever emitted (Req 15.3). */
const DEPLOYMENT_KEYS = ["deployment", "deployment_id", "deploymentId"] as const;

/** Coerce an unknown value into a plain record for safe property access. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * The first candidate that is a non-empty string once trimmed, or `undefined`
 * when none qualify.
 */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/** A classified, redactable failure value. */
function fail(category: DiscoveryError["category"], message: string): AdapterResult {
  return { ok: false, error: { category, message } };
}

/** Whether the record requests deployment enumeration via the sentinel header (Req 15.4). */
function isDeploymentEnumerationRequested(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === ENUMERATE_DEPLOYMENTS_HEADER) {
      const normalized = value.trim().toLowerCase();
      return normalized.length > 0 && normalized !== "false" && normalized !== "0" && normalized !== "no";
    }
  }
  return false;
}

/**
 * The Azure endpoint origin for data-plane requests, preferring the Azure
 * config's `endpoint` and falling back to the record `baseUrl`. Trailing
 * slashes are trimmed. Returns `undefined` when neither is configured.
 */
function resolveEndpoint(azure: AzureProviderConfig, baseUrl: string | undefined): string | undefined {
  const endpoint = firstString(azure.endpoint, baseUrl);
  return endpoint === undefined ? undefined : endpoint.replace(/\/+$/, "");
}

/**
 * The record's non-secret custom headers minus the deployment-enumeration
 * sentinel, which is a control flag and must never be forwarded to Azure.
 */
function forwardableHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== ENUMERATE_DEPLOYMENTS_HEADER) {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Extract the array of model entries from the Azure data-plane envelope
 * (`{ data: [...] }`), also tolerating a bare array. Returns `undefined` when
 * the payload is not a recognizable list so the caller can classify it as an
 * unsupported response (Requirement 14.3).
 */
function extractEntries(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) {
    return payload;
  }
  const envelope = asRecord(payload);
  if (Array.isArray(envelope.data)) {
    return envelope.data;
  }
  return undefined;
}

/** Classify a non-OK HTTP status into a {@link DiscoveryError} category. */
function classifyStatus(status: number): DiscoveryError["category"] {
  if (status === 401 || status === 403) {
    return "auth_invalid";
  }
  if (status === 404) {
    return "endpoint_invalid";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "unknown";
}

/** A copy of the raw entry with every deployment-shaped field removed (Req 15.3). */
function stripDeploymentFields(entry: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...entry };
  for (const key of DEPLOYMENT_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

async function discover(ctx: AdapterContext): Promise<AdapterResult> {
  const { record, secret, fetchImpl } = ctx;
  const azure: AzureProviderConfig = record.azure ?? {};

  // Deployment enumeration is a management-plane (ARM) operation that an
  // endpoint + key cannot satisfy; report it honestly (Req 15.4).
  if (isDeploymentEnumerationRequested(record.headers)) {
    return fail(
      "requires_management_plane",
      "Azure deployment auto-discovery requires management-plane (ARM) authentication; an endpoint and API key can only list the data-plane model catalog.",
    );
  }

  const endpoint = resolveEndpoint(azure, record.baseUrl);
  if (endpoint === undefined) {
    return fail("endpoint_invalid", "An Azure OpenAI endpoint is required to discover models.");
  }
  if (firstString(secret) === undefined) {
    return fail("auth_invalid", "An Azure OpenAI API key is required to discover models.");
  }

  const apiVersion = firstString(azure.apiVersion) ?? DEFAULT_API_VERSION;
  const url = `${endpoint}/openai/models?api-version=${encodeURIComponent(apiVersion)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        ...forwardableHeaders(record.headers),
        Accept: "application/json",
        // Azure OpenAI data-plane authenticates with the `api-key` header.
        "api-key": secret as string,
      },
    });
  } catch {
    return fail("network_error", "Failed to reach the Azure OpenAI model catalog.");
  }

  if (!response.ok) {
    return fail(classifyStatus(response.status), `Azure OpenAI model discovery failed (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return fail("unsupported_response", "The Azure OpenAI model catalog returned a non-JSON response.");
  }

  const entries = extractEntries(payload);
  if (entries === undefined) {
    return fail("unsupported_response", "The Azure OpenAI model catalog response was not a recognizable model list.");
  }

  const lastRefreshedAt = new Date().toISOString();
  const normalizeContext: NormalizeContext = {
    providerId: record.id,
    kind: record.kind,
    source: SOURCE,
    lastRefreshedAt,
    scope: { endpoint },
    // Every Azure candidate requires a deployment to be usable (Req 15.2).
    requiresDeployment: true,
    requiresRegion: false,
  };

  const candidates: ModelCandidate[] = entries.map((rawEntry) => {
    // Strip any deployment-shaped field so the normalizer can never emit a
    // deploymentId an endpoint + key has no authority to enumerate (Req 15.3).
    const candidate = normalizeCandidate(stripDeploymentFields(asRecord(rawEntry)), normalizeContext);
    // Belt-and-suspenders: guarantee the invariant regardless of normalizer input.
    delete candidate.deploymentId;
    return candidate;
  });

  return { ok: true, candidates };
}

/**
 * The Azure OpenAI {@link DiscoveryAdapter} (Requirement 15). Exported for the
 * discovery service to register; registry assembly happens in the service, not
 * here.
 */
export const azureDiscoveryAdapter: DiscoveryAdapter = {
  kind: "azure-openai",
  discover,
};
