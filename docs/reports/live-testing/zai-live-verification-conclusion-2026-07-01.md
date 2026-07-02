# Z.ai Live Verification Campaign — Conclusion Report

---

## Title Page Metadata

| Field | Value |
| --- | --- |
| **Document title** | Z.ai Live Verification Campaign — Conclusion Report |
| **Report date** | 2026-07-01 |
| **Repository** | ArchiTecCTT/Rector (Apache-2.0) |
| **Integration branch** | `zai-evidence-live-integration` |
| **Worktree path** | `/home/ornyx-opifex/projects/rector/.worktrees/zai-evidence-integration` |
| **Merge anchor commit** | `5da5c25065f9288cd456e0f08ae58ca4c717722e` — *merge: integrate zai live evidence gate* |
| **Latest documented HEAD** | `e34ea803f0c4ec4d78b0adcfc98bb1d4ec480a47` — *docs: sync Z.ai glm-5v-turbo verify:zai-live gate PASS and operator knobs* |
| **Prepared for** | Rector engineering leadership and Z.ai partner / technical discussion |
| **Primary operator runbook** | `docs/operations/zai-live-verification.md` |
| **Phase 2 completion reference** | `docs/plans/2-0/phases/phase-2-completion-report.md` |

### Confidentiality and evidence hygiene

This report is intended for professional sharing (including PDF export). It contains **sanitized summaries only**:

- No API keys, bearer tokens, or credential env values.
- No full redacted prompt/response dumps from live runs.
- No committed copies of `.rector/evidence/**` (that tree is **gitignored** by design).

Representative JSON excerpts in §8 (Representative Sanitized Snippets) are **illustrative reconstructions** aligned with documented pass/fail outcomes and Rector schema contracts. They are **not** verbatim copies of on-disk evidence files. Operators with credentials may regenerate authoritative artifacts locally via `npm run verify:zai-live`.

---

## 1. Executive Summary

On **2026-07-01**, the Rector project completed an intensive **live verification campaign** against Z.ai’s OpenAI-compatible API. The campaign’s purpose was not marketing smoke: it was to prove, with durable (local) evidence and strict gates, that real GLM models can survive Rector’s **typed-fact protocol**, **provider smoke**, and **orchestrated chat harness** without relaxing validators or substituting spy/fake doubles.

### Headline outcomes

| Claim class | Result |
| --- | --- |
| **Official single-model gate PASS** | **Two** models documented: `glm-4-32b-0414-128k` and `glm-5v-turbo` |
| **First foundation discovery matrix** | **0 / 9** full-chain passes (comparison only; not official verification) |
| **Offline CI substrate** | `npm run verify:phase2` green; post-campaign `npm test`: **416** files passed / **1** skipped; **2878** tests passed / **5** skipped |
| **Fake-seam containment** | `npm run audit:no-fakes:check`: **0** unallowed production seams (20 allowlisted compatibility seams) |
| **Regolo parallel track** | **Unverified** — no `verify:regolo-live` gate PASS |

### Why two models matter

Rector treats **live-verified** as a **per-model** property. A matrix row graded “B” or a fact-shadow rerun at 4/5 does **not** upgrade product or phase labels. Only a full `npm run verify:zai-live` chain that ends in `npm run evidence:zai-live:gate` **PASS** with `liveEvidenceStatus: live_provider` may update `.rector/evidence/manifest.json` and support external live claims for that specific `ZAI_MODEL`.

### Investment thesis for partners

The campaign demonstrated that **prompt engineering, strict JSON contracts, bounded repair loops, and harness operator knobs** were sufficient to bring **two** GLM variants over a high bar. It also demonstrated—honestly—that **most** candidate GLM SKUs in a broad matrix still fail on strict typed-fact shadow, truncation, grounding refs, or `provider_runtime` at discovery budgets. That gap motivates **fine-tuning or distillation on Rector traces** rather than weakening gates for demo labels.

---

## 2. Verification Thesis

### 2.1 Why strict live verification matters

Rector is a **configured orchestration** product: chat is gated until UI-written `runtime-settings.json` proves readiness, and the authoritative path is `runOrchestratedChatRun`. Deterministic doubles (`SpyLLMProvider`, simulators, injected runners) exist for **CI and unit tests only**. Letting those doubles stand in for live providers would:

1. **False-positive** investor or partner claims (“we verified on Z.ai” while CI never called the network).
2. **Hide** schema/provenance failures that only appear under real model stochasticity.
3. **Undermine** Phase 2’s typed-fact substrate, which is meant to feed Memory OS, rules, and capability fabric in later phases.

Strict live verification therefore enforces:

- Real provider discovery from configured credentials (env or UI settings).
- Evidence writers that **exit nonzero** unless they record `live_provider` success.
- A gate that rejects fake/spy/mock providers, traversal in manifest pointers, disagreeing summary/report fields, secret-like substrings, and harness scenarios that mutated source when they must remain read-only / plan-only / safety-refusal.
- Per-campaign budgets: **≤ 100,000 tokens** and **≤ 20 model calls** (operator hard limit unless manually approved).

### 2.2 Official gate vs matrix vs shadow vs smoke

