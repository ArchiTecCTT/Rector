# Chunk 33 — Stale Doc Cleanup and Vision Alignment (Cloud-Capable Transition)

## Goal
Align all documentation, agent guides, and high-level descriptions with the new primary vision: a hassle-free, UI-configurable, commercial cloud-capable Rector system runnable on VPS for real coding work. Preserve local/provider-free as an ironclad regression baseline and contributor on-ramp, but de-emphasize it as the "target" or "default end state."

Incorporate user feedback:
- No rigid architecture.
- Hassle-free experience: users configure providers (LLM, memory DB, sandbox, etc.) entirely through the web UI.
- Pluggable memory database providers: local (in-memory, SQLite, etc.), Mem0, TiDB Cloud, and future options — all selectable/configurable via UI without editing files or env.
- Everything (including the neuro-symbolic enhancements from chunks 26-32) should support this configurable, UI-driven model.

This chunk focuses on **documentation and messaging cleanup** as the foundation before deeper implementation of the cloud-capable transition.

## Scope
- Detailed inventory of stale references to "v0.1.0-alpha local developer preview", "lightweight MVP", "provider-free as primary goal", "local-only simulation", "alpha brainstem", etc.
- Proposed and executed edits to key files: AGENTS.md, root README.md, docs/README.md, master-roadmap.md, 0.1.0-architecture.md, deployment docs, .env.example comments, contributing docs, etc.
- Add or update banners for historical alpha docs.
- Update AGENTS.md "Active Development Goal", "Next Chunks", "Target release", and "Source of Truth" sections to reference the cloud-capable vision and .kiro/specs/cloud-capable-transition/ (while keeping local baseline rules).
- Align with existing .kiro/specs/cloud-capable-transition/ spec.
- Note the neuro-symbolic work (26-32) as enhancements for usability in the new vision.
- Update concerns-and-vulnerabilities.md with any new risks from direction shift (e.g., increased surface for UI-driven config, pluggable memory backends).
- No code changes to runtime in this chunk (pure docs + messaging).
- Run full verification (npm test, npm run build) at end.
- Commit as separate chunk.

## Non-goals for this chunk
- Full implementation of remaining cloud-capable items (BYOK discovery, E2B, TiDB wiring, etc.) — those come after in subsequent chunks aligned to the .kiro spec, adapted for UI-configurability and non-rigid design.
- Changes to actual persistence/memory provider interfaces (those will be planned in follow-on chunks to support UI config for Mem0/TiDB/local/etc.).
- UI work itself.

## Detailed Inventory of Stale Docs (as of inspection)

**Critical / High Impact (directly mislead agents and new contributors):**
1. **AGENTS.md (and duplicate Agents.md at root)** 
   - "Target first public release: `v0.1.0-alpha` local developer preview, not production SaaS."
   - "local/provider-free mode must remain default."
   - "Active Development Goal": "continuing Alpha Build development... local/provider-free mode must remain default."
   - "Next Chunks Needed for v0.1.0-alpha": only lists local hardening.
   - "v0.1.0-alpha — local developer preview" section.
   - Source of truth still points heavily to old 0.1.0-alpha docs.
   - **Proposed edit**: Rewrite vision section to new cloud-capable VPS product goal. Keep strong "local is mandatory perfect regression baseline and contributor default" language. Update "Current Implemented Chunks" to include 26-32. Point "Source of Truth" to cloud-capable-transition spec + updated architecture. Add note on UI-configurable pluggable providers (memory DBs like local/Mem0/TiDB).

2. **README.md (root)**
   - "Alpha status: This is a local developer preview. The full pipeline runs end-to-end on deterministic fake/local adapters..."
   - "the alpha runs fully on fake/local adapters"
   - Tech stack and non-goals section locked to alpha prototype.
   - **Proposed edit**: Update status and intro to "cloud-capable system with strong local baseline". Emphasize hassle-free UI configuration for providers and memory backends. Keep "local mode is always available and identical for tests/contributors". Update "What Is Rector?" to highlight configurable, VPS-deployable nature.

3. **docs/README.md**
   - "current source-of-truth documents for Rector 0.1.0-alpha work."
   - Prioritizes provider-free-quickstart and old alpha docs.
   - "Removed stale docs" section claims cleanup but alpha framing persists.
   - **Proposed edit**: Rephrase to current cloud-capable direction. List cloud-capable-transition and updated architecture first. Keep provider-free quickstart as "for local development and contributors". Add section on UI-driven configuration.

