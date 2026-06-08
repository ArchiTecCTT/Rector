import type { DiscoveryError } from "../types";
import {
  normalizeCandidate,
  type AdapterContext,
  type AdapterResult,
  type DiscoveryAdapter,
  type NormalizeContext,
} from "./index";

/**
 * Generic OpenAI-compatible Discovery_Adapter (design section C —
 * `openaiCompatible.ts`, Requirement 14).
 *
 * Any user-supplied endpoint that speaks the OpenAI wire format exposes its
 * catalog at `GET /v1/models`, returning the standard `{ object: "list", data:
 * [...] }` envelope. This adapter therefore:
 *
 * - requests the model list at `GET /v1/models` (Requirement 14.1);
 * - normalizes entries that omit optional fields without raising — the shared
 *   {@link normalizeCandidate} emits only the fields a raw entry actually
 *   carries, so a bare `{ id }` still yields a valid Model_Candidate
 *   (Requirement 14.2);
 * - returns a classified, redacted {@link DiscoveryError} (never throws) when
 *   the response is not a recognizable model list (Requirement 14.3).
 *
 * All network access goes through the injected `ctx.fetchImpl`, keeping tests
 * hermetic (Requirement 29). The transient secret is used only to authorize the
 * request and is never persisted or logged (Requirement 18.4).
 */

/** Adapter/source label recorded on every candidate this adapter produces. */
const SOURCE = "openai-compatible";

/** The OpenAI-compatible model-list path (Requirement 14.1). */
const MODELS_PATH = "/v1/models";

/** The outcome of the model-list request, before classification. */
type FetchOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "http"; status: number }
  | { kind: "network" };

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
 * always targets `<origin>/v1/models` (Requirement 14.1) whether or not the
 * user included `/v1` in their base URL.
 */
function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${trimmed}${MODELS_PATH}`;
}

/**
 * Build the request headers: a JSON `Accept`, any non-secret custom headers
 * from the record, and a bearer `Authorization` when a transient secret is
 * present. The secret authorizes this request only and is never persisted or
 * logged (Requirement 18.4).
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
 * throwing (Requirement 14.3).
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
 * transport error becomes `network`, a non-2xx response becomes `http`, and a
 * 2xx response becomes `ok` (with `payload` left `undefined` when the body is
 * not valid JSON, so it classifies as an unsupported response downstream).
 */
async function requestList(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers });
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
 * The generic OpenAI-compatible {@link DiscoveryAdapter}. Requests `GET
 * /v1/models`, normalizes the returned entries defensively, and returns a
 * classified error for any unrecognizable response (Requirement 14). Exported
 * for the discovery service to register; the registry is assembled in the
 * service, not here.
 */
export const openaiCompatibleDiscoveryAdapter: DiscoveryAdapter = {
  kind: "openai-compatible",
  async discover(ctx: AdapterContext): Promise<AdapterResult> {
    const baseUrl = firstString(ctx.record.baseUrl);
    if (baseUrl === undefined) {
      return {
        ok: false,
        error: { category: "endpoint_invalid", message: "A base URL is required to discover models." },
      };
    }

    const outcome = await requestList(buildModelsUrl(baseUrl), buildHeaders(ctx), ctx.fetchImpl);

    if (outcome.kind === "network") {
      return {
        ok: false,
        error: { category: "network_error", message: "The model discovery request failed to connect." },
      };
    }
    if (outcome.kind === "http") {
      return { ok: false, error: classifyStatus(outcome.status) };
    }

    const list = extractModelList(outcome.payload);
    if (list === undefined) {
      return {
        ok: false,
        error: {
          category: "unsupported_response",
          message: "The model discovery response was not a recognizable model list.",
        },
      };
    }

    const normalizeContext: NormalizeContext = {
      providerId: ctx.record.id,
      kind: ctx.record.kind,
      source: SOURCE,
      lastRefreshedAt: new Date().toISOString(),
      requiresDeployment: false,
      requiresRegion: false,
    };

    return { ok: true, candidates: list.map((entry) => normalizeCandidate(entry, normalizeContext)) };
  },
};
