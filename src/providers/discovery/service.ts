import { redactString } from "../../security/redaction";
import type { SecretStore } from "../../security/secretStore";
import type { ProviderConfigRecord } from "../config";
import type { ProviderConfigStore } from "../configStore";
import type { AdapterContext, AdapterResult, DiscoveryAdapterRegistry } from "./adapters";
import type { DiscoveryCache } from "./cache";
import type { DiscoveryError, DiscoveryResult } from "./types";

/**
 * Model_Discovery_Service (design section C — `service.ts`).
 *
 * The single interface that enumerates {@link import("./types").ModelCandidate}s
 * for a configured Provider, identified by its
 * {@link ProviderConfigRecord} id (Requirement 10.1). It owns the request flow
 * and delegates the per-provider HTTP work to a {@link DiscoveryAdapterRegistry}
 * so the service stays provider-agnostic:
 *
 * 1. resolve the record; an unknown id short-circuits to a classified
 *    `not_found` result with NO network call (Requirement 10.3);
 * 2. serve a cached result that is still within its TTL when the caller did not
 *    ask to refresh (Requirement 16.2);
 * 3. read the provider's secret transiently through the {@link SecretStore} at
 *    request time — never persisted, logged, or returned (Requirement 18.3,
 *    18.4);
 * 4. dispatch to the {@link DiscoveryAdapter} registered for `record.kind`
 *    (Requirement 10.2); the adapter already returns normalized candidates
 *    (Requirement 10.4);
 * 5. route every returned error message through the Redaction_Layer
 *    (Requirement 18.1, 18.2);
 * 6. write the success/error result into the {@link DiscoveryCache} with the
 *    appropriate TTL (Requirement 16.1, 16.4).
 *
 * All network access flows through an injected `fetchImpl` (defaulting to the
 * global `fetch` only at the boundary), keeping tests hermetic (Requirement 29).
 * Time is read through an injectable `clock` so caching and `lastRefreshedAt`
 * stay deterministic.
 */

/** Options for a single discovery request. */
export interface DiscoverOptions {
  /** Bypass the Discovery_Cache and re-run discovery (Requirement 17.2). */
  refresh?: boolean;
  /** Include models marked deprecated in the result (Requirement 12.4). */
  includeDeprecated?: boolean;
  /** Injected `fetch` implementation; defaults to the global `fetch` (Requirement 29). */
  fetchImpl?: typeof fetch;
}

/** The Model_Discovery_Service contract (design section C). */
export interface ModelDiscoveryService {
  /**
   * Enumerate the Model_Candidates for the Provider identified by `providerId`,
   * returning a classified, redacted error result on any failure rather than
   * throwing.
   */
  discover(providerId: string, options?: DiscoverOptions): Promise<DiscoveryResult>;
}

/** Construction dependencies for {@link createModelDiscoveryService}. */
export interface ModelDiscoveryServiceDeps {
  /** Source of the non-secret {@link ProviderConfigRecord}s. */
  configStore: ProviderConfigStore;
  /** Secret_Store the transient per-request secret is read from. */
  secrets: SecretStore;
  /** TTL cache of prior discovery results. */
  cache: DiscoveryCache;
  /** One {@link DiscoveryAdapter} per {@link import("../config").ProviderKind}. */
  adapters: DiscoveryAdapterRegistry;
  /** Epoch-millisecond clock; defaults to {@link Date.now}. */
  clock?: () => number;
}

/** Build a classified, redacted {@link DiscoveryError}. */
function discoveryError(category: DiscoveryError["category"], message: string): DiscoveryError {
  return { category, message: redactString(message) };
}

/**
 * Hard ceiling on a single Discovery_Adapter catalog request (Requirement 2.9).
 * The service aborts any adapter call that does not resolve within this window
 * and classifies the unanswered request as a `network_error` at the adapter
 * layer; the Settings_API re-classifies its own outer wait as `timeout`.
 */
const DISCOVERY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Look up the {@link ProviderConfigRecord} for `providerId`, or `undefined` when
 * no record exists. Reads the full state through the store and never throws.
 */
async function resolveRecord(
  configStore: ProviderConfigStore,
  providerId: string,
): Promise<ProviderConfigRecord | undefined> {
  const state = await configStore.getState();
  return state.providers.find((provider) => provider.id === providerId);
}

