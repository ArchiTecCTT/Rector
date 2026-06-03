# Chunk 15 — End-to-End Chat Brainstem Test

## Goal

Prove the local provider-free chat brainstem runs from a user chat message through deterministic orchestration and returns a synthesized assistant response backed by trace evidence.

## Scope

- Add a small synthesis module for final assistant text.
- Wire synthesis into `POST /api/chat/conversations/:id/messages` after validation/healing.
- Preserve local-only/no-provider behavior: no API keys, no shell, no external IO.
- Add end-to-end chat API tests for phase payload coverage and final response evidence.
- Add deterministic failure+healing coverage using simulator options/test helper path.
- Update concerns register.

## Acceptance Criteria

1. Chat message produces run events for triage, context building, planning, skeptic review, crucible, DAG compilation, execution, validation/healing, synthesis, and done.
2. Final assistant message includes concise status, route, trace ID, and pipeline evidence instead of placeholder receipt text.
3. E2E tests assert all phase payloads exist.
4. E2E tests assert local provider-free execution requires no API keys and does not configure providers.
5. Failure+healing path deterministically reaches healed validation status without shell/provider calls.
6. `npm test` and `npm run build` pass.

## Implementation Notes

- Keep synthesizer pure and deterministic.
- Avoid exposing large raw event payloads in assistant text.
- Use existing simulator failure knobs for healing tests.
- Keep Chunk 16 observability out of scope.
