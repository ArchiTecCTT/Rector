# Phase 2 — Typed Fact Protocol — Completion Report

**Repository:** `ArchiTecCTT/Rector`  
**Integration target:** `rector-0.3.0` / `origin/rector-0.3.0`  
**Evidence worktree:** `phase-2G-docs-completion`  
**Gate commit (post Phase 2F merge):** `45768e5`  
**Completion label:** `phase2-complete-live-verified-zai-finalist` (Z.ai single-model `verify:zai-live` gate PASS documented for `glm-4-32b-0414-128k` @ 2026-07-01 post `75f4233` and **`glm-5v-turbo`** @ 2026-07-01 post `ff65580`–`07abf93`; Regolo and other models remain live-unverified)
**Report date:** 2026-06-28 (live finalist gate documented 2026-07-01)
**Live-test conclusion report:** `docs/reports/live-testing/zai-live-verification-conclusion-2026-07-01.md` (`.pdf` colocated)

---

## Summary

Phase 2 delivered the typed fact protocol substrate: strict Zod fact contracts, append-only ledgers with replay/diff, adapters from Cartographer / ToolRegistry / capability evals / global harness / run events, structural validation gates, offline fact evals with JSON/Markdown reports, and an opt-in live shadow runner with honest skipped evidence plus nonzero live-verification exit behavior when no live provider is available.

**Offline CI gates passed** at `45768e5` and remain green on `zai-evidence-live-integration` (`npm test` **416** files / **2878** tests after `glm-5v-turbo` verify slice). **Live-model verification (scoped):** official `verify:zai-live` PASS for **`glm-4-32b-0414-128k`** (harness hardening `75f4233`) and **`glm-5v-turbo`** (fact-shadow + provider smoke hardening `ff65580`–`07abf93` — shadow 5/5 with 4 first / 1 repair pass, provider smoke `first_pass`, harness 3/3, **43,911** tokens, manifest updated). Do **not** extrapolate to all Z.ai GLM variants, v2 shadow tables, or Regolo. Broader label `phase2-complete-live-verified` applies only when operator policy extends beyond documented per-model gate PASSes.

Configured-product invariants remain: product chat is gated on UI-written `runtime-settings.json` and `runOrchestratedChatRun`; deterministic doubles (`FakeLLMProvider`, spy/simulator seams) are **test/CI-only**, not end-user defaults.

---

## Pull requests and merge sequence

