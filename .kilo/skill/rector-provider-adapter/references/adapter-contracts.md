# Adapter Contracts Reference

## LLM Provider Contract

### ProviderKind (from `src/providers/config.ts`)

```typescript
export const PROVIDER_KINDS = ["together", "cloudflare", "azure-openai", "openai-compatible"] as const;
export type ProviderKind = typeof PROVIDER_KINDS[number];
```

### ProviderConfigRecord Schema

```typescript
{
  id: string;                    // Stable identifier (e.g., "openai-compatible:my-proxy")
  kind: ProviderKind;            // Selects the concrete adapter
  label: string;                 // User-facing name
  baseUrl?: string;              // API base URL
  model?: string;                // Default model
  models?: string[];             // Available models list
  headers?: Record<string, string>; // Custom headers
  azure?: {                      // Azure-specific config
    endpoint: string;
    deploymentId: string;
    apiVersion?: string;
  };
  cloudflare?: {                 // Cloudflare-specific config
    accountId: string;
  };
  secretRef: string;             // Key into SecretStore (NEVER the secret value)
  createdAt: string;             // ISO datetime
  updatedAt: string;             // ISO datetime
}
```

## Memory Provider Contract (from `src/memory/provider.ts`)

```typescript
export interface MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };

  createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
  listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]>;
  updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined>;
  deleteMemoryEntry(id: string): Promise<boolean>;
  searchMemory(query?: string, options?: { layer?: MemoryLayer; limit?: number }): Promise<MemoryEntry[]>;
  pruneMemory(options?: { targetLayer?: MemoryLayer; maxEntries?: number }): Promise<{ pruned: number; summarized: number }>;
  validateConfig?(): void;
}
```

### MemoryEntry Schema

```typescript
{
  id: string;
  content: string;               // Redacted before storage
  layer: MemoryLayer;            // "episodic" | "semantic" | "procedural" | "core"
  tags?: string[];
  accessCount?: number;
  lastAccessedAt?: string;       // ISO datetime
  createdAt: string;
  updatedAt: string;
}
```

### CreateMemoryEntryInput

```typescript
{
  content: string;
  layer?: MemoryLayer;           // Defaults to "episodic"
  tags?: string[];
  metadata?: Record<string, string>;
}
```

## Discovery Adapter Contract (from `src/providers/discovery/adapters/index.ts`)

```typescript
export interface DiscoveryAdapter {
  readonly kind: ProviderKind;
  discover(ctx: AdapterContext): Promise<AdapterResult>;
}

export interface AdapterContext {
  record: ProviderConfigRecord;    // Non-secret config
  secret?: string;                 // Transient, never persisted
  fetchImpl: typeof fetch;         // Injectable for tests
  includeDeprecated: boolean;
  signal?: AbortSignal;            // 30s timeout abort
}

export type AdapterResult =
  | { ok: true; candidates: ModelCandidate[] }
  | { ok: false; error: DiscoveryError };

export interface ModelCandidate {
  id: string;                      // Model identifier
  name?: string;                   // Display name
  contextWindow?: number;          // Max context tokens
  capabilities?: string[];         // ["chat", "code", "vision", etc.]
  deprecated?: boolean;
  pricing?: { input: number; output: number }; // Per-token USD
}
```

## ModelDiscoveryService Dependencies

```typescript
interface ModelDiscoveryServiceDeps {
  configStore: ProviderConfigStore;
  secrets: SecretStore;
  cache: DiscoveryCache;
  adapters: DiscoveryAdapterRegistry;
  clock?: () => number;
}
```

### Discovery Flow

1. Resolve `ProviderConfigRecord` by id from store
2. Check cache (TTL: 5 min success, 30 sec error/empty)
3. Read secret transiently from `SecretStore`
4. Dispatch to registered adapter with 30s `AbortController` timeout
5. Normalize results through `toDiscoveryResult()`
6. Cache write with appropriate TTL

## ConfigBridge Functions

### `resolveProviderEnv(store, secrets, baseEnv)`
Builds effective environment: persisted record fields + resolved secrets overlay onto process.env copy.
**Persisted UI config wins** over ambient env vars.

### `buildProviderFromRecord(record, secret, options, target?)`
Switches on `record.kind` to construct the right `LLMProvider` class.
Injects: secret, baseUrl, model, fetchImpl, enableNetwork flags.

### `buildConfiguredRouter(options)`
Constructs the External_Mode `ModelRouter` from all configured providers.
Maps record IDs to provider instances for Active_Route_Map resolution.
Local mode returns only `FakeLLMProvider`.

### `resolveTestProvider(providerId, store, secrets, options, target?)`
Resolves exactly one provider for connection-test path.
Returns `undefined` for unknown IDs.

## Memory Adapter Base Utilities (from `src/memory/adapterBase.ts`)

```typescript
// Strip secrets from content before storage
redactMemoryContent(content: string): string

// Map provider-native record to validated MemoryEntry (Zod-parsed)
mapToMemoryEntry(raw: unknown, now: string): MemoryEntry

// Wrap any error into redacted, classified Error
classifyAdapterError(error: unknown, context: string): Error

// Serialize entry fields into flat provider metadata
memoryEntryToMetadata(entry: MemoryEntry): Record<string, string>

// Reconstruct memory fields from provider metadata
metadataToMemoryFields(metadata: Record<string, string>, fallbackNow: string): Partial<MemoryEntry>

// Injectable client factory interface for testing
interface MemoryAdapterDeps<TClient> {
  clientFactory: (apiKey: string) => TClient;
  nowFn?: () => string;
  run?: Run;
}
```

## Registration Patterns

### Discovery Adapter Registration (centralized, explicit)

```typescript
// src/providers/discovery/adapters/registry.ts
const ADAPTERS: readonly DiscoveryAdapter[] = [
  togetherDiscoveryAdapter,
  cloudflareDiscoveryAdapter,
  azureDiscoveryAdapter,
  openaiCompatibleDiscoveryAdapter,
  // Add new adapter here
];

export function createDefaultDiscoveryAdapterRegistry(): DiscoveryAdapterRegistry {
  const registry = {} as Record<ProviderKind, DiscoveryAdapter>;
  for (const adapter of ADAPTERS) {
    registry[adapter.kind] = adapter;
  }
  return registry;
}
```

### Memory Provider Registration (bridge switch)

```typescript
// src/providers/memoryBridge.ts
export function buildMemoryProviderFromRecord(record, secret, deps): MemoryProvider {
  switch (record.kind) {
    case "local": return new LocalMemoryProvider(deps);
    case "mem0": return new Mem0MemoryProvider({ apiKey: secret, ...deps });
    case "tidb": return new TidbMemoryProvider({ connectionString: secret, ...deps });
    case "chroma": return new ChromaMemoryProvider({ url: record.baseUrl, ...deps });
    // Add new memory provider here
    default: throw new Error(`Unknown memory provider kind: ${record.kind}`);
  }
}
```
