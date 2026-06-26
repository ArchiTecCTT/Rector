---
name: rector-fake-purge-auditor
description: "MUST USE for Rector work touching FakeLLMProvider, SpyLLMProvider, createFakePlan, simulator tools, deterministic fallbacks, validation passes, benchmark naming, or fake-seam audits. Prevents test doubles from leaking into product behavior. Triggers: 'fake', 'spy', 'simulator', 'deterministic fallback', 'audit:no-fakes', 'configured_spy_pipeline'."
compatibility: opencode
metadata:
  project: rector
  invariant: fake-purge
---

# rector-fake-purge-auditor

Use this skill to keep deterministic doubles useful for tests while impossible to mistake for product behavior.

## Load when touching

- `FakeLLMProvider`, `SpyLLMProvider`, scripted model providers, or in-memory doubles.
- `createFakePlan`, fake planner paths, deterministic fallbacks, or planner failure handling.
- Executor simulators, simulator tools, echo tools, or validation stubs.
- Benchmark/eval names involving fake/local/spy pipelines.
- `npm run audit:no-fakes` findings.

## Allowed uses

| Double | Allowed surface |
|---|---|
| `SpyLLMProvider` | CI/tests only; scripted responses and invocation counting. |
| `FakeLLMProvider` | Test/development double only; not selectable through normal configured runtime. |
| `createFakePlan` | Test sketch/helper only; must not create executable production work. |
| Simulator tools | Tests, harnesses, or explicit non-production diagnostics only. |

## Required containment

- Product runtime must not select fake providers through normal setup/readiness.
- Planner failure must not silently become executable fake work.
- Validation must not say `passed: true` without real evidence.
- Simulator execution must not stand in for safe workspace/sandbox execution in product chat.
- Benchmark names should use `configured_spy_pipeline`, not `local_fake_pipeline`, when measuring spy-injected orchestration.

## Audit commands

Use when relevant:

```bash
npm run audit:no-fakes
rg -n "FakeLLMProvider|SpyLLMProvider|createFakePlan|runFakeChatRun|simulator|local_fake_pipeline|configured_spy_pipeline" src tests docs scripts README.md
```

Every remaining fake/deterministic reference must be one of:

- test-only;
- CI-only;
- migration-only;
- historical/stale and clearly marked;
- deliberately deferred and recorded in `docs/plans/concerns-and-vulnerabilities.md`.