| PR | Branch | Scope | Status |
|----|--------|-------|--------|
| [#21](https://github.com/ArchiTecCTT/Rector/pull/21) | `phase-2A-fact-contracts` | Fact contracts, IDs, provenance, trust, scope | Merged |
| [#22](https://github.com/ArchiTecCTT/Rector/pull/22) | `phase-2B-fact-ledger` | Ledger, replay, diff | Merged |
| [#23](https://github.com/ArchiTecCTT/Rector/pull/23) | `phase-2C-fact-adapters` | Cartographer, ToolRegistry, capability eval, global harness, run-event adapters | Merged |
| [#24](https://github.com/ArchiTecCTT/Rector/pull/24) | `phase-2D-fact-validation` | Validation gates and security tests | Merged |
| [#25](https://github.com/ArchiTecCTT/Rector/pull/25) | `phase-2E-fact-evals` | Offline fact evals, reports, global harness integration | Merged (tip included `036ed6c` CI fallout fix) |
| [#26](https://github.com/ArchiTecCTT/Rector/pull/26) | `phase-2F-live-shadow` | Live shadow runner and contract tests | Merged (tip included `3f7a29b` review feedback); integration HEAD `45768e5` |
| (pending) | `phase-2G-docs-completion` | This completion report and doc sync | In progress (parent commit after verify) |

Plan reference: `docs/plans/2-0/phases/phase-2-typed-facts.md`.

---

## Implemented modules

### Core (`src/facts/`)

| Module | Role |
|--------|------|
| `schemas.ts`, `types.ts` | Discriminated fact kinds and exported types |
| `ids.ts` | Deterministic `factId` helpers |
| `provenance.ts`, `trust.ts`, `scope.ts` | Provenance, trust ladder, workspace scope |
| `ledger.ts` | `FactLedger`, `InMemoryFactLedger`, `JsonlFactLedger` |
| `replay.ts`, `diff.ts` | Run replay and fact-run diff |
| `validation.ts` | Schema, provenance, grounding, scope, redaction, trust-transition gates |
| `index.ts` | Stable public exports |

### Adapters (`src/facts/adapters/`)

| Adapter | Sources |
|---------|---------|
| `cartographerFacts.ts` | Graph snapshots, nodes/edges, query results |
| `toolFacts.ts` | Tool definitions, results, handler events |
| `capabilityEvalFacts.ts` | Capability eval cases/results and artifact refs |
| `globalHarnessFacts.ts` | Global scenarios, scorecards, traces |
| `runEventFacts.ts` | Run events and phase artifacts |

### Reports (`src/facts/reports/`)

| Module | Role |
|--------|------|
| `factReport.ts`, `markdown.ts` | Offline eval report builders |
| `safety.ts` | Report redaction/safety helpers (added during implementation) |

### Scripts (`scripts/facts/`)

| Script | npm script |
|--------|------------|
| `run-fact-evals.ts` | `npm run eval:facts` |
| `run-live-fact-shadow.ts` | `npm run eval:facts:live` (`LIVE_FACT_EVALS=1`; bounded strict JSON repair + v2 report @ `a282128`) |
| `replay-facts.ts` | `npm run facts:replay` |
| `validate-phase2.ts` | Standalone validator (not wired into `verify:phase2` chain) |

### Tests (`tests/facts/`)

17+ test files covering schemas, IDs, provenance, scope, property invariants, ledger/replay/diff, all adapters (including `adapters.runEvent.test.ts`), validation, security, offline evals (`evals.test.ts`), live shadow contracts (`liveShadow.contract.test.ts`, `liveFactShadowClassification.test.ts`), and orchestration strict JSON (`strictOutputDiagnostics`, `strictJsonRepairLoop`, `strictJsonRepairCards`).

### Orchestration strict JSON (cross-cutting, `zai-evidence-live-integration` @ `472eefe`–`a282128`)

| Module | Role |
|--------|------|
| `src/orchestration/strictOutputDiagnostics.ts` | Normalize JSON syntax / schema / semantic / provenance-grounding-scope-redaction / truncation / provider-runtime diagnostics |
| `src/orchestration/strictJsonRepairLoop.ts` | Bounded two-attempt repair; `first_pass` / `repair_pass` / `failed_after_repair`; blocks `deterministic_fallback` as live pass |
| `src/orchestration/strictJsonRepairCards.ts` | Compiler-style repair cards for planner (and shadow) repair prompts |
| `src/orchestration/planner.ts` | Repair loop integration; safe `PLANNER_INVALID` diagnostic projection; `strictJsonEvidenceStatus` |
| `src/facts/reports/liveFactShadowReport.ts` | v2 report/summary schema with classification rollups |
| `src/facts/reports/liveFactShadowClassification.ts` | Aggregate pass classification and failure categories for shadow cases |

---

## Verification commands run (Phase 2G worktree, `45768e5`)

| Command | Result | Notes |
|---------|--------|-------|
| `npm run baseline:phase0` | Pass | Wrote `.rector/evidence/phase0/phase0-baseline.json`, `.rector/evidence/phase0/phase0-baseline.md` (legacy `.omo/evidence` retained for history) |
| `npm run verify:phase2` | Pass | `check` + full `npm test` + `eval:facts` + `test:global` + `test:systems` |
| `npm run check` | Pass | Part of `verify:phase2` |
| `npm test` | Pass | 386 files passed / 1 skipped; 2642 tests passed / 5 skipped |
| `npm run eval:facts` | Pass | 10/10 cases, all metrics passed |
| `npm run test:global` | Pass (exit 0) | 33 scenarios executed; 19/33 passed per scenario expectation in report; mixed corpus by design |
| `npm run test:systems` | Pass | 1/1 specialist profiles valid |
| `npm run eval:facts:live` | Historical skipped evidence; current live script exits nonzero without a live provider | No live provider; see live section below |
| `npm run build` | Pass | |
| `npm audit` | Pass | 0 vulnerabilities |
| `npm run audit:no-fakes` | Exit 0, report-only | 20 allowlisted fake/simulator seams (AST scan), 0 unallowed findings after Z.ai hardening |
| `npm run audit:no-fakes:check` | Exit 0, strict | Same scan with `--fail-on-unallowed` (AST detectors); pre-merge / hardening verification, not default CI |

Primary Phase 2 gate for ongoing CI: `npm run verify:phase2`.

### Strict JSON repair slice — offline verification (`a282128`, 2026-07-01)

| Command | Result | Notes |
|---------|--------|-------|
| `npm run check` | Pass | |
| Targeted strict-json / planner / live-shadow tests | Pass | Per parent verify |
| `npm run eval:facts` | Pass | 10/10 |
| `npm run build` | Pass | |
| `npm run audit:no-fakes:check` | Pass | 0 unallowed |
| `npm audit` | Pass | 0 vulnerabilities |
| `npm test` | Pass | 416 files passed / 1 skipped; 2878 tests passed / 5 skipped (post `glm-5v-turbo` verify slice) |
| `npm run evidence:verify-paths` | Pass | |
| `RECTOR_LIVE_PROVIDER=zai ZAI_MODEL=glm-4-32b-0414-128k npm run eval:facts:live` | Pass (v2 shadow, discovery) | 5/5, `firstPassCases` 5, `repairPassCases` 0, `failedAfterRepairCases` 0, `live_provider`, schema v2; ~2613 tokens — **not** a substitute for full `verify:zai-live` |
| Broad v2 shadow reruns (other Z.ai models) | Discovery only | Summaries under `/tmp/rector-zai-v2-fact-shadow` + gitignored `.rector/evidence`; see `docs/operations/zai-live-verification.md` § v2 live fact-shadow reruns |
| `RECTOR_LIVE_PROVIDER=zai ZAI_MODEL=glm-5v-turbo npm run verify:zai-live` | Pass | Full chain @ 2026-07-01; gate PASS, `live_provider`, manifest updated; post-gate `build`, `audit:no-fakes:check`, `evidence:verify-paths` pass |

---

## Evidence artifact paths

| Artifact | Path | Status |
|----------|------|--------|
| Offline fact eval (JSON) | `.rector/evidence/phase2/fact-report.json` | Written by `npm run eval:facts` |
| Offline fact eval (Markdown) | `.rector/evidence/phase2/fact-report.md` | Written by `npm run eval:facts` |
| Live shadow (JSON) | `.rector/evidence/phase2/live-fact-shadow-report.json` | Schema `rector.live-fact-shadow-report.v2` when regenerated; gate VM / old runs may lack v2 rollups |
| Live shadow (Markdown) | `.rector/evidence/phase2/live-fact-shadow-report.md` | May be absent when skipped; JSON is authoritative |
| Phase 0 baseline | `.rector/evidence/phase0/phase0-baseline.json` / `.md` | Refreshed during gate run |
| Global harness | `.rector/evidence/global/global-report.json` / `.md` | Refreshed during `verify:phase2` |

Legacy flat paths under `.omo/evidence/` remain for historical gate runs; new output uses `.rector/evidence` per track layout.

### Live shadow — gate VM skip vs Z.ai finalist (2026-07-01)

The **Phase 2G gate VM** historical run recorded skipped live evidence (`status: skipped`, no configured non-fake provider). That does **not** override the **documented finalist** campaign on `zai-evidence-live-integration`:

- **Official gate PASS (per model):** `glm-4-32b-0414-128k`; **`glm-5v-turbo`** (2026-07-01, commits `ff65580`–`07abf93`).
- **Other Z.ai models:** Discovery matrix **0/9** early full-chain passes; **`glm-4.6v-flashx`** still **4/5** shadow (`test_log_diagnosis` ref `stdout:2` after Slice B); **`glm-5-turbo`** 4/5 with repair uplift. Not live-verified without full `verify:zai-live` PASS.
- **Regolo:** No single-model gate PASS; `gemma4-31b` deepest runner (provider smoke pass, harness timeout @ 300s) — see `docs/operations/regolo-live-verification.md`.

Live scripts exit nonzero on skipped/failed evidence. **Strict JSON repair + v2 shadow taxonomy:** live-measured @ 2026-07-01 on Z.ai (see ops doc). Validators not relaxed. **Next operator step:** close shadow failures on `glm-4.6v-flashx` / `glm-5-turbo`, then per-model `verify:zai-live`.

---

## Known limitations

1. **Live scoped to per-model gate PASS** — **Official** live verification is documented for **`glm-4-32b-0414-128k`** and **`glm-5v-turbo`** only (`verify:zai-live` @ 2026-07-01). Other providers/models and partial shadow runs are not generalized live claims. Harness smoke integrity fixed `d86d679` — pre-fix pass-with-zero-usage reports are untrusted.
2. **Global harness mixed corpus** — `test:global` exits 0 while reporting 19/33 scenario passes; intentional regressions and fake-path rows remain in the committed scenario set.
3. **Fake seams partially hardened** — `audit:no-fakes` reports 20 allowlisted findings and 0 unallowed findings; `audit:no-fakes:check` enforces zero new unallowed seams; full extraction of test doubles/simulator compatibility remains Phase 3 / Phase 13 fake-purge policy.
4. **No product wiring** — Facts are not yet consumed by chat orchestration, Memory OS, rules, or DAG execution; adapters ingest existing surfaces only.
5. **`validate-phase2.ts`** — Exists as a helper script; the documented gate is `verify:phase2` (does not invoke `validate-phase2.ts` as a separate step).

---

## Explicit not-built (deferred by design)

Per `phase-2-typed-facts.md` boundaries, Phase 2 did **not** implement:

- Durable Memory OS / MemoryGate promotion (Phase 2.1 / 2.2)
- Capability Contract Generator runtime (Phase 2.4)
- Capability-SLM Fabric manager (Phase 2.5)
- Rule engine / Crucible hard gates (Phase 3)
- Planner/skeptic ensembles as authoritative orchestration
- Validation-aware DAG executor integration (Phase 5)
- Safe transformation engine / healing loop production paths
- ExecutiveRouter / production specialist execution (Phase 11/12)
- Autonomous multi-agent chat layer
- Production dependence on live providers for CI or default installs

Proposal fact kinds (`PlanCandidateFact`, `MemoryPatchCandidateFact`, etc.) may exist as contracts for later phases but are **not** execution authority in Phase 2.

---

## Handoff to next phases

### Phase 2.1 / 2.2 — Memory OS

- Consume `MemoryPatchCandidateFact` and validation-linked facts only.
- Store raw artifacts separately from semantic/core memory; never promote from live shadow or unvalidated LLM prose.

### Phase 2.4 — Capability Contract Generator

- Emit capability contract facts from `ToolDefinitionFact` and `CapabilityGraphContextFact`.
- Admit contracts only after eval + provenance gates (reuse Phase 2 validators).

### Phase 2.5 — Capability-SLM Fabric

- Route SLM outputs through `CapabilityEvidenceFact` / `CapabilityCoverageFact` / `CapabilityFailureFact` and `RawArtifactFact`.
- Cheap-model compression must not bypass fact validation; live efficiency thresholds remain separate from Phase 2 offline gates.

### Phase 3 — Rule engine / Crucible

- Rules consume facts, not free-form chat; gate decisions cite source facts and derivations.

### Configured product (parallel track)

- Continue v0.3.0 onboarding gate, `runOrchestratedChatRun` consolidation, and spy-only CI per `docs/architecture/configured-product-architecture.md`.

### Z.ai live evidence harness (parallel track, branch `zai-evidence-live-integration`)

- `.rector/evidence` path module, Z.ai provider/harness smoke writers, live evidence gate, opt-in matrix (per-model snapshots, optional probe pre-filter), harness/provider diagnostics, and smoke integrity (`liveHarnessIntegrity.ts`, `d86d679`) are implemented (plan: `docs/plans/2-0/live/zai-evidence-directory-and-live-harness-plan.md`; operator steps: `docs/operations/zai-live-verification.md`).
- **Discovery matrix (2026-07-01):** 0/9 official full-chain passes — first-pass strict fact-shadow bottleneck for non-finalists; not final model impossibility.
- **Official gate PASS (2026-07-01):** `glm-4-32b-0414-128k` (post `75f4233`); **`glm-5v-turbo`** (post `ff65580`–`07abf93`, 43,911 tokens, ~$0.0392). Label: `phase2-complete-live-verified-zai-finalist`. Matrix grades and partial shadow reruns do **not** extend live-verified without per-model `verify:zai-live` PASS.
- **Strict JSON repair + v2 shadow (offline @ `a282128`, live @ 2026-07-01):** diagnostics core, bounded repair, repair cards, live-shadow v2 report; provider smoke caps and shadow prompt hardening enabled second documented gate PASS.
- **Documentation policy:** Material findings from live campaigns must be recorded in ops docs and this register before completion claims (`4b1be28` / `AGENTS.md`).

---

## Plan deviations

Material differences from the written plan are recorded in **Deviation ledger** at the end of `docs/plans/2-0/phases/phase-2-typed-facts.md` (Phase 2G).

---

## Sign-off criteria met (offline)

```text
[x] Fact contracts exported via src/facts/index.ts
[x] Append-only replayable ledger (memory + JSONL)
[x] Adapters for Cartographer, tools, capability evals, global harness, run events
[x] Validation gates and security tests
[x] Offline fact eval reports (JSON + Markdown)
[x] verify:phase2 passes
[x] Live shadow runner with honest skipped evidence and nonzero live-verification exit when no provider
[ ] phase2-complete-live-verified (requires real-provider shadow capture)
```