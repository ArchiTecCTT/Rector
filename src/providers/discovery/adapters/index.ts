import type { ProviderConfigRecord, ProviderKind } from "../../config";
import {
  ModelCandidateScopeSchema,
  ModelCandidateSchema,
  type DiscoveryError,
  type ModelCandidate,
  type ModelCandidateScope,
} from "../types";

/**
 * Discovery_Adapter contract, registry, and the shared candidate normalizer
 * (design section C — Discovery_Adapter, `adapters/index.ts`).
 *
 * A {@link DiscoveryAdapter} is the per-provider-kind boundary the
 * Model_Discovery_Service dispatches to (Requirement 10.2). Each concrete
 * adapter (`cloudflare.ts`, `together.ts`, `openaiCompatible.ts`, `azure.ts`)
 * builds its request from the non-secret {@link ProviderConfigRecord} plus a
 * transient secret, parses the provider's response defensively, and returns an
 * {@link AdapterResult} — never throwing on a malformed payload, instead
 * returning a classified {@link DiscoveryError} (Requirement 14.2, 14.3).
 *
 * Every adapter funnels its raw entries through {@link normalizeCandidate}, the
 * single shared normalizer that maps an arbitrary provider entry into the
 * provider-agnostic {@link ModelCandidate} shape (Requirement 10.4, 11). The
 * normalizer is defensive by construction: it never throws on missing or
 * malformed optional fields, and every value it returns parses against
 * {@link ModelCandidateSchema}.
 */

/**
 * The injected context an adapter receives for one discovery run. The secret is
 * transient — read from the `Secret_Store` for the duration of the call and
 * never persisted or logged (Requirement 18.4). `fetchImpl` is injected so
 * tests stay hermetic against a mocked `fetch` (Requirement 29).
 */
export interface AdapterContext {
  /** The non-secret provider configuration to discover models for. */
  record: ProviderConfigRecord;
  /** Transient secret for the provider; never persisted or logged. */
  secret?: string;
  /** Injected `fetch` implementation (hermetic in tests). */
  fetchImpl: typeof fetch;
  /** Whether models marked deprecated should be included (Requirement 12.4). */
  includeDeprecated: boolean;
}

/**
 * The outcome of an adapter run: either the normalized candidates, or a
 * classified, redacted {@link DiscoveryError}. Adapters never throw on a bad
 * payload (Requirement 14.2, 14.3).
 */
export type AdapterResult =
  | { ok: true; candidates: ModelCandidate[] }
  | { ok: false; error: DiscoveryError };

/**
 * The contract every per-kind discovery adapter implements. `kind` mirrors the
 * {@link ProviderKind} the adapter handles so the registry can be validated.
 */
export interface DiscoveryAdapter {
  readonly kind: ProviderKind;
  discover(ctx: AdapterContext): Promise<AdapterResult>;
}

/**
 * The registry the Model_Discovery_Service dispatches through: one
 * {@link DiscoveryAdapter} per {@link ProviderKind} (Requirement 10.2).
 */
export type DiscoveryAdapterRegistry = Record<ProviderKind, DiscoveryAdapter>;

/**
 * The adapter-supplied, non-raw context the {@link normalizeCandidate} helper
 * needs to build a valid {@link ModelCandidate}. These are the fields an
 * adapter always knows from the {@link ProviderConfigRecord} and the run
 * itself, as opposed to the per-entry fields it reads defensively from the raw
 * provider payload.
 */
export interface NormalizeContext {
  /** Id of the Provider_Config_Record this candidate was discovered for. */
  providerId: string;
  /** Provider kind, mirrored from the record. */
  kind: ProviderKind;
  /** Adapter/source label that produced this candidate. */
  source: string;
  /** Timestamp of the discovery result (ISO-8601). */
  lastRefreshedAt: string;
  /** Provider-specific scope coordinates; sub-fields optional. */
  scope?: ModelCandidateScope;
  /** Whether using candidates from this source requires a deployment. */
  requiresDeployment?: boolean;
  /** Whether using candidates from this source requires a region. */
  requiresRegion?: boolean;
  /**
   * Capability tags to fall back to when none can be derived from the raw
   * entry (e.g. an adapter that only lists chat models).
   */
  defaultCapabilities?: readonly string[];
}

/** Coerce an unknown value into a plain record for safe property access. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

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

/** A finite number, or `undefined` for anything else (NaN/Infinity/non-number). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A positive integer, or `undefined` for anything else. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Collect capability tags from the common shapes providers use (`capabilities`,
 * `tasks`, `task`, `type`, `modality`), merged with any adapter-supplied
 * defaults. Returns a de-duplicated list of non-empty strings; non-string
 * entries are silently dropped so a malformed field never throws.
 */
function extractCapabilities(raw: Record<string, unknown>, defaults: readonly string[]): string[] {
  const tags: string[] = [];
  const pushTag = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        tags.push(trimmed);
      }
    }
  };

  for (const key of ["capabilities", "tasks"]) {
    const value = raw[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        // Entries may be plain strings or objects like `{ name: "chat" }`.
        pushTag(typeof entry === "string" ? entry : firstString(asRecord(entry).name, asRecord(entry).id));
      }
    }
  }
  pushTag(raw.task);
  pushTag(raw.type);
  pushTag(raw.modality);

  for (const fallback of defaults) {
    pushTag(fallback);
  }

  return [...new Set(tags)];
}

