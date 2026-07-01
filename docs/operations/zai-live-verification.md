# Z.ai live verification (operator)

Rector separates **offline** gates from **live** Z.ai verification. **Official live verification** is a single-model `npm run verify:zai-live` gate PASS with `live_provider` evidence — not matrix discovery grades or partial fact-shadow reruns.

**Current status (2026-07-01):** One **official** finalist PASS — `glm-4-32b-0414-128k` (`verify:zai-live`, manifest updated). All other Z.ai models remain **live-unverified** until each passes its own full chain. Regolo and spy/fake/deterministic paths do not count as live evidence.

## First foundation discovery run (2026-07-01)

Rector’s **first** live Z.ai **matrix** discovery campaign on branch `zai-evidence-live-integration` (after evidence-path + no-fakes hardening). That matrix **did not** produce any full-chain gate pass — do not treat matrix `overallStatus: fail` as contradicting the later **single-model** finalist PASS.

| Item | Result |
| --- | --- |
| Preflight | `evidence:verify-paths`, strict `audit:no-fakes:check`, clean worktree, env loaded |
| Probe (`probe:zai-models` + JSON capability) | 9/10 callable; `glm-4.6v-flash` skipped (HTTP 429 / overload); only `glm-4-32b-0414-128k` reported JSON capability **supported** |
| Matrix (`verify:zai-live:matrix`, 1 run/model, pre-filter + JSON probe) | `overallStatus: fail` — **0** pass / **9** fail / **1** skipped (probe) |
| Follow-up intentionally skipped | No 10-run matrix repeat and no finalist `verify:zai-live` — discovery found **zero** full-chain gate passes |

**Failure pattern (evidence-backed, official matrix):** **9/9** callable models in the first official matrix run failed **before** harness because `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` did not complete with zero failed cases. Frame this as a **first-pass / current-wrapper strict fact-shadow bottleneck** on the raw live shadow path — not proof that those models cannot pass after bounded repair or linter-assisted retries. Only `glm-4-32b-0414-128k` completed Phase 2F live shadow **5/5** and provider smoke in that campaign, then failed live harness on orchestration schema/validation (pre-hardening). Treat non-finalist matrix rows as **discovery grades**, not live-verified claims.

**What this run did prove:** Real Z.ai OpenAI-compatible calls, `live_provider` evidence, no auth failure, no systemic quota failure in matrix diagnostics, no secret leakage in artifacts, and gate rejection of fake/spy doubles remains intact. Matrix is **comparison/discovery only** (no manifest update).

**Operator interpretation (not a harness change):** Strict gate + harness behavior appears useful; failures look like **model ↔ schema/instruction mismatch**. Likely follow-on is model-specific prompting, adapters, or fine-tuning — **not** relaxing the harness for live-verified claims.

**Official finalist verification (harness hardening, 2026-07-01):** After live-harness optimization commits `4438205`–`75f4233` (structured-role output caps, strict JSON prompt cards + provider-gated no-thinking, diagnostics/bottleneck taxonomy, bounded product `maxRuntimeMs`, harness repair preflight), **`RECTOR_LIVE_PROVIDER=zai ZAI_MODEL=glm-4-32b-0414-128k npm run verify:zai-live`** **passed** the strict gate: harness **3/3** scenarios, **46,695** / 100,000 tokens, **$0.0441** estimated cost, `live_provider` evidence, manifest updated. Report: `.rector/evidence/live/zai/latest.md`. **Only this single-model gate PASS** supports `zai-live-verified` / `phase2-complete-live-verified-zai-finalist` labels. Matrix discovery and partial fact-shadow reruns do **not** update the manifest or substitute for per-model `verify:zai-live`.

### Strict JSON diagnostics and bounded repair (offline verified @ `a282128`)

Orchestration and the Phase 2F live shadow runner now share a **strict output diagnostic** core (`src/orchestration/strictOutputDiagnostics.ts`) and a **bounded strict JSON repair loop** (`src/orchestration/strictJsonRepairLoop.ts`, max two attempts). Validators were **not** relaxed — repair improves convergence and reporting only.

