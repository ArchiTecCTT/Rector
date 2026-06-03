# Chunk 21 — Retool Operator Console API

## Goal

Expose local-only operator API endpoints that a future Retool console can consume for run inspection and operational triage. Retool remains optional maintainer/operator tooling, not the user product.

## Scope

Implement only provider-free, network-free API surfaces:

- Run inspection endpoints.
- Failure listing endpoint.
- Approval listing and decision placeholder.
- Cost summary endpoint.
- Retry and abort placeholders.
- Artifact metadata endpoint that never returns stored raw artifact content.
- Linear issue creation stub that performs no network calls.

## Out of Scope

- Authentication/authorization beyond explicit `localOnly` response metadata.
- Retool UI/app export.
- Real Linear API calls.
- Real retry/resume/abort execution control.
- Durable storage or production operator audit log.

## API Shape

All endpoints live under `/api/operator` and return `localOnly: true` plus `auth: "local-only-no-auth"`.

- `GET /api/operator/runs` — list run summaries.
- `GET /api/operator/runs/:id` — inspect one run with events, conversation, user message, assistant messages, and artifact handles discovered from events.
- `GET /api/operator/failures` — list failed, aborted, needs-decision, or error-bearing runs with failure events.
- `GET /api/operator/approvals` — list runs currently waiting for decisions.
- `POST /api/operator/approvals/:runId/decision` — validate and echo a placeholder decision, no resume/network.
- `GET /api/operator/costs` — aggregate estimated/actual USD, tokens, and model-call counts.
- `POST /api/operator/runs/:id/retry` — placeholder response, no mutation.
- `POST /api/operator/runs/:id/abort` — placeholder response, no mutation.
- `GET /api/operator/artifacts/:id` — artifact metadata only; omit `metadata.content`.
- `POST /api/operator/linear/issues` — deterministic stub response, no network.

## Test Plan

Follow TDD:

1. Add failing API tests covering endpoint availability and response shape.
2. Assert artifact endpoint returns metadata only and omits raw content.
3. Assert Linear stub does not call `globalThis.fetch` and returns a local stub issue key.
4. Assert placeholder endpoints do not mutate run status/phase.
5. Run `npm test` and `npm run build`.

## Acceptance Criteria

- All new endpoints are provider-free and network-free.
- All responses identify the API as local-only/no-auth.
- Operator endpoints expose enough metadata for Retool tables/detail views.
- Artifact viewing never leaks raw in-memory content from artifact metadata.
- Concerns register documents local-only/no-auth/operator limitations.