/**
 * Build the candidate `pricing` object from the common provider shapes, keeping
 * only well-typed sub-fields. Returns `undefined` when nothing usable is
 * present so the optional field is omitted rather than emitted empty.
 */
function extractPricing(raw: Record<string, unknown>): ModelCandidate["pricing"] | undefined {
  const pricing = asRecord(raw.pricing);
  const inputPer1k = finiteNumber(pricing.inputPer1k ?? pricing.input ?? pricing.prompt);
  const outputPer1k = finiteNumber(pricing.outputPer1k ?? pricing.output ?? pricing.completion);
  const currency = firstString(pricing.currency, raw.currency);

  if (inputPer1k === undefined && outputPer1k === undefined && currency === undefined) {
    return undefined;
  }
  const result: NonNullable<ModelCandidate["pricing"]> = {};
  if (inputPer1k !== undefined) result.inputPer1k = inputPer1k;
  if (outputPer1k !== undefined) result.outputPer1k = outputPer1k;
  if (currency !== undefined) result.currency = currency;
  return result;
}

/**
 * Derive the lifecycle tag. A truthy `deprecated` flag wins and maps to
 * `"deprecated"`; otherwise the first provider-reported lifecycle/status string
 * is used. Returns `undefined` when nothing is reported.
 */
function extractLifecycle(raw: Record<string, unknown>): string | undefined {
  if (raw.deprecated === true) {
    return "deprecated";
  }
  return firstString(raw.lifecycle, raw.status, raw.state);
}

/**
 * Sanitize an adapter-supplied scope into a valid {@link ModelCandidateScope}.
 * An invalid scope is dropped to an empty scope rather than allowed to fail the
 * final parse.
 */
function safeScope(scope: ModelCandidateScope | undefined): ModelCandidateScope {
  if (scope === undefined) {
    return {};
  }
  const parsed = ModelCandidateScopeSchema.safeParse(scope);
  return parsed.success ? parsed.data : {};
}

/**
 * Map a raw provider entry into a normalized {@link ModelCandidate}
 * (Requirement 10.4, 11).
 *
 * This is the single shared normalizer every Discovery_Adapter uses. It is
 * defensive by construction:
 *
 * - `raw` may be any shape (or not an object at all); property access is
 *   guarded so a missing or malformed optional field never throws
 *   (Requirement 14.2).
 * - Required fields are sourced from the adapter-supplied {@link ctx}, with
 *   `displayName` falling back to the model id and finally a generic label so
 *   a candidate is always well-formed (Requirement 11.1).
 * - Optional fields are emitted only when a well-typed value is present
 *   (Requirement 11.3); otherwise the key is omitted.
 *
 * The constructed candidate is validated against {@link ModelCandidateSchema}
 * before return; on the off chance construction produced an invalid value the
 * normalizer degrades to a minimal, schema-valid candidate rather than throwing
 * — so every returned value parses successfully.
 */
export function normalizeCandidate(raw: unknown, ctx: NormalizeContext): ModelCandidate {
  const entry = asRecord(raw);
  const scope = safeScope(ctx.scope);
  const requiresDeployment = ctx.requiresDeployment ?? false;
  const requiresRegion = ctx.requiresRegion ?? false;

  const modelId = firstString(entry.id, entry.model, entry.model_id, entry.modelId, entry.name);
  const displayName =
    firstString(entry.display_name, entry.displayName, entry.label, entry.name, modelId) ?? "Unknown model";

  const candidate: ModelCandidate = {
    providerId: ctx.providerId,
    kind: ctx.kind,
    scope,
    displayName,
    capabilities: extractCapabilities(entry, ctx.defaultCapabilities ?? []),
    requiresDeployment,
    requiresRegion,
    source: ctx.source,
    lastRefreshedAt: ctx.lastRefreshedAt,
  };

  if (modelId !== undefined) {
    candidate.modelId = modelId;
  }
  const deploymentId = firstString(entry.deployment, entry.deployment_id, entry.deploymentId);
  if (deploymentId !== undefined) {
    candidate.deploymentId = deploymentId;
  }
  const contextWindow = positiveInt(
    entry.context_window ?? entry.contextWindow ?? entry.context_length ?? entry.context_size,
  );
  if (contextWindow !== undefined) {
    candidate.contextWindow = contextWindow;
  }
  const pricing = extractPricing(entry);
  if (pricing !== undefined) {
    candidate.pricing = pricing;
  }
  const lifecycle = extractLifecycle(entry);
  if (lifecycle !== undefined) {
    candidate.lifecycle = lifecycle;
  }

  const parsed = ModelCandidateSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  // Degrade to a minimal, guaranteed-valid candidate. This path is a safety net
  // for an out-of-contract `ctx` (e.g. a malformed scope or timestamp); the
  // normalizer must never throw (Requirement 14.2).
  return ModelCandidateSchema.parse({
    providerId: ctx.providerId,
    kind: ctx.kind,
    scope,
    displayName,
    capabilities: [],
    requiresDeployment,
    requiresRegion,
    source: ctx.source,
    lastRefreshedAt: ctx.lastRefreshedAt,
  });
}
