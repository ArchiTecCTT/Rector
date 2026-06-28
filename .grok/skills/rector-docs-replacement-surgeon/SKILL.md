---
name: rector-docs-replacement-surgeon
description: "MUST USE for Rector docs, README, stale-doc quarantine, roadmap/spec alignment, or removing old BYOK/local-mode/provider-free product language."
metadata:
  project: rector
  workflow: docs-replacement
---

# rector-docs-replacement-surgeon

Use when editing `README.md`, `docs/**/*.md`, roadmap/phase/chunk docs, or branch-specific specs.

## Canonical wording

- Rector is a configured orchestration product.
- Fresh installs start `unconfigured`.
- Onboarding/readiness gates product chat.
- Runtime settings live in `.rector/runtime-settings.json` and are written by UI/setup APIs.
- Product chat uses `runOrchestratedChatRun`.
- Spy/fake/deterministic doubles are CI/test-only.
- `ORCHESTRATOR_MODE` is deprecated migration/operator override only.

## Stale language sweep

Search changed docs for:

```text
local mode|external mode|provider-free|fake chat|fake plan|ORCHESTRATOR_MODE|BYOK alpha
```

Every remaining hit must be historical, test-only, migration-only, or intentionally deprecated.

Keep `AGENTS.md` compact; use it as a pointer, not a status ledger.
