---
name: rector-provider-adapter
description: "This skill should be used when creating, modifying, or debugging provider adapters in Rector — LLM provider adapters, memory provider adapters, or discovery adapters. Covers the adapter interfaces, registration patterns, configBridge wiring, secret isolation, and the probe mechanism. Triggers on tasks like 'add new provider', 'create adapter', 'wire provider to UI', or 'implement memory backend'."
---

# Rector Provider Adapter

Create and wire provider adapters following Rector's pluggable architecture patterns.

## Purpose

Rector uses a pluggable adapter architecture for LLM providers, memory backends, and model discovery. This skill encodes the contracts, registration patterns, and wiring steps required to add new providers while maintaining secret isolation, local-mode safety, and UI configurability.

## When to Use

- Adding a new LLM provider (e.g., Anthropic, Google, local Ollama)
- Adding a new memory backend (e.g., Pinecone, Weaviate)
- Adding a new discovery adapter for model enumeration
- Debugging provider configuration or connection test failures
- Understanding how UI config flows to runtime provider instances

## Architecture Overview

```
Browser UI (config panel)
    |  POST /api/providers { id, kind, ...fields, apiKey? }
    v
API Server (src/api/server.ts)
    |  Stores record -> ProviderConfigStore (providers.json)
    |  Stores secret -> SecretStore (encrypted, secretRef key)
    v
Config Bridge (src/providers/configBridge.ts)
    |  resolveProviderEnv(): records + secrets -> effective env
    |  buildProviderFromRecord(): constructs live LLMProvider
    |  buildConfiguredRouter(): builds ModelRouter with all providers
    v
ModelRouter.select(input) -> ModelSelection
```

## Adding a New LLM Provider

### Step 1: Define the Provider Kind

In `src/providers/config.ts`:
- Add the new kind to `PROVIDER_KINDS` array
- Add any kind-specific config schema (e.g., `AnthropicProviderConfigSchema`)
- Add optional fields to `ProviderConfigRecordSchema`

### Step 2: Implement the Provider Class

Create or extend an `LLMProvider` implementation. The contract requires:

```typescript
interface LLMProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  invoke(request: LLMRequest): Promise<LLMResponse>;
  // Optional: streaming, model listing, etc.
}
```

Key design rules:
- Accept `fetchImpl` as injectable dependency (for testing)
- Never store raw secrets as class properties visible in serialization
- Classify all errors through probe categories before surfacing
- Support `AbortSignal` for cancellation

### Step 3: Wire into ConfigBridge

In `src/providers/configBridge.ts`:
1. Add a `case` in `overlayRecord()` mapping record fields to env variable names
2. Add a `case` in `buildProviderFromRecord()` constructing the new provider class
3. Add the provider to `buildConfiguredRouter()` — either as singleton preset or per-record instance
4. Map the record `id` into `providerByRecordId` for Active_Route_Map resolution

### Step 4: Create Discovery Adapter

In `src/providers/discovery/adapters/`:
1. Create `{kind}.ts` implementing `DiscoveryAdapter`
2. Register in `registry.ts`'s `ADAPTERS` array

```typescript
export const myDiscoveryAdapter: DiscoveryAdapter = {
  kind: "my-provider",
  async discover(ctx: AdapterContext): Promise<AdapterResult> {
    // ctx.record — non-secret config
    // ctx.secret — transient secret (never persisted/logged)
    // ctx.fetchImpl — injectable fetch
    // ctx.signal — 30s timeout abort
    try {
      const models = await listModels(ctx);
      return { ok: true, candidates: models.map(normalizeCandidate) };
    } catch (error) {
      return { ok: false, error: classifyDiscoveryError(error) };
    }
  },
};
```

### Step 5: Register in Frontend

In `src/public/app.js`:
- Add to `PROVIDER_CONFIG_PRESETS` array with `id`, `kind`, `label`, `fields`
- Fields support dotted paths for nested config (e.g., `"azure.endpoint"`)

In `src/api/server.ts`:
- Add the id to `SUPPORTED_PROVIDER_IDS`

### Step 6: Write Tests

- Property test for the adapter's error classification
- Unit test for configBridge overlay and construction
- Integration test (skipped without credentials) for live round-trip