| Surface | Command / entry | Updates manifest? | What it proves |
| --- | --- | --- | --- |
| **Official gate (single model)** | `npm run verify:zai-live` | **Yes** on PASS | Full chain: offline Phase 2 + live fact shadow + provider smoke + harness smoke + gate |
| **Multi-model matrix** | `npm run verify:zai-live:matrix` | **No** (`--no-manifest-update` on gate) | Discovery/comparison across `ZAI_MODELS`; per-model snapshots under `.rector/evidence/live/zai/matrix/` |
| **Live fact shadow only** | `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` | No | Typed facts under real model output (5 cases); v2 report with repair classification |
| **Provider smoke only** | `npm run test:live:zai:provider` | No | Minimal JSON contract + `live_provider` usage accounting |
| **Harness smoke only** | `npm run test:live:zai:harness` | No | Scenarios B1/B2/B3 through planner → skeptic → crucible → synthesis path |

**Rule for external communication:** Say **“officially live-verified (per model)”** only with a documented `verify:zai-live` PASS. Say **“discovery grade”** for matrix/v2 shadow/partial reruns.

### 2.3 What Track A vs Track B prove

From the live harness plan (`docs/plans/2-0/live/zai-evidence-directory-and-live-harness-plan.md`):

- **Track A (Phase 2F live shadow):** Can a live GLM produce typed facts that survive schema, provenance, grounding, scope, redaction, and trust-transition checks?
- **Track B (harness smoke):** Can Rector’s orchestration stack (routing, planning, skeptic, crucible, synthesis, run events, cost accounting) operate on real prompts without forbidden mutations?

Neither track alone is sufficient for the official label; the gate requires both plus provider smoke and offline `verify:phase2`.

---

## 3. Chronological Timeline

Timeline anchor: merge commit **`5da5c25065f9288cd456e0f08ae58ca4c717722e`** (2026-06-30 19:03:55 +0800) through **`e34ea803f0c4ec4d78b0adcfc98bb1d4ec480a47`** (2026-07-01 21:35:27 +0800).

Sequence verified via:

```bash
git log --reverse --format='%H%x09%ci%x09%s' 5da5c25065f9288cd456e0f08ae58ca4c717722e^..HEAD
```

**Note:** Commits `8fd1066` and `a7ba4b1` (2026-06-30) immediately **precede** the merge and landed the initial Z.ai evidence gate scripts; they are referenced in §7 as pre-merge foundation but are **outside** the post-merge table per scoping instructions.

### 3.1 Post-merge commit ledger (chronological)

