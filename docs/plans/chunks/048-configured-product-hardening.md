# Chunk 048 — Configured Product Hardening

> **Created:** 2026-06-13
> **Phase:** Post-Runtime Maturity (Product Finalization)
> **Depends on:** Chunks 047a–047f (runtime maturity), Chunk 915c219 (local mode kill), Cloud-Capable Transition spec
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Close every remaining gap between the **documented configured-product architecture** (`docs/architecture/configured-product-architecture.md`) and the **running system**. After this chunk, a fresh Rector install boots into `unconfigured`, shows an uncloseable onboarding overlay, refuses chat until readiness passes, and transitions to `configured` with live provider calls — no fake-chat path exposed as product.

## Gap Analysis

| # | Gap | Severity | Current State | Target State |
|---|-----|----------|--------------|-------------|
| G1 | **Conversation creation has no readiness gate** | Critical | `POST /api/chat/conversations` creates conversations even when unconfigured | Reject with 409 `SETUP_REQUIRED` when `!readiness.ready` |
| G2 | **No integration test for the unconfigured→configured→chat flow** | High | Unit tests exist for individual pieces but no E2E proves the product model works end-to-end | Integration test boots server, hits chat unconfigured (409), completes onboarding, hits chat configured (201) |
| G3 | **`ORCHESTRATOR_MODE` still referenced in non-migration paths** | Medium | `server.ts` resolves mode from env for router selection even after migration | `ORCHESTRATOR_MODE` is only read during `migrateRuntimeSettingsFromEnv`; all post-migration logic reads `runtime-settings.json` |
| G4 | **Package version still `0.1.0`** | Low | `package.json` version `0.1.0` | Bump to `0.3.0` (or `0.3.0-alpha.1`) to reflect the product model |
| G5 | **No smoke test for real provider instantiation** | High | `TogetherAIProvider` exists but no test exercises it with `enableNetwork: true` against a mock HTTP server | Integration test starts a local HTTP server, configures a Together provider pointing at it, runs a chat, asserts the real request shape and response parse |
| G6 | **Stale worktrees polluting `.worktrees/`** | Housekeeping | 18+ stale worktree directories | Document cleanup; user deletes non-rector-0.3.0 dirs |
| G7 | **`docs/architecture/current-rector-byok-architecture.md` not quarantined** | Low | File exists without stale banner | Add stale banner pointing to `configured-product-architecture.md` |
| G8 | **Concerns register not updated for configured-product gaps** | Medium | `concerns-and-vulnerabilities.md` has no entries for chat-gate gaps, provider network smoke | Add entries for G1–G5 |

## Scope

### In Scope

- G1: Chat gate on conversation creation
- G2: End-to-end integration test for product model flow
- G3: Remove `ORCHESTRATOR_MODE` from runtime paths (keep only in migration)
- G4: Package version bump
- G5: Provider smoke test against local HTTP mock
- G7: Stale doc banner
- G8: Concerns register update

### Out of Scope

- G6: Worktree cleanup (user action)
- OAuth refresh flows
- Cross-region provider routing
- Billing/quota management
- Multi-user auth hardening (beyond chunk 037)

## Implementation Tasks

### Task 1: Gate conversation creation on readiness (G1)

**Files:** `src/api/server.ts`, `tests/`

Add readiness check to `POST /api/chat/conversations`:

```ts
app.post("/api/chat/conversations", async (req, res) => {
  try {
    // NEW: Gate on product readiness (same pattern as messages endpoint)
    const readiness = await computeProductReadiness(readinessDepsFor(req));
    if (!readiness.ready) {
      return sendRedacted(res, 409, {
        code: "SETUP_REQUIRED",
        blockers: readiness.blockers,
        setupUrl: "/setup",
        onboardingStep: readiness.onboardingStep,
      });
    }
    // ... existing handler
  }
});
```

**Test:** `tests/productGate.test.ts`
- Unconfigured profile → POST conversation → 409 SETUP_REQUIRED
- Configured profile → POST conversation → 201

### Task 2: E2E product model integration test (G2)

**New file:** `tests/productModel.integration.test.ts`

```
Boot server (SpyLLMProvider, in-memory store)
  → GET /api/runtime-settings → orchestrationProfile = "unconfigured"
  → POST /api/chat/conversations → 409 SETUP_REQUIRED
  → POST /api/chat/conversations/:id/messages → 409 SETUP_REQUIRED
  → POST /api/setup/activate → sets orchestrationProfile = "configured"
  → GET /api/runtime-settings → orchestrationProfile = "configured"
  → POST /api/chat/conversations → 201
  → POST /api/chat/conversations/:id/messages → 201 (SpyLLMProvider response)
```

This is the **single most important test** — it proves the product model works end-to-end.

### Task 3: Remove `ORCHESTRATOR_MODE` from runtime paths (G3)

**Files:** `src/bin/server.ts`

Current: `server.ts` resolves `orchestrationConfig` from env at boot, then uses the resolved mode for router selection even after `ensureRuntimeSettings()` has written `runtime-settings.json`.