/**
 * Map an {@link AdapterResult} into the public {@link DiscoveryResult}, attaching
 * the `providerId` and result `lastRefreshedAt`, and routing any error message
 * through the Redaction_Layer (Requirement 18.1, 18.2).
 */
function toDiscoveryResult(
  adapterResult: AdapterResult,
  providerId: string,
  lastRefreshedAt: string,
): DiscoveryResult {
  if (adapterResult.ok) {
    return { ok: true, providerId, candidates: adapterResult.candidates, lastRefreshedAt };
  }
  return {
    ok: false,
    providerId,
    error: discoveryError(adapterResult.error.category, adapterResult.error.message),
    lastRefreshedAt,
  };
}

/**
 * Create the {@link ModelDiscoveryService}.
 *
 * The returned service is stateless beyond its injected dependencies, so a
 * single instance can serve every request; the {@link DiscoveryCache} holds the
 * only per-provider state.
 */
export function createModelDiscoveryService(deps: ModelDiscoveryServiceDeps): ModelDiscoveryService {
  const { configStore, secrets, cache, adapters } = deps;
  const clock = deps.clock ?? (() => Date.now());

  return {
    async discover(providerId: string, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
      const now = clock();
      const lastRefreshedAt = new Date(now).toISOString();

      // 1. Resolve the record. An unknown id short-circuits to `not_found` with
      //    no secret read and no network call (Requirement 10.3).
      const record = await resolveRecord(configStore, providerId);
      if (record === undefined) {
        return {
          ok: false,
          providerId,
          error: discoveryError("not_found", `No provider configuration found for "${providerId}".`),
          lastRefreshedAt,
        };
      }

      // 2. Serve a still-fresh cached result unless a refresh was requested
      //    (Requirement 16.2). A refresh bypasses the cache (Requirement 17.2).
      if (!options.refresh) {
        const cached = cache.get(providerId, now);
        if (cached !== undefined) {
          return cached;
        }
      }

      // 3. Read the secret transiently through the Secret_Store at request time
      //    (Requirement 18.4). The value is passed to the adapter for the
      //    duration of the call only and is never persisted, logged, or
      //    returned (Requirement 18.3). A missing secret is left undefined so
      //    the adapter classifies it (e.g. `auth_invalid`).
      const secretResult = await secrets.getSecret(record.secretRef);
      const secret = secretResult.ok ? secretResult.value : undefined;

      // 4. Dispatch to the adapter registered for this record's kind
      //    (Requirement 10.2). Adapters are defensive and return a classified
      //    error rather than throwing, but guard here too so an unexpected throw
      //    still yields a classified, redacted result (Requirement 18.1).
      //
      //    The adapter's catalog request is wrapped with an AbortController and
      //    a 30 000 ms timer (Requirement 2.9): if the adapter has not resolved
      //    by the deadline the controller is aborted — cancelling the adapter's
      //    in-flight `fetch` via `ctx.signal` — and the unanswered request is
      //    classified as a `network_error`.
      const adapter = adapters[record.kind];
      const controller = new AbortController();
      const context: AdapterContext = {
        record,
        secret,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        includeDeprecated: options.includeDeprecated ?? false,
        signal: controller.signal,
      };

      let result: DiscoveryResult;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<DiscoveryResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({
              ok: false,
              providerId,
              error: discoveryError(
                "network_error",
                `Model discovery for "${providerId}" did not respond within ${DISCOVERY_REQUEST_TIMEOUT_MS} ms.`,
              ),
              lastRefreshedAt,
            });
          }, DISCOVERY_REQUEST_TIMEOUT_MS);
        });

        const adapterRun = adapter
          .discover(context)
          // 5. Normalize the adapter result and redact (Requirement 10.4, 18.2).
          .then((adapterResult) => toDiscoveryResult(adapterResult, providerId, lastRefreshedAt));

        result = await Promise.race([adapterRun, timeout]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          ok: false,
          providerId,
          error: discoveryError("unknown", message),
          lastRefreshedAt,
        };
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      // 6. Cache the result with its success/error TTL (Requirement 16.1, 16.4).
      cache.set(providerId, result, now);
      return result;
    },
  };
}
