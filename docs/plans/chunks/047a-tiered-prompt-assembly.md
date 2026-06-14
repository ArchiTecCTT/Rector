# Chunk 047a — Tiered Prompt Assembly & Compression Lineage

> **Created:** 2026-06-12
> **Phase:** 1 of 6 (Runtime Maturity)
> **Depends on:** Chunk 042a (context builder budget hardening)
> **Branch:** `rector-0.3.0-configured-product`

## Goal

Introduce a three-tier prompt assembly model (`stable` → `context` → `volatile`) so the system contract stays byte-stable across turns within a run, while context and ephemeral overlays are budget-capped and injectable only at call time. When context exceeds budget, fork a child conversation/run lineage with a summary artifact instead of mutating history in place.

## Scope

### In Scope

- `src/orchestration/contextBuilder.ts`
- `src/orchestration/prompts.ts`
- `src/store/schemas.ts` (conversation/run lineage fields)
- `src/orchestration/chatRunner.ts` (compression trigger + event emission)
- `src/orchestration/externalRunSupport.ts` (phase payload extensions if needed)
- New: `src/orchestration/promptTiers.ts`
- New: `src/orchestration/contextCompression.ts`
- Tests under `tests/`
- `docs/plans/concerns-and-vulnerabilities.md`

### Out of Scope

- Provider-specific prompt cache breakpoints (Anthropic cache_control) — defer to provider adapter layer
- FTS indexing of compressed summaries — Chunk 047e
- Skills/procedural memory injection — Chunk 047d
- Live LLM summarization for compression (use deterministic summary in spy/local; optional live summarizer behind budget gate in external mode only)

## Design Principles

1. **Stable tier is immutable mid-run.** Once a run enters PLANNING, the stable system contract hash must not change until the run completes or is aborted.
2. **Volatile tier never persists.** Timestamp, profile label, and per-turn overlays exist only in LLM request assembly, not in `Message` or `RunEvent` payloads stored verbatim.
3. **Lineage over mutation.** Compression creates a child conversation linked via `parentConversationId` and a `CONTEXT_COMPRESSED` artifact; original messages remain in the parent for audit.
4. **Budget is tier-aware.** Each tier has independent char/token caps enforced before planner/skeptic/synth calls.
5. **Deterministic local fallback.** Spy/local mode uses rule-based summarization (truncate + bullet extraction); no provider call required.

## Data Model

### New schemas in `src/orchestration/promptTiers.ts`

```ts
export const PromptTierNameSchema = z.enum(["stable", "context", "volatile"]);

export const PromptTierBudgetSchema = z.object({
  maxStableChars: z.number().int().positive().default(4_000),
  maxContextChars: z.number().int().positive().default(12_000),
  maxVolatileChars: z.number().int().positive().default(2_000),
});

export const PromptTierBundleSchema = z.object({
  stable: z.string(),
  stableHash: z.string().min(64).max(64), // sha256 hex
  context: z.string(),
  volatile: z.string(),
  assembledAt: z.string().datetime(),
  tierBudget: PromptTierBudgetSchema,
  contextBytes: z.number().int().nonnegative(),
  volatileBytes: z.number().int().nonnegative(),
});
```

### Store schema extensions in `src/store/schemas.ts`

```ts
// ConversationSchema additions:
parentConversationId: z.string().min(1).optional(),
compressionGeneration: z.number().int().nonnegative().default(0),
compressionSummaryArtifactId: z.string().min(1).optional(),

// RunSchema additions (optional, for trace):
contextCompressionApplied: z.boolean().default(false),
parentRunId: z.string().min(1).optional(),
```

### New event types (protocol)

Add to `src/protocol/events.ts` if not present:

- `CONTEXT_BUDGET_EVALUATED` — payload: `{ tier, usedChars, capChars, exceeded: boolean }`
- `CONTEXT_COMPRESSED` — payload: `{ parentConversationId, childConversationId, summaryArtifactId, method: "deterministic" | "live" }`

## Work Items

### 1. Prompt tier assembly module

Create `src/orchestration/promptTiers.ts`:

- `buildStableTier(input: StableTierInput): string`
  - Sources: `PLANNER_SYSTEM_RULES`, role-specific system rules from `prompts.ts`, product identity block (configured orchestration, no secrets)
  - Excludes: user message, timestamps, per-turn memory deltas
- `buildContextTier(input: ContextTierInput): string`
  - Sources: `ContextPack` inline handles, ranked memory/docs, constraints, approved skill summaries (047d hook stub returns empty until 047d lands)
  - Applies `DEFAULT_CONTEXT_BUDGET` / tier budget caps from 042a
- `buildVolatileTier(input: VolatileTierInput): string`
  - Sources: ISO timestamp (injectable clock), active template id, run phase, budget remaining summary (redacted)
- `assemblePromptTiers(input): PromptTierBundle`
  - Computes `stableHash = sha256(stable)`
  - Returns bundle; does not persist volatile tier to store

### 2. Integrate tiers into `prompts.ts`

For each LLM prompt builder (`buildPlannerMessages`, `buildSkepticMessages`, `buildSynthesizerMessages`, live repair):

- Replace flat system string concatenation with:
  ```ts
  const tiers = assemblePromptTiers({ ... });
  const systemContent = [tiers.stable, tiers.context, tiers.volatile].filter(Boolean).join("\n\n---\n\n");
  ```