| # | Commit (short) | Timestamp (+0800) | Subject | Contribution |
| --- | --- | --- | --- | --- |
| 1 | `5da5c250` | 2026-06-30 19:03:55 | merge: integrate zai live evidence gate | Integrates Ticket 6 evidence gate + verify chain onto integration branch |
| 2 | `9ff52b58` | 2026-06-30 19:22:07 | fix(zai-live): harden gate, wire configured discovery, update evidence paths | Gate hardening; configured provider discovery; `.rector/evidence` path alignment |
| 3 | `dc29146c` | 2026-06-30 19:23:30 | fix(live): address Qodana high findings in Z.ai evidence paths | Static analysis cleanup on live evidence modules |
| 4 | `93211163` | 2026-06-30 19:31:12 | fix(live): clear remaining Qodana NEW findings | Import/null-guard/dedupe fixes |
| 5 | `2e9364d4` | 2026-06-30 19:37:51 | docs(zai-live): sync implementation status; live remains unverified | Honest doc state: infrastructure ready, live unverified |
| 6 | `26abc227` | 2026-06-30 19:39:19 | docs(zai-live): align live plan exit gates | Plan/gate alignment in docs |
| 7 | `6e31e102` | 2026-06-30 21:40:12 | feat(zai): harden live evidence and fake-system quarantine | Evidence directory hardening; fake-system quarantine wave |
| 8 | `a24f32b6` | 2026-07-01 11:11:53 | feat(zai): isolate matrix evidence snapshots and probe pre-filter | Per-model matrix snapshots; optional callable-model pre-filter |
| 9 | `82f717c8` | 2026-07-01 11:15:11 | feat(zai): add live harness diagnostics taxonomy and latency stats | `rector.zai-live-diagnostics.v1` taxonomy + latency rollups |
| 10 | `2345ab1d` | 2026-07-01 11:18:09 | feat(audit): add strict no-fakes gate and AST detectors | `audit:no-fakes:check` strict mode + AST scanning |
| 11 | `350d49de` | 2026-07-01 11:20:52 | chore(zai): clarify matrix campaign ratings and token rollups | Matrix summary grading clarity |
| 12 | `dcd55aa3` | 2026-07-01 11:22:25 | docs(zai): sync hardened live verification workflow | Operator workflow sync |
| 13 | `04800fb9` | 2026-07-01 11:31:47 | chore: resolve qodana cleanup findings | Qodana resolution |
| 14 | `ce6fffe1` | 2026-07-01 12:53:58 | docs(zai): record first live foundation discovery run | Documents matrix 0/9 discovery (2026-07-01 ~04:04Z artifacts) |
| 15 | `2f569750` | 2026-07-01 13:29:16 | feat(live): add regolo provider verification track | Parallel Regolo verify/matrix/gate (out of scope for Z.ai PASS claims) |
| 16 | `8900aa16` | 2026-07-01 13:49:49 | fix(live): Regolo matrix artifact hygiene with shared credential env filter | Env-name hygiene in matrix summaries |
| 17 | `f3a58b50` | 2026-07-01 14:08:16 | fix(live-matrix): allowlist step env keys and isolate per-model snapshots | Allowlisted repro env keys; snapshot isolation |
| 18 | `96e377cf` | 2026-07-01 14:33:10 | docs(regolo): record first live foundation discovery run | Regolo discovery documentation |
| 19 | `3a82cd67` | 2026-07-01 14:40:54 | fix(live): harden matrix snapshot pointers and workspace hygiene | Pointer validation; workspace hygiene |
| 20 | `44382052` | 2026-07-01 15:06:39 | feat(live-harness): propagate structured-role output caps (Slice B) | Planner/skeptic/synth/repair max output token caps in live harness |
| 21 | `acca43a4` | 2026-07-01 15:08:32 | feat(live-harness): provider-gated strict JSON no-thinking (Slice C) | Provider-gated minimize-reasoning for strict JSON roles |
| 22 | `7eb82778` | 2026-07-01 15:12:37 | feat(live-harness): strict JSON contract and repair cards (Slice D) | Harness strict JSON prompt cards |
| 23 | `28f380f1` | 2026-07-01 15:18:12 | feat(live-harness): diagnostics bottlenecks and runtime env override (slices E/F) | Bottleneck taxonomy; `RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` |
| 24 | `53d2f88e` | 2026-07-01 15:27:17 | fix(config): bound product maxRuntimeMs and harness repair preflight | Product runtime bounds; repair preflight |
| 25 | `75f42332` | 2026-07-01 15:47:51 | fix(live): omit scenario failure diagnostics when harness scenario passed | Diagnostics only on failure — enables clean finalist harness reports |
| 26 | `3088ed5d` | 2026-07-01 16:15:39 | docs: sync Z.ai finalist live gate and harness operator knobs | Documents **`glm-4-32b-0414-128k`** official PASS post-hardening |
| 27 | `d86d6796` | 2026-07-01 17:18:11 | fix(live-harness): fail smoke reports when provider calls fail without usage | **Smoke integrity** — blocks false pass with zero `modelCalls` |
| 28 | `4b1be285` | 2026-07-01 18:51:24 | docs: require documenting material findings | AGENTS.md policy: librarian-grade documentation mandatory |
| 29 | `3b834045` | 2026-07-01 19:18:47 | docs: record Z.ai live campaign findings and follow-ups | Campaign findings register |
| 30 | `472eefe3` | 2026-07-01 19:36:10 | feat(orchestration): add strict output diagnostics | Shared diagnostic core for JSON/schema/semantic/truncation/runtime |
| 31 | `4a3f7973` | 2026-07-01 19:40:54 | fix(planner): safe blocker diagnostics and strict JSON evidence status | Safe `PLANNER_INVALID` projection; evidence status on planner |
| 32 | `e8606398` | 2026-07-01 19:45:47 | feat(orchestration): render strict JSON repair cards from diagnostics (Slice C) | Compiler-style repair cards |
| 33 | `1ac60047` | 2026-07-01 19:47:10 | test(planner): expect structured repair cards | Test coverage for repair cards |
| 34 | `a2821286` | 2026-07-01 19:51:39 | feat(facts): Slice D live shadow report classification and bounded repair | Live fact-shadow **v2** report + bounded repair in shadow runner |
| 35 | `899807f3` | 2026-07-01 19:57:59 | docs: strict JSON repair slice and live-shadow v2 (offline verified) | Documents offline verification of repair slice |
| 36 | `52eddf6a` | 2026-07-01 20:25:26 | docs: record Z.ai v2 live fact-shadow discovery reruns | Broad v2 shadow discovery table (non-official) |
| 37 | `07abf93a` | 2026-07-01 20:59:52 | fix(facts): sharpen live shadow prompt for tsc diagnostic grouping (Slice B) | `tsc_diagnostic_grouping` prompt hardening |
| 38 | `bff0a167` | 2026-07-01 21:02:09 | feat(live): bounded strict JSON repair for Z.ai provider smoke (Slice C) | Provider smoke repair loop |
| 39 | `d04ab03e` | 2026-07-01 21:05:29 | fix(live): require ok and provider in Z.ai provider smoke JSON contract | Strict minimal smoke JSON shape |
| 40 | `138d92e5` | 2026-07-01 21:20:04 | fix(facts): harden live fact-shadow prompts and failure diagnostics | Shadow prompt/ref/failure diagnostics |
| 41 | `ff655804` | 2026-07-01 21:26:32 | fix(live): raise Z.ai provider smoke token cap and strict JSON options | Default smoke cap raised (truncation mitigation) |
| 42 | `e34ea803` | 2026-07-01 21:35:27 | docs: sync Z.ai glm-5v-turbo verify:zai-live gate PASS and operator knobs | Documents **`glm-5v-turbo`** official PASS; HEAD doc sync |

### 3.2 Campaign phases (narrative)

1. **2026-06-30 evening — Infrastructure merge and hardening**  
   Evidence gate lands; Qodana and path hardening; documentation explicitly states live remains unverified.

2. **2026-07-01 morning — Measurement hygiene**  
   Matrix snapshots, diagnostics taxonomy, strict no-fakes AST gate, first foundation matrix run recorded (**0/9** full-chain passes).

3. **2026-07-01 afternoon — Harness finalist path (`glm-4-32b-0414-128k`)**  
   Structured-role caps, strict JSON cards, bottleneck diagnostics, repair preflight, and `75f4233` diagnostics fix → first **official** `verify:zai-live` PASS for 32B finalist.

4. **2026-07-01 late afternoon — Integrity and policy**  
   `d86d679` closes false-pass smoke illusion; documentation discipline enforced.

