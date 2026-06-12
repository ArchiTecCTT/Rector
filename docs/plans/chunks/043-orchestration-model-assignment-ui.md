# Chunk 043 — Orchestration Model Assignment UI

> **Pre-v0.3.0; superseded by [`configured-product-architecture.md`](../../architecture/configured-product-architecture.md).**

> **Created:** 2026-06-12
> **Branch:** `rector-0.2.0`
> **Depends on:** Chunks 038–041 module foundation; Chunk 042 hardening track recommended before/alongside implementation
> **Goal:** Let users assign specific providers/models to each Rector orchestration role from the web UI, with presets, fallbacks, capability checks, budgets, and deterministic local defaults.

## Why This Chunk Exists

Rector's core commercial value is not just “call an LLM.” It is a configurable orchestration system where users decide which model powers each stage of the brain:

- cheap/fast model for triage
- structured-output model for preprocessing
- strong reasoning model for planning
- critic/reviewer model for skeptic
- arbitration model/policy for crucible
- high-reasoning model for deep planning
- cheap background model for ponder
- polished prose model for synthesis

Today Rector has provider config and module config foundations, but it does not expose a first-class **role → provider/model** assignment matrix in the UI.

## Target Product Experience

User opens Settings → Orchestration Models and sees a matrix:

| Role | Provider | Model | Fallback | Budget | Required Capabilities | Status |
|------|----------|-------|----------|--------|-----------------------|--------|
| Triage | Gemini | flash | deterministic | low | text | ready |
| Preprocessor | OpenAI | gpt-4.1-mini | deterministic | low | JSON mode | ready |
| Planner | Azure | gpt-5.5 | Claude | high | JSON, reasoning | ready |
| Skeptic | GLM | GLM-5.1-high | GPT | medium | critique, JSON | ready |
| Synthesizer | OpenAI | gpt-4.1 | deterministic | medium | prose | ready |
| Ponder | Gemini | flash | disabled | low | summarization | optional |

User can:

- choose provider/model per role
- test capability/connection
- set fallback model
- set max cost/token/time per role
- apply a template
- reset to local/free defaults
- export/import configuration later via Chunk 045

## Orchestration Roles

Add canonical role identifiers:

```ts
export const ORCHESTRATION_ROLES = [
  "triage",
  "preprocessor",
  "planner",
  "skeptic",
  "crucible",
  "deepPlanner",
  "taskDecomposer",
  "validator",
  "healer",
  "synthesizer",
  "directAnswer",
  "ponder",
  "embedding",
  "reranker",
] as const;
```

Suggested type:

```ts
export type OrchestrationRole = (typeof ORCHESTRATION_ROLES)[number];
```

## Data Model

Create `src/providers/orchestrationAssignments.ts` or similar.

```ts
interface OrchestrationModelAssignment {
  id: string;
  userId?: string;
  workspaceId?: string;
  role: OrchestrationRole;
  providerId: string | "deterministic" | "disabled";
  modelId?: string;
  fallbackProviderId?: string | "deterministic" | "disabled";
  fallbackModelId?: string;
  enabled: boolean;
  maxUsdPerCall?: number;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  requiresJsonMode?: boolean;
  requiresToolCalling?: boolean;
  requiresStreaming?: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}
```

Add Zod schemas for:

- role enum
- assignment create/update
- assignment record
- effective assignment resolution
- capability mismatch warnings

## Storage

Implement an `OrchestrationAssignmentStore` with two initial variants:

1. **Local JSON/file-backed store** or existing provider config store pattern.
2. **User-scoped store wrapper** using existing Chunk 037 user isolation primitives.

Rules:

- No secrets in assignments.
- Secrets remain in `SecretStore` via provider config records.
- Local default works without any assignment records.
- Assignment records are scoped by user/workspace when auth is enabled.

## Capability Model

Extend provider/model metadata to describe capabilities:

```ts
interface ModelCapabilities {
  text: boolean;
  jsonMode?: boolean;
  toolCalling?: boolean;
  streaming?: boolean;
  vision?: boolean;
  embeddings?: boolean;
  maxContextTokens?: number;
  reasoning?: "none" | "low" | "medium" | "high";
  costTier?: "free" | "low" | "medium" | "high";
}
```

