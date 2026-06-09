import type { DiscoveryError } from "../types";
import {
  normalizeCandidate,
  type AdapterContext,
  type AdapterResult,
  type DiscoveryAdapter,
  type NormalizeContext,
} from "./index";

/**
 * Together AI Discovery_Adapter (design section C — `adapters/together.ts`,
 * Requirement 13).
 *
 * Together exposes a native model list at `GET /models` and, for OpenAI
 * compatibility, the same catalog at `GET /v1/models`. This adapter therefore:
 *
 * - requests the native list at `GET {baseUrl}/models` first (Requirement 13.1);
 * - falls back to the OpenAI-compatible `GET {baseUrl}/v1/models` only when the
 *   native endpoint is unavailable — i.e. it answers `404 Not Found`
 *   (Requirement 13.2);
 * - never depends on a provider Responses API for enumeration: discovery is a
 *   read of the model catalog only (Requirement 13.3).
 *
 * Like every Discovery_Adapter it is defensive by construction: it never throws
 * on a transport failure or a malformed payload, returning a classified
 * {@link DiscoveryError} instead, and it funnels every raw entry through the
 * shared {@link normalizeCandidate} so the result is always a valid
 * {@link import("../types").ModelCandidate}. All network access goes through the
 * injected `ctx.fetchImpl`, keeping tests hermetic (Requirement 29).
 */

/** Adapter/source label recorded on every candidate this adapter produces. */
const SOURCE = "together";

/**
 * Default Together AI API base used when a record omits its `baseUrl`. The
 * native (`/models`) and OpenAI-compatible (`/v1/models`) paths are appended to
 * this origin.
 */
const DEFAULT_BASE_URL = "https://api.together.xyz";

/** The native Together model-list path requested first (Requirement 13.1). */
const NATIVE_PATH = "/models";

/** The OpenAI-compatible fallback path (Requirement 13.2). */
const FALLBACK_PATH = "/v1/models";

/** The outcome of a single model-list request, before classification. */
type FetchOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "http"; status: number }
  | { kind: "network" };

/** Join a base URL and an absolute path, tolerating trailing slashes on the base. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The record's `baseUrl` when non-empty, otherwise the Together default. */
function resolveBaseUrl(ctx: AdapterContext): string {
  const configured = ctx.record.baseUrl?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_BASE_URL;
}

/**
 * Build the request headers: a JSON `Accept`, any non-secret custom headers
 * from the record, and a bearer `Authorization` when a transient secret is
 * present. The secret is used only to authorize this request and is never
 * persisted or logged (Requirement 18.4).
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
 * Extract the model array from either the native Together shape (a bare array)
 * or the OpenAI-compatible shape (`{ data: [...] }`). Returns `undefined` when
 * the payload is neither, so the caller can classify it as an unsupported
 * response rather than throwing.
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
 * Run one model-list request through the injected fetch, never throwing: a
 * transport error becomes `network`, a non-2xx response becomes `http`, and a
 * 2xx response becomes `ok` (with `payload` left `undefined` when the body is
 * not valid JSON, so it classifies as an unsupported response downstream).
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
    return { category: "auth_invalid", message: "Together rejected the provided credentials." };
  }
  if (status === 404) {
    return { category: "endpoint_invalid", message: "Together model list endpoint was not found." };
  }
  if (status === 429) {
    return { category: "rate_limited", message: "Together rate-limited the model discovery request." };
  }
  return {
    category: "unknown",
    message: `Together model discovery failed with status ${status}.`,
  };
}

/**
 * The Together AI Discovery_Adapter. Requests the native `/models` list first
 * and falls back to the OpenAI-compatible `/v1/models` list when the native
 * endpoint reports `404 Not Found` (Requirement 13).
 */
export const togetherDiscoveryAdapter: DiscoveryAdapter = {
  kind: "together",
  async discover(ctx: AdapterContext): Promise<AdapterResult> {
    const baseUrl = resolveBaseUrl(ctx);
    const headers = buildHeaders(ctx);

    // Native list first (Req 13.1).
    let outcome = await requestList(joinUrl(baseUrl, NATIVE_PATH), headers, ctx.fetchImpl, ctx.signal);

    // Fall back to the OpenAI-compatible list only when the native endpoint is
    // unavailable (404). Auth, rate-limit, and other errors would recur on the
    // fallback path, so they are classified directly (Req 13.2).
    if (outcome.kind === "http" && outcome.status === 404) {
      outcome = await requestList(joinUrl(baseUrl, FALLBACK_PATH), headers, ctx.fetchImpl, ctx.signal);
    }

    if (outcome.kind === "network") {
      return {
        ok: false,
        error: { category: "network_error", message: "Together model discovery request failed to connect." },
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
          message: "Together model discovery returned an unrecognized model list.",
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
