# Chunk 23 — External Workflow Integrations

## Goal

Add local-first external workflow integration contracts for Rector alpha. Linear and Make become typed adapter surfaces for escalation tickets, notifications, reports, and approval workflows, but all external calls remain disabled by default and tests perform no network access.

## Scope

Implement only deterministic contracts, request builders, validation, and stubs:

- Workflow payload schemas for notifications, reports, approval workflows, and escalation tickets.
- Linear integration adapter contract/stub with config validation, GraphQL request builder, and network-disabled default invocation gate.
- Make integration adapter contract/stub with config validation, webhook request builder, and network-disabled default invocation gate.
- Requestly and BrowserStack plan stub schemas/functions for future API/UI testing workflows; docs/plans only, no network execution.
- Unit tests for schema validation, config validation, request construction, no-network defaults, and plan stubs.
- Environment example entries for optional integration configuration.
- Concerns register update documenting alpha limitations.

## Out of Scope

- Real Linear or Make calls in tests/CI.
- Live Requestly or BrowserStack API integration.
- Operator UI wiring beyond exported contracts.
- Durable workflow audit logs.
- Production webhook signature verification, retry/backoff, or RBAC.

## Design

Add `src/workflows/index.ts` exporting:

- `WORKFLOW_INTEGRATION_API_VERSION`.
- Shared schemas: `WorkflowNotificationPayloadSchema`, `WorkflowReportPayloadSchema`, `ApprovalWorkflowPayloadSchema`, `EscalationTicketPayloadSchema`.
- Result schemas: `WorkflowIssueRecordSchema`, `WorkflowDeliveryResultSchema`, `WorkflowPlanStubSchema`.
- `WorkflowIntegrationError` with `CONFIG_INVALID`, `NETWORK_DISABLED`, `PROVIDER_HTTP_ERROR`, and `PROVIDER_RESPONSE_INVALID` codes.
- `LinearWorkflowAdapter`:
  - Reads `LINEAR_API_KEY`, optional `LINEAR_TEAM_ID`, optional `LINEAR_BASE_URL`.
  - `validateConfig()` requires an API key and absolute GraphQL URL.
  - `buildCreateIssueRequest()` emits a GraphQL `issueCreate` request without fetching.
  - `createIssue()` defaults to `NETWORK_DISABLED` unless constructed with `enableNetwork: true`.
- `MakeWorkflowAdapter`:
  - Reads `MAKE_WEBHOOK_URL` and optional `MAKE_WEBHOOK_SECRET`.
  - `validateConfig()` requires an absolute webhook URL.
  - `buildWebhookRequest()` emits a JSON webhook request without fetching.
  - `sendWorkflow()` defaults to `NETWORK_DISABLED` unless constructed with `enableNetwork: true`.
- `createRequestlyPlanStub()` and `createBrowserStackPlanStub()` return documented local plan stubs with `networkCalls: 0`.

### Linear Label ID Mapping Design Note

In the Linear integration adapter:
- The `labels` list from `EscalationTicketPayload` maps directly to Linear's GraphQL `labelIds` variable.
- These `labelIds` are Linear provider IDs (UUIDs), not human-readable display names (e.g., "bug", "rector").
- Direct use of string names in `labels` will be rejected by Linear's API. Display-to-UUID translation requires a future resolution step (e.g., querying active labels via GraphQL). Currently, callers must pre-resolve or pass direct Linear UUIDs.

## Test Plan

Follow TDD:

1. Add tests for notification/report/approval/escalation payload schemas.
2. Add Linear config validation and no-network default tests using a fetch spy.
3. Add Linear request builder tests verifying GraphQL shape without network calls.
4. Add Make config validation and no-network default tests using a fetch spy.
5. Add Make request builder tests verifying webhook shape without network calls.
6. Add Requestly and BrowserStack plan stub tests verifying docs-only/no-network shape.
7. Run focused test, full `npm test`, and `npm run build`.

## Acceptance Criteria

- Linear and Make adapters are optional and disabled by default.
- Missing required config fails clearly before live use.
- Request builders can be contract-tested without network access.
- Notification, report, approval, and escalation payload schemas reject malformed payloads.
- Requestly and BrowserStack are documented plan stubs only and perform no network calls.
- Open-source local mode remains provider-free.