## Adding a New Memory Provider

### Step 1: Implement the MemoryProvider Interface

```typescript
interface MemoryProvider {
  readonly kind: string;
  readonly id: string;
  readonly metadata: { id: string; kind: string; label?: string };
  createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry>;
  getMemoryEntry(id: string): Promise<MemoryEntry | undefined>;
  listMemoryEntries(layer?: MemoryLayer): Promise<MemoryEntry[]>;
  updateMemoryEntry(id: string, patch: UpdateMemoryEntryInput): Promise<MemoryEntry | undefined>;
  deleteMemoryEntry(id: string): Promise<boolean>;
  searchMemory(query?: string, options?: SearchOptions): Promise<MemoryEntry[]>;
  pruneMemory(options?: PruneOptions): Promise<{ pruned: number; summarized: number }>;
  validateConfig?(): void;
}
```

### Step 2: Use adapterBase Utilities

From `src/memory/adapterBase.ts`:
- `redactMemoryContent(content)` — strip secrets from stored content
- `mapToMemoryEntry(raw, now)` — map provider-native record to validated MemoryEntry
- `classifyAdapterError(error, context)` — wrap errors into redacted, classified Error
- `memoryEntryToMetadata(entry)` — serialize entry fields into flat provider metadata
- `metadataToMemoryFields(metadata, fallbackNow)` — reconstruct from provider metadata

### Step 3: Implement Key Patterns

```typescript
export class MyMemoryProvider implements MemoryProvider {
  // Lazy client initialization (optional deps loaded via createRequire)
  private getClient(): Client {
    if (!this.client) {
      this.client = this.clientFactory(this.apiKey);
    }
    return this.client;
  }

  // Budget enforcement before every operation
  private assertBudget(op: MemoryBudgetOperation): void {
    const decision = evaluateMemoryBudget(this.run, {
      estimatedUsd: MEMORY_OP_COST_USD[op],
      provider: this.kind,
    });
    if (decision.status === "denied") {
      throw classifyAdapterError(new Error(decision.reasons.join("; ")), "Budget denied");
    }
  }

  // Every method wraps in try/catch with classifyAdapterError
  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    this.assertBudget("create");
    try {
      const client = this.getClient();
      // ... implementation ...
    } catch (error) {
      throw classifyAdapterError(error, "createMemoryEntry failed");
    }
  }
}
```

### Step 4: Wire into Memory Bridge

In `src/providers/memoryBridge.ts`:
- Add a `case` in `buildMemoryProviderFromRecord()` switching on `record.kind`

## Architectural Principles

| Principle | Implementation |
|-----------|---------------|
| Secret isolation | Records hold `secretRef` keys, never raw secrets. Secrets read transiently at request time only. |
| Redaction everywhere | All error messages route through `redactString()` / `classifyAdapterError()` before surfacing |
| Injectable deps | `fetchImpl`, `clock`, `fsImpl`, `clientFactory` — all injectable for deterministic tests |
| Local-mode guard | Local mode never reads secrets, never performs network. Always the safe fallback. |
| Defensive adapters | Never throw on malformed payloads — return classified errors. Degrade gracefully. |
| Budget enforcement | Memory operations checked against per-run budget before execution |
| Atomic persistence | Config stores write to temp file then `rename()` — no partial state on crash |
| TTL caching | Discovery results cached 5 min (success) / 30 sec (error). Invalidated on config mutation. |

## Probe Error Categories

When classifying connection test failures:

| Category | Trigger |
|----------|---------|
| `auth_invalid` | 401/403 status |
| `endpoint_invalid` | 404/DNS/connection errors |
| `region_unsupported` | Region-specific rejection |
| `deployment_not_found` | Azure-specific 404 |
| `model_access_missing` | Agreement/access required |
| `quota_exceeded` | 429 or quota keywords |
| `parameter_incompatible` | 400 status |
| `content_rejected` | Content filter keywords |
| `unknown` | Fallthrough |

Classification is most-specific to least-specific. The user-facing message is always redacted.

## Reference Files

- `references/adapter-contracts.md` — Full interface definitions and type schemas for all adapter contracts
