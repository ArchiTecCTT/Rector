# ORN-56 Kiro Opus Implementation Prompts

Use these prompts with Kiro Opus 4.8 for the ORN-56 workstream.

## Workspace

Work only in:

```text
C:/Users/MharSky/Dev/Projects/Rector/.worktrees/rector-0.1.0
```

Do not work in repo root `main`; it is stale task-MVP state.

Baseline before changes:

- `npm test`: 106 files / 951 tests passing
- `npm run build`: passing

Preserve provider-free local mode as default. No test should require live provider credentials or network.

## Linear issues

Parent:

- ORN-56 — BYOK chat UX and model discovery

Children:

- ORN-57 — Friendly clarification responses for vague chat
- ORN-58 — Route simple direct queries to a lightweight answer path
- ORN-59 — Provider model discovery API v1
- ORN-60 — Provider setup UI model picker and per-model probe
- ORN-61 — Azure and Bedrock regional discovery follow-up

ORN-53 is already occupied by unrelated CI hardening work, so this workstream uses ORN-56 through ORN-61.

---

## Prompt 1 — ORN-57: Friendly clarification responses for vague chat

You are implementing ORN-57 in Rector.

Goal: when triage returns `NEEDS_CLARIFICATION`, Rector must send a natural chat clarification message instead of surfacing raw trace/status prose like `Status: VALIDATED. Route: NEEDS_CLARIFICATION...`.

Context:

- Active workspace: `C:/Users/MharSky/Dev/Projects/Rector/.worktrees/rector-0.1.0`
- Current triage: `src/orchestration/triage.ts`
- Current synthesizer: `src/orchestration/synthesizer.ts`
- Current chat endpoint: `src/api/server.ts`, `POST /api/chat/conversations/:id/messages`
- Current UI: `src/public/app.js` + `src/public/index.html`
- Current behavior for `Hello` / `What's up`: user-facing assistant bubble shows trace/status summary. That is the bug.

Requirements:

1. For `NEEDS_CLARIFICATION`, main assistant response should be short, natural, and helpful.
2. It should ask the user for missing task details.
3. It must not put raw trace IDs, evidence lists, provider cost, or internal phase summaries in the main chat bubble.
4. Existing trace/event endpoints and expandable trace UI should still expose internal details.
5. Local provider-free mode remains deterministic and needs no API keys.
6. No secrets in logs, snapshots, tests, or UI.

Suggested copy:

```text
What would you like me to help with? Share the task, repo area, or goal, and I’ll route it through the right Rector workflow.
```

Acceptance criteria:

- `Hello`, `hi`, `What's up`, and similarly vague messages return a friendly clarification.
- Main assistant message does not contain `Status:`, `Route: NEEDS_CLARIFICATION`, `Trace:`, or `Evidence:`.
- Trace/event data remains available through run events.
- Tests cover API behavior and any affected UI rendering.
- `npm test` and `npm run build` pass.

Implementation guidance:

- Prefer a small dedicated formatter/helper over scattering string conditionals.
- Keep old trace synthesis available for run evidence, but separate internal trace from user-facing response.
- Update tests that intentionally snapshot the user-facing response; do not weaken tests that protect trace persistence.

---

## Prompt 2 — ORN-58: Lightweight direct-answer path for simple queries

You are implementing ORN-58 in Rector.

Goal: simple direct questions should produce a user-friendly answer path, not an assembly-line trace summary. Local mode can use deterministic fallback text. External/BYOK mode may use a configured cheap/simple provider route, gated by budgets and redaction.

Context:

- Triage routes: `src/orchestration/triage.ts`
- Direct answer route exists: `DIRECT_ANSWER`
- Chat runner: `src/orchestration/chatRunner.ts`
- Synthesizer: `src/orchestration/synthesizer.ts`
- Provider router/types: `src/providers/llm.ts`
- Budget/redaction: `src/security/budget.ts`, `src/security/redaction.ts`

