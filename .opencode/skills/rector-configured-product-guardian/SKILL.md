---
name: rector-configured-product-guardian
description: "MUST USE for Rector changes touching product mode, chat dispatch, onboarding, runtime settings, providers, planner/executor paths, or product docs. Enforces v0.3.0 configured-product invariants: unconfigured/configured only, runtime-settings source of truth, runOrchestratedChatRun, spy/fake CI-only. Triggers: 'configured product', 'runtime-settings', 'onboarding', 'runOrchestratedChatRun', 'ORCHESTRATOR_MODE', 'fake chat'."
compatibility: opencode
metadata:
  project: rector
  phase: v0.3.0
---

# rector-configured-product-guardian

Use this skill to keep Rector aligned with the canonical v0.3.0 configured-product model.

## Load when touching

- Product-mode language or behavior.
- Chat API/UI dispatch.
- First-run onboarding and readiness gates.
- `.rector/runtime-settings.json`, setup endpoints, provider settings, or migration from environment variables.
- Planner/executor paths that could expose fake behavior as product behavior.
- Documentation describing how users run or configure Rector.

## Source of truth

Read first:

1. `docs/architecture/configured-product-architecture.md`
2. `.kiro/specs/cloud-capable-transition/requirements.md`
3. `.kiro/specs/cloud-capable-transition/design.md`
4. `.kiro/specs/cloud-capable-transition/tasks.md`
5. `docs/plans/rector-master-roadmap.md`
6. `docs/plans/concerns-and-vulnerabilities.md`

If anything conflicts, `docs/architecture/configured-product-architecture.md` wins.

## Non-negotiable invariants

| Area | Required behavior |
|---|---|
| Product states | Only `unconfigured` and `configured` are user-facing product states. |
| Fresh install | Starts unconfigured. Chat is gated by mandatory onboarding until readiness passes. |
| Source of truth | `.rector/runtime-settings.json`, written by UI/setup APIs. |
| Product chat | Uses `runOrchestratedChatRun` with configured provider adapters. |
| Fake/deterministic behavior | Test/CI only. Never product default or user-facing try mode. |
| `ORCHESTRATOR_MODE` | Deprecated migration/operator override only, not normal product configuration. |

## Forbidden moves

- Do not describe Rector as `local` vs `external` product modes.
- Do not add or preserve a provider-free demo chat path.
- Do not route normal chat through `runFakeChatRun`, `createFakePlan`, simulator execution, or fake providers.
- Do not make environment variables the primary setup UX.
- Do not present deterministic doubles as a supported end-user configuration.

## Implementation checklist

Before editing:

- Identify whether the change is product behavior, test-only behavior, or migration-only behavior.
- Confirm which runtime settings field gates the behavior.
- Trace chat-facing behavior to `runOrchestratedChatRun`.

Before final answer:

- Search changed docs/code for stale terms: `local mode`, `external mode`, `provider-free`, `fake chat`, `fake plan`, `ORCHESTRATOR_MODE`.
- Explain any remaining stale terms as historical, test-only, or migration-only.
- Update `docs/plans/concerns-and-vulnerabilities.md` if the work exposes a product, provider, secret, budget, sandbox, or stale-doc risk.
