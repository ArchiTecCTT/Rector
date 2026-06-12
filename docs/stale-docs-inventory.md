# Stale Docs Inventory & Proposed Edits

> **v0.3.0 transition in progress (branch `rector-0.3.0-configured-product`).**  
> Canonical architecture is now [`docs/architecture/configured-product-architecture.md`](architecture/configured-product-architecture.md).  
> The local/external dual-mode and provider-free-as-product framing is **deprecated**.  
> Product = configured orchestration with mandatory onboarding. CI = `SpyLLMProvider` only.

**Date of inspection:** During Chunk 33 work; updated for v0.3.0 configured-product transition.
**Context:** Shifting from local/external dual-mode to **unconfigured vs configured** product model. UI-persisted `runtime-settings.json` is source of truth. Mandatory first-run onboarding gates chat. Single orchestration path (`runOrchestratedChatRun`). Deterministic doubles are test-only.

This inventory was produced as the first structural step. Proposed edits were applied starting with highest-impact files (AGENTS.md, root README, docs/README, etc.). Old alpha language is either updated, given prominent banners, or noted as historical.

## High-Impact Stale Files (directly affect agents, contributors, and product messaging)

### 1. AGENTS.md (and duplicate Agents.md at root) — HIGHEST PRIORITY
**Why stale:** This is the primary guide for all AI agents working on the repo. It locks the target to the old local alpha preview and repeatedly says "local/provider-free mode must remain default" as the development goal, conflicting with the new cloud/VPS + hassle-free UI-config vision.
**Key stale excerpts (before edits):**
- "Target first public release: `v0.1.0-alpha` local developer preview, not production SaaS."
- "Active Development Goal": "continuing Alpha Build development through the final roadmap chunk. Optimize for fast, responsive, light system design; credits are available but local/provider-free mode must remain default."
- "Next Chunks Needed for v0.1.0-alpha": only lists local hardening (audit, screenshots, tag).
- "v0.1.0-alpha — local developer preview" section with "Need complete local brainstem..."
- Source of truth points exclusively to old 0.1.0-alpha docs.
**Proposed/Applied edits:**
- Rewrote Project Vision to emphasize hassle-free, UI-configurable cloud-capable product (pluggable memory providers: local/Mem0/TiDB/etc., all via web UI).
- Updated Current Branch/Worktree to state primary goal as "Cloud-capable, VPS-deployable commercial product with full web-UI configuration... Local... remains the mandatory perfect regression baseline".
- Updated Source of Truth to prioritize `.kiro/specs/cloud-capable-transition/`, current-byok-architecture.md, and note neuro-symbolic chunks + new transition chunks.
- Rewrote Active Development Goal and Next Work sections to focus on cloud-capable transition (adapted from .kiro spec for non-rigid/UI-config vision), while keeping local baseline rules. Noted chunks 26-32 as usability enhancements.
- Result: File now guides toward the new vision.

### 2. README.md (root)
**Why stale:** Sets the public first impression. Badge and text scream "local alpha preview" with fake adapters as current reality.
**Key stale excerpts (before edits):**
- "Alpha status: This is a local developer preview. The full pipeline runs end-to-end on deterministic fake/local adapters with no API keys and no network."
- "the alpha runs fully on fake/local adapters"
- "Real isolated sandbox execution is contract-defined but deferred past the alpha"
- Tech stack section assumes alpha prototype.
**Proposed/Applied edits:**
- Changed status badge to cloud-capable-transition.
- Rewrote intro and "What Is Rector?" to highlight hassle-free web-UI configuration for providers and memory backends (local, Mem0, TiDB Cloud, etc.), non-rigid architecture, VPS/cloud suitability, and neuro-symbolic usability features.
- Kept strong language that local mode is always available as identical regression baseline.
- Updated "Current direction" to point to .kiro/cloud-capable spec.

### 3. docs/README.md
**Why stale:** Claims to be the index for "Rector 0.1.0-alpha work" and prioritizes provider-free quickstart as source of truth.
**Key stale excerpts:**
- "This directory contains current source-of-truth documents for Rector 0.1.0-alpha work."
- Lists provider-free-quickstart prominently.
- "Removed stale docs" section but alpha framing dominates.
**Proposed/Applied edits (started):**
- Rephrase opening to current cloud-capable direction.
- Prioritize .kiro/cloud-capable-transition and current-byok-architecture.
- Keep provider-free quickstart but frame it as "for local development and contributors".
- Add note on UI-driven configuration and pluggable memory providers.

