# Z.ai live verification (operator)

Rector separates **offline** gates from **live** Z.ai verification. Offline infrastructure can be complete while live status remains **unverified** until a real non-fake provider campaign passes `npm run verify:zai-live`.

## First foundation discovery run (2026-07-01)

Rector’s **first** live Z.ai foundation discovery campaign on branch `zai-evidence-live-integration` (after evidence-path + no-fakes hardening). **Live verification did not pass** — do not relabel Phase 2 or harness milestones as live-verified.

| Item | Result |
| --- | --- |
| Preflight | `evidence:verify-paths`, strict `audit:no-fakes:check`, clean worktree, env loaded |
| Probe (`probe:zai-models` + JSON capability) | 9/10 callable; `glm-4.6v-flash` skipped (HTTP 429 / overload); only `glm-4-32b-0414-128k` reported JSON capability **supported** |
| Matrix (`verify:zai-live:matrix`, 1 run/model, pre-filter + JSON probe) | `overallStatus: fail` — **0** pass / **9** fail / **1** skipped (probe) |
| Follow-up intentionally skipped | No 10-run matrix repeat and no finalist `verify:zai-live` — discovery found **zero** full-chain gate passes |

**Failure pattern (evidence-backed):** Most flash / air / turbo / vision-turbo candidates failed at `eval:facts:live` with `model_json_invalid` and schema/provenance failures (see per-model `phase2-live-fact-shadow-report.json` under matrix snapshots). `glm-4-32b-0414-128k` was the only candidate that completed Phase 2F live shadow **5/5** and provider smoke, then failed live harness on orchestration schema/validation (e.g. skeptic `findings.*.recommendation`, planner `dependencies` / `approvalGates` — `provider_json` / validation after one repair). Treat it as the **best current finalist / debug target**, not a verified pass.

**What this run did prove:** Real Z.ai OpenAI-compatible calls, `live_provider` evidence, no auth failure, no systemic quota failure in matrix diagnostics, no secret leakage in artifacts, and gate rejection of fake/spy doubles remains intact. Matrix is **comparison/discovery only** (no manifest update).

**Operator interpretation (not a harness change):** Strict gate + harness behavior appears useful; failures look like **model ↔ schema/instruction mismatch**. Likely follow-on is model-specific prompting, adapters, or fine-tuning — **not** relaxing the harness for live-verified claims.

**Artifact pointers (local, gitignored):**

- `.rector/evidence/live/zai/model-probe/latest.json`
- `.rector/evidence/live/zai/matrix/matrix-summary.json` (`generatedAt` ~2026-07-01T04:04:37Z)
- Per-model snapshots: `.rector/evidence/live/zai/matrix/<safe-model-id>/0/` (e.g. `phase2-live-fact-shadow-report.json`, `latest.json`)

**Caution:** Shared canonical rollups (`.rector/evidence/live/zai/latest.json`, root Phase 2 shadow) are **last-writer-wins** during matrix runs. Prefer `matrix-summary.json` and per-model snapshot paths for triage; a snapshot’s copied `latest.json` can disagree with the model that “won” the shared rollup.

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

### Harness diagnostics (operator / partner triage)

Live harness, provider smoke, and matrix summaries include a `diagnostics` block (`rector.zai-live-diagnostics.v1`):

- **Provider failure taxonomy** — `rate_limit`, `quota`, `timeout`, `provider_http`, `provider_json`, `unknown` (derived from provider HTTP status, retryability, and error codes when available; otherwise `unknown`).
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