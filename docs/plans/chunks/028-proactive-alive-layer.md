# Chunk 28 — Proactive / “Alive” Layer (Neuro-Symbolic Step 3)

## Goal
Make Rector feel "alive and proactive". Add a layer that can initiate conversations, check in on goals, and send messages like “Hey, you wanted to finish the pagination work yesterday — I sketched a plan and the tests are passing in the sandbox. Want me to apply it?”

## Scope (this chunk)
- New module: `src/proactive/ProactiveAgent.ts` (and index).
- `ProactiveAgent` class that can be triggered on timer or specific events (e.g., long `NEEDS_DECISION`, morning-like idle, or manual trigger for alpha).
- Uses dedicated model route `"proactive-companion"` (warmer, relational prompt via existing router).
- Can read open runs + memory (from Step 2).
- Decides to send proactive assistant messages by reusing the existing `runChat` pipeline with a synthetic user message (e.g. "[proactive check-in]").
- Messages created with `source: "proactive"` (extend Message lightly if needed for metadata).
- All calls go through budget, redaction, and the symbolic pipeline.
- Local mode: the agent is not auto-started (no timers in fake path); can be manually triggered in tests/external for demo.
- Basic integration in server.ts: optional start of a simple interval or on-demand trigger endpoint for alpha.
- Tests: unit for agent decision logic, integration test that reuses runChat without breaking existing.
- Update concerns.
- Commit as Chunk 28.

## Non-goals
- Full UI badge (the `source` will be in the message/run payload for future UI; content can mention it).
- Complex scheduling (use simple setInterval or event hook for alpha; real cron later).
- Changes to local fake run behavior.
- Heavy use of new memory in proactive decision for this chunk (basic run + memory summary is fine; advanced in later steps).

## Implementation Plan
1. Create `src/proactive/index.ts` and `ProactiveAgent.ts`.
2. Define the agent:
   - Constructor takes store, router (optional for local), etc.
   - `triggerProactiveCheck(options: { syntheticPrompt?: string; conversationId?: string })`: creates a synthetic user message, runs the chat pipeline (reusing runChat), marks the resulting assistant message with source "proactive".
   - Internal logic: reads recent runs/memory, builds a relational prompt for "proactive-companion" route.
3. Add `source?: string` optional to MessageSchema (and Create/Update) for marking (backward compatible, default undefined for existing).
4. In `src/api/server.ts`:
   - After setting up rectorStore, optionally create and start a ProactiveAgent (only if orchestration mode external or via flag; disabled by default for local tests).
   - Add a dev/test trigger `POST /api/dev/proactive-trigger` (guarded, like existing /api/dev/scenario).
5. Update message creation in chatRunner or server to propagate source if provided in the run result or extra.
6. Tests in new `tests/proactive.test.ts`: test that proactive trigger produces a message with source, reuses pipeline, no breakage to normal chat.
7. Update concerns.
8. Commit.

## Acceptance Criteria
- Proactive messages are created via the real pipeline.
- `source: "proactive"` is present on those messages (visible in API responses/events).
- Local mode tests still pass 100% (agent not auto-started in local).
- Budget/redaction applied to any proactive LLM calls.
- Plan doc + clean commit.

## Risks
- Timers in server can affect tests if not isolated — guard strictly.
- Proactive could spam — limit frequency, use memory to avoid repeats.

## References
- Neuro-symbolic prompt Step 3.
- Existing chatRunner, server routes, memory from 27.
- Model router for "proactive-companion" route (add to config if needed, fall back to cheap).

This delivers the “feels alive” behavior quickly while staying under symbolic control.