# Z.ai live verification (operator)

Rector separates **offline** gates from **live** Z.ai verification. Offline infrastructure can be complete while live status remains **unverified** until a real non-fake provider campaign passes `npm run verify:zai-live`.

## Evidence layout

- Canonical root: `.rector/evidence`
- Legacy compatibility only: `.omo/evidence` (migrate with `npm run evidence:migrate-local` when needed)
- Z.ai live harness rollups: `.rector/evidence/live/zai/latest.json` and `latest.md`
- Per-run artifacts: `.rector/evidence/live/zai/runs/<run-id>/`
- Provider smoke: `.rector/evidence/live/zai/provider-smoke.json`
- Phase 2F live fact shadow: `.rector/evidence/phase2/live-fact-shadow-report.json`

## Offline vs live

| Command | Network / secrets | What it proves |
| --- | --- | --- |
| `npm test` | No | Deterministic unit/integration tests |
| `npm run verify:phase2` | No | Typed-fact substrate offline |
| `npm run verify:zai-live` | Yes (when configured) | Live Z.ai provider + harness + evidence gate |

Do **not** claim `zai-live-verified` or update phase labels to live-verified unless `npm run evidence:zai-live:gate` passes against evidence with `liveEvidenceStatus: live_provider` from a real configured provider (not spy/fake/test injection).

## Operator steps (live campaign)

1. Configure Z.ai OpenAI-compatible credentials (UI `runtime-settings.json` or env):
   - `RECTOR_LIVE_PROVIDER=zai`
   - `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL` (Z.ai host, e.g. `api.z.ai`), `OPENAI_COMPATIBLE_MODEL`
2. Optional path check: `npm run evidence:verify-paths`
3. Provider smoke: `RECTOR_ZAI_PROVIDER_SMOKE=1 npm run test:live:zai:provider` (or `tsx scripts/live/run-zai-provider-smoke.ts`)
4. Phase 2F shadow: `npm run eval:facts:live`
5. Harness smoke (orchestrated chat): `LIVE_HARNESS_EVALS=1 npm run test:live:zai:harness` (or `tsx scripts/live/run-zai-harness-smoke.ts`)
6. Gate: `npm run evidence:zai-live:gate`
7. Full chain: `npm run verify:zai-live`

## Gate behavior

`scripts/live/gate-zai-live-evidence.ts` reads `latest.json`, required run artifacts, provider smoke, and Phase 2F summary. It **fails** when:

- `liveEvidenceStatus !== live_provider`
- Provider is fake/deterministic/spy/mock/fixture/scripted/test-double
- Host is not Z.ai-compatible or adapter is not `openai-compatible`
- Required files or redacted prompts/outputs are missing
- Campaign tokens exceed **100,000** or model calls are zero
- Read-only / plan-only / safety scenarios mutated source files
- Secret-like values appear in evidence
- Scorecard or track reports do not pass

On **PASS** only, it may update `.rector/evidence/manifest.json` with `liveEvidenceStatus`, `secretScanPassedAt`, and campaign budget rollup.

## Budget

First live campaign hard limit: **100,000 total tokens** across provider smoke, Phase 2F shadow, and harness smoke.