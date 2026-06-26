---
name: rector-docs-replacement-surgeon
description: "MUST USE for Rector Phase 1 documentation replacement, README updates, stale-doc quarantine, roadmap/spec alignment, or removing old BYOK/local-mode language. Covers configured-product wording, runtime-settings onboarding docs, stale banners, and cross-doc consistency. Triggers: 'Phase 1 docs', 'documentation replacement', 'README', 'stale docs', 'local mode', 'provider-free'."
compatibility: opencode
metadata:
  project: rector
  phase: phase-1-docs
---

# rector-docs-replacement-surgeon

Use this skill to replace stale Rector documentation with the configured-product architecture without preserving old product assumptions.

## Load when editing

- `README.md`, `docs/**/*.md`, `.kiro/specs/**/*.md`, or roadmap/chunk docs.
- Any doc containing `local mode`, `external mode`, `provider-free`, `fake chat`, `BYOK alpha`, or `ORCHESTRATOR_MODE`.
- First-run setup, onboarding, readiness, provider configuration, or runtime settings docs.

## Canonical wording

Use this framing:

- Rector is a configured orchestration product.
- Fresh installs start `unconfigured`.
- Mandatory onboarding gates chat until readiness passes.
- Runtime settings live in `.rector/runtime-settings.json` and are written by the UI/setup APIs.
- Product chat uses `runOrchestratedChatRun`.
- Spy/fake/deterministic doubles are CI/test-only.
- `ORCHESTRATOR_MODE` is deprecated migration/operator override surface only.

## Replacement map

| Stale wording | Replacement |
|---|---|
| local mode as product | unconfigured fresh install or test-only spy path, depending on context |
| external mode | configured product runtime |
| provider-free quickstart | first-run setup/onboarding; provider-free only for tests/CI if historically needed |
| fake/local providers by default | configured providers for product, spy providers for CI |
| mode switch in UI | onboarding/readiness product gate |
| environment configuration | UI-persisted runtime settings |

## Stale doc handling

- If a doc is retained only for history, add or preserve a clear stale/quarantined banner.
- If a stale doc conflicts with `docs/architecture/configured-product-architecture.md`, rewrite or mark it stale.
- Do not let historical notes appear as current setup instructions.

## Cross-check before finishing

Run a stale-language sweep over changed docs:

```bash
rg -n "local mode|external mode|provider-free|fake chat|fake plan|ORCHESTRATOR_MODE|BYOK alpha" README.md docs .kiro
```

For each remaining hit, ensure it is explicitly historical, test-only, migration-only, or intentionally deprecated.
