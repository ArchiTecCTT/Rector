# Chunk 6 — Chat API Vertical Shell

## Goal
Add a chat-first vertical slice without removing the existing task API.

## Scope
- Add in-memory chat conversation, message, run, and run event endpoints on the existing Express app.
- Use `InMemoryRectorStore` only; no provider calls and no full orchestration integration.
- Create a fake successful run trace for each user message so UI can display status/events.
- Add a minimal chat-first UI shell in `src/public` while preserving existing marketing/task smoke markers.
- Add API/UI tests and keep old task API tests passing.

## TDD checklist
1. Add tests for conversation create/list/get, message send, missing conversation, run events, and UI chat markers.
2. Implement narrow Express handlers using the new store.
3. Replace/add minimal UI chat form logic that calls the new endpoints.
4. Run `npm test` and `npm run build`.
