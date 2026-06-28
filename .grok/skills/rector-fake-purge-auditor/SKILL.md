---
name: rector-fake-purge-auditor
description: "MUST USE for work touching FakeLLMProvider, SpyLLMProvider, fake planners, simulator tools, deterministic fallbacks, validation stubs, benchmark naming, or fake-seam audits."
metadata:
  project: rector
  invariant: fake-purge
---

# rector-fake-purge-auditor

Use to keep deterministic doubles useful for tests while impossible to mistake for product behavior.

## Allowed surfaces

- `SpyLLMProvider`: CI/tests only.
- `FakeLLMProvider`: test/development double only; not normal configured runtime.
- `createFakePlan`: test/helper only; not executable product work.
- Simulator tools: tests, harnesses, or explicit non-production diagnostics.

## Required containment

- Product runtime must not select fake providers through normal setup/readiness.
- Planner failure must not silently become executable fake work.
- Validation must not claim success without evidence.
- Simulator execution must not stand in for real safe workspace/sandbox execution in product chat.
- Benchmark/eval names should use `configured_spy_pipeline` when measuring spy-injected orchestration.

## Audit

Run when relevant:

```bash
npm run audit:no-fakes
```

Remaining fake/deterministic references must be test-only, CI-only, migration-only, historical/stale, or recorded as deferred risk.