| Surface | Behavior |
| --- | --- |
| Diagnostic kinds | JSON syntax, Zod schema, semantic invariant, provenance / grounding / scope / redaction hooks, truncation, provider runtime |
| Pass classification | `first_pass`, `repair_pass`, `failed_after_repair` |
| Evidence status | `live_provider` vs `test_only_injected` vs `deterministic_fallback` — deterministic fallback cannot count as a live strict JSON pass |
| Planner | Top-level `strictJsonEvidenceStatus`; `PLANNER_INVALID` blocker `details` use **safe diagnostic projection** (`kind` / `code` / `path` / `severity` only — no model-derived persisted messages) |
| Repair cards | Compiler-style strict JSON repair cards (`strictJsonRepairCards.ts`) feed planner repair prompts; harness live smoke may use the same loop where wired |

**Live fact-shadow report v2** (`rector.live-fact-shadow-report.v2` / summary v2): adds `firstPassCases`, `repairPassCases`, `failedAfterRepairCases`, `failureCategoryCounts`, per-case `passClassification`, and safe per-attempt summaries. `scripts/facts/run-live-fact-shadow.ts` runs bounded repair with repair cards. Z.ai/Regolo live gates still enforce `live_provider`, zero `failedCount`, and related summary fields; gate parsers use **passthrough** on report JSON so v2 fields do not break older gate checks. **Pre-v2 artifacts on disk do not include classification rollups** — regenerate with opt-in `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` before triaging repair-pass rates.

**Offline verification (2026-07-01, no new live gate rerun):** `npm run check`, targeted strict-json / planner / live-shadow tests, `npm run eval:facts` (10/10), `npm run build`, `npm run audit:no-fakes:check` (0 unallowed), `npm audit` (0 vulnerabilities), full `npm test` (415 files passed / 1 skipped; 2858 tests passed / 5 skipped), `npm run evidence:verify-paths`. **Next operator step:** opt-in v2 live shadow + harness reruns on finalists/non-finalists; do not relabel manifest live-verified until a fresh `verify:zai-live` PASS.

### Typed-fact live shadow reruns (operator, pre–repair-loop baselines)

Historical **first-pass-only** `eval:facts:live` reruns (before bounded repair in the shadow runner) summarized approximate pass rates on **5** shadow cases per model:

| Model | First-pass shadow (approx.) | Common failure modes |
| --- | --- | --- |
| `glm-4.5-flash`, `glm-4.5-air`, `glm-4.5-airx`, `glm-5-turbo` | ~3/5 | `model_json_invalid`, missing schema-valid expected facts, `invalid_union_discriminator`, evidence extraction |
| `glm-4.6v-flashx`, `glm-5v-turbo` | ~2/5 | Same JSON/schema classes + vision-turbo variability |
| `glm-4.7-flash`, `glm-4.7-flashx`, `glm-4.6v-flash` | Poor / rate-limited | HTTP 429 / overload, `model_json_invalid`, `tsc_diagnostic_grouping` |

**Interpretation:** These scores describe **raw first-pass** output against strict validators on the **old** shadow path. The repair loop and v2 report taxonomy are implemented offline (see § Strict JSON diagnostics and bounded repair); rerun `eval:facts:live` to measure **repair-pass** uplift. **Do not** relax validators to improve matrix grades.

### Live harness smoke integrity (fixed `d86d679`)

Harness-only reruns exposed a **smoke-report integrity bug**: scenarios could appear to pass while provider calls failed and **zero** live `modelCalls`/usage were recorded (orchestration swallowed errors). Fixed in `d86d679` via `src/live/liveHarnessIntegrity.ts`, scorecard failure kind `missing_live_usage`, and reconciled Z.ai/Regolo harness report writers. Treat pre-fix smoke JSON as **untrusted** for pass claims; post-fix reports fail closed when live usage is missing.

### Operator spend and reruns

Campaign budget remains **≤100,000 tokens** and **≤20 model calls** per single-model gate. Early Z.ai live campaigns used on the order of **~$0.50** total against a much larger operator budget (~$100) — broad post-fix reruns are acceptable **if** budgets, matrix caps (`ZAI_MATRIX_MAX_MODELS`), and **no raw `.rector/evidence` commits** are respected. Deterministic/spy/fake paths never count as live evidence.

**Artifact pointers (local, gitignored):**

- `.rector/evidence/live/zai/model-probe/latest.json`
- `.rector/evidence/live/zai/matrix/matrix-summary.json` (`generatedAt` ~2026-07-01T04:04:37Z)
- Per-model snapshots: `.rector/evidence/live/zai/matrix/<safe-model-id>/0/` (e.g. `phase2-live-fact-shadow-report.json`, `latest.json`)

