# Rector Docs Index

This directory contains current source-of-truth documents for Rector 0.1.0-alpha work.

## Current source of truth

Read these first for Rector 0.1.0 work:

1. [`architecture/rector-0.1.0-architecture.md`](architecture/rector-0.1.0-architecture.md) — authoritative product and technical architecture.
2. [`plans/rector-master-roadmap.md`](plans/rector-master-roadmap.md) — authoritative roadmap and implementation chunk order.
3. [`plans/chunks/002-migration-map.md`](plans/chunks/002-migration-map.md) — current old-task-MVP to chat/run migration map and compatibility strategy.
4. `plans/chunks/*.md` — per-chunk implementation plans when present.
5. [`getting-started/provider-free-quickstart.md`](getting-started/provider-free-quickstart.md) — local setup without paid provider credentials.
6. [`extensions/public-contracts.md`](extensions/public-contracts.md) — public alpha extension manifest, compatibility, and typed contract surface.
7. [`issues/`](issues/) — contributor-ready roadmap issue catalog and generated GitHub issue drafts.
8. [`contributing/adapters.md`](contributing/adapters.md) — adapter contribution guide skeleton.
9. [`contributing/linear-tracking.md`](contributing/linear-tracking.md) — how the roadmap is mirrored to the Linear board and kept in sync.
10. [`../reviews/`](../reviews/) — review inputs that informed the current architecture and roadmap.
11. [`deployment/prototype.md`](deployment/prototype.md) — deployment prototype, Heroku/Cloudflare configuration, and graceful shutdown contract.

Current direction: Rector is Apache-2.0 open-source software with a normal chat-first user experience. Deterministic orchestration, model routing, validation, sandboxing, and self-healing run underneath the chat interface and should not be exposed as the primary UX.

## Removed stale docs

Historical local-MVP and cloud-heavy planning docs were deleted after the alpha completion audit so they cannot mislead future work. The current architecture, roadmap, chunk plans, issue catalog, and concerns register are the source of truth.
