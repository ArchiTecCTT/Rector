# Rector Docs Index

This directory contains documentation for Rector. 

**Primary direction (as of cloud-capable transition):** A hassle-free, web-UI-configurable, commercial cloud-capable AI engineering system runnable on VPS for real daily coding work. Users configure LLM providers, memory database backends (local options, Mem0, TiDB Cloud, etc.), sandbox, telemetry, and more entirely through the browser UI — no deep file or env editing required. Architecture is intentionally non-rigid and pluggable. Local/provider-free mode remains the mandatory, identical regression baseline for tests, contributors, and safe development.

See the active spec: `.kiro/specs/cloud-capable-transition/` (requirements, design, tasks — adapted for the above vision).

## Current source of truth (updated for new vision)

Read these first:

1. `.kiro/specs/cloud-capable-transition/` (requirements.md, design.md, tasks.md) — active transition spec toward cloud-capable, UI-configurable product.
2. `architecture/current-rector-byok-architecture.md` — current architecture (local-first BYOK with pluggable, UI-driven providers and backends).
3. `plans/rector-master-roadmap.md` — roadmap (being aligned; historical chunks 0-25 are foundation).
4. `plans/chunks/*.md` — per-chunk plans (26-32 added neuro-symbolic usability features; 033+ for cloud transition and doc alignment).
5. `plans/concerns-and-vulnerabilities.md` — deferred risks (updated during transition).
6. `getting-started/provider-free-quickstart.md` — local setup (still valid for contributors and regression; see cloud-capable spec for VPS/UI-config paths).
7. `extensions/public-contracts.md` — public extension contracts (evolving for pluggable UI-configured backends including memory).
8. `issues/` — historical issue catalog for 0-25; current work tracked in .kiro/cloud-capable-transition and new chunks.
9. `contributing/adapters.md` and `contributing/linear-tracking.md` — contribution guidance (local baseline preserved; cloud features via UI where possible).
10. `../reviews/` — historical review inputs.
11. `deployment/` docs — historical prototype notes; real deployment follows cloud-capable spec (VPS, configurable persistence/memory).

Neuro-symbolic enhancements (chunks 26-32: SLM preprocessing, advanced memory with notes/pruning/time-awareness + `POST /api/notes`, proactive layer, symbolic engines, MCTS, ponder swarm, decomposition/stitching) are retained as they make the system more usable for long-running work in the new cloud/VPS context.

## Historical / Stale Alpha Docs

Many files still contain language from the original "v0.1.0-alpha local developer preview / lightweight MVP" phase (e.g. "local developer preview", "provider-free as primary", "alpha brainstem", "vertical slice"). 

- `architecture/rector-0.1.0-architecture.md` — historical; see banner inside and current-byok-architecture.md.
- `deployment/prototype.md`, `deployment/desktop-shell-decision.md` — historical prototype notes.
- Old plans in `plans/chunks/0xx-025*.md` and `docs/issues/generated/` — historical for alpha foundation.
- `docs/plans/rector-master-roadmap.md` (parts) and root `AGENTS.md` (updated in this chunk).
- `.env.example` comments and various audits/scripts.

These are retained for history but are **no longer authoritative**. They have (or will receive) banners. Source-of-truth wins in conflicts. See `docs/stale-docs-inventory.md` for full list and edit history.

The neuro-symbolic and cloud transition work moves us toward the hassle-free, UI-configurable vision while keeping the local baseline untouched.