Requirements:

1. `DIRECT_ANSWER` should not default to trace/status prose as the main chat answer.
2. Local mode should return deterministic, polite, bounded text.
3. External mode may call a cheap/simple model if configured and within budget.
4. Provider failure, missing provider, or budget denial must fall back to deterministic local text.
5. Raw provider errors and secrets must never surface.
6. Trace/events should still record route, run, provider calls, cost, and fallback status.

Acceptance criteria:

- Direct/simple query API tests demonstrate user-friendly answer output.
- Mocked external provider success path is tested.
- Provider failure fallback is tested.
- Budget denial fallback is tested if relevant to existing budget helpers.
- Local provider-free mode remains default.
- `npm test` and `npm run build` pass.

Implementation guidance:

- Keep deterministic control plane in charge: triage chooses route; budgets gate calls; failure falls back.
- Avoid overbuilding general semantic QA. This is a thin UX improvement and simple-model hook.
- If adding a new model role is too large, keep role selection minimal and document follow-up.

---

## Prompt 3 — ORN-59: Provider model discovery API v1

You are implementing ORN-59 in Rector.

Goal: add backend model discovery for configured BYOK providers so users do not manually pre-select model IDs blindly.

Context:

- Provider config model: `src/providers/config.ts`
- Provider config store: `src/providers/configStore.ts`
- Provider config bridge: `src/providers/configBridge.ts`
- Provider adapters: `src/providers/llm.ts`
- Provider API routes: `src/api/server.ts`, `/api/providers`, `/api/setup/test-connection`
- Secret invariant: provider config store is non-secret only; secrets live in Secret_Store.

Provider-specific requirements:

1. Cloudflare Workers AI:
   - Use account-scoped model catalog: `GET /accounts/{account_id}/ai/models/search`.
   - Schema endpoint exists: `/accounts/{account_id}/ai/models/schema`.
   - Docs currently report 78 models.
   - Filter useful defaults to text generation/chat/embeddings and hide deprecated unless requested.
2. Together AI:
   - Prefer native `GET /models` for richer metadata.
   - Fall back to OpenAI-compatible `GET /v1/models`.
   - Do not assume Responses API support.
3. OpenAI-compatible:
   - Try `GET /v1/models`.
   - Metadata quality varies; normalize defensively.
4. Azure OpenAI:
   - Endpoint + key may list data-plane models via `{endpoint}/openai/models?api-version=2024-10-21`.
   - Actual inference usually requires deployment names.
   - Deployment auto-discovery requires Azure management-plane auth/resource metadata; do not pretend endpoint+key can always enumerate deployments.

Recommended normalized shape:

```ts
{
  providerId: string;
  kind: ProviderKind;
  scope: {
    accountId?: string;
    region?: string;
    endpoint?: string;
    azureResource?: string;
    subscriptionId?: string;
    resourceGroup?: string;
  };
  modelId?: string;
  deploymentId?: string;
  displayName: string;
  capabilities: string[];
  contextWindow?: number;
  pricing?: unknown;
  lifecycle?: "active" | "preview" | "deprecated" | string;
  requiresDeployment: boolean;
  requiresRegion: boolean;
  source: string;
  lastRefreshedAt: string;
}
```

Suggested endpoints:

- `GET /api/providers/:id/models`
- `POST /api/providers/:id/models/refresh`

Acceptance criteria:

- API returns normalized candidates for supported provider records.
- Results are cached with TTL and invalidated on provider config/secret/scope changes.
- Negative/error results get short TTL or no long-term stale cache.
- Errors are classified and redacted.
- Unit tests use mocked fetch; CI makes no live provider calls.
- No secret values are stored, logged, or returned.
- `npm test` and `npm run build` pass.

Implementation guidance:

