# Testing Policy

## Verification Commands

Before claiming any work is complete, run all three and confirm they pass:

```bash
npm test
npm run build
npm run check
```

`npm test` runs Vitest once (`vitest run`). Use `npm run test:watch` only for local iteration,
never as the completion gate. Focused runs are fine while developing, e.g.:

```bash
npm test -- tests/validationHealing.test.ts
```

Never claim a result passes unless the command actually ran and passed.

## Known-Good Baseline

Current baseline: **28 test files / 278 tests passing**, build passing, check passing. Do not
regress this. New features should add tests and raise the count, not lower it.

## What to Test

- Every new feature and every bug fix needs tests.
- Cover protocol/schemas, state transitions, DAG compilation/execution, validation/healing,
  chat and operator APIs, security/redaction, providers, and integration contracts.
- For bug fixes, add a regression test that fails before the fix and passes after.

## Test Quality Rules

- **Deterministic.** Avoid wall-clock and real-time dependencies; they cause CI flakes (the
  rate-limit timing test was widened for exactly this reason). Inject clocks/timeouts where
  possible.
- **No real network.** Mock `fetch` for any provider/workflow/extension/sandbox test. Assert
  no network where appropriate.
- **No API keys.** Tests must pass with no credentials set. Missing-credential paths produce
  skips or graceful errors, not hard failures.
- **In-process over child processes.** Prefer testing exported runners in-process. Avoid
  spawning child processes where in-process testing is possible (the contributor issue
  generator tests are the current child-process exception and a candidate to refactor).
- **Provider-free suite stays green.** The default `npm test` run must use zero real network
  and zero real model calls.

## Optional Live-Provider Tests

If live-provider smoke tests are added, they must:

- Be disabled by default and require an explicit env opt-in (e.g.
  `RECTOR_ENABLE_LIVE_PROVIDER_TESTS=true`).
- Skip (not fail) when the opt-in or required key is absent.
- Never print secrets and always respect budget gates.
- Leave normal `npm test` using fake/local providers only.