5. **2026-07-01 evening — Strict JSON + shadow v2 + second finalist (`glm-5v-turbo`)**  
   Shared repair/diagnostics core; provider smoke contract + repair; fact-shadow prompt hardening → second **official** PASS; manifest reflects last successful gate (documented as `glm-5v-turbo`).

---

## 4. Evidence and Verified Results

### 4.1 Official verification chain (both models)

Command:

```bash
export RECTOR_LIVE_PROVIDER=zai
export ZAI_API_KEY="<redacted>"
export ZAI_BASE_URL="https://api.z.ai/api/paas/v4"
export ZAI_MODEL="<model-id>"
npm run verify:zai-live
```

Equivalent chain from `package.json`:

```text
npm run verify:phase2
&& RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live
&& npm run test:live:zai:provider
&& npm run test:live:zai:harness
&& npm run evidence:zai-live:gate
```

### 4.2 `glm-4-32b-0414-128k` — official PASS (harness track)

| Step | Outcome | Notes |
| --- | --- | --- |
| `verify:phase2` | Pass | Offline substrate at time of run |
| Live fact shadow | Pass (discovery reconfirmed) | v2: **5/5**; `firstPassCases` **5**, `repairPassCases` **0**, `failedAfterRepairCases` **0**; ~**2,613** tokens (~$0.0026) on shadow-only rerun |
| Provider smoke | Pass | `live_provider` |
| Harness smoke | Pass | **3/3** scenarios (B1, B2, B3) |
| Gate | **PASS** | **46,695** / 100,000 tokens; **~$0.0441** estimated; manifest updated |
| Enabling commits | `4438205`–`75f4233` | Harness caps, strict JSON cards, diagnostics, repair preflight |

**First foundation matrix context:** In the early matrix, this model was the only callable candidate that completed **5/5** shadow and provider smoke, but **failed harness** on orchestration schema/validation **before** harness hardening. Post-hardening single-model verify closed that gap.

### 4.3 `glm-5v-turbo` — official PASS (fact-shadow + provider smoke track)

Documented at commits `ff65580`–`07abf93` (with prerequisite harness integrity `d86d679` and strict-json slice `a282128`).

| Step | Outcome | Metrics |
| --- | --- | --- |
| `verify:phase2` | Pass | `npm test` **416** files / **1** skipped; **2878** tests / **5** skipped; `eval:facts` **10/10**; `test:global` + `test:systems` pass |
| Live fact shadow v2 | Pass | `live_provider`, **5/5** passed; `firstPassCases` **4**, `repairPassCases` **1**, `failedAfterRepairCases` **0**; **4,680** tokens, **~$0.004681** |
| Provider smoke | Pass | `live_provider`, `first_pass`, **1** attempt, **106** tokens, **~$0.000106** |
| Harness smoke | Pass | `live_provider`, **3/3** scenarios, **39,125** tokens, **~$0.039128**; no mutations, no failures |
| Gate | **PASS** | **43,911** / 100,000 tokens; **~$0.0392**; manifest updated |
| Post-gate checks | Pass | `npm run build`; `npm audit` **0** vulnerabilities; `audit:no-fakes:check` **0** unallowed; `evidence:verify-paths` |

### 4.4 Completion label

Phase 2 completion report label: **`phase2-complete-live-verified-zai-finalist`**.

Interpretation: Phase 2 offline gates passed at `45768e5`; **live** claims are **scoped** to the two documented per-model gate PASSes—not to all GLM SKUs, not to matrix grades, not to Regolo.

### 4.5 Harness scenarios (Track B)

| ID | Kind | Intent |
| --- | --- | --- |
| **B1** | `read_only_repository_inspection` | High-level repo summary; **no** file mutation |
| **B2** | `plan_only_improvement` | Plan for harness reliability; planning only |
| **B3** | `forbidden_mutation_safety` | Refuse unsafe immediate mutation; workspace unchanged |

Gate checks `expectNoSourceMutation` for all three; any unauthorized mutation fails verification.

### 4.6 Live fact-shadow cases (Track A)

Five committed scenarios in `scripts/facts/run-live-fact-shadow.ts`:

1. `intent_extraction_stress`
2. `rg_artifact_evidence_extraction` (committed `rg` fixture)
3. `test_log_diagnosis` (Vitest log fixture)
4. `tsc_diagnostic_grouping` (TypeScript diagnostic fixture)
5. `insufficient_evidence` (must honestly report insufficient evidence)

---

## 5. Intermediate Failures and Fixes

### 5.1 First foundation matrix — 0 / 9 full-chain passes

| Observation | Detail |
| --- | --- |
| Callable models | 9/10 in probe; `glm-4.6v-flash` skipped (HTTP 429 / overload) |
| JSON capability probe | Only `glm-4-32b-0414-128k` reported JSON capability **supported** in probe metadata |
| Matrix rollup | `overallStatus: fail` — **0** pass / **9** fail / **1** skipped |
| Dominant pattern | **9/9** failed **before harness** because `eval:facts:live` did not complete with zero failed cases |

**Interpretation:** First-pass strict fact-shadow bottleneck on the live wrapper—not proof that models cannot pass after bounded repair and prompt hardening. Matrix is **discovery**, not contradiction of later finalist PASSes.

### 5.2 `glm-5v-turbo` — path to PASS

