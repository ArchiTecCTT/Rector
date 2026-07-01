# Regolo live verification (operator)

Regolo is wired as an opt-in live evidence track parallel to Z.ai. Normal product configuration remains `runtime-settings.json` / UI; env vars are operator and test overrides only.

## Prerequisites

- `RECTOR_LIVE_PROVIDER=regolo`
- `REGOLO_API_KEY`, `REGOLO_BASE_URL` (e.g. `https://api.regolo.ai/v1`), `REGOLO_MODEL`
- Optional list: `REGOLO_MODELS` for matrix/probe (comma/space/newline separated)

Model IDs and `/models` metadata must be validated via live probe; candidate examples include `qwen3.5-9b`, `Llama-3.3-70B-Instruct`, `mistral-small-4-119b` — treat callability as unknown until `npm run probe:regolo-models` records results.

## Evidence layout

- Rollups: `.rector/evidence/live/regolo/latest.json` and `latest.md`
- Per-run: `.rector/evidence/live/regolo/runs/<run-id>/`
- Provider smoke: `.rector/evidence/live/regolo/provider-smoke.json`
- Phase 2 shadow (shared track): `.rector/evidence/phase2/live-fact-shadow-report.json`
- Matrix: `.rector/evidence/live/regolo/matrix/matrix-summary.{json,md}`
- Probe: `.rector/evidence/live/regolo/model-probe/latest.json`

Matrix runs overwrite shared canonical rollups (last writer wins). Use per-model snapshots under `matrix/<safe-model-id>/<run-index>/` for comparisons. Matrix grades do **not** imply live-verified status.

## Commands

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