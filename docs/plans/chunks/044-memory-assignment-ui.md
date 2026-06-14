# Chunk 044 — Memory Assignment UI and Provider Wiring

> **Created:** 2026-06-12
> **Branch:** `rector-0.2.0`
> **Depends on:** Chunks 034–036 memory UI/provider foundations; Chunk 042d memory hardening recommended before/alongside implementation
> **Goal:** Let users choose and configure memory providers per memory role from the web UI, with local defaults, secret-safe setup, connection testing, and migration-ready contracts.

## Why This Chunk Exists

Rector's memory system is central to the product vision. Users should be able to choose memory backends from the UI:

- local in-memory for demos/tests
- local SQLite for durable zero-config use
- TiDB Cloud for hosted SQL durability
- Chroma for vector search
- Mem0 for managed long-term AI memory
- future memory providers through the module system

Today the project has memory provider records, adapters, and UI pieces, but it needs a stronger **memory role assignment** model: different kinds of memory should be allowed to use different providers.

## Target Product Experience

User opens Settings → Memory and sees:

```text
Memory Setup

Conversation store:   SQLite local          [Change] [Test]
Episodic memory:      Mem0                  [Change] [Test]
Semantic memory:      Chroma                [Change] [Test]
Truth library:        TiDB Cloud            [Change] [Test]
Reflection lessons:   SQLite local          [Change] [Test]
Artifact index:       SQLite local          [Change] [Test]
```

User can:

- select provider per memory role
- configure API keys/connections in UI
- test connection
- see readiness/errors
- choose local-first defaults
- later apply templates from Chunk 045

## Memory Roles

Add canonical roles:

```ts
export const MEMORY_ROLES = [
  "conversationStore",
  "episodicMemory",
  "semanticMemory",
  "truthLibrary",
  "vectorSearch",
  "reflectionLessons",
  "artifactIndex",
] as const;
```

Definitions:

| Role | Purpose | Default |
|------|---------|---------|
| `conversationStore` | conversations/messages/runs/events | SQLite/local store |
| `episodicMemory` | run/user experience memories | local SQLite |
| `semanticMemory` | summarized knowledge | local SQLite |
| `truthLibrary` | trusted docs/facts/citations | local truth library |
| `vectorSearch` | embedding-based recall | disabled/local keyword fallback |
| `reflectionLessons` | ponder/subconscious lessons | local SQLite |
| `artifactIndex` | file/doc/artifact metadata | local SQLite |

## Data Model

Create `src/providers/memoryAssignments.ts` or similar.

```ts
interface MemoryRoleAssignment {
  id: string;
  userId?: string;
  workspaceId?: string;
  role: MemoryRole;
  providerRecordId: string | "local" | "disabled";
  enabled: boolean;
  readPriority?: number;
  writePriority?: number;
  fallbackProviderRecordId?: string | "local" | "disabled";
  retentionPolicy?: "ephemeral" | "session" | "durable" | "longTerm";
  maxEntries?: number;
  maxUsdPerDay?: number;
  createdAt: string;
  updatedAt: string;
}
```

No secrets in assignments. Provider records reference secret IDs in `SecretStore`.

## Provider Capability Model

Each memory provider advertises capabilities:

```ts
interface MemoryProviderCapabilities {
  durable: boolean;
  vectorSearch: boolean;
  keywordSearch: boolean;
  metadataFilters: boolean;
  delete: boolean;
  update: boolean;
  prune: boolean;
  externalNetwork: boolean;
  estimatedCostTier: "free" | "low" | "medium" | "high";
}
```

Examples:

| Provider | Durable | Vector | External | Notes |
|----------|---------|--------|----------|-------|
| in-memory | no | no | no | local tests/demo |
| SQLite | yes | no | no | default local durable |
| TiDB | yes | maybe later | yes | cloud SQL |
| Chroma | yes | yes | optional | vector search |
| Mem0 | yes | yes/managed | yes | managed AI memory |