- Add provider-specific discovery adapters behind one service interface.
- Keep cache small and simple first; do not introduce external infrastructure.
- Include `lastRefreshedAt` and source metadata for UI.
- Avoid changing existing provider invocation behavior unless required.

---

## Prompt 4 — ORN-60: Provider setup UI model picker and per-model probe

You are implementing ORN-60 in Rector.

Goal: extend the BYOK setup UI so users can discover available models, pick flagship/SLM route assignments, and test selected models/deployments with cheap probes before saving active routes.

Depends on:

- ORN-59 Provider model discovery API v1

Context:

- UI files: `src/public/app.js`, `src/public/index.html`, CSS under `src/public/styles/`
- Provider routes: `/api/providers`, `/api/providers/active`, `/api/setup/test-connection`
- Existing setup/status/workspace panels should remain usable.

Requirements:

1. Provider setup offers `Discover models` / `Refresh`.
2. UI shows `lastRefreshedAt`.
3. Model candidates display capability tags, lifecycle/deprecated status, context/pricing when available, and region/deployment notes.
4. User can select candidates for `flagship` and `slm` roles.
5. Manual override remains available for providers where discovery is incomplete.
6. `Test selected model` runs a cheap probe for that model/deployment before saving active route.
7. Save verified selection; allow explicit `save unverified` only with warning.
8. UI never displays secret values.

Probe error categories:

- auth invalid
- endpoint/base URL invalid
- region/location unsupported
- deployment not found
- model access/agreement missing
- quota/rate limit
- parameter incompatibility
- content/safety rejection
- unknown provider error

Acceptance criteria:

- UI tests or integration tests cover discovery render, refresh, probe success, and probe error display.
- Active route save works with selected model/deployment.
- Azure UX clearly explains deployment-name limitation.
- No secret values are displayed or persisted in provider config.
- `npm test` and `npm run build` pass.

Implementation guidance:

- Keep UI simple and local-first.
- Avoid loading huge model lists into main chat context; display paginated/filtered if needed.
- Reuse existing connection-test service if possible, but make probe model/deployment-aware.

---

## Prompt 5 — ORN-61: Azure and Bedrock regional discovery follow-up

You are implementing ORN-61 in Rector.

Goal: document and scaffold follow-up support for cloud-provider regional discovery where ordinary endpoint+API-key credentials are insufficient.

Depends on:

- ORN-59 Provider model discovery API v1

Azure facts:

- Data-plane model listing: `{endpoint}/openai/models?api-version=2024-10-21`.
- Inference generally uses deployment names.
- Deployment listing requires Azure management plane:
  - subscription ID
  - resource group
  - account name
  - Azure auth
- Regional capacity/model availability also requires management-plane APIs.

AWS Bedrock facts:

- Bedrock discovery is region-scoped.
- Use `ListFoundationModels` in selected region.
- Selected model readiness needs `GetFoundationModelAvailability`.
- Inference profiles can route cross-region and require data-residency/IAM warning.
- Bedrock provider adapter may need to be a separate future implementation if not present.

Requirements:

1. Docs/architecture explain Azure data-plane vs management-plane discovery.
2. UI/API error states distinguish invalid key from region/deployment/model unavailable.
3. Provider config shape/design notes include future Azure management fields:
   - subscriptionId
   - resourceGroup
   - accountName
   - location
   - deployment name
   - model name/version
   - SKU/provisioning state
4. Bedrock design notes include:
   - region-first model listing
   - account entitlement/access check
   - inference profile support
   - data-residency warning
5. If implementation is included, tests must mock all cloud APIs; no live cloud calls in CI.

Acceptance criteria:

- Documentation exists in the appropriate architecture/implementation docs.
- Follow-up implementation path is clear enough for a future agent.
- Existing tests/build pass.

Implementation guidance:

- Do not block ORN-59/60 on full Azure management auth or Bedrock adapter work.
- Keep this as a precise follow-up design/scaffold unless the needed provider adapter already exists.
