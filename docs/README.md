# Rector Docs Index

This directory contains documentation for Rector.

**Primary direction (v0.3.0 configured product):** A hassle-free, web-UI-configurable AI engineering system. Users configure LLM providers, memory backends, sandbox, telemetry, and budgets entirely through the browser. Fresh installs start **unconfigured** with mandatory first-run onboarding until readiness passes. Chat runs configured orchestration — no fake demo path.

**Canonical architecture:** [`architecture/configured-product-architecture.md`](architecture/configured-product-architecture.md)

## Current source of truth

Read these first:

1. [`architecture/configured-product-architecture.md`](architecture/configured-product-architecture.md) — **canonical** v0.3.0+ product model (unconfigured vs configured, runtime settings, onboarding, single orchestration path, spy-only CI).
2. [`.kiro/specs/cloud-capable-transition/`](../.kiro/specs/cloud-capable-transition/) — active implementation spec (requirements, design, tasks).
3. [`getting-started/first-run-setup.md`](getting-started/first-run-setup.md) — guided setup for new installs.
4. [`plans/rector-master-roadmap.md`](plans/rector-master-roadmap.md) — roadmap including v0.3.0 milestone.
5. [`plans/chunks/*.md`](plans/chunks/) — per-chunk plans (pre-v0.3.0 plans carry stale banners).
6. [`plans/concerns-and-vulnerabilities.md`](plans/concerns-and-vulnerabilities.md) — deferred risks.
7. [`extensions/public-contracts.md`](extensions/public-contracts.md) — public extension contracts.
8. [`contributing/adapters.md`](contributing/adapters.md) and [`contributing/linear-tracking.md`](contributing/linear-tracking.md) — contribution guidance.
9. [`issues/`](issues/) — historical issue catalog; current work tracked in `.kiro/specs/cloud-capable-transition/`.
10. [`../reviews/`](../reviews/) — historical review inputs.
11. [`deployment/`](deployment/) — deployment notes; VPS/hosted paths follow configured-product architecture.

Neuro-symbolic enhancements (chunks 26–32: SLM preprocessing, advanced memory, proactive layer, symbolic engines, MCTS, ponder swarm, task decomposition) are part of the configured product, not a separate local demo.

## Stale / historical docs

Files with pre-v0.3.0 local/external or provider-free-as-product language carry warning banners:

- [`architecture/current-rector-byok-architecture.md`](architecture/current-rector-byok-architecture.md) — stale pre-v0.3.0 BYOK reference
- [`architecture/rector-0.1.0-architecture.md`](architecture/rector-0.1.0-architecture.md) — historical alpha prototype
- [`getting-started/provider-free-quickstart.md`](getting-started/provider-free-quickstart.md) — redirect to first-run setup
- [`deployment/prototype.md`](deployment/prototype.md), [`deployment/desktop-shell-decision.md`](deployment/desktop-shell-decision.md) — historical prototype notes
- Chunk plans 042–046 with local-default language — see banners

See [`stale-docs-inventory.md`](stale-docs-inventory.md) for the full inventory. When documents conflict, **configured-product-architecture.md** wins.