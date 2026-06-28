---
name: rector-configured-product-guardian
description: "MUST USE for Rector changes touching product mode, chat dispatch, onboarding, runtime settings, providers, planner/executor paths, or product docs. Enforces configured-product invariants."
metadata:
  project: rector
  invariant: configured-product
---

# rector-configured-product-guardian

Use whenever work touches product behavior, product docs, chat dispatch, onboarding/readiness, runtime settings, or providers.

## Source of truth

1. `docs/architecture/configured-product-architecture.md`
2. Active phase plan under `docs/plans/2-0/phases/`
3. `docs/plans/concerns-and-vulnerabilities.md`
4. `.kiro/specs/**` only if present in the current branch/worktree

## Invariants

- User-facing product states are `unconfigured` and `configured`.
- Fresh installs start unconfigured; chat is gated until readiness passes.
- `.rector/runtime-settings.json` is UI-written product state.
- Product chat uses `runOrchestratedChatRun`.
- Spy/fake/deterministic doubles are test/CI-only.
- `ORCHESTRATOR_MODE` is deprecated migration/operator override only.

## Avoid

- Local/external as current product modes.
- Provider-free demo chat as product behavior.
- Normal chat through fake planners, simulator execution, or fake providers.
- Environment variables as primary setup UX.

Before finishing, sweep changed paths for stale terms and qualify any historical/test-only hits.