| Failure | Mitigation |
| --- | --- |
| Fact-shadow `rg_artifact_evidence_extraction` **truncation** on early full verify | Shadow output token cap / strict JSON guidance (`LIVE_FACT_SHADOW_MAX_OUTPUT_TOKENS`; prompt habits) |
| Provider smoke **truncation / `json_syntax`** | Raised `RECTOR_ZAI_PROVIDER_SMOKE_MAX_OUTPUT_TOKENS`; strict JSON options (`ff65580`) |
| Smoke contract shape | Require top-level **`ok`** and **`provider`** (`d04ab03`) |
| Smoke convergence | Bounded strict JSON repair on provider smoke (`bff0a16`) |
| Shadow grounding / refs | Prompt + failure diagnostics hardening (`138d92e`); `tsc` grouping Slice B (`07abf93`) |
| Pre-fix split: shadow 5/5 but smoke **`provider_json`** | Addressed by smoke cap + repair + contract—not validator relaxation |

### 5.3 `glm-4.6v-flashx` — promising but not verified

| Stage | Result |
| --- | --- |
| Slice B `tsc` prompt (`07abf93`) | Improved `tsc_diagnostic_grouping` behavior in discovery |
| Remaining shadow failure | `test_log_diagnosis` — hallucinated grounding ref **`stdout:2`** (invalid vs fixture line refs) |
| Isolated smokes | Provider + harness smoke **passed** in some probes |
| Official status | **Not** live-verified — shadow **4/5** blocks full chain |

### 5.4 `glm-5-turbo` — 4 / 5 shadow

v2 discovery: **4/5** passed; `firstPassCases` **1**, `repairPassCases` **3**, `failedAfterRepairCases` **1**. Shows **repair uplift** but one case still fails after repair → full `verify:zai-live` does not PASS.

### 5.5 Weak flash variants and `provider_runtime`

Discovery v2 table (5 cases per model, **not** official):

| Model | Passed | first | repair | failedAfter | Notes |
| --- | --- | --- | --- | --- | --- |
| `glm-4.5-flash` | 3/5 | 2 | 1 | 2 | `provider_runtime` on 2 cases |
| `glm-4.5-air` | 3/5 | 3 | 0 | 2 | `provider_runtime` |
| `glm-4.5-airx` | 2/5 | 1 | 1 | 3 | |
| `glm-4.6v-flash` | 2/5 | 1 | 1 | 3 | `provider_runtime`; probe 429 |
| `glm-4.7-flash` | 0/5 | 0 | 0 | 5 | `provider_runtime` on all |
| `glm-4.7-flashx` | 0/5 | 0 | 0 | 5 | `provider_runtime` on all |

### 5.6 Regolo — unverified

Parallel track added `2f56975`+. Discovery **0/10** gate passes. Deepest runner `gemma4-31b`: provider smoke pass, harness **timeout** at 300s with **0** usage tokens in diagnostics—not the same failure class as Z.ai pre-hardening schema validation. **No** Regolo live-verified claims in this report.

### 5.7 Smoke integrity bug (pre-`d86d679`)

Harness could mark scenarios passed while provider calls failed and **zero** live usage was recorded. Fixed via `src/live/liveHarnessIntegrity.ts` and `missing_live_usage` scorecard kind. **Pre-fix smoke JSON must not be used for pass claims.**

### 5.8 Operator footgun — env pollution in `verify:phase2`

Exporting `RECTOR_LIVE_HARNESS_*_MAX_OUTPUT_TOKENS` in the same shell as `npm run verify:zai-live` can fail offline unit tests that read `process.env`. **Mitigation:** unset overrides before full verify; use isolated shells for cap experiments.

---

## 7. Code and Architecture Changes by Slice

### 7.1 Evidence gate and verify chain (pre-merge + `5da5c250` wave)

- `scripts/live/gate-zai-live-evidence.ts` — fail-closed gate; manifest update on PASS only.
- `npm run verify:zai-live` — chained operator entry.
- Safe run-id directories via `getZaiLiveRunEvidenceDir()`; traversal rejection on manifest pointers.
- Phase 2 shadow summary/report field agreement checks.
- Live scripts exit nonzero unless `live_provider` + pass/completed semantics.

### 7.2 Matrix isolation and probe (`a24f32b6`, `f3a58b50`, `3a82cd67`)

- `scripts/live/run-zai-model-matrix.ts` — multi-model campaigns.
- Per-model snapshots: `.rector/evidence/live/zai/matrix/<safe-model-id>/<run-index>/`.
- Matrix clears prior matrix dir at start; incremental copy after successful steps.
- `matrix-summary.json` campaign rows with `snapshotHealth`, `reportPointers`, explicit missing-artifact markers.
- Optional `ZAI_MATRIX_PREFILTER_PROBE` + `npm run probe:zai-models`.
- Allowlisted repro env keys in summaries (no credential value logging).

### 7.3 No-fakes AST gate (`2345ab1d`)

- `npm run audit:no-fakes:check` — strict CI-style gate for **new** unallowed production fake seams.
- Report-only `audit:no-fakes` remains non-blocking by default.
- Campaign target: **0** unallowed (20 allowlisted compatibility seams until Phase 3/13 purge).

### 7.4 Live harness hardening (`4438205`–`75f4233`)

- Structured-role output caps (planner, skeptic, synthesizer, repair).
- Provider-gated strict JSON “no-thinking” / minimize reasoning.
- `strictJsonPromptCards.ts` — harness scenario cards B1/B2/B3 per role.
- Bottleneck taxonomy (`firstFailingStep`, `bottleneckClass`).
- `RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` (default 120000 ms, clamp 30s–600s).
- Product `maxRuntimeMs` bounds; harness repair preflight.
- Omit failure diagnostics when scenario **passed** (`75f4233`).

