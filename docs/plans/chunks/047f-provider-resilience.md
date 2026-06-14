# Chunk 047f — Provider Resilience: Credential Pools & Failover

> **Created:** 2026-06-12
> **Phase:** 6 of 6 (Runtime Maturity)
> **Depends on:** Chunk 047c (abort signal on provider waits), Chunk 040 (provider module registry), Chunk 043 (orchestration assignments UI)
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Harden configured-provider execution with **per-role fallback chains**, **multi-key credential pools**, and **one-shot retry state** so transient rate limits, auth failures, and primary provider outages degrade gracefully inside `runOrchestratedChatRun` without silent failure or secret leakage.

## Scope

### In Scope

- New: `src/providers/credentialPool.ts`
- New: `src/providers/turnRetryState.ts`
- New: `src/providers/failover.ts`
- `src/providers/configBridge.ts`
- `src/providers/llm.ts` (`ModelRouter` extensions)
- `src/providers/orchestrationAssignments.ts`
- `src/config/runtimeSettings.ts` (optional failover enable flag)
- `src/orchestration/chatRunner.ts` (wire failover at planner/skeptic/synth/repair calls)
- `src/orchestration/externalRunSupport.ts` (trace substitution markers)
- `src/api/server.ts` (assignment schema for fallback role mapping)
- Tests under `tests/`

### Out of Scope

- OAuth refresh flows for third-party providers (document as future)
- Cross-region provider routing
- Billing/quota management
- Automatic provider discovery on failover (uses pre-configured assignments only)

## Design Principles

1. **Pre-configured fallback only.** Failover targets must be declared in orchestration assignments UI, not invented at runtime.
2. **Trace substitution.** When fallback used, emit `PROVIDER_SUBSTITUTED` event with `{ role, primaryId, fallbackId }` — no secrets.
3. **One-shot retries.** Each recovery strategy (429 backoff, auth retry, compress-and-retry) fires at most once per call site per `TurnRetryState`.
4. **Abort-aware.** Provider waits honor `abortSignal` from 047c.
5. **Bridge isolation preserved.** Credential pool values never enter sandbox environment (configBridge rule unchanged).

## Data Model

### Orchestration assignment extension

In `src/providers/orchestrationAssignments.ts`:

```ts
export const OrchestrationRoleAssignmentSchema = z.object({
  role: OrchestrationRoleSchema,
  providerId: z.string().min(1),
  model: z.string().min(1),
  fallbackProviderId: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
});
```

Persisted in `.rector/orchestration-assignments.json` via existing Settings API.

### `src/providers/credentialPool.ts`

```ts
export const CredentialPoolEntrySchema = z.object({
  providerId: z.string().min(1),
  secretRef: z.string().min(1),
  label: z.string().optional(),
  cooldownUntil: z.string().datetime().optional(),
});

export class CredentialPool {
  constructor(entries: CredentialPoolEntry[], clock?: () => Date);
  acquire(providerId: string): CredentialPoolEntry | undefined;
  markCooldown(providerId: string, secretRef: string, until: Date): void;
  reset(providerId: string): void;
}
```

- Round-robin among non-cooled entries for same `providerId`
- Injectable for tests

### `src/providers/turnRetryState.ts`

```ts
export class TurnRetryState {
  hasRetried429: boolean;
  hasRetriedAuth: boolean;
  hasActivatedFallback: boolean;
  hasCompressedAndRetried: boolean;
  // one-shot setters: tryMarkRetried429(): boolean — returns false if already set
}
```

### `src/providers/failover.ts`

```ts
export type ProviderCallSite = "planner" | "skeptic" | "synthesizer" | "repair" | "triage";

export async function callWithResilience<T>(input: {
  site: ProviderCallSite;
  role: OrchestrationRole;
  router: ModelRouter;
  assignments: OrchestrationAssignments;
  credentialPool?: CredentialPool;
  retryState: TurnRetryState;
  abortSignal?: AbortSignal;
  invoke: (selection: ModelSelection) => Promise<T>;
}): Promise<{ result: T; selection: ModelSelection; substituted: boolean }>;
```

**Recovery order:**