### 4. docs/plans/rector-master-roadmap.md
**Why stale:** Foundational plan still frames everything around alpha local baseline and "provider-free local demo mode" as the open-source requirement.
**Key stale excerpts:**
- "Required baseline: Provider-free local demo mode. Fake/local deterministic LLM provider. In-memory/local store."
- Chunk 0 and early chunks described in local-MVP terms.
- "First Chunk to Plan Next" still old.
**Proposed/Applied edits (started):**
- Update "Goal" and "Required baseline" to new vision (hassle-free cloud-capable with UI config for memory/providers; local as regression baseline).
- Note that chunks 0-25 are historical foundation; 26-32 added neuro-symbolic usability; active work follows adapted cloud-capable-transition.
- Add language about non-rigid, pluggable, UI-configurable architecture (memory DBs as example).

### 5. docs/architecture/rector-0.1.0-architecture.md
**Why stale:** Title, "0.1.0 Prototype Definition", "v0.1.0-alpha brainstem", scaling path locked to alpha prototype.
**Key stale excerpts:**
- "The repository now contains the completed provider-free `v0.1.0-alpha` brainstem"
- "0.1.0 proves the full hidden architecture through one vertical slice"
- Section 12.1 "0.1.x: Brainstem"
**Proposed/Applied edits (started):**
- Add prominent top banner: "HISTORICAL — v0.1.0-alpha local prototype architecture. See current-rector-byok-architecture.md and .kiro/specs/cloud-capable-transition/ for active direction toward cloud-capable, UI-configurable product."
- Update key vision/migration sections to note evolution.

### 6. docs/deployment/prototype.md
**Title and content:** "# Deployment Prototype — v0.1.0-alpha" "Rector alpha remains local-first."
**Proposed/Applied edits (started):**
- Add banner at top. Rename or move content to historical notes. Update to reference real cloud-capable deployment (VPS, configurable persistence).

### 7. .env.example
**Stale comments:** Assume local/provider-free as primary; persistence comments emphasize memory as "provider-free baseline".
**Proposed/Applied edits (started):**
- Update comments to note UI-managed config (providers.json + secrets.enc) is preferred for hassle-free use. Local mode ignores cloud config. Add section on pluggable memory providers configurable via UI (local options, Mem0, TiDB, etc.). RECTOR_PERSISTENCE etc. become advanced/fallback.

**Other files with notable stale references (banners or minor language updates recommended):**
- docs/deployment/desktop-shell-decision.md
- docs/contributing/adapters.md
- docs/extensions/public-contracts.md (v0.1.0-alpha contract)
- docs/plans/concerns-and-vulnerabilities.md (many "alpha brainstem", "local alpha" in open items — update language while preserving history)
- docs/getting-started/provider-free-quickstart.md (keep functional, add deprecation note or companion cloud guide)
- CONTRIBUTING.md
- docs/issues/roadmap-issues.json + generated/ + scripts/generate-roadmap-issues.js + export-linear-issues.js (add header: "Historical for v0.1.0-alpha 0-25. Current work in .kiro/cloud-capable-transition and new chunks.")
- audits/ (various)
- Old .kiro/specs/byok-alpha-* (consider moving or bannering as superseded by cloud-capable-transition)
- docs/plans/chunks/0xx-025 (historical — add note in index if needed; individual plans can stay)
- Some neuro chunk plans (026-032) reference "byokExternalE2E / localMode*" — minor, can stay or be updated in follow-on.

## Additional Notes from Inspection
- Positive: .kiro/specs/cloud-capable-transition/ is the right active spec. current-rector-byok-architecture.md is better aligned.
- The neuro-symbolic chunks (26-32) we implemented fit the "usable product" goal well (memory, proactive, reflection help with long coding sessions on VPS).
- User's new requirements (hassle-free UI config for memory providers like Mem0/TiDB/local, non-rigid architecture) should be reflected in updated docs and used to adapt the cloud-capable spec in later work.
- Many "brainstem" and "vertical slice" references are historical artifacts from Chunk 0-15 era — they can be left in old plans but not in active guides.
- No explicit "stale" banners were found on most conflicting files (contrary to Chunk 0 intent).

## Next Structural Steps (as requested)
1. (This document + inventory produced.)
2. Begin updating files (edits started on AGENTS.md, README.md; continuing with others + banners).
3. Continue with full cloud-capable-transition (adapt .kiro spec for UI-config memory providers, non-rigid design, integrate neuro features, implement remaining tasks like full BYOK, real E2B, TiDB, UI surfaces).

All changes will follow project process: this chunk plan (033), edits, verification (npm test + build), separate commit, update concerns.

See updated AGENTS.md and README.md for first examples of vision-aligned language.