Validation examples:

- `preprocessor` should require JSON mode or robust JSON repair fallback.
- `planner` should prefer JSON mode + higher context/reasoning.
- `synthesizer` should support prose and optionally streaming.
- `embedding` must support embeddings.
- `ponder` should be low-cost or disabled by default.

Capability mismatch should not crash UI. It should show warnings and block only truly impossible assignments.

## Resolution Algorithm

Create an `OrchestrationModelRouter`:

```ts
resolve(role, context): EffectiveModelRoute
```

Resolution order:

1. User/workspace assignment for role.
2. Workspace default assignment.
3. Built-in template assignment.
4. Deterministic/local fallback.

Must return:

- selected provider/model
- fallback provider/model
- capability warnings
- budget projection
- deterministic fallback reason if no provider

## API Surface

Add endpoints:

```http
GET    /api/orchestration-models/roles
GET    /api/orchestration-models/assignments
PUT    /api/orchestration-models/assignments/:role
POST   /api/orchestration-models/assignments/:role/test
POST   /api/orchestration-models/assignments/reset
GET    /api/orchestration-models/effective
```

Requirements:

- Auth-aware if multi-user mode enabled.
- Redact provider errors.
- Never return secret values.
- Return capability warnings in structured form.

## UI Work

Add Settings panel:

- `Orchestration Models`
- role table/matrix
- provider dropdown
- model dropdown filtered by provider
- fallback dropdown
- budget fields
- capability badges
- test button per role
- reset/apply preset buttons

UI should support:

- local/free default state
- missing provider setup callout
- capability mismatch warnings
- unsaved changes indicator
- save/test flow

## Runtime Wiring

Update orchestration callsites to use role-based resolution:

| Component | Role |
|----------|------|
| `runLiveTriage` if added | `triage` |
| `runSLMPreprocessor` | `preprocessor` |
| `runLivePlanner` | `planner` |
| `runLiveSkepticReview` | `skeptic` |
| future live crucible | `crucible` |
| `runDeepPlanner` | `deepPlanner` |
| live decomposition | `taskDecomposer` |
| live healing | `healer` |
| `runLiveSynthesizer` | `synthesizer` |
| `runDirectAnswer` | `directAnswer` |
| `runPonderSwarm` | `ponder` |

Do this behind a compatibility layer so existing router behavior still works.

## Tests

Add/extend:

- `tests/orchestrationAssignments.test.ts`
- `tests/orchestrationAssignmentsApi.test.ts`
- `tests/orchestrationModelRouter.test.ts`
- `tests/orchestrationModelAssignments.dom.test.ts`
- `tests/orchestrationAssignmentLocalMode.property.test.ts`

Test cases:

- local mode uses deterministic fallback with zero providers
- role assignment roundtrip
- per-user isolation
- secret never returned
- capability mismatch warning
- fallback chosen when primary provider unavailable
- JSON-required role rejects model with no JSON support unless repair fallback enabled
- provider test errors redacted

## Acceptance Criteria

- Users can configure provider/model per orchestration role from UI.
- Local default remains zero-config and deterministic.
- Existing provider config continues working.
- Assignments are user/workspace scoped when auth enabled.
- Runtime orchestration uses assignment router for live provider calls.
- Capability warnings are visible in API/UI.
- `npm test`, `npm run build`, and `npm audit` pass.

## Risks

| Risk | Mitigation |
|------|------------|
| Wrong model assigned to role | capability validation + warnings |
| Secrets leaked in assignment records | no secret fields; use SecretStore references only |
| Local mode accidentally uses network | property test no network in local mode |
| UI overwhelms users | templates in Chunk 045; sensible defaults |
| Provider discovery incomplete | allow manual model entry with warning |

## Follow-Up

- Chunk 045 turns assignments into reusable templates.
- Chunk 046 adds stronger RBAC around who can edit assignments.

## Suggested Commit

```text
feat(chunk-043): add orchestration model assignment plan
```
