import type { ProviderKind } from "../../config";
import { azureDiscoveryAdapter } from "./azure";
import { cloudflareDiscoveryAdapter } from "./cloudflare";
import type { DiscoveryAdapter, DiscoveryAdapterRegistry } from "./index";
import { openaiCompatibleDiscoveryAdapter } from "./openaiCompatible";
import { togetherDiscoveryAdapter } from "./together";

/**
 * Default Discovery_Adapter registry assembly (design section C —
 * Model_Discovery_Service dispatch, Requirement 10.2).
 *
 * The Model_Discovery_Service dispatches to exactly one {@link DiscoveryAdapter}
 * per {@link ProviderKind}. The concrete adapters intentionally do NOT assemble
 * themselves into a registry — each exports only its own
 * {@link DiscoveryAdapter} value — so the single mapping from kind to adapter
 * lives here, next to the service that consumes it.
 *
 * The mapping is keyed by {@link ProviderKind} and each entry's `kind` is
 * asserted to match its key at construction time, so a future adapter wired to
 * the wrong key fails loudly rather than silently mis-dispatching.
 */

/** The four shipped adapters, one per {@link ProviderKind}. */
const ADAPTERS: readonly DiscoveryAdapter[] = [
  togetherDiscoveryAdapter,
  cloudflareDiscoveryAdapter,
  azureDiscoveryAdapter,
  openaiCompatibleDiscoveryAdapter,
];

/**
 * Build the default {@link DiscoveryAdapterRegistry} from the four shipped
 * adapters (Together, Cloudflare, Azure OpenAI, OpenAI-compatible). A fresh
 * object is returned on each call so callers (and tests) never share mutable
 * registry state.
 *
 * Throws if any adapter's declared `kind` does not match the key it is filed
 * under, guarding against a mis-wired dispatch table.
 */
export function createDefaultDiscoveryAdapterRegistry(): DiscoveryAdapterRegistry {
  const registry = {} as Record<ProviderKind, DiscoveryAdapter>;
  for (const adapter of ADAPTERS) {
    registry[adapter.kind] = adapter;
  }
  return registry;
}