4. **docs/plans/rector-master-roadmap.md**
   - Heavy emphasis on "Provider-free local demo mode" as required baseline for open-source.
   - Chunk descriptions and "Why This Order" tied to alpha prototype.
   - "First Chunk to Plan Next" still points to old Chunk 0.
   - **Proposed edit**: Update goal and required baseline to "hassle-free cloud-capable product with local as regression baseline". Note that pluggable UI-configurable providers (including memory) are now part of the vision. Mark historical chunks 0-25 as completed foundation. Add note on neuro-symbolic 26-32. Reference .kiro cloud-capable spec for active work.

5. **docs/architecture/rector-0.1.0-architecture.md**
   - Title and content locked to "0.1.0 Prototype Definition", "v0.1.0-alpha brainstem", "local developer preview".
   - Scaling path section 12.1 "0.1.x: Brainstem".
   - **Proposed edit**: Add prominent "Historical - see current-rector-byok-architecture.md and cloud-capable-transition for active direction" banner at top. Or move to a "historical/" subdir with banner. Update key sections to note the evolution to cloud-capable.

**Medium Impact (still mislead but less central):**
6. **docs/getting-started/provider-free-quickstart.md** — Keep as-is for contributors, but de-prioritize in indexes. Add sibling "cloud-deployment-quickstart.md" later.
7. **docs/deployment/prototype.md** — Rename or banner as "Historical Deployment Prototype notes for v0.1.0-alpha". Update title and intro.
8. **docs/deployment/desktop-shell-decision.md** — Similar historical banner; content assumes local-first.
9. **.env.example** — Update comments: emphasize that UI config (providers.json + secrets.enc) is preferred for hassle-free use; local mode ignores them. Note pluggable memory options.
10. **docs/contributing/adapters.md**, **docs/extensions/public-contracts.md** — Add notes that contracts now support pluggable UI-configured backends (memory, etc.).
11. **docs/plans/concerns-and-vulnerabilities.md** — Has many "alpha brainstem", "local alpha" references in open items. Update language to reflect current status; keep historical accuracy where needed.
12. **docs/issues/roadmap-issues.json** and generated/ + scripts/ — These are historical for 0-25. Add header "Historical v0.1.0-alpha issue catalog. Current work tracked in .kiro/specs/cloud-capable-transition/ and new chunks."
13. **audits/** and old .kiro/specs/byok-alpha-* — Add banners or move to "historical/" if possible.
14. **CONTRIBUTING.md** — Minor: "preserve provider-free local development" is still true, but soften to "local remains fully supported regression baseline".

**Low Impact / Historical (keep with banners):**
- Old chunk plans in docs/plans/chunks/ (0-25 and even 26-32 can stay as history).
- Many internal comments in code referring to "alpha" or "brainstem" (update only the most visible ones; code comments can evolve with implementation chunks).

## Proposed Process for This Chunk
1. Create this plan (done).
2. Produce full inventory in response + here.
3. Update highest-impact files first (AGENTS.md, README.md, docs/README.md, master-roadmap, architecture doc) with banners + vision-aligned text.
4. Update supporting files (.env.example, contributing, deployment docs, concerns).
5. Update scripts/issues where practical (or add deprecation notes).
6. Add a new "cloud-deployment" or "ui-configuration" quickstart skeleton if time.
7. Run `npm test && npm run build`.
8. Commit as Chunk 33.
9. Update concerns-and-vulnerabilities.md with any doc-related risks (e.g., contributor confusion during transition).

## Acceptance Criteria
- All high-impact files have clear updated language or banners pointing to new vision + .kiro/cloud-capable spec.
- AGENTS.md now guides toward cloud-capable hassle-free product with UI-configurable providers (incl. memory DBs: local/Mem0/TiDB/etc.).
- No breaking of existing local baseline language where it is factually a regression requirement.
- Full test + build green.
- This plan + changes committed separately.

## Risks / Concerns to Track
- Over-editing historical accuracy — keep "what it was" sections where useful.
- Agent confusion during transition — banners and updated AGENTS.md mitigate.
- The neuro-symbolic chunks (26-32) should be framed as making the system more usable in the cloud/VPS context (e.g., proactive checks, memory for long-running coding sessions).
- New vision (UI-configurable memory providers) may require future architecture adjustments for pluggability — note in concerns and reference in cloud-capable spec.

## References
- .kiro/specs/cloud-capable-transition/ (requirements, design, tasks)
- Previous neuro-symbolic work (chunks 26-32)
- User's direction: hassle-free, web-UI configuration for memory providers (local, Mem0, TiDB cloud), non-rigid architecture.

Next chunks after this will execute the adapted cloud-capable-transition (BYOK, real sandbox, persistence, UI config surfaces, etc.), incorporating the configurable memory provider idea.

## Verification
```bash
npm test
npm run build
```
