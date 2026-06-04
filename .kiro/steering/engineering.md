# Engineering Standards

## Language and Types

- TypeScript with strict mode. Do not weaken `tsconfig` strictness to silence errors.
- Validate all external/boundary input with **Zod schemas** (API payloads, provider
  responses, DAG, events, config, extension manifests). Parse at the boundary, then trust
  typed data internally.
- Prefer small, deterministic, pure functions. Side effects belong at edges (API, bin,
  adapters), not in core orchestration logic.
- Keep modules focused and composable. Avoid broad rewrites unless the current design is
  demonstrably blocking; prefer wrapping/adapting.

## Determinism and Safety Defaults

- No real network calls in normal tests or in provider-free mode.
- No arbitrary shell execution. Sandbox/executor deny shell by default; only allowlisted
  fake/local commands run.
- No API keys required for contributor setup. Missing credentials must degrade gracefully
  (skip/disable), never crash local dev, tests, or builds.
- Do not introduce background timers, daemons, polling loops, or always-on network calls
  unless explicitly required by the task and covered by tests.
- Keep `src/index.ts` side-effect free. Runtime bootstrap stays in `src/bin/server.ts`.
- Provider-free mode must remain the default: zero model calls, zero cost.

## Implementation Workflow

When implementing a feature on this repo:

1. Read the relevant steering docs and source-of-truth docs.
2. Inspect current code and tests for the affected modules.
3. Make a small plan; keep scope tight.
4. Write or update tests first where feasible (deterministic, in-process).
5. Implement minimal deterministic code that satisfies the contract.
6. Update `docs/plans/concerns-and-vulnerabilities.md` if behavior or risk changed, and
   keep related docs in sync.
7. Run focused tests while developing.
8. Run full verification before claiming completion.
9. Summarize changed files and the evidence (commands run + results).

## Verification (required before claiming done)

Focused tests are fine during development, but before declaring work complete, run all three:

```bash
npm test
npm run build
npm run check
```

Never claim something passes unless the command actually ran and passed. The current known-good
baseline is 28 test files / 278 tests passing, plus passing build and check. Do not regress it.

Optional package-import smoke checks (used in the final audit):

```bash
node -e "import('rector').then(m=>console.log(typeof m.createApp))"
node -e "import('rector/sandbox').then(m=>console.log(typeof m.SafeLocalSandboxAdapter))"
```

## Adding Providers / Integrations / Sandbox Behavior

- New provider support: disabled by default, network gated behind an explicit
  `enableNetwork`-style flag, all tests mock `fetch`. Budget gate runs before invocation.
- New integration support: use request builders/stubs first; no live network by default;
  validate env/config.
- New sandbox/execution behavior: deny arbitrary shell by default; patch artifacts use safe
  relative paths; file writes require approval metadata.

## Documentation Sync

- Keep `docs/plans/concerns-and-vulnerabilities.md` current for any new limitation, risk,
  or deferred fix.
- Source-of-truth docs win over stale/quarantined docs. Do not delete stale docs; banner
  or quarantine them instead unless explicitly instructed otherwise.