- Add `assertStableTierUnchanged(runId, priorHash, currentHash)` — throws internal error in dev; emits `STABLE_TIER_MUTATION_BLOCKED` event in prod path
- Export `getStableTierHashForRun(run)` from run metadata cache (in-memory per run, keyed by runId)

### 3. Context builder tier budgeting

Extend `ContextBudgetSchema` in `contextBuilder.ts`:

```ts
tierBudget: PromptTierBudgetSchema.optional(), // default from promptTiers
maxStableInlineChars: z.number().int().positive().optional(),
```

- `buildContextPack()` returns `contextPack.promptTiers?: PromptTierBundle` when `includePromptTiers: true` option set
- Ranking/scoring from 042a applies only to **context** tier material
- When context tier exceeds `maxContextChars`:
  - Set `contextPack.compressionRecommended = true`
  - Do not silently truncate trusted memory; prefer handles over inline

### 4. Compression lineage module

Create `src/orchestration/contextCompression.ts`:

- `evaluateContextPressure(pack: ContextPack, budget: PromptTierBudget): ContextPressureResult`
  - Returns `{ exceeded: boolean, tier: "context" | "volatile", overByChars: number }`
- `compressContextLineage(deps, input: CompressionInput): Promise<CompressionResult>`
  - **Input:** `conversationId`, `runId`, `contextPack`, `store`
  - **Steps:**
    1. Build deterministic summary from `messageRefs` + inline context (max 2_000 chars, redacted)
    2. Create `Artifact` kind `CONTEXT_SUMMARY` with hash + provenance
    3. Create child `Conversation` with `parentConversationId`, `compressionGeneration = parent.generation + 1`
    4. Copy only: summary artifact reference + last N message refs (configurable, default 4)
    5. Emit `CONTEXT_COMPRESSED` event on parent run
    6. Return `{ childConversationId, summaryArtifactId, newContextPack }`
- `summarizeDeterministic(messages, inlineContext): string` — pure function, testable

Optional external path (behind `enableNetwork` + budget):

- `summarizeWithProvider(router, input)` — single LLM call with strict max tokens; fallback to deterministic on failure

### 5. Chat runner integration

In `chatRunner.ts` / `runOrchestratedChatRun` flow after `buildContextPack`:

1. Assemble prompt tiers
2. If `compressionRecommended` and policy allows (config flag in runtime settings, default true for configured product):
   - Call `compressContextLineage`
   - Continue run against child conversation id
3. Record `contextCompressionApplied` on run when compression occurs
4. Pass `promptTiers.stableHash` through `ChatRunnerDeps` for assertion in subsequent phases

### 6. Runtime settings hook

Extend `src/config/runtimeSettings.ts` (non-breaking optional fields):

```ts
contextCompressionEnabled: z.boolean().default(true),
contextCompressionMaxGeneration: z.number().int().positive().default(3),
```

- Prevent infinite compression chains: if `compressionGeneration >= max`, emit `NEEDS_CLARIFICATION` synthesis instead of further fork

## TDD Plan

### Unit tests — `tests/promptTiers.test.ts`

- Stable tier identical across two calls with same inputs
- Volatile tier changes when clock advances
- Context tier respects `maxContextChars` cap (never exceeds)
- `stableHash` stable for same stable content; changes when rules change
- Redaction applied before tier assembly

### Unit tests — `tests/contextCompression.test.ts`

- Deterministic summary is stable for same inputs
- Child conversation has `parentConversationId` and incremented `compressionGeneration`
- Parent messages not deleted (listMessages parent count unchanged)
- Summary artifact created with kind `CONTEXT_SUMMARY`
- Max generation guard blocks further compression

### Integration tests — `tests/tieredPromptAssembly.integration.test.ts`

- Full chat run with spy router: `CONTEXT_BUDGET_EVALUATED` event emitted
- Forced oversized context fixture triggers compression + child conversation
- Planner receives system message containing stable rules block
- Stable hash unchanged from PLANNING through SYNTHESIZING on same run

### Property tests — `tests/promptTiers.property.test.ts`

- **Property 47a-1:** For any context pack, assembled context tier length ≤ configured cap after truncation policy
- **Property 47a-2:** `compressContextLineage` preserves acyclic parent chain (walk parents, no cycles)
- Use `fast-check`, ≥100 iterations

## Acceptance Criteria

- [ ] `PromptTierBundle` schema exported and used by planner/skeptic/synth prompt builders
- [ ] Stable tier hash invariant enforced mid-run (test proves mutation attempt blocked/logged)
- [ ] Context compression forks conversation; no in-place message deletion
- [ ] `CONTEXT_COMPRESSED` and `CONTEXT_BUDGET_EVALUATED` events appear in trace UI payload
- [ ] Spy/local runs remain deterministic without provider calls
- [ ] `npm test`, `npm run build`, `npm audit` pass
- [ ] Concerns register updated (compression summary quality, live summarizer cost)

## Concerns to Register

- Deterministic summarization may lose nuance vs live summarizer
- Deep compression chains may confuse users without UI lineage indicator (047e UI follow-up)
- Stable tier still changes on `/model` equivalent (orchestration assignment change mid-session) — document as expected

## Commit

```text
feat(chunk-047a): tiered prompt assembly and compression lineage
```