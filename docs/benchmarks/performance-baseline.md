# Rector Local Performance Baseline

## Goals

Measure **real local/provider-free performance** so we can tell whether the growing codebase is actually slow. This benchmark is about **measurement and repeatable evidence**, not optimization.

- Run without provider keys, network, live memory providers, or sandbox credentials
- Stay deterministic and zero-config (same regression baseline as `npm test`)
- Produce a concise table suitable for CI logs or local before/after comparisons
- Keep thresholds **advisory** until enough baseline history exists across machines

## Commands

```bash
npm run benchmark:performance
npm run benchmark:performance -- --enforce
```

| Command | Purpose |
|---|---|
| `npm run benchmark` | Regression/task benchmark harness (`src/bin/benchmark.ts`) — correctness and failure modes |
| `npm run benchmark:performance` | Latency baseline (`scripts/performance-baseline.ts`) — local-mode speed evidence |

### Flags

- **`--enforce`**: exit non-zero when any measured value exceeds the **acceptable** threshold. Default behavior exits zero even when thresholds are exceeded (advisory mode).

## Local-mode constraints

The script must never:

- Call external networks or live provider APIs
- Read or print secrets
- Initialize Mem0, Chroma, TiDB, or E2B
- Require `.env` or UI configuration

It uses in-memory stores, deterministic orchestration (`runFakeChatRun`), and the same `createApp` wiring as integration tests.

## Benchmark catalog

| Section ID | What is measured |
|---|---|
| `startup_import` | Dynamic import of `src/api/server` + `createApp(new TaskManager())` (warm, in-process) |
| `startup_cold_subprocess` | Fresh Node subprocess running `scripts/performance-baseline-cold-start.ts` via tsx (median of 3 wall-clock spawns) |
| `startup_cold_compiled_subprocess` | Fresh Node subprocess running `scripts/performance-baseline-cold-start-compiled.mjs` against `dist/` (requires `npm run build`) |
| `pipeline_triage` | `triageUserMessage` phase of the local fake pipeline |
| `pipeline_context_building` | `buildContextPack` phase of the local fake pipeline |
| `pipeline_planning` | `PLANNING` observability span inside `runFakeChatRun` |
| `pipeline_executing` | `EXECUTING` observability span inside `runFakeChatRun` |
| `pipeline_synthesizing` | `SYNTHESIZING` observability span inside `runFakeChatRun` |
| `local_direct_answer` | `triageUserMessage` + `synthesizeChatBrainstemResponse` on `DIRECT_ANSWER` |
| `local_fake_pipeline` | Full local brainstem via `runFakeChatRun` |
| `orchestration_assignment_resolution` | `resolveEffectiveAssignment` for all orchestration roles |
| `memory_role_resolution` | `MemoryRoleRouter.resolveMemoryProvider` for all memory roles |
| `template_preview` | Built-in `local-free` template preview (no secret reads) |
| `context_builder_1k` | `buildContextPack` with ~1,000 episodic memory entries (setup excluded from timing) |
| `api_setup_status` | `GET /api/setup/status` via supertest |
| `api_orchestration_models_effective` | `GET /api/orchestration-models/effective` |
| `api_memory_assignments_effective` | `GET /api/memory-assignments/effective` |
| `api_templates` | `GET /api/templates` |

### Interpretation notes

- **`startup_import`** measures in-process module import + app factory time after the benchmark script is already running (warm).
- **`startup_cold_subprocess`** spawns a fresh Node+tsx process via `performance-baseline-cold-start.ts` and records parent wall-clock time (median of 3).
- **`startup_cold_compiled_subprocess`** spawns plain `node` against compiled `dist/api/server.js` (median of 3). Skipped with reason when `dist/` is absent.
- **Pipeline phase rows** break down `local_fake_pipeline` into TRIAGE, CONTEXT_BUILDING, PLANNING, EXECUTING, and SYNTHESIZING (median of 3 runs). Phase spans come from the in-memory observability trace.
- **Context builder** pre-builds 1,000 synthetic `MemoryEntry` values; only `buildContextPack` is timed.
- Noisy paths use the **median of 3 iterations**; pure CPU resolution loops use a single iteration.
- Threshold exceedances are warnings unless `--enforce` is passed.

## Advisory thresholds

| Benchmark | Preferred | Acceptable |
|---|---|---|
| Server startup / import warm (`startup_import`) | < 1s | < 2s |
| Server startup / import cold subprocess tsx (`startup_cold_subprocess`) | < 1s | < 2s |
| Server startup / import cold subprocess compiled (`startup_cold_compiled_subprocess`) | < 1s | < 2s |
| Local direct answer (`local_direct_answer`) | < 100ms | < 250ms |
| Local full fake pipeline total (`local_fake_pipeline`) | < 500ms | < 1s |
| Pipeline TRIAGE (`pipeline_triage`) | < 10ms | < 25ms |
| Pipeline CONTEXT_BUILDING (`pipeline_context_building`) | < 50ms | < 100ms |
| Pipeline PLANNING (`pipeline_planning`) | < 50ms | < 150ms |
| Pipeline EXECUTING (`pipeline_executing`) | < 50ms | < 150ms |
| Pipeline SYNTHESIZING (`pipeline_synthesizing`) | < 50ms | < 150ms |
| Orchestration assignment resolution (`orchestration_assignment_resolution`) | < 10ms | < 25ms |
| Memory role resolution (`memory_role_resolution`) | < 10ms | < 25ms |
| Template preview (`template_preview`) | < 50ms | < 100ms |
| Context builder 1K memories (`context_builder_1k`) | < 100ms | < 250ms |
| Settings / setup API (`api_setup_status`) | < 100ms | < 250ms |
| Other local API routes (`api_*`) | < 100ms | < 250ms |

## Smoke test

`tests/performanceBaseline.test.ts` runs the script in CI/local suites. It asserts:

- exit code `0` (without `--enforce`)
- expected section IDs appear in stdout
- output does not contain secret-like values

It does **not** assert millisecond timings.

## Related docs

- [`docs/plans/concerns-and-vulnerabilities.md`](../plans/concerns-and-vulnerabilities.md) — performance measurement concern register entry
- [`docs/architecture/current-rector-byok-architecture.md`](../architecture/current-rector-byok-architecture.md) — local/provider-free baseline architecture