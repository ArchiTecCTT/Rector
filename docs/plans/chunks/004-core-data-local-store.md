# Chunk 004 — Core Data Model and Local Store

Plan:
- Add focused store modules under `src/store` without changing legacy task repository.
- Define Zod schemas and TypeScript types for Conversation, Message, Budget, Run, Artifact, and store inputs.
- Reuse `RunEvent` from `src/protocol/events` for persisted store events.
- Implement `InMemoryRectorStore` with async CRUD/list/append methods that validate data and return deep copies.
- Add lightweight ID/time helpers only where needed by store create methods.
- Cover create/list/get, update, copy safety, event append order, artifact storage, and run budget persistence with Vitest.
- Verify with `npm test` and `npm run build`.
