import type { CloudflareProviderConfig } from "../../config";
import type { DiscoveryError, ModelCandidate } from "../types";
import {
  normalizeCandidate,
  type AdapterContext,
  type AdapterResult,
  type DiscoveryAdapter,
  type NormalizeContext,
} from ".";

/**
 * Cloudflare Workers AI Discovery_Adapter (design section C — `cloudflare.ts`,
 * Requirement 12).
 *
 * Discovery for a Cloudflare provider requests the account-scoped catalog at
 * `GET /accounts/{account_id}/ai/models/search` (Requirement 12.1), keeps only
 * text-generation, chat, and embedding models (Requirement 12.2), and omits
 * models marked deprecated unless the caller asked for them (Requirement 12.3,
 * 12.4).
 *
 * Like every adapter it is defensive: it never throws on a missing scope, a
 * failed network call, or an unrecognizable payload, returning a classified,
 * redacted {@link DiscoveryError} instead (Requirement 14.2, 14.3, 18.1). All
 * network access goes through the injected `ctx.fetchImpl` so tests stay
 * hermetic (Requirement 29).
 */

/** Source label stamped onto every candidate this adapter produces. */
const SOURCE = "cloudflare";

/** Default Cloudflare API base, mirroring the inference provider's default. */
const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

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

/**
 * Family markers recognized in a Cloudflare task name, each mapped to the
 * canonical capability tags that task contributes (Requirement 2.3,
 * Requirement 12.2). Cloudflare exposes human-readable task names like
 * `"Text Generation"`, `"Conversational Chat"`, or `"Text Embeddings"` rather
 * than canonical tokens, so we recognize the real-world task *family* by
 * substring while still mapping only to the canonical capability set
 * {text-generation, chat, embeddings}. Order matters: `embedding` is checked
 * first so an embedding task never collides with the text/chat families.
 */
const TASK_FAMILIES: ReadonlyArray<{ marker: string; capabilities: string[] }> = [
  // Any embedding task (e.g. "Text Embeddings", "Embeddings", "Embedding").
  { marker: "embedding", capabilities: ["embeddings"] },
  // Cloudflare's text-generation family serves chat-style completions too.
  { marker: "text generation", capabilities: ["text-generation", "chat"] },
  { marker: "text-generation", capabilities: ["text-generation", "chat"] },
  // Any chat task (e.g. "Chat", "Conversational Chat").
  { marker: "chat", capabilities: ["chat"] },
];

/**
 * Normalize a raw task token to its comparison form: trimmed and lower-cased.
 * Family matching is substring-based, so internal whitespace is preserved
 * (unlike an exact-token comparison) — this lets `"Text Generation"` and the
 * canonical `"text-generation"` both be recognized via their family markers.
 */
function normalizeTaskToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The capability tags a Cloudflare task maps to, or `undefined` when the task
 * belongs to none of the retained families. A task is retained iff its
 * lower-cased name contains a recognized family marker — `embedding`,
 * `text generation`/`text-generation`, or `chat` — and maps only to canonical
 * capabilities drawn from {text-generation, chat, embeddings} (Requirement 2.3,
 * Requirement 12.2). A Cloudflare entry's `task` is an object like
 * `{ name: "Text Generation" }`, though we also accept a bare string.
 */
function classifyTask(entry: Record<string, unknown>): string[] | undefined {
  const taskName = firstString(
    typeof entry.task === "string" ? entry.task : asRecord(entry.task).name,
    asRecord(entry.task).id,
  );
  if (taskName === undefined) {
    return undefined;
  }
  const normalized = normalizeTaskToken(taskName);
  for (const { marker, capabilities } of TASK_FAMILIES) {
    if (normalized.includes(marker)) {
      return capabilities;
    }
  }
  return undefined;
}

/**
 * Whether a raw Cloudflare entry is flagged deprecated. Cloudflare does not
 * expose a single canonical flag, so we accept the common shapes defensively: a
 * boolean `deprecated`, a lifecycle/status string, or a `properties` entry that
 * mentions deprecation.
 */
