import type { DiscoveryError, ModelCandidate } from "../types";
import {
  normalizeCandidate,
  type AdapterContext,
  type AdapterResult,
  type DiscoveryAdapter,
  type NormalizeContext,
} from "./index";

/**
 * Generic OpenAI-compatible Discovery_Adapter (design section C —
 * `openaiCompatible.ts`, Requirements 2.6, 3.4–3.7).
 *
 * Any user-supplied endpoint that speaks the OpenAI wire format exposes its
 * catalog at `GET /v1/models`, returning the standard `{ object: "list", data:
 * [...] }` envelope. Because a bring-your-own provider's catalog endpoint may be
 * unavailable, the user may also supply a `Manual_Model_List` on the record. This
 * adapter therefore:
 *
 * - requests the model list at `GET {baseUrl}/v1/models` first (Requirements 2.6,
 *   3.4);
 * - normalizes entries that omit optional fields without raising — the shared
 *   {@link normalizeCandidate} emits only the fields a raw entry actually
 *   carries, so a bare `{ id }` still yields a valid Model_Candidate;
 * - falls back to the record's `Manual_Model_List` when the endpoint request
 *   fails, times out, returns a non-OK status, or yields no usable entries, and a
 *   manual list is present — emitting exactly one schema-valid Model_Candidate per
 *   manual identifier with a matching model id (Requirements 3.5, 3.6);
 * - returns a classified, redacted {@link DiscoveryError} (never throws) when the
 *   endpoint is unusable and no manual list is present (Requirement 3.7).
 *
 * All network access goes through the injected `ctx.fetchImpl`, keeping tests
 * hermetic. The transient secret is used only to authorize the request and is
 * never persisted or logged.
 */

/** Adapter/source label recorded on every candidate this adapter produces. */
const SOURCE = "openai-compatible";

/** Source label recorded on candidates built from the Manual_Model_List. */
const MANUAL_SOURCE = "openai-compatible:manual";

/** The OpenAI-compatible model-list path (Requirements 2.6, 3.4). */
const MODELS_PATH = "/v1/models";

/** The outcome of the model-list request, before classification. */
type FetchOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "http"; status: number }
  | { kind: "network" };

/**
 * The outcome of an endpoint discovery attempt: either a (possibly empty) list of
 * normalized candidates, or a classified error. Distinguishing "succeeded but
 * empty" from "failed" lets the caller apply the manual-model fallback uniformly
 * (Requirement 3.5).
 */
type EndpointOutcome =
  | { kind: "candidates"; candidates: ModelCandidate[] }
  | { kind: "error"; error: DiscoveryError };

/**
 * The first candidate that is a non-empty string once trimmed, or `undefined`
 * when none qualify. Non-string inputs are ignored rather than coerced.
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

/**
 * Build the `GET /v1/models` URL for a configured base URL. An
 * OpenAI-compatible `baseUrl` conventionally already includes the `/v1` segment
 * (e.g. `https://api.openai.com/v1`, mirroring `OpenAICompatibleProvider`'s
 * `{baseUrl}/chat/completions`), so a trailing `/v1` is stripped before the
 * canonical `/v1/models` path is appended. The resolved request therefore
 * always targets `<origin>/v1/models` whether or not the user included `/v1` in
 * their base URL.
 */
