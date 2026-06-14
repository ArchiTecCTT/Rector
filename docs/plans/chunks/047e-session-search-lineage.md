# Chunk 047e — Session Search & Conversation Lineage

> **Created:** 2026-06-12
> **Phase:** 5 of 6 (Runtime Maturity)
> **Depends on:** Chunk 047a (compression lineage fields), Chunk 004/005 (store baseline)
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Add **full-text search** over conversation messages (SQLite FTS5 for `SqlRectorStore`) and expose **conversation lineage** (`parentConversationId`, `compressionGeneration`) in the API and chat UI so users can find past sessions and understand compression forks.

## Scope

### In Scope

- `src/store/schemas.ts` (lineage fields — may overlap 047a; consolidate migration)
- `src/store/sqlRectorStore.ts` (FTS5 virtual table + triggers)
- `src/store/inMemoryRectorStore.ts` (keyword fallback for tests)
- New: `src/store/sessionSearch.ts`
- `src/api/server.ts` (`GET /api/conversations/search`)
- `src/public/app.js` (sidebar search box + lineage badge)
- `src/public/index.html` (search input markup)
- Tests under `tests/`

### Out of Scope

- Cross-workspace search
- Semantic/vector search (Chunk 042d / memory adapters)
- TiDB FTS (SQLite only for v0.3.0; TiDB gets keyword fallback)
- Message content highlighting in FTS snippets beyond basic match

## Design Principles

1. **Redact before index.** Message content passes through `redactString` before FTS insert; secrets never enter FTS tables.
2. **Lineage is acyclic.** `parentConversationId` chain must not cycle; enforce on create.
3. **CI hermetic.** In-memory store uses simple keyword scan; FTS tests use `:memory:` SQLite driver only.
4. **Search is read-only.** FTS queries never mutate store.
5. **Workspace scoped.** Results filtered by `workspaceId` from session/auth context.

## Data Model

### Conversation schema (consolidate with 047a)

```ts
export const ConversationSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  workspaceId: NonEmptyStringSchema,
  parentConversationId: NonEmptyStringSchema.optional(),
  compressionGeneration: z.number().int().nonnegative().default(0),
  compressionSummaryArtifactId: NonEmptyStringSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  retentionPolicy: NonEmptyStringSchema,
});
```

### Search result type — `src/store/sessionSearch.ts`

```ts
export const SessionSearchHitSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  title: z.string(),
  snippet: z.string(), // redacted, length-capped
  score: z.number().nonnegative(),
  matchedAt: z.string().datetime(),
  compressionGeneration: z.number().int().nonnegative(),
  parentConversationId: z.string().optional(),
});

export interface SessionSearchQuery {
  query: string;
  workspaceId: string;
  limit?: number; // default 20, max 50
}
```

## Work Items

### 1. SQLite FTS5 schema

In `sqlRectorStore.ts` migration (schema version bump):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  workspace_id UNINDEXED,
  content,
  tokenize = 'porter'
);

-- Triggers on messages INSERT/UPDATE/DELETE to sync messages_fts
```

- On `createMessage` / `updateMessage`: redact content, upsert FTS row
- On `deleteMessage` (if supported): remove FTS row
- Store only redacted content; if redaction fails, index `[REDACTION_FAILED]` placeholder

### 2. Lineage validation

Add `src/store/lineage.ts`:

- `validateParentConversation(store, childId, parentId): Promise<void>`
  - Parent must exist
  - Walk parent chain; reject if childId appears (cycle)
  - Max depth 10
- Call from `createConversation` when `parentConversationId` set

### 3. Session search service

Create `src/store/sessionSearch.ts`:

- `searchSessions(store, query: SessionSearchQuery): Promise<SessionSearchHit[]>`
- **SqlRectorStore path:** FTS5 `MATCH` with workspace filter; snippet via `highlight(messages_fts, 3, '<b>', '</b>')` escaped for HTML
- **InMemoryRectorStore path:** case-insensitive substring scan on messages
- Ranking: FTS rank + recency boost (`updatedAt`)
- Empty query returns recent conversations (no FTS), sorted by `updatedAt` desc

### 4. Store interface extension

Add to `RectorStore` interface:

```ts
searchConversations?(query: SessionSearchQuery): Promise<SessionSearchHit[]>;
getConversationLineage?(conversationId: string): Promise<Conversation[]>;
```

- `getConversationLineage`: walk `parentConversationId` from child to root, return ordered array `[root, ..., current]`
- Default in-memory implementation for tests

### 5. API routes

In `src/api/server.ts`:

```
GET /api/conversations/search?q=&limit=
→ { hits: SessionSearchHit[] }
```

- Require auth / workspace context as per existing conversation routes
- Redact outbound via `sendRedacted`
- 400 if `q` longer than 500 chars

```
GET /api/conversations/:id/lineage
→ { lineage: Conversation[] }
```

### 6. Chat UI

In `src/public/index.html` + `app.js`:

- Search input in conversation sidebar
- Debounce 300ms; call `/api/conversations/search`
- Render hits with title, snippet, generation badge (`gen-2` if compressionGeneration > 0)
- Click hit → navigate to conversation
- When viewing compressed child, show breadcrumb: `Parent › Current (compressed)`

### 7. Integration with 047a compression

When `compressContextLineage` creates child conversation:

- Set `parentConversationId`, `compressionGeneration`
- FTS indexes messages only in active conversation (child starts with summary + recent messages)
- Parent conversation remains searchable independently

## TDD Plan

### `tests/sessionSearchSqlite.test.ts`

- Insert messages; search finds by keyword
- Redacted secret not matchable by secret substring
- Workspace filter isolates results
- Update message updates FTS index

### `tests/conversationLineage.test.ts`

- Parent-child chain retrievable
- Cycle rejection on create
- Max depth enforcement

### `tests/sessionSearchInMemory.test.ts`

- Keyword fallback works without FTS
- Empty query returns recents

### API test — `tests/conversationSearchApi.test.ts`

- GET search returns hits
- Lineage endpoint returns ordered chain

### Property test

- **Property 47e-1:** Lineage walk from any conversation yields acyclic chain
- **Property 47e-2:** Search result snippets length ≤ 300 chars

## Acceptance Criteria

- [ ] FTS5 active for SQLite persistence path
- [ ] In-memory tests pass without FTS
- [ ] Search API returns redacted snippets
- [ ] UI search box functional
- [ ] Lineage breadcrumb visible for compressed conversations
- [ ] No secret tokens in FTS table (audit test with inject secret message)
- [ ] `npm test`, `npm run build`, `npm audit` pass

## Concerns to Register

- FTS5 porter stemming may over-match; acceptable for v0.3.0
- TiDB path lacks FTS5; keyword fallback only until later chunk
- Large message bodies increase index size; consider truncation at index time (max 32KB)

## Commit

```text
feat(chunk-047e): session search and conversation lineage
```