1. Primary selection → invoke
2. On 429: if `!retryState.hasRetried429`, backoff (Retry-After or 2s+jitter), retry once
3. On auth error: if `!retryState.hasRetriedAuth`, rotate credential pool entry, retry once
4. On primary failure: if fallback configured and `!retryState.hasActivatedFallback`, switch to fallback, retry once
5. On context length error: if 047a compression enabled and `!retryState.hasCompressedAndRetried`, trigger compression hook, retry once
6. Else: throw classified `ProviderResilienceError` (redacted)

## Work Items

### 1. Credential pool wiring

- Load multiple secret refs per provider from `providers.json` + `secrets.enc` when user adds "additional keys" in Settings UI (schema extension: `additionalSecretRefs?: string[]`)
- Build `CredentialPool` at router construction in `configBridge.ts`
- Pass pool into `ChatRunnerDeps`

### 2. Failover resolver

In `failover.ts`:

- `resolvePrimaryAndFallback(role, assignments): { primary, fallback? }`
- `buildSelection(providerId, model, pool)` → `ModelSelection`
- Integrate with `getLlmProviderRegistry()` from Chunk 040

### 3. ModelRouter wrapper

Option A (preferred): `ResilientModelRouter` decorates `ModelRouter`:

```ts
class ResilientModelRouter implements ModelRouter {
  complete(messages, opts): Promise<LLMResult> {
    return callWithResilience({ site: opts.site, invoke: (sel) => inner.complete(...) });
  }
}
```

Wire in `chatRunner.ts` when `runtimeSettings.providerResilienceEnabled !== false` (default true for configured product).

### 4. Trace events

Add `PROVIDER_SUBSTITUTED`, `PROVIDER_RETRY`, `CREDENTIAL_ROTATED` to protocol events with redacted payloads.

Emit from `callWithResilience` at each recovery step.

### 5. Orchestration call site updates

Wrap live calls in:

- `runLivePlanner` → site `planner`
- `runLiveSkeptic` → site `skeptic`
- live synthesizer path → site `synthesizer`
- `LiveRepairAgent` → site `repair`
- optional live triage (042a) → site `triage`

Each call site receives fresh `TurnRetryState` per invocation (not shared across entire run unless intentional for planner→repair; document: **per call site instance**).

### 6. Settings UI extension

In `src/public/app.js` orchestration assignment panel:

- Optional "Fallback provider" dropdown per role
- Optional "Fallback model" text field
- Validation: fallback must differ from primary; same kind recommended

Persist via existing assignments PATCH endpoint.

### 7. Spy provider test doubles

Extend `SpyLLMProvider` in `tests/support/`:

- Configurable failure sequence: fail primary N times, succeed fallback
- Assert `callWithResilience` invokes fallback and emits substitution event

## TDD Plan

### `tests/credentialPool.test.ts`

- Round-robin acquisition order
- Cooldown skips entry
- Empty pool returns undefined

### `tests/turnRetryState.test.ts`

- One-shot flags prevent double retry

### `tests/providerFailover.test.ts`

- Primary fails → fallback succeeds
- No fallback → classified error
- 429 triggers single backoff retry
- Auth error rotates pool once
- AbortSignal cancels waiting retry

### Integration — `tests/providerResilience.integration.test.ts`

- Spy primary always fails, fallback succeeds → run completes DONE
- Trace contains `PROVIDER_SUBSTITUTED`
- No secret in event payloads (snapshot redaction audit)

### Property test

- **Property 47f-1:** For any sequence of provider errors, total retries per call site ≤ 4 (429 + auth + fallback + compress)

## Acceptance Criteria

- [ ] Fallback assignment persisted and honored
- [ ] Credential pool rotates on auth failure (spy test)
- [ ] Substitution events visible in trace UI
- [ ] Abort cancels in-flight provider retry wait
- [ ] Config bridge does not pass pool secrets to sandbox
- [ ] `npm test`, `npm run build`, `npm audit` pass

## Concerns to Register

- Fallback may use different model quality; synthesis quality variance
- Additional API keys increase secret storage complexity
- Compress-and-retry may surprise users if not traced clearly (depends on 047a)

## Commit

```text
feat(chunk-047f): provider resilience pools and failover
```