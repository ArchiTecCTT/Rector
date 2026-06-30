# Phase 2 — Typed Fact Protocol — Completion Report

**Repository:** `ArchiTecCTT/Rector`  
**Integration target:** `rector-0.3.0` / `origin/rector-0.3.0`  
**Evidence worktree:** `phase-2G-docs-completion`  
**Gate commit (post Phase 2F merge):** `45768e5`  
**Completion label:** `phase2-offline-complete-live-unverified`  
**Report date:** 2026-06-28  

---

## Summary

Phase 2 delivered the typed fact protocol substrate: strict Zod fact contracts, append-only ledgers with replay/diff, adapters from Cartographer / ToolRegistry / capability evals / global harness / run events, structural validation gates, offline fact evals with JSON/Markdown reports, and an opt-in live shadow runner with honest skip reporting.

**Offline CI gates passed** on this worktree at `45768e5`. **Live-model shadow capture did not run** — no configured non-fake live provider was available on the dev VM. Do **not** use this completion state for investor/demo claims about live-model fact reliability; use `phase2-complete-live-verified` only after a real-provider shadow report is captured.

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
| `run-live-fact-shadow.ts` | `npm run eval:facts:live` (`LIVE_FACT_EVALS=1`) |
| `replay-facts.ts` | `npm run facts:replay` |
| `validate-phase2.ts` | Standalone validator (not wired into `verify:phase2` chain) |

### Tests (`tests/facts/`)

17 test files covering schemas, IDs, provenance, scope, property invariants, ledger/replay/diff, all adapters (including `adapters.runEvent.test.ts`), validation, security, offline evals (`evals.test.ts`), and live shadow contracts (`liveShadow.contract.test.ts`).

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
| `npm run eval:facts:live` | Pass (honest skip) | No live provider; see live section below |
| `npm run build` | Pass | |
| `npm audit` | Pass | 0 vulnerabilities |
| `npm run audit:no-fakes` | Exit 0, report-only | 40 existing fake/simulator seams (policy deferral, not Phase 2 regression) |

Primary Phase 2 gate for ongoing CI: `npm run verify:phase2`.

---

## Evidence artifact paths

| Artifact | Path | Status |
|----------|------|--------|
| Offline fact eval (JSON) | `.rector/evidence/phase2/fact-report.json` | Written by `npm run eval:facts` |
| Offline fact eval (Markdown) | `.rector/evidence/phase2/fact-report.md` | Written by `npm run eval:facts` |
| Live shadow (JSON) | `.rector/evidence/phase2/live-fact-shadow-report.json` | Written with **skipped** status (live unverified) |
| Live shadow (Markdown) | `.rector/evidence/phase2/live-fact-shadow-report.md` | May be absent when skipped; JSON is authoritative |
| Phase 0 baseline | `.rector/evidence/phase0/phase0-baseline.json` / `.md` | Refreshed during gate run |
| Global harness | `.rector/evidence/global/global-report.json` / `.md` | Refreshed during `verify:phase2` |

Legacy flat paths under `.omo/evidence/` remain for historical gate runs; new output uses `.rector/evidence` per track layout.

### Live shadow skip (explicit)

`npm run eval:facts:live` completed successfully but recorded:

- **status:** `skipped`
- **liveEvidenceStatus:** `skipped`
- **skippedReason:** `No configured non-fake live provider was available; wrote skipped report instead.`

Follow-up: configure a non-fake provider via the web UI (`runtime-settings.json`), set `LIVE_FACT_EVALS=1`, re-run `npm run eval:facts:live`, and only then promote completion label to `phase2-complete-live-verified`.

---

## Known limitations

1. **Live unverified** — No real-model shadow cases executed on this VM; schema/provenance stress under live LLM output is not evidenced here.
2. **Global harness mixed corpus** — `test:global` exits 0 while reporting 19/33 scenario passes; intentional regressions and fake-path rows remain in the committed scenario set.
3. **Fake seams unchanged** — `audit:no-fakes` still reports 40 findings; report-only until Phase 3 / Phase 13 fake-purge policy.
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
[x] Live shadow runner with honest skip when no provider
[ ] phase2-complete-live-verified (requires real-provider shadow capture)
```