**Caution:** Shared canonical rollups (`.rector/evidence/live/zai/latest.json`, root Phase 2 shadow) are **last-writer-wins** during matrix runs. For triage, treat **`matrix-summary.json` campaign rows** as authoritative: each campaign lists `snapshotCopiedFiles`, `snapshotSkippedArtifacts`, `snapshotHealth`, and `reportPointers` where missing artifacts are explicitly **`not captured`** (not shared canonical paths). Matrix runs **clear** `.rector/evidence/live/zai/matrix/` at start so prior-run snapshot dirs cannot leak. Snapshots copy **incrementally after each successful live step**; guarded JSON is re-validated on finalize and only copied pointers are emitted. **Official live verification** remains single-model `npm run verify:zai-live` (manifest update), not matrix grades alone.

## Evidence layout

- Canonical root: `.rector/evidence`
- Legacy compatibility only: `.omo/evidence` (migrate with `npm run evidence:migrate-local` when needed)
- Z.ai live harness rollups: `.rector/evidence/live/zai/latest.json` and `latest.md`
- Per-run artifacts: `.rector/evidence/live/zai/runs/<run-id>/`
- Provider smoke: `.rector/evidence/live/zai/provider-smoke.json`
- Phase 2F live fact shadow: `.rector/evidence/phase2/live-fact-shadow-report.json`
- Multi-model matrix rollup (opt-in): `.rector/evidence/live/zai/matrix/matrix-summary.json` and `matrix-summary.md`
- Per-model matrix snapshots: `.rector/evidence/live/zai/matrix/<safe-model-id>/<run-index>/` (isolated copies of campaign rollups)
- Optional model callability probe: `.rector/evidence/live/zai/model-probe/latest.json` (`npm run probe:zai-models`)

## Offline vs live

| Command | Network / secrets | What it proves |
| --- | --- | --- |
| `npm test` | No | Deterministic unit/integration tests |
| `npm run verify:phase2` | No | Typed-fact substrate offline |
| `npm run verify:zai-live` | Yes (when configured) | Live Z.ai provider + harness + evidence gate |
| `npm run verify:zai-live:matrix` | Yes (when configured) | Same live chain **per model** from `ZAI_MODELS` (or single `ZAI_MODEL`); writes matrix summary only |

Do **not** claim `zai-live-verified` or update phase labels to live-verified unless `npm run evidence:zai-live:gate` passes against evidence with `liveEvidenceStatus: live_provider` from a real configured provider (not spy/fake/test injection).

## Operator steps (live campaign)

1. Configure Z.ai OpenAI-compatible credentials (UI `runtime-settings.json` or env):
   - `RECTOR_LIVE_PROVIDER=zai`
   - **Recommended (Z.ai-specific, shell-safe):** `ZAI_API_KEY`, `ZAI_BASE_URL` (Z.ai host, e.g. `https://api.z.ai/api/paas/v4`), `ZAI_MODEL`
   - **Compatibility / generic OpenAI-compatible adapter:** `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` — used when `ZAI_*` values are absent; per-field `ZAI_*` wins when set
   - **Do not** use `Z.AI_API_KEY` (dot in the name) in shell `export` lines; POSIX shells treat it as invalid. Use `ZAI_API_KEY` or configure via the web UI / `runtime-settings.json`.
2. Optional path check: `npm run evidence:verify-paths`
3. Provider smoke (repo-root writer): `npm run test:live:zai:provider` — sets `RECTOR_LIVE_PROVIDER=zai` and `RECTOR_ZAI_PROVIDER_SMOKE=1`, writes `.rector/evidence/live/zai/`, and exits nonzero unless it records `live_provider` + `passed`.
4. Phase 2F shadow: `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` — exits nonzero unless it records `live_provider` + `completed` with zero failed cases.
5. Harness smoke (repo-root writer): `npm run test:live:zai:harness` — sets `RECTOR_LIVE_PROVIDER=zai` and `LIVE_HARNESS_EVALS=1`, writes harness artifacts, and exits nonzero unless it records `live_provider` + `passed`.
6. Gate: `npm run evidence:zai-live:gate`
7. Full chain: `npm run verify:zai-live`

## Multi-model matrix (opt-in, reporting)