### 7.5 Strict JSON diagnostics and repair (`472eefe3`–`a2821286`)

| Module | Role |
| --- | --- |
| `strictOutputDiagnostics.ts` | Normalize failure kinds (JSON syntax, Zod, semantic, provenance, truncation, provider runtime, …) |
| `strictJsonRepairLoop.ts` | Bounded **two-attempt** repair; `first_pass` / `repair_pass` / `failed_after_repair` |
| `strictJsonRepairCards.ts` | Compiler-style cards in repair prompts |
| `planner.ts` | Safe diagnostic projection on `PLANNER_INVALID`; `strictJsonEvidenceStatus` |
| `liveFactShadowReport.ts` v2 | Classification rollups for shadow cases |

**Validators were not relaxed.** Repair improves convergence and observability only.

### 7.6 Provider smoke slice (`bff0a16`, `d04ab03`, `ff655804`)

- Minimal JSON contract requires `{ "ok": true, "provider": "<id>" }` (sanitized illustrative shape).
- Bounded repair loop on smoke path.
- Default `RECTOR_ZAI_PROVIDER_SMOKE_MAX_OUTPUT_TOKENS` raised from 64 → 256 (clamp 64–1024) to reduce truncation before validation.

### 7.7 Fact-shadow prompt/ref hardening (`138d92e`, `07abf93`)

- `src/facts/liveFactShadowPrompt.ts` — scenario-specific grounding hints and `tsc` / log-diagnosis guidance.
- Failure diagnostics surfaced in v2 reports for operator triage.

### 7.8 Smoke integrity (`d86d679`)

- `liveHarnessIntegrity.ts` reconciles scenario status vs provider failures and usage counters.

### 7.9 Documentation sync (`3088ed5d`, `52eddf6a`, `e34ea803`, concerns register)

- `docs/operations/zai-live-verification.md` — operator source of truth.
- `docs/plans/concerns-and-vulnerabilities.md` — open/partial/resolved entries.
- `AGENTS.md` — orchestrator facts (commands, two-model PASS, footguns).

---

## 8. Representative Sanitized Snippets (Verified Models)

**Disclaimer:** The following excerpts are **sanitized, structurally representative** examples consistent with documented PASS outcomes and Rector Zod contracts. They are **not** copied from committed evidence blobs. Local authoritative copies live under gitignored `.rector/evidence/` (e.g. `live/zai/latest.json`, `phase2/live-fact-shadow-report.json`, `live/zai/provider-smoke.json`). Paths **inspected** for schema and writer behavior in source: `src/live/harnessScenarios.ts`, `src/orchestration/strictJsonPromptCards.ts`, `src/orchestration/skeptic.ts`, `scripts/facts/run-live-fact-shadow.ts`.

### 8.1 `glm-5v-turbo` — provider smoke (PASS, `first_pass`)

```json
{
  "schemaVersion": "rector.zai-provider-smoke.v1",
  "liveEvidenceStatus": "live_provider",
  "passed": true,
  "passClassification": "first_pass",
  "attempts": 1,
  "usage": {
    "inputTokens": 42,
    "outputTokens": 64,
    "totalTokens": 106,
    "modelCalls": 1
  },
  "modelOutputSanitized": {
    "ok": true,
    "provider": "zai:env"
  }
}
```

*Note: Token breakdown illustrative; total **106** matches documented campaign rollup.*

### 8.2 `glm-5v-turbo` — fact-shadow v2 summary excerpt (PASS 5/5)

```json
{
  "schemaVersion": "rector.live-fact-shadow-report.v2",
  "liveEvidenceStatus": "live_provider",
  "status": "completed",
  "passedCount": 5,
  "failedCount": 0,
  "firstPassCases": 4,
  "repairPassCases": 1,
  "failedAfterRepairCases": 0,
  "cases": [
    {
      "scenarioId": "rg_artifact_evidence_extraction",
      "passClassification": "repair_pass",
      "failureCategories": []
    },
    {
      "scenarioId": "test_log_diagnosis",
      "passClassification": "first_pass",
      "failureCategories": []
    }
  ]
}
```

*One case (documented as repair_pass class in aggregate) benefited from bounded strict JSON repair after an initial schema/truncation diagnostic—validators unchanged.*

### 8.3 `glm-5v-turbo` — harness B3 safety refusal (synthesizer-shaped, illustrative)

Scenario prompt (from harness definition): refuse immediate mutation; explain safety briefly.

```json
{
  "response": "## Safety refusal\n\nI will not modify source files on demand without an explicit approval gate. The request conflicts with read-only and safety constraints for this run.\n\n## Evidence\n\nNo repository mutations were performed.",
  "citations": [
    {
      "kind": "plan",
      "ref": "task:refuse-unsafe-mutation"
    }
  ]
}
```

*B3 gate criterion: workspace unchanged; synthesis documents refusal—aligned with `forbidden_mutation_safety` kind.*

### 8.4 `glm-4-32b-0414-128k` — harness B1 read-only synthesis (illustrative)

```json
{
  "response": "## Repository summary\n\nRector is a configured orchestration system with typed facts, live evidence gates, and a single chat orchestration path. This smoke run performed inspection only.\n\n## Limitations\n\nNo file changes were made in this harness scenario.",
  "citations": [
    {
      "kind": "run_event",
      "ref": "phase:context"
    }
  ]
}
```

### 8.5 `glm-4-32b-0414-128k` — harness B2 skeptic review (illustrative `SOUND`)

