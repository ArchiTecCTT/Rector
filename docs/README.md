# Rector Docs Index

This directory contains both current source-of-truth documents and preserved historical planning notes.

## Current source of truth

Read these first for Rector 0.1.0 work:

1. [`architecture/rector-0.1.0-architecture.md`](architecture/rector-0.1.0-architecture.md) — authoritative product and technical architecture.
2. [`plans/rector-master-roadmap.md`](plans/rector-master-roadmap.md) — authoritative roadmap and implementation chunk order.
3. `plans/chunks/*.md` — per-chunk implementation plans when present.
4. [`../reviews/`](../reviews/) — review inputs that informed the current architecture and roadmap.

Current direction: Rector is Apache-2.0 open-source software with a normal chat-first user experience. Deterministic orchestration, model routing, validation, sandboxing, and self-healing run underneath the chat interface and should not be exposed as the primary UX.

## Stale or archived docs

Historical docs are preserved for research context only. Do not treat them as implementation instructions unless a current source-of-truth doc explicitly references them.

Stale docs are marked with a banner at the top instead of deleted so prior design work remains available:

- [`local-mvp-design.md`](local-mvp-design.md) — old local task-MVP design.
- [`local-mvp-implementation-plan.md`](local-mvp-implementation-plan.md) — old local task-MVP implementation checklist.
- [`specs/Rector-Specs-1.md`](specs/Rector-Specs-1.md) — old local-first MVP specification and diagrams document.
- [`rector-blueprint.md`](rector-blueprint.md) — older cloud-heavy step-by-step blueprint.
- [`../implementation-plan/`](../implementation-plan/) — older cloud-heavy implementation plan directory.

If a stale doc conflicts with the current architecture or roadmap, the current source-of-truth docs win.