Use when comparing several Z.ai GLM models for an external report. **Not** part of default `npm test` or CI. Matrix runs **do not** update `.rector/evidence/manifest.json` and **do not** by themselves satisfy live-verified labels—even if every model grades **A**, run `verify:zai-live` once on the chosen finalist for manifest-backed live claims.

```bash
export ZAI_API_KEY="..."
export ZAI_BASE_URL="https://api.z.ai/api/paas/v4"
export ZAI_MODELS="glm-small,glm-mid,glm-large"   # comma / space / newline separated
npm run verify:zai-live:matrix
```

If `ZAI_MODELS` is unset, the matrix falls back to a **single** campaign using `ZAI_MODEL` (same steps as `verify:zai-live`, minus manifest updates on intermediate gate runs).

### Matrix env knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZAI_MATRIX_RUNS_PER_MODEL` | `1` | Repeat full live chain per model (use `3`–`5` only for finalist models, not every candidate) |
| `ZAI_MATRIX_MAX_MODELS` | unset | Safety cap on parsed `ZAI_MODELS` length |
| `ZAI_MATRIX_SKIP_OFFLINE` | unset | Set `1` to skip one-shot `npm run verify:phase2` before live campaigns |
| `ZAI_MATRIX_CONTINUE_ON_FAILURE` | `1` | Set `0` to stop after the first failing model campaign |
| `ZAI_MATRIX_PREFILTER_PROBE` | unset | Set `1` to run `probe:zai-models` logic before live chains and skip non-callable models |
| `ZAI_MATRIX_PROBE_JSON` / `ZAI_MODEL_PROBE_JSON` | unset | Set `1` for an extra cheap JSON-mode probe per callable model (probe CLI or matrix pre-filter) |

Each model campaign sets `ZAI_MODEL=<model>` and runs, in order:

1. `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live`
2. `npm run test:live:zai:provider`
3. `npm run test:live:zai:harness`
4. `npm run evidence:zai-live:gate -- --no-manifest-update`

Matrix gate runs disable manifest updates so comparing models does not thrash `.rector/evidence/manifest.json`. Run plain `npm run verify:zai-live` once on the chosen finalist to update the manifest after review.

**Shared rollup overwrite:** each model campaign still writes the same canonical paths (`.rector/evidence/live/zai/latest.json`, provider smoke, Phase 2 shadow). The **last** model in the run wins those shared files. Use `matrix-summary.json` **and** per-model snapshots under `.rector/evidence/live/zai/matrix/<safe-model-id>/<run-index>/` for isolated evidence pointers (matrix is comparison-only; single-model `verify:zai-live` remains required for manifest-backed live verification).

### Strict harness operator knobs (live smoke / matrix only)

These env vars are **operator and live-test overrides** — not the configured-product web UI setup path.

| Variable | Default / clamp | Purpose |
| --- | --- | --- |
| `RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` | default **120000**; clamp **30000**–**600000** | Per-scenario orchestration wall-clock for live harness smoke |
| `RECTOR_LIVE_HARNESS_PLANNER_MAX_OUTPUT_TOKENS` | harness default **4096** per role (scenario cap when unset) | Explicit cap on planner strict JSON calls |
| `RECTOR_LIVE_HARNESS_SKEPTIC_MAX_OUTPUT_TOKENS` | same | Skeptic strict JSON |
| `RECTOR_LIVE_HARNESS_SYNTH_MAX_OUTPUT_TOKENS` | same | Synthesizer strict JSON |
| `RECTOR_LIVE_HARNESS_REPAIR_MAX_OUTPUT_TOKENS` | same (falls back to planner cap) | Repair strict JSON |

Live harness attaches structured-role caps and `strictJsonMinimizeReasoning` on planner/skeptic/synthesizer/repair only; normal product chat via `runOrchestratedChatRun` does **not** opt into this policy unless explicitly passed.

**Do not export cap overrides in the same shell session as `npm run verify:zai-live`:** the chain runs `npm run verify:phase2` first, which includes unit tests that read `process.env`. A prior `export RECTOR_LIVE_HARNESS_*_MAX_OUTPUT_TOKENS=8192` (or similar) can make offline tests observe operator overrides and fail or skew results. For cap experiments, use `npm run test:live:zai:harness` / provider smoke in a clean shell, unset overrides before the full verify chain, or scope env only to the live harness subprocess (smoke scripts), not the parent verify shell.

### Harness diagnostics (operator / partner triage)

Live harness, provider smoke, and matrix summaries include a `diagnostics` block (`rector.zai-live-diagnostics.v1`):

