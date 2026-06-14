# Available Arbitraries

All exported from `tests/support/byokArbitraries.ts`.

## Prompts

| Arbitrary | Description |
|-----------|-------------|
| `arbPrompt()` | Mixed canned route-bearing prompts + lorem + free-form; always non-empty/trimmed |

## Secrets & Redaction

| Arbitrary | Description |
|-----------|-------------|
| `arbKeyLikeSecret()` | API-key-like strings (prefix + 24-48 alphanumerics) |
| `arbSecretChannelText(secret)` | Secret embedded in redactable patterns (Bearer, api_key=, etc.) |
| `arbSecretInjectionCase()` | Complete injection scenario: secret + channel + carrier text |

## Budgets & Runs

| Arbitrary | Description |
|-----------|-------------|
| `generousBudget(overrides?)` | Factory for permissive budget (all limits high) |
| `arbAllowingBudget()` | Always allows a positive estimate |
| `arbSubThresholdBudget()` | Zeroes one limit to guarantee denial |
| `arbBudget()` | Either allowing or sub-threshold |
| `makeExternalRun(budget, overrides?)` | Pre-built Run entity for testing |

## Plans & Context

| Arbitrary | Description |
|-----------|-------------|
| `arbTriage()` | Triage result from arbitrary prompt |
| `arbPlannerInput()` | Schema-valid planner input (prompt -> triage -> context pack -> input) |
| `arbValidPlan()` | Plan satisfying both schema and invariants (via `createFakePlan`) |
| `arbSchemaValidPlan()` | May have dangling deps (schema-valid, invariant-violating) |
| `arbMalformedPlannerJson()` | Not-JSON / wrong-shape / missing-field variants |
| `makeContextPack(triage, intent?)` | Factory for a schema-valid ContextPack |

## Workspace & Filesystem

| Arbitrary | Description |
|-----------|-------------|
| `arbSafeRelativePath()` | Valid relative paths within workspace |
| `arbEmptyPath()` | Empty string paths |
| `arbAbsolutePath()` | Absolute paths (should be denied) |
| `arbDotDotPath()` | Path traversal attempts (should be denied) |
| `arbAdversarialPathCase()` | Union of empty/absolute/dot-dot/symlink (always denied) |
| `arbWorkspacePathCase()` | Any category (safe or adversarial) |
| `InMemoryWorkspaceFs` | Injectable in-memory FS double with realpath/read/list/write and symlink resolution; tracks all accesses for containment assertions |
| `createWorkspaceFs(options)` | Factory for InMemoryWorkspaceFs |

## Commands

| Arbitrary | Description |
|-----------|-------------|
| `arbAllowlistedCommand()` | Safe commands (npm:test, tsc, etc.) |
| `arbDestructiveCommand({ alsoAllowlisted? })` | rm -rf, dd, format, etc. |
| `arbShellMetacharacterCommand()` | Commands with ; pipe & $() etc. |

## DAGs & Healing

| Arbitrary | Description |
|-----------|-------------|
| `arbDag()` | 1-4 node linear chain, healable node types |
| `arbFailingDag()` | DAG + all-failed execution result |
| `makeFailingExecutionResult(dag, now?)` | All nodes FAILED with INJECTED_FAILURE |
| `makeAlwaysFailingExecutor(now?)` | Never succeeds, counts invocations |
| `makeAlwaysFailingRepairAgent(options?)` | Always proposes a patch that doesn't fix |
| `makeNoRepairAgent()` | Always returns undefined |

## Skeptic & Synthesis

| Arbitrary | Description |
|-----------|-------------|
| `arbSkepticFinding()` | Single skeptic finding |
| `arbValidSkepticDraft()` | Valid skeptic review draft |
| `arbMalformedSkepticJson()` | Invalid skeptic JSON variants |
| `arbSynthesisCitation()` | Single citation |
| `arbValidSynthesisDraft()` | Valid synthesis with citations |
| `arbCitationFreeSynthesisDraft()` | Synthesis without citations |
| `arbMalformedSynthesisJson()` | Invalid synthesis JSON variants |

## LLM Provider Doubles

| Utility | Description |
|---------|-------------|
| `SpyLLMProvider` | Configurable spy with scripted responses, invoke counter, request recording |
| `DEFAULT_SPY_USAGE` | Baseline usage object (100 in / 50 out / $0.01) |
| `createFetchDouble(options?)` | Mocked `fetch` returning OpenAI-compatible responses |

## Helper Factories

| Utility | Description |
|---------|-------------|
| `planToJson(plan)` | Serialize plan for provider response mocking |
| `skepticDraftToJson(draft)` | Serialize skeptic draft for mocking |
| `synthesisDraftToJson(draft)` | Serialize synthesis draft for mocking |

## Composition Patterns

```typescript
// Independent generators
fc.tuple(arbPrompt(), arbBudget())

// Dependent generation (budget depends on prompt complexity)
arbPrompt().chain(prompt => fc.tuple(fc.constant(prompt), budgetForPrompt(prompt)))

// Post-processing
arbValidPlan().map(plan => ({ ...plan, metadata: { source: "test" } }))

// Structured objects
fc.record({
  prompt: arbPrompt(),
  budget: arbBudget(),
  triage: arbTriage(),
})

// Variant selection
fc.oneof(arbSafeRelativePath(), arbAdversarialPathCase())
```

## Common Test Double Patterns

### SpyLLMProvider

```typescript
const spy = new SpyLLMProvider({
  responses: [
    planToJson(someValidPlan),      // First call returns plan
    skepticDraftToJson(someDraft),  // Second call returns skeptic review
  ],
});
// After test:
expect(spy.invokeCount).toBe(2);
expect(spy.requests[0].messages).toContainEqual(/* ... */);
```

### InMemoryWorkspaceFs

```typescript
const fs = createWorkspaceFs({
  files: { "src/main.ts": "export default {}" },
  symlinks: { "link.ts": "/etc/passwd" },  // for escape testing
});
// After operation:
expect(fs.accessLog).toContainEqual({ op: "read", path: "src/main.ts" });
expect(fs.deniedAccesses).toHaveLength(1);  // symlink escape blocked
```