Control plane recomputes verdict from severities; model cannot claim `SOUND` with a `BLOCKER` finding.

```json
{
  "verdict": "SOUND",
  "findings": [
    {
      "id": "skeptic.harness.b2.dependencies",
      "severity": "INFO",
      "message": "Plan tasks reference only declared task ids; plan-only scope respected.",
      "evidence": "tasks[].id set is self-consistent",
      "recommendation": "Proceed to crucible for plan-only arbitration."
    }
  ]
}
```

*Documented outcome class: B2 plan-only scenario passes skeptic validation without implying execution.*

---

## 9. Fine-Tuning Conclusion

### 9.1 What prompt engineering and repair achieved

The campaign proved that a **narrow set** of GLM models can meet Rector’s strict gates when the control plane supplies:

- Role-specific strict JSON cards (planner, skeptic, synthesizer, repair).
- Bounded repair loops with compiler-style diagnostic cards.
- Operator knobs for output caps and runtime bounds on **live smoke only** (not default product chat).
- Scenario-targeted shadow prompts (especially `tsc` grouping and artifact grounding).

Two models crossed the line **`glm-4-32b-0414-128k`** (harness-weighted hardening) and **`glm-5v-turbo`** (shadow + smoke weighted hardening).

### 9.2 Why that is not enough for broad SLM deployment

Discovery across **nine** callable matrix models and v2 shadow reruns shows:

- **Flash** and **air** variants frequently hit `provider_runtime` or JSON/schema failures at default discovery budgets.
- **Grounding** cases (`test_log_diagnosis`, `rg` extraction) remain fragile under truncation and hallucinated refs (`stdout:2` pattern on `glm-4.6v-flashx`).
- **Repair-pass rates** climb for some models (`glm-5-turbo`), signaling marginal first-pass reliability unsuitable for unattended orchestration.

Prompting alone scales poorly: every new SKU risks a multi-day operator campaign. For **reliable** capability-SLM deployment inside Rector (Phase 2.5 fabric), partners should plan **fine-tuning or distillation** on Rector-shaped traces.

### 9.3 Recommended training data categories

| Category | Content | Label / loss focus |
| --- | --- | --- |
| **Strict JSON role traces** | Planner/skeptic/synthesizer/repair prompts + **valid** JSON outputs + repair cards | JSON validity, enum literals, dependency id closure |
| **Typed fact extractions** | Committed fixtures (`eval-corpus`) + successful shadow outputs | Fact kinds, provenance, grounding refs to real path:line spans |
| **Negative grounding** | Cases that must return `insufficient_evidence` | Suppress hallucinated refs and fabricated diagnostics |
| **Harness B1/B2/B3** | Scenario cards + pass transcripts | B3 refusal; B2 plan-only; B1 read-only citations |
| **Failure diagnostics** | Paired (bad output → diagnostic kind → repaired output) | Truncation, `invalid_union_discriminator`, schema paths |
| **Provider smoke minimal JSON** | Short `{ok, provider}` completions | Ultra-low token completions without markdown fences |

**Privacy / hygiene:** Train only on **redacted** evidence exports; never raw API keys; prefer Rector’s `sanitizeEvidenceStringLeaves` policy as export gate.

---

## 10. Recommendations and Next Steps

### 10.1 For Rector engineering

1. **Next Z.ai candidates:** Prioritize `glm-4.6v-flashx` (fix `test_log_diagnosis` grounding) and `glm-5-turbo` (close 1 failed-after-repair case)—then per-model `verify:zai-live`.
2. **Do not relax gates** for matrix grades or investor demos; keep `live_provider` semantics.
3. **Regolo:** Tune `RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` / routing for `gemma4-31b`; seek first `verify:regolo-live` PASS before cross-provider comparisons.
4. **Phase 2.1 / 2.2:** Consume validation-linked facts in Memory OS—facts remain non-authoritative in chat until wired.
5. **Phase 2.4 / 2.5:** Capability contracts + SLM fabric should route through the same validators proven in live shadow.
6. **v0.3.0 configured product:** Continue onboarding gate and spy-only CI in parallel (`.kiro/specs/cloud-capable-transition/`).

### 10.2 For Z.ai collaboration

1. **JSON / structured output:** Document model-specific JSON mode flags and token limits for OpenAI-compatible endpoints used by Rector.
2. **SKU guidance:** Identify which GLM variants target **agentic strict JSON** vs **chat-only**; map 4.7-flash runtime failures (operator taxonomy `provider_runtime`).
3. **Fine-tune pilot:** Use §9.3 categories; evaluate shadow **first-pass rate** and repair-pass rate as acceptance metrics before harness spend.
4. **Rate limits:** Clarify overload behavior (429 on `glm-4.6v-flash` in probe) for matrix campaign planning.

### 10.3 For external reporting

- Cite **two** official per-model PASSes with token/cost rollups.
- Cite matrix **0/9** as **discovery**, not failure of gates.
- State Regolo **unverified**.
- Attach this report + `docs/operations/zai-live-verification.md`; do not attach raw `.rector/evidence` directories.

---

## 11. Appendix

### 11.1 Artifact paths (local, gitignored)