function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${trimmed}${MODELS_PATH}`;
}

/**
 * Build the request headers: a JSON `Accept`, any non-secret custom headers
 * from the record, and a bearer `Authorization` when a transient secret is
 * present. The secret authorizes this request only and is never persisted or
 * logged.
 */
function buildHeaders(ctx: AdapterContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (ctx.record.headers) {
    Object.assign(headers, ctx.record.headers);
  }
  if (ctx.secret) {
    headers.Authorization = `Bearer ${ctx.secret}`;
  }
  return headers;
}

/**
 * Extract the model array from the OpenAI-compatible envelope (`{ data: [...] }`)
 * or, defensively, a bare array. Returns `undefined` when the payload is
 * neither, so the caller can classify it as an unsupported response rather than
 * throwing.
 */
function extractModelList(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload !== null && typeof payload === "object") {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      return data;
    }
  }
  return undefined;
}

/**
 * Run the model-list request through the injected fetch, never throwing: a
 * transport error (including an abort/timeout) becomes `network`, a non-2xx
 * response becomes `http`, and a 2xx response becomes `ok` (with `payload` left
 * `undefined` when the body is not valid JSON, so it classifies as an
 * unsupported response downstream).
 */
async function requestList(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers, signal });
  } catch {
    return { kind: "network" };
  }
  if (!response.ok) {
    return { kind: "http", status: response.status };
  }
  try {
    return { kind: "ok", payload: await response.json() };
  } catch {
    return { kind: "ok", payload: undefined };
  }
}

/** Map a non-2xx HTTP status to a classified, redaction-safe {@link DiscoveryError}. */
function classifyStatus(status: number): DiscoveryError {
  if (status === 401 || status === 403) {
    return { category: "auth_invalid", message: "The endpoint rejected the provided credentials." };
  }
  if (status === 404) {
    return { category: "endpoint_invalid", message: "The OpenAI-compatible model list endpoint was not found." };
  }
  if (status === 429) {
    return { category: "rate_limited", message: "The endpoint rate-limited the model discovery request." };
  }
  return { category: "unknown", message: `OpenAI-compatible model discovery failed with status ${status}.` };
}

/**
 * Attempt the `GET {baseUrl}/v1/models` request and normalize its result
 * (Requirements 2.6, 3.4). Returns the normalized candidates on a recognizable
 * model list (possibly empty), or a classified error on a transport failure,
 * non-OK status, or unrecognized payload. Never throws.
 */
async function discoverFromEndpoint(baseUrl: string, ctx: AdapterContext): Promise<EndpointOutcome> {
  const outcome = await requestList(buildModelsUrl(baseUrl), buildHeaders(ctx), ctx.fetchImpl, ctx.signal);

  if (outcome.kind === "network") {
    return { kind: "error", error: { category: "network_error", message: "The model discovery request failed to connect." } };
  }
  if (outcome.kind === "http") {
    return { kind: "error", error: classifyStatus(outcome.status) };
  }

  const list = extractModelList(outcome.payload);
  if (list === undefined) {
    return {
      kind: "error",
      error: {
        category: "unsupported_response",
        message: "The model discovery response was not a recognizable model list.",
      },
    };
  }

  const normalizeContext = buildNormalizeContext(ctx, SOURCE);
  return { kind: "candidates", candidates: list.map((entry) => normalizeCandidate(entry, normalizeContext)) };
}

/**
 * The de-duplicated, trimmed Manual_Model_List on a record, preserving first-seen
 * order. Whitespace-only identifiers are dropped so every retained identifier
 * produces a schema-valid candidate with a matching, non-empty model id.
 */
function collectManualModels(manualModels: readonly string[] | undefined): string[] {
  if (manualModels === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of manualModels) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Build exactly one schema-valid Model_Candidate per Manual_Model_List
 * identifier, with the candidate's model id matching the identifier
 * (Requirement 3.6). The shared {@link normalizeCandidate} maps the bare
 * `{ id }` into a valid candidate whose `modelId` and `displayName` are the
 * identifier.
 */
function buildManualCandidates(models: readonly string[], ctx: AdapterContext): ModelCandidate[] {
  const normalizeContext = buildNormalizeContext(ctx, MANUAL_SOURCE);
  return models.map((id) => normalizeCandidate({ id }, normalizeContext));
}

/** The shared {@link NormalizeContext} for this adapter's candidates. */
function buildNormalizeContext(ctx: AdapterContext, source: string): NormalizeContext {
  return {
    providerId: ctx.record.id,
    kind: ctx.record.kind,
    source,
    lastRefreshedAt: new Date().toISOString(),
    requiresDeployment: false,
    requiresRegion: false,
  };
}

/**
 * The generic OpenAI-compatible {@link DiscoveryAdapter}. Requests `GET
 * {baseUrl}/v1/models` first; on a request failure, timeout, non-OK status, or a
 * response with no usable entries, builds the result from the record's
 * Manual_Model_List when present, otherwise returns a classified, redacted error
 * (Requirements 2.6, 3.4–3.7). Exported for the discovery service to register;
 * the registry is assembled in the service, not here.
 */
export const openaiCompatibleDiscoveryAdapter: DiscoveryAdapter = {
  kind: "openai-compatible",
  async discover(ctx: AdapterContext): Promise<AdapterResult> {
    const manualModels = collectManualModels(ctx.record.manualModels);
    const baseUrl = firstString(ctx.record.baseUrl);

    // Attempt the catalog endpoint first when a base URL is configured
    // (Requirements 2.6, 3.4). A missing base URL means no request can be made,
    // which is treated as an unusable endpoint for fallback purposes.
    const endpoint = baseUrl === undefined ? undefined : await discoverFromEndpoint(baseUrl, ctx);

    // A successful endpoint response with usable entries is returned as-is.
    if (endpoint?.kind === "candidates" && endpoint.candidates.length > 0) {
      return { ok: true, candidates: endpoint.candidates };
    }

    // The endpoint failed, timed out, returned non-OK, or yielded no usable
    // entries. Fall back to the Manual_Model_List when present (Requirement 3.5),
    // emitting exactly one schema-valid candidate per identifier (Requirement 3.6).
    if (manualModels.length > 0) {
      return { ok: true, candidates: buildManualCandidates(manualModels, ctx) };
    }

    // No manual fallback is available. A recognizable but empty catalog is a
    // success with zero candidates (Requirement 2.14); any other unusable
    // endpoint returns a classified, redacted error (Requirement 3.7).
    if (endpoint?.kind === "candidates") {
      return { ok: true, candidates: [] };
    }
    if (endpoint?.kind === "error") {
      return { ok: false, error: endpoint.error };
    }
    return {
      ok: false,
      error: { category: "endpoint_invalid", message: "A base URL is required to discover models." },
    };
  },
};
