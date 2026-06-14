---
name: rector-test-writer
description: "This skill should be used when writing tests for Rector — property-based tests with fast-check, DOM tests using the vm-based harness, integration tests with live providers, or standard unit tests. Covers test file naming, arbitrary composition, deterministic clock/store injection, and the providerPanelHarness. Triggers on tasks like 'write tests', 'add property test', 'test this module', or 'add coverage'."
---

# Rector Test Writer

Write tests for Rector following established patterns: property-based (fast-check), DOM (vm harness), integration (live providers), and unit tests.

## Purpose

Rector maintains 1369+ tests across 213+ files using Vitest with extensive property-based testing via fast-check. This skill encodes the testing conventions, available arbitraries, deterministic patterns, and harness utilities to produce consistent, high-quality tests.

## When to Use

- Writing any new test for Rector
- Adding property-based coverage for invariants
- Creating DOM tests for UI components
- Writing integration tests for live providers
- Extending existing test suites

## Test Configuration

- **Framework:** Vitest 4.1.8, globals enabled (`describe`, `it`, `expect` available without import)
- **Environment:** `node` (NOT jsdom)
- **Location:** All tests in flat `tests/` directory
- **Support utilities:** `tests/support/`
- **Run command:** `npm test`

## File Naming Convention

Format: `{descriptiveName}.{category}.test.ts`

| Category | Suffix | Purpose |
|----------|--------|---------|
| Property-based | `.property.test.ts` | fast-check invariant tests |
| DOM | `.dom.test.ts` | UI tests via vm-based fake DOM |
| Integration | `.integration.test.ts` | Live provider round-trips |
| Unit | `.unit.test.ts` or `.test.ts` | Standard assertions |

## Writing Property-Based Tests

### Structure

```typescript
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { /* arbitraries */ } from "./support/byokArbitraries";

/**
 * Task: {TASK_ID}
 * Property {N}: {Property name}
 * Requirements validated: {list}
 * Design rationale: {explanation}
 */

describe("Property {N}: {invariant description}", () => {
  it("{specific assertion}", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbBudget(), async (prompt, budget) => {
        const store = new InMemoryRectorStore({ now: fixedStringClock() });
        // ... exercise SUT ...
        expect(result).toSatisfy(invariant);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
```

### Key Patterns

- Use `fc.asyncProperty` for async assertions (store/provider calls)
- Set `{ numRuns: 100 }` (typical), 40-80 for heavy tests
- Add timeout on `it(...)`: `, 60_000` or `, 120_000` for long property runs
- Each property test is self-contained — fresh store/doubles per run
- JSDoc block documents task ID, property name, requirements, rationale

### Available Arbitraries

See `references/arbitraries.md` for the complete list. Key categories:

- **Prompts:** `arbPrompt()`
- **Secrets:** `arbKeyLikeSecret()`, `arbSecretChannelText(secret)`, `arbSecretInjectionCase()`
- **Budgets:** `generousBudget()`, `arbAllowingBudget()`, `arbSubThresholdBudget()`, `arbBudget()`
- **Plans:** `arbValidPlan()`, `arbSchemaValidPlan()`, `arbMalformedPlannerJson()`
- **DAGs:** `arbDag()`, `arbFailingDag()`
- **Workspace:** `arbSafeRelativePath()`, `arbAdversarialPathCase()`, `InMemoryWorkspaceFs`
- **Providers:** `SpyLLMProvider`, `createFetchDouble()`

### Composition Techniques

```typescript
fc.tuple(arb1, arb2)           // Independent generators
arb.chain(value => ...)         // Dependent generation
arb.map(transform)              // Post-processing
fc.record({ field: arb })       // Structured objects
fc.oneof(arb1, arb2)           // Variant selection
```

## Deterministic Clock/Store Injection

Every source of non-determinism is pinned via dependency injection:

```typescript
// String clock for stores (entity timestamps/IDs)
function fixedStringClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

// Date clock for observability spans
function fixedDateClock(): () => Date {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000);
}

// Span ID factory for observability
function fixedSpanIdFactory(): () => string {
  let counter = 0;
  return () => `span-${++counter}`;
}
```

Usage:
```typescript
const store = new InMemoryRectorStore({ now: fixedStringClock() });
const trace = createInMemoryObservabilityTrace({
  traceId: "test-trace-1",
  idFactory: fixedSpanIdFactory(),
  now: fixedDateClock(),
});
```

For timestamps not under DI control, normalize during comparison:
```typescript
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
JSON.stringify(value, (_key, val) =>
  typeof val === "string" && ISO_TIMESTAMP.test(val) ? "<timestamp>" : val);
```

## Writing DOM Tests

DOM tests use Node's `vm` module with a hand-rolled fake DOM (no jsdom):

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createProviderPanelHarness } from "./support/providerPanelHarness";
// Or for theme tests:
import { createFakeRoot, createFakeStorage, createFakeLink, getThemeFactory } from "./support/themeDoubles";
```

### Provider Panel Harness

```typescript
const harness = createProviderPanelHarness();
harness.setFetchHandler(async (url, opts) => { /* mock responses */ });
harness.openPanel();
harness.selectProvider("together");
await harness.runTest();
expect(harness.getEl("test-result").textContent).toContain("ok");
```

### Theme Doubles

```typescript
const root = createFakeRoot();
const storage = createFakeStorage();
const link = createFakeLink();
const createTheme = getThemeFactory();
const theme = createTheme({ root, storage, link });
theme.applyTheme("aether");
expect(root.getAttribute("data-theme")).toBe("aether");
```

## Writing Integration Tests

### Skip Conditions

```typescript
const apiKey = process.env.PROVIDER_API_KEY?.trim() ?? "";
const hasCredentials = apiKey.length > 0;

describe.skipIf(!hasCredentials)("live provider integration", () => {
  // Tests only run when credentials are available
});
```

### Optional Package Detection

```typescript
import { createRequire } from "node:module";
function isOptionalPackageInstalled(name: string): boolean {
  const req = createRequire(import.meta.url);
  try { req(name); return true; } catch { return false; }
}

it.skipIf(!isOptionalPackageInstalled("mem0ai"))("round-trips", async () => {
  // ...
}, 60_000);
```

### Integration Test Pattern

1. Instantiate real provider with credentials from env
2. Call `validateConfig()` first
3. Perform CRUD round-trip (create, search, get, delete)
4. Assert redaction: verify `redactSecrets(value)` never leaks raw credentials
5. Use unique content per run: `uniqueTestContent(label)` with ISO timestamp + PID
6. Extended timeouts: `60_000` ms

## Key Invariants

1. **Determinism:** Two runs with the same seed produce identical results
2. **Local baseline:** Tests never require network or API keys (skip conditions for those that do)
3. **Isolation:** Each test/property run has fresh state (store, doubles, clocks)
4. **Redaction:** Never assert on raw secret values; verify secrets are redacted

## Reference Files

- `references/arbitraries.md` — Complete catalog of available arbitraries with signatures and usage examples