## Resolution Algorithm

Create `MemoryRoleRouter`:

```ts
resolveMemoryProvider(role, context): EffectiveMemoryProvider
```

Resolution order:

1. user/workspace role assignment
2. workspace default
3. template default
4. local built-in fallback
5. disabled if role optional and no provider exists

Must return:

- provider instance or disabled state
- fallback provider
- capability warnings
- readiness status
- redacted error if not ready

## API Surface

Add/strengthen endpoints:

```http
GET    /api/memory-roles
GET    /api/memory-assignments
PUT    /api/memory-assignments/:role
POST   /api/memory-assignments/:role/test
POST   /api/memory-assignments/reset
GET    /api/memory-assignments/effective
POST   /api/memory-assignments/:role/migrate/plan
```

Migration endpoint in this chunk only produces a **plan**, not automatic destructive migration.

## UI Work

Add/extend Settings → Memory panel:

- role/provider matrix
- provider readiness cards
- configure provider modal
- secret/API key form using SecretStore flow
- connection test button
- warning if external memory used in non-local mode
- local default quick setup
- migration plan preview, no destructive action yet

## Runtime Wiring

Update memory consumers to resolve by role:

| Consumer | Memory Role |
|----------|-------------|
| conversations/messages/runs | `conversationStore` |
| `/api/notes` | `episodicMemory` or `semanticMemory` based on type |
| context builder memory recall | `episodicMemory`, `semanticMemory`, `truthLibrary` |
| ponder swarm lessons | `reflectionLessons` |
| truth library retrieval | `truthLibrary` |
| future embedding search | `vectorSearch` |
| artifact handles | `artifactIndex` |

Keep compatibility with current `MemoryProvider` bridge.

## Provider Setup Requirements

### Local SQLite

- zero API key
- default durable path under user/workspace data path
- test verifies writable DB + schema

### TiDB

- base URL/host
- account/user
- database
- secret/password
- TLS default on
- startup migration verified
- errors redacted

### Mem0

- API key in SecretStore
- optional user/project namespace
- adapter contract tests with fake client
- live smoke optional/skipped by default

### Chroma

- base URL or local connection mode
- collection name
- metadata filters
- live smoke optional/skipped by default

## Tests

Add/extend:

- `tests/memoryAssignments.test.ts`
- `tests/memoryAssignmentsApi.test.ts`
- `tests/memoryAssignments.dom.test.ts`
- `tests/memoryRoleRouter.test.ts`
- `tests/memoryAssignmentLocalMode.property.test.ts`
- `tests/memoryProviderCapabilityWarnings.test.ts`

Test cases:

- defaults resolve to local providers
- external provider cannot leak secret
- capability mismatch warning for vector role assigned to non-vector provider
- per-user isolation
- connection test errors redacted
- migration plan is non-destructive
- local mode makes no external network calls

## Acceptance Criteria

- Users can assign memory provider per memory role from UI.
- Local SQLite/in-memory default remains zero-config.
- Mem0/Chroma/TiDB can be configured without editing files/env.
- Secrets never appear in assignment/provider API responses.
- Runtime memory consumers use role router where appropriate.
- Provider capability warnings are visible.
- `npm test`, `npm run build`, and `npm audit` pass.

## Risks

| Risk | Mitigation |
|------|------------|
| Data loss during provider switch | only migration plan, no destructive migration in this chunk |
| Cost surprise from external memory | role budgets + warnings |
| Secret leak | SecretStore-only, redaction tests |
| Vector provider assigned to non-vector role | capability warnings but allow where safe |
| Too much complexity in UI | sane defaults + templates in Chunk 045 |

## Follow-Up

- Chunk 045 templates include memory assignments.
- Later chunk: actual safe memory migration/copy with backups.
- Later chunk: advanced vector/hybrid retrieval if needed.

## Suggested Commit

```text
feat(chunk-044): add memory role assignment plan
```