- **Provider failure taxonomy** — `rate_limit`, `quota`, `timeout`, `provider_http`, `provider_json`, `unknown` (derived from provider HTTP status, retryability, and error codes when available; otherwise `unknown`).
- **Bottleneck taxonomy** — per-scenario `firstFailingStep` and `bottleneckClass` (e.g. `provider_timeout`, `provider_json`, `orchestration_validation`) when a scenario fails; omitted when the scenario **passed** (post-`75f4233`).
- **Latency aggregates** — min/avg/p50/p95/max for provider calls, harness scenarios, and (matrix) campaign/step durations.
- **Token totals** — input/output/total tokens, model calls, and estimated USD where tracked.

For **matrix** summaries specifically, the diagnostics `tokens` block rolls up **only** each campaign's gate `campaignTokens` (summed when > 0). Matrix diagnostics set input/output/model-call/cost fields to zero because the matrix runner does not merge per-snapshot harness breakdowns; per-model token detail lives under `.rector/evidence/live/zai/matrix/<safe-model-id>/<run-index>/latest.json`.

Markdown rollups (`latest.md`, `provider-smoke.md`, `matrix-summary.md`) echo the same diagnostics tables. Artifacts remain redacted (no API keys or auth headers).

### How tests relate to live verification

- **Unit/integration (`npm test`)** — matrix parsing, env isolation, secret redaction, diagnostics rollups, and orchestration use **injected command runners**; no network, no real API keys, no live gate pass claims.
- **Fake-seam containment (`npm run audit:no-fakes:check`)** — offline strict scan (0 unallowed production fake seams); default `audit:no-fakes` remains report-only unless CI policy changes.
- **Live scripts** (`test:live:zai:*`, `eval:facts:live`) — opt-in; exit nonzero unless evidence records `live_provider` with passing tracks.
- **Gate** (`evidence:zai-live:gate`) — rejects spy/fake providers and `test_only_injected` evidence; fake doubles cannot satisfy live verification.

### Rating criteria (matrix summary)

Per-model **grade** / **rating** in `matrix-summary.json` are derived from gate outcome plus harness evidence when present:

| Grade | Meaning |
| --- | --- |
| **A** | Gate pass, scorecard pass, all harness scenarios passed (`rating`: `gate_and_harness_pass` — campaign-local, not org manifest live verification) |
| **B** | Gate pass, ≥80% scenarios passed |
| **C** | Gate pass but harness scorecard failed |
| **D** | Gate pass with weak scenario coverage |
| **F** | Gate fail or campaign step failure |

Grades support operator comparison; they do **not** replace `live_provider` gate PASS for live-verified labels.

### Recommended run counts and budget

Per **single** live campaign (one model), plan limits apply: **≤100,000 tokens** total and **≤20 model calls** across provider smoke, Phase 2F shadow, and harness smoke.

Recommended matrix workflow:

1. **Discovery:** `ZAI_MATRIX_RUNS_PER_MODEL=1` across a short `ZAI_MODELS` list (3–6 candidates).
2. **Finalists:** repeat `3`–`5` campaigns only for 1–2 models that graded **A** or **B**.
3. Avoid `50`–`100` repeats per model until budget and stability are proven.

Hardening ideas (deferred): pinned campaign correlation ids across probe/matrix/gate, and automatic finalist promotion into `verify:zai-live` manifest update.

## Gate behavior

`scripts/live/gate-zai-live-evidence.ts` reads `latest.json`, required run artifacts, provider smoke, and Phase 2F summary. It **fails** when:

- `liveEvidenceStatus !== live_provider`
- Provider is fake/deterministic/spy/mock/fixture/scripted/test-double
- `providerId`, `adapterId`, or Z.ai-compatible `host` missing on harness/provider-smoke tracks
- Host is not Z.ai-compatible or adapter is not `openai-compatible`
- Required files or redacted prompts/outputs are missing
- Campaign tokens exceed **100,000** or model calls are zero
- Read-only / plan-only / safety scenarios mutated source files
- Secret-like values appear in evidence
- Scorecard or track reports do not pass

On **PASS** only, it may update `.rector/evidence/manifest.json` with `liveEvidenceStatus`, `secretScanPassedAt`, and campaign budget rollup.

## Budget

First live campaign hard limit: **100,000 total tokens** across provider smoke, Phase 2F shadow, and harness smoke.