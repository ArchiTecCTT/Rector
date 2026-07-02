# Regolo live verification (operator)

Regolo is wired as an opt-in live evidence track parallel to Z.ai. **Configured-product rule:** normal product configuration remains `runtime-settings.json` and the web UI; env vars below are **operator and test overrides** only (not the primary setup path).

## First foundation discovery run (2026-07-01)

Rector's **first** live Regolo foundation discovery campaign on branch `zai-evidence-live-integration` after the Regolo track landed (`2f56975`) and matrix artifact hygiene hardening (`8900aa1`, `f3a58b5`). **Live verification did not pass** — do not relabel Phase 2 or harness milestones as live-verified for Regolo.

| Item | Result |
| --- | --- |
| Offline gates (post-`f3a58b5`) | `npm run check`, `npm test`, `npm run build`, `npm audit`, `npm run audit:no-fakes:check` passed |
| Probe (`probe:regolo-models`) | **10/10** callable: `apertus-70b`, `gemma4-31b`, `gpt-oss-20b`, `gpt-oss-120b`, `Llama-3.3-70B-Instruct`, `mistral-small-4-119b`, `qwen3-coder-next`, `qwen3.5-122b`, `qwen3.5-9b`, `qwen3.6-27b` |
| Matrix (`verify:regolo-live:matrix`, 1 run/model) | `overallStatus: fail` — **0** pass / **10** fail / **0** skipped |
| Follow-up intentionally skipped | No finalist `npm run verify:regolo-live` — discovery found **zero** full-chain gate passes |