Change: After `ensureRuntimeSettings()`, the runtime **must read `orchestrationProfile` from the persisted store** — not from env. The `resolveOrchestrationConfig` call remains only for the initial migration path.

```ts
// BEFORE migration:
const orchestration = await resolveOrchestrationConfig({...}); // env-based
const migrated = migrateRuntimeSettingsFromEnv(...);
// After migration, orchestrationProfile IS the source of truth.

// AFTER this change:
const runtimeSettings = await ensureRuntimeSettings(); // creates or reads file
// buildStartupRouter reads runtimeSettings.orchestrationProfile, not env
const orchestrationRouter = await buildStartupRouter(runtimeSettings.orchestrationProfile);
```

Remove any remaining `orchestration.configuredProviders` / `orchestration.mode` reads after migration. The `resolveOrchestrationConfig` function stays (used by migration), but the boot sequence no longer branches on its output for router selection.

**Test:** Boot server without `ORCHESTRATOR_MODE` env → profile reads from `runtime-settings.json`. Boot server with `ORCHESTRATOR_MODE=external` → migration runs, file written, subsequent reads from file.

### Task 4: Package version bump (G4)

**File:** `package.json`

```diff
- "version": "0.1.0",
+ "version": "0.3.0-alpha.1",
```

Use `-alpha.1` until the smoke test (Task 5) passes against a real provider.

### Task 5: Provider smoke test against local HTTP mock (G5)

**New file:** `tests/providerSmoke.test.ts`

Spin up a `http.createServer` that returns a valid OpenAI-shaped chat completion response. Configure a `TogetherAIProvider` (or `OpenAICompatibleProvider`) pointing at `http://localhost:{port}` with `enableNetwork: true`. Assert:

1. The request reaches the mock with correct headers (`Authorization: Bearer test-key`)
2. The response parses through `parseResponse` into a valid `LLMResponse`
3. Usage tokens are extracted correctly
4. On non-200 response, `ProviderError` with correct `retryable` flag

This is **not** a property test — it's a focused smoke test that proves the real HTTP path works, not just `SpyLLMProvider`.

### Task 6: Stale doc quarantine (G7)

**File:** `docs/architecture/current-rector-byok-architecture.md`

Add stale banner at top:

```md
> ⚠️ **STALE** — This document describes the pre-v0.3.0 local/external model.
> The canonical product model is now [configured-product-architecture.md](./configured-product-architecture.md).
> Retain for historical reference only.
```

### Task 7: Concerns register update (G8)

**File:** `docs/plans/concerns-and-vulnerabilities.md`

Add entries:

- **G1 fix:** Conversation creation was ungated; now returns 409 when unconfigured. Chat gate is complete on both endpoints.
- **G3 note:** `ORCHESTRATOR_MODE` removed from runtime paths; migration-only usage. Contributors who set `ORCHESTRATOR_MODE` without a `.rector/runtime-settings.json` will get a one-time migration on boot.
- **G5 note:** Real provider smoke test exercises `enableNetwork: true` path only against local mock. Live provider smoke (against real Together/Azure endpoints) is an opt-in CI job, not the default.

## Acceptance Criteria

1. `npm test` passes with zero regressions
2. `npm run build` passes
3. `tests/productModel.integration.test.ts` proves: unconfigured → 409, configured → 201
4. `POST /api/chat/conversations` returns 409 when unconfigured
5. `POST /api/chat/conversations/:id/messages` returns 409 when unconfigured (already works)
6. Boot without `ORCHESTRATOR_MODE` env → reads from `runtime-settings.json`
7. Boot with `ORCHESTRATOR_MODE=external` → migration runs, profile written to file
8. Provider smoke test passes against local HTTP mock
9. Package version reflects v0.3.0
10. Stale docs have banner; concerns register updated

## Test Plan

| Test | Type | Validates |
|------|------|-----------|
| `productGate.test.ts` | Unit | Conversation creation gate (G1) |
| `productModel.integration.test.ts` | Integration | Full unconfigured→configured→chat flow (G2) |
| `bootSequence.test.ts` | Unit | Runtime settings source of truth, not env (G3) |
| `providerSmoke.test.ts` | Integration | Real HTTP provider path (G5) |

## Risks

- **G3 regression:** If `ORCHESTRATOR_MODE` env is still relied on by any runtime path after migration, removing it could break existing deployments. Mitigation: migration writes to file first; subsequent reads ignore env.
- **G5 mock fidelity:** Local HTTP mock may not perfectly mimic provider behavior (rate limits, streaming). Mitigation: smoke test is focused on request/response shape, not edge cases.
- **G1 UX:** Returning 409 on conversation creation when unconfigured means the "New conversation" button in the UI should be disabled. Mitigation: `setOnboardingShellLocked(true)` already disables `new-conversation` button.

## Dependencies

- No new npm packages required
- Uses existing `vitest`, `fast-check`, `http` (Node built-in for mock server)