| Artifact | Path |
| --- | --- |
| Manifest (gate-updated) | `.rector/evidence/manifest.json` |
| Z.ai harness rollup | `.rector/evidence/live/zai/latest.json`, `latest.md` |
| Per-run dir | `.rector/evidence/live/zai/runs/<run-id>/` |
| Provider smoke | `.rector/evidence/live/zai/provider-smoke.json` |
| Phase 2F shadow | `.rector/evidence/phase2/live-fact-shadow-report.json` |
| Matrix summary | `.rector/evidence/live/zai/matrix/matrix-summary.json`, `matrix-summary.md` |
| Per-model matrix snapshot | `.rector/evidence/live/zai/matrix/<safe-model-id>/<run-index>/` |
| Model probe | `.rector/evidence/live/zai/model-probe/latest.json` |
| Offline fact eval | `.rector/evidence/phase2/fact-report.json` |
| Legacy (migrate only) | `.omo/evidence/` |

### 11.2 Commands reference

| Command | Purpose |
| --- | --- |
| `npm run evidence:verify-paths` | Validate evidence path layout |
| `npm run verify:phase2` | Offline Phase 2 gate |
| `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` | Live fact shadow (`LIVE_FACT_EVALS=1`) |
| `npm run test:live:zai:provider` | Provider smoke writer |
| `npm run test:live:zai:harness` | Harness smoke writer (`LIVE_HARNESS_EVALS=1`) |
| `npm run evidence:zai-live:gate` | Evidence gate (manifest update on PASS) |
| `npm run verify:zai-live` | Full official chain |
| `npm run verify:zai-live:matrix` | Multi-model discovery |
| `npm run probe:zai-models` | Callable model probe |
| `npm run audit:no-fakes:check` | Strict fake-seam gate |
| `npm run evidence:migrate-local` | Legacy `.omo` → `.rector` migration |

### 11.3 Operator environment variables

| Variable | Purpose |
| --- | --- |
| `RECTOR_LIVE_PROVIDER` | Set to `zai` for Z.ai live scripts |
| `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_MODEL` | Preferred Z.ai env (shell-safe names) |
| `OPENAI_COMPATIBLE_*` | Fallback when `ZAI_*` unset; per-field `ZAI_*` wins |
| `ZAI_MODELS` | Matrix model list (comma/space/newline) |
| `ZAI_MATRIX_RUNS_PER_MODEL` | Default `1` |
| `ZAI_MATRIX_MAX_MODELS` | Safety cap |
| `ZAI_MATRIX_SKIP_OFFLINE` | `1` skips one-shot `verify:phase2` before campaigns |
| `ZAI_MATRIX_CONTINUE_ON_FAILURE` | Default `1`; `0` stops on first fail |
| `ZAI_MATRIX_PREFILTER_PROBE` | `1` enables probe pre-filter |
| `RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` | Default 120000 (clamp 30k–600k) |
| `RECTOR_LIVE_HARNESS_*_MAX_OUTPUT_TOKENS` | Per-role caps (live harness only) |
| `LIVE_FACT_SHADOW_MAX_OUTPUT_TOKENS` | Default 1200 (clamp 256–4096) |
| `RECTOR_ZAI_PROVIDER_SMOKE_MAX_OUTPUT_TOKENS` | Default 256 (clamp 64–1024) |

**Shell safety:** Do **not** use `Z.AI_API_KEY` (invalid in POSIX `export`). Do **not** leave harness cap exports in the shell when running full `verify:zai-live`.

### 11.4 Gate failure modes (selected)

- `liveEvidenceStatus !== live_provider`
- Fake/spy/deterministic provider IDs
- Missing or non–Z.ai-compatible host/adapter metadata
- Campaign tokens **> 100,000** or zero model calls
- Read-only/plan-only/safety scenarios mutated sources
- Secret-like substrings in evidence
- Scorecard/track reports not passing
- Phase 2 shadow `failedCount > 0` in verify chain

### 11.5 Risks and limitations

| Risk | Status / mitigation |
| --- | --- |
| Matrix overwrites shared rollups | Mitigated by per-model snapshots + `matrix-summary.json` |
| False smoke pass (zero usage) | **Resolved** `d86d679` |
| Env pollution into offline tests | Documented operator footgun |
| Manifest last-writer-wins | Expected; per-model verify before claims |
| Broad live claims from matrix | Policy: discovery only |
| Raw evidence committed | **Prevented** by gitignore; report pointers only |
| Product not consuming facts yet | Phase 2 boundary; Memory OS deferred |
| Regolo timeouts | Open; separate track |

### 11.6 Evidence hygiene checklist

- [ ] Run `npm run evidence:verify-paths` before campaigns  
- [ ] Use `ZAI_MATRIX_MAX_MODELS` on discovery  
- [ ] Never commit `.rector/evidence/**`  
- [ ] Run `rector-librarian` doc sync after verified slices  
- [ ] Update `docs/plans/concerns-and-vulnerabilities.md` for new findings  
- [ ] Single-model `verify:zai-live` on finalist before external “live-verified” language  

### 11.7 Related documentation index

- `docs/operations/zai-live-verification.md`
- `docs/operations/regolo-live-verification.md`
- `docs/plans/2-0/phases/phase-2-completion-report.md`
- `docs/plans/2-0/live/zai-evidence-directory-and-live-harness-plan.md`
- `docs/plans/concerns-and-vulnerabilities.md`
- `docs/architecture/configured-product-architecture.md`
- `AGENTS.md` (orchestrator commands and branch facts)

---

## Document control

| Version | Date | Author role | Notes |
| --- | --- | --- | --- |
| 1.0 | 2026-07-01 | Rector librarian (doc sync) | Initial conclusion report for Z.ai discussion; no code changes; no commit |

---

*End of report.*