**Failure pattern (evidence-backed):** **9/10** models failed at `RECTOR_LIVE_PROVIDER=regolo npm run eval:facts:live` (typed-fact live shadow). **`gemma4-31b`** was the only candidate that completed Phase 2F live shadow and provider smoke, then failed live harness smoke on **orchestration timeout** across harness scenarios B1/B2/B3 (did not reach a clean schema-validation pass like Z.ai's finalist). Treat **`gemma4-31b` as the best current Regolo debug target**, not a verified pass.

**Cross-provider comparison (discovery only, not a product claim):** Z.ai's best prior result on this branch was **`glm-4-32b-0414-128k` / `glm-4-32B` family** — passed live facts and provider smoke, then failed harness on **orchestration schema/validation** (not timeout). Regolo's deepest runner was **`gemma4-31b`** (facts + smoke, harness timeout). Neither provider has a single-model gate PASS; do not rank providers for investors without finalist `verify:*-live` evidence.

**What this run did prove:** Real Regolo OpenAI-compatible calls, `live_provider` evidence on steps that completed, probe callability for all ten candidates, gate rejection of fake/spy doubles remains intact, and matrix summaries no longer leak broad env-var name lists after allowlist hardening (`f3a58b5`). Matrix is **comparison/discovery only** (gate uses `--no-manifest-update`; matrix grades ≠ official live verification).

**Operator interpretation (not a harness change):** Broad multi-model matrices are **slow and costly**; large Regolo models may hit **timeouts** before schema issues surface; output caps and JSON/schema behavior per model remain **unknown until probed and snapshotted**. Likely follow-on is model-specific timeouts, prompting, or finalist-only campaigns — **not** relaxing the harness for live-verified claims.

**Post–Z.ai-parity harness hardening focused rerun (2026-07-01, branch @ `75f4233`):** After the same structured-role caps, strict JSON cards, and diagnostics landed for Regolo harness writers, focused **`gemma4-31b`** reruns: **provider smoke passed**; **harness smoke failed** B1/B2/B3. Diagnostics showed **300000ms** harness runtime (`RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS` override), **three** provider/orchestration **timeouts**, **one planner call per scenario**, **0** usage tokens — bottleneck is **provider/orchestration timeout classification**, not a proof of schema/cap truncation failure. **No** `npm run verify:regolo-live` gate PASS; Regolo remains live-unverified. Do not infer Regolo quality from this single finalist smoke.

**Strict JSON repair + live shadow v2 (shared with Z.ai, offline @ `a282128`):** Phase 2F `run-live-fact-shadow.ts` uses the same bounded repair loop and `rector.live-fact-shadow-report.v2` classification fields as the Z.ai track. Validators unchanged; deterministic fallback cannot satisfy live pass. **No** post-`a282128` Regolo live campaign has been rerun — discovery matrix grades and pre-v2 shadow artifacts remain authoritative until operators regenerate evidence locally (gitignored; not committed).

**Harness smoke integrity (shared with Z.ai, `d86d679`):** Regolo harness reports use the same `liveHarnessIntegrity` reconciliation — smoke must not show pass when provider calls failed without recorded usage (`missing_live_usage`). Pre-fix artifacts may overstate success; post-fix fails closed.

**Artifact pointers (local, gitignored — do not commit):**

- `.rector/evidence/live/regolo/model-probe/latest.json`
- `.rector/evidence/live/regolo/matrix/matrix-summary.{json,md}`
- Per-model snapshots: `.rector/evidence/live/regolo/matrix/<safe-model-id>/0/` (e.g. `phase2-live-fact-shadow-report.json`, `latest.json`, `provider-smoke.json` when copied)

**Caution:** Shared canonical rollups (`.rector/evidence/live/regolo/latest.json`, root Phase 2 shadow) are **last-writer-wins** during matrix runs. For triage, treat **`matrix-summary.json` campaign rows** as authoritative: `snapshotCopiedFiles`, `snapshotSkippedArtifacts`, `snapshotHealth`, and `reportPointers` (use **`not captured`** when an artifact was not copied for that campaign). Matrix runs **clear** `.rector/evidence/live/regolo/matrix/` at start. Guarded JSON snapshots are re-validated on finalize. **Official live verification** is single-model `npm run verify:regolo-live`, not matrix comparison alone.

## Evidence layout

- Canonical root: `.rector/evidence`
- Regolo live rollups: `.rector/evidence/live/regolo/latest.json` and `latest.md`
- Per-run artifacts: `.rector/evidence/live/regolo/runs/<run-id>/`
- Provider smoke: `.rector/evidence/live/regolo/provider-smoke.json`
- Phase 2F live fact shadow (shared track): `.rector/evidence/phase2/live-fact-shadow-report.json`
- Multi-model matrix rollup (opt-in): `.rector/evidence/live/regolo/matrix/matrix-summary.json` and `matrix-summary.md`
- Per-model matrix snapshots: `.rector/evidence/live/regolo/matrix/<safe-model-id>/<run-index>/`
- Model callability probe: `.rector/evidence/live/regolo/model-probe/latest.json` (`npm run probe:regolo-models`)

## Offline vs live

| Command | Network / secrets | What it proves |
| --- | --- | --- |
| `npm test` | No | Deterministic unit/integration tests |
| `npm run verify:phase2` | No | Typed-fact substrate offline |
| `npm run verify:regolo-live` | Yes (when configured) | Live Regolo provider + harness + evidence gate |
| `npm run verify:regolo-live:matrix` | Yes (when configured) | Same live chain **per model** from `REGOLO_MODELS` (or single `REGOLO_MODEL`); writes matrix summary only |

Do **not** claim `regolo-live-verified` or update phase labels to live-verified unless `npm run evidence:regolo-live:gate` passes against evidence with `liveEvidenceStatus: live_provider` from a real configured provider (not spy/fake/test injection).

## Prerequisites

- `RECTOR_LIVE_PROVIDER=regolo`
- **Recommended (Regolo-specific):** `REGOLO_API_KEY`, `REGOLO_BASE_URL` (e.g. `https://api.regolo.ai/v1`), `REGOLO_MODEL`
- **Compatibility / generic OpenAI-compatible adapter:** `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL` — used when `REGOLO_*` values are absent; per-field `REGOLO_*` wins when set
- Optional list: `REGOLO_MODELS` for matrix/probe (comma/space/newline separated)

Model IDs and `/models` metadata must be validated via live probe; treat callability and JSON behavior as unknown until `npm run probe:regolo-models` records results.

## Operator steps (live campaign)

1. Configure Regolo credentials (UI `runtime-settings.json` or env overrides above).
2. Optional path check: `npm run evidence:verify-paths`
3. Provider smoke: `npm run test:live:regolo:provider` — sets `RECTOR_LIVE_PROVIDER=regolo` and `RECTOR_REGOLO_PROVIDER_SMOKE=1`, writes `.rector/evidence/live/regolo/`, exits nonzero unless it records `live_provider` + `passed`.
4. Phase 2F shadow: `RECTOR_LIVE_PROVIDER=regolo npm run eval:facts:live` — exits nonzero unless it records `live_provider` + `completed` with zero failed cases.
5. Harness smoke: `npm run test:live:regolo:harness` — sets `LIVE_HARNESS_EVALS=1`, exits nonzero unless it records `live_provider` + `passed`.
6. Gate: `npm run evidence:regolo-live:gate`
7. Full chain: `npm run verify:regolo-live`

## Multi-model matrix (opt-in, reporting)

Use when comparing several Regolo models. **Not** part of default `npm test` or CI. Matrix runs **do not** update `.rector/evidence/manifest.json` and **do not** by themselves satisfy live-verified labels — even if a model grades well, run `verify:regolo-live` once on the chosen finalist for manifest-backed live claims.

```bash
export REGOLO_API_KEY="..."
export REGOLO_BASE_URL="https://api.regolo.ai/v1"
export REGOLO_MODELS="qwen3.5-9b,gemma4-31b,Llama-3.3-70B-Instruct"
npm run verify:regolo-live:matrix
```

If `REGOLO_MODELS` is unset, the matrix falls back to a **single** campaign using `REGOLO_MODEL` (same steps as `verify:regolo-live`, minus manifest updates on intermediate gate runs).

### Matrix env knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `REGOLO_MATRIX_RUNS_PER_MODEL` | `1` | Repeat full live chain per model (use 3–5 only for finalists) |
| `REGOLO_MATRIX_MAX_MODELS` | unset | Safety cap on parsed `REGOLO_MODELS` length |
| `REGOLO_MATRIX_SKIP_OFFLINE` | unset | Set `1` to skip one-shot `npm run verify:phase2` before live campaigns |
| `REGOLO_MATRIX_CONTINUE_ON_FAILURE` | `1` | Set `0` to stop after the first failing model campaign |
| `REGOLO_MATRIX_PREFILTER_PROBE` | unset | Set `1` to run probe logic before live chains and skip non-callable models |
| `REGOLO_MATRIX_PROBE_JSON` / `REGOLO_MODEL_PROBE_JSON` | unset | Set `1` for an extra cheap JSON-mode probe per callable model |

Each model campaign sets `REGOLO_MODEL=<model>` and runs, in order:

1. `RECTOR_LIVE_PROVIDER=regolo npm run eval:facts:live`
2. `npm run test:live:regolo:provider`
3. `npm run test:live:regolo:harness`
4. `npm run evidence:regolo-live:gate -- --no-manifest-update`

Matrix step logs record **allowlisted** env key names only (values never written); credential key names are redacted from summaries (`f3a58b5`).

### Strict harness operator knobs

Same live-harness env overrides as Z.ai (`RECTOR_LIVE_HARNESS_MAX_RUNTIME_MS`, `RECTOR_LIVE_HARNESS_*_MAX_OUTPUT_TOKENS`). See `docs/operations/zai-live-verification.md` § Strict harness operator knobs — including the warning **not** to leave cap overrides exported in a shell that also runs `npm run verify:regolo-live` (offline `verify:phase2` unit tests read `process.env`).

## Commands (quick reference)

| Script | Purpose |
|--------|---------|
| `npm run probe:regolo-models` | Cheap callability probe |
| `npm run test:live:regolo:provider` | Provider smoke (`RECTOR_REGOLO_PROVIDER_SMOKE=1`) |
| `RECTOR_LIVE_PROVIDER=regolo npm run eval:facts:live` | Phase 2 live fact shadow |
| `npm run test:live:regolo:harness` | Harness smoke (`LIVE_HARNESS_EVALS=1`) |
| `npm run evidence:regolo-live:gate` | Strict gate (manifest update on PASS) |
| `npm run verify:regolo-live` | Full offline phase2 + live chain + gate |
| `npm run verify:regolo-live:matrix` | Multi-model compare (`--no-manifest-update` on gate) |

Do not commit raw `.rector/evidence` live artifacts. Do not claim live verification passed without a gate PASS recording `live_provider` evidence.