function isDeprecated(entry: Record<string, unknown>): boolean {
  if (entry.deprecated === true) {
    return true;
  }
  const lifecycle = firstString(entry.lifecycle, entry.status, entry.state);
  if (lifecycle !== undefined && lifecycle.toLowerCase() === "deprecated") {
    return true;
  }
  const properties = entry.properties;
  if (Array.isArray(properties)) {
    for (const property of properties) {
      const record = asRecord(property);
      const propertyId = firstString(record.property_id, record.propertyId, record.name)?.toLowerCase() ?? "";
      const value = firstString(record.value)?.toLowerCase() ?? "";
      if (propertyId.includes("deprecat") || value.includes("deprecat")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extract the array of catalog entries from a Cloudflare API envelope. The
 * search endpoint returns `{ success, result: [...] }`; we also accept a bare
 * array. Returns `undefined` when the payload is not a recognizable list so the
 * caller can classify it as an unsupported response (Requirement 14.3 analog).
 */
function extractEntries(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) {
    return payload;
  }
  const envelope = asRecord(payload);
  if (Array.isArray(envelope.result)) {
    return envelope.result;
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

async function discover(ctx: AdapterContext): Promise<AdapterResult> {
  const { record, secret, fetchImpl, includeDeprecated } = ctx;

  const cloudflare: CloudflareProviderConfig = record.cloudflare ?? {};
  const accountId = firstString(cloudflare.accountId);
  if (accountId === undefined) {
    return fail("endpoint_invalid", "Cloudflare account id is required to discover models.");
  }
  if (firstString(secret) === undefined) {
    return fail("auth_invalid", "A Cloudflare API token is required to discover models.");
  }

  const baseUrl = (firstString(record.baseUrl) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/accounts/${encodeURIComponent(accountId)}/ai/models/search`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      signal: ctx.signal,
    });
  } catch {
    return fail("network_error", "Failed to reach the Cloudflare model catalog.");
  }

  if (!response.ok) {
    return fail(classifyStatus(response.status), `Cloudflare model discovery failed (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return fail("unsupported_response", "The Cloudflare model catalog returned a non-JSON response.");
  }

  const entries = extractEntries(payload);
  if (entries === undefined) {
    return fail("unsupported_response", "The Cloudflare model catalog response was not a recognizable model list.");
  }

  const lastRefreshedAt = new Date().toISOString();
  const candidates: ModelCandidate[] = [];

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);

    // Retain only entries whose task belongs to a recognized Cloudflare task
    // family — text generation, chat, or embeddings — discarding all others
    // (Requirement 2.3, Requirement 12.2).
    const capabilities = classifyTask(entry);
    if (capabilities === undefined) {
      continue;
    }

    const deprecated = isDeprecated(entry);
    // Omit deprecated models unless explicitly requested (Requirement 12.3, 12.4).
    if (deprecated && !includeDeprecated) {
      continue;
    }

    // Cloudflare's `name` is the usable model id (e.g. "@cf/meta/...") while
    // `id` is an internal uuid, so feed the normalizer a reshaped entry that
    // resolves the model id from `name`.
    const modelName = firstString(entry.name, entry.model, entry.id);
    const normalizeInput: Record<string, unknown> = {
      ...entry,
      id: modelName,
      name: modelName,
      display_name: firstString(entry.description) ?? modelName,
    };
    if (deprecated) {
      normalizeInput.deprecated = true;
    }

    const normalizeContext: NormalizeContext = {
      providerId: record.id,
      kind: record.kind,
      source: SOURCE,
      lastRefreshedAt,
      scope: { accountId },
      requiresDeployment: false,
      requiresRegion: false,
      defaultCapabilities: capabilities,
    };

    candidates.push(normalizeCandidate(normalizeInput, normalizeContext));
  }

  return { ok: true, candidates };
}

/**
 * The Cloudflare Workers AI {@link DiscoveryAdapter} (Requirement 12). Exported
 * for the discovery service to register (registry assembly happens in the
 * service, not here).
 */
export const cloudflareDiscoveryAdapter: DiscoveryAdapter = {
  kind: "cloudflare",
  discover,
};
