# phase-0-benchmarks - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** A measuring stick for the whole SLM project, built before any money is spent on live models. It defines what "good" means (eval data shapes, a place to store raw tool output safely, and eight pass/fail quality thresholds), ships a test corpus made of real tool output with known-correct answers, an offline scorer that produces a readable report, and a "fake detector" that scans the codebase and tells you where simulated/placeholder systems are hiding — without breaking the build.

**Why this approach:** You can't promote tools that "pass" until you can measure passing honestly. Phase 0 makes quality and fakeness measurable first, fully offline, so later phases have an objective ruler and the fake-detector starts as a quiet report rather than a tripwire that would fail the build on day one.

**What it will NOT do:** It won't call any real AI model. It won't delete or change any of the existing placeholder systems. It won't fail CI when it finds those placeholders.

**Effort:** Medium
**Risk:** Low — all new files, offline, no runtime behavior changed.
**Decisions to sanity-check:** report-only audit (not a build gate yet); plan mirrored into tracked docs so worktree agents can read it; real-fixture corpus (no hand-faked tool output).

Your next move: approve, or ask for the dual high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Medium / Low. 8 todos, all offline, all-new files. Deliver eval schemas + raw-artifact store + 8-threshold metrics + real-fixture corpus + offline runner + report-only fake-audit; wire npm scripts; mirror plan to docs/plans/2-0/phases/. No live providers, no purges, no CI-blocking.

## Scope
### Must have
- A versioned, Zod-validated eval data model: `CapabilityEvalCaseSchema` and `CapabilityEvalResultSchema`.
- A raw-artifact-store contract (interface + local filesystem implementation) that hashes, redacts, and references raw tool output by handle — the substrate every later capability eval depends on.
- A cost/context metric module that encodes the 8 Phase-0 thresholds as named, testable constants and a scoring function.
- A test-corpus directory layout (`tests/fixtures/eval-corpus/`) with a documented manifest schema and at least 3 committed real-artifact fixture cases (NOT mocked).
- An eval runner (`scripts/evals/run-capability-evals.ts`) that loads cases, runs them against a deterministic oracle (no live provider), and emits a JSON + Markdown report.
- A **report-only** fake-detector audit script (`scripts/audit/no-production-fakes.ts`) that scans `src/**` and prints findings; it exits nonzero ONLY if the script itself errors, never on known fakes.
- New npm scripts wired: `eval:capabilities`, `eval:capabilities:report`, `audit:no-fakes`.
- A committed tracked mirror of this plan at `docs/plans/2-0/phases/phase-0-benchmarks.md`.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- NO live provider calls (no Regolo, no Azure, no Cloudflare) — Phase 0 runs fully offline. Live eval is Phase 2.5.5 / Phase 9.
- NO purging or modifying of existing fake systems (`FakeLLMProvider`, `createFakePlan`, `simulator.echo`, `workspace.validate`). Phase 0 only MEASURES them. Purges are Phase 3 + the fake-purge workstream.
- NO CI-blocking on detected fakes. The audit is report-only this phase; it becomes a gate in Phase 13.
- NO mocked-success tests: no mocked validator returning pass, no mocked SLM accuracy, no fake planner output counted as production proof. (Deterministic fixtures and spies for schema/policy/budget/redaction behavior ARE allowed.)
- NO coding-agent benchmarking against live repos — only schema + fixture-driven runner scaffolding.
- NO changes to `src/orchestration`, `src/providers`, or `src/tools` runtime behavior.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after within the same todo** (implementation + test = one todo) using the existing Vitest + fast-check stack (`vitest run`). Each todo's test file lives under `tests/capabilities/` or `tests/evals/`.
- "No fake tests" precise rule (per user): deterministic fixtures + spies are PERMITTED for schema/policy/budget/redaction assertions. FORBIDDEN is fake success — a mocked validator reporting pass, a mocked SLM whose accuracy is then measured, or fake planner output treated as production proof. Every todo carries a `Fake-risk check` line stating which side of this line it sits on.
- Evidence: `.omo/evidence/task-<N>-phase-0-benchmarks.<ext>` (command transcript or report artifact).
- Gate commands (must all pass before phase complete): `npm test`, `npm run check`, `npm run build`, `npm run audit:no-fakes` (report-only, exits 0), `npm run eval:capabilities` (offline, green).

## Execution strategy
### Worktree + PR preamble (executing agent reads this FIRST)
- Phase 0 starts from branch `rector-0.3.0`. The executing agent creates a dedicated worktree branch `rector-0.3.0-phase0-benchmarks` off `rector-0.3.0` and opens a PR back into `rector-0.3.0` when the phase completes.
- Because `.omo/` is gitignored (`.gitignore:43`), the authoritative copy the agent follows is the tracked mirror `docs/plans/2-0/phases/phase-0-benchmarks.md`. Todo 1 verifies the local branch state directly (GitHub view alone is insufficient).
- GOTCHA (verified): the whole `docs/plans/2-0` tree is gitignored (`.gitignore:50`), so the mirror is NOT trackable until that is un-ignored. Todo 8 adds a negation pattern `!docs/plans/2-0/phases/` (and `!docs/plans/2-0/phases/**`) so ONLY the `phases/` subdir becomes trackable while the bulky source package under `docs/plans/2-0/` stays ignored. The user (who authored `.gitignore:50`) approved this un-ignore.
- Every todo ends in its own commit (commit-per-task). Conventional Commit messages, scoped `eval`/`audit`/`capabilities`/`docs`.

### Parallel execution waves
> Target 5-8 todos per wave.
- **Wave 1 (foundation, mostly sequential):** Todo 1 (branch verify) → Todo 2 (eval schemas) → Todo 3 (raw-artifact store). Todo 2 and 3 can overlap after 1.
- **Wave 2 (builds on schemas):** Todo 4 (metrics module), Todo 5 (corpus layout + fixtures), Todo 6 (eval runner). 4 and 5 parallelize; 6 depends on 2+3+4+5.
- **Wave 3 (audit + wiring):** Todo 7 (report-only audit script), Todo 8 (npm scripts + tracked mirror + concerns-doc update). 7 and 8 parallelize.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 branch verify | — | all | — |
| 2 eval schemas | 1 | 4,6,7 | 3 |
| 3 raw-artifact store | 1 | 6 | 2 |
| 4 metrics module | 2 | 6 | 3,5 |
| 5 corpus + fixtures | 1 | 6 | 4 |
| 6 eval runner | 2,3,4,5 | 8 | — |
| 7 audit script | 2 | 8 | 5,6 |
| 8 scripts + mirror + concerns | 6,7 | 9 | — |
| 9 doc sync | 8 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Verify local branch state and create the phase-0 worktree
  What to do: Run `git branch --show-current` and `git status --short` from the repo root and capture both. Confirm the current branch is `rector-0.3.0` (or the agreed phase base) and the tree has no unrelated staged changes. Then create worktree `rector-0.3.0-phase0-benchmarks` off `rector-0.3.0` for all subsequent work. Record the captured output to the evidence file.
  Must NOT do: do NOT proceed if the branch is unexpected or the tree has unexplained modifications — stop and surface to the operator. Do NOT rely on the GitHub web view to determine the active local branch.
  Parallelization: Wave 1 | Blocked by: none | Blocks: all
  References: AGENTS.md (Current Branch / Worktree section); `.gitignore:43` (.omo gitignored); existing worktree pattern `git worktree list` shows `.worktrees/rector-0.3.0-cartographer`.
  Acceptance criteria (agent-executable): evidence file contains the verbatim output of `git branch --show-current` and `git status --short`; `git worktree list` shows the new `rector-0.3.0-phase0-benchmarks` worktree.
  QA scenarios: happy — `git branch --show-current` prints the expected base branch; failure — simulate from a detached HEAD or wrong branch and confirm the recorded procedure says STOP. Evidence `.omo/evidence/task-1-phase-0-benchmarks.txt`
  Fake-risk check: N/A (git inspection only, no test logic).
  Commit: Y | chore(phase0): create phase-0 benchmarks worktree and record branch verification

- [x] 2. Define CapabilityEvalCase + CapabilityEvalResult Zod schemas
  What to do: Create `src/capabilities/eval/schemas.ts` exporting `CapabilityEvalCaseSchema`, `CapabilityEvalResultSchema`, and inferred types. The case schema carries `id`, `capabilityId`, `workspaceRef`, `request` (intent/scope/queryHints), and an `oracle` block (`mustIncludePaths`, `mustIncludeLineContains`, `mustNotClaimPaths`) per plan lines 2426-2442. The result schema carries `caseId`, `capabilityId`, `passed`, per-metric scores, `omissions`, `rawArtifactRefs`, `failureReason?`. Add `tests/capabilities/capabilitySchemas.test.ts` proving valid cases parse and malformed cases reject.
  Must NOT do: do NOT import from `src/providers` or call a model. Schemas only.
  Parallelization: Wave 1/2 | Blocked by: 1 | Blocks: 4,6,7 | parallel with 3
  References: schema example plan lines 2426-2442; Phase 0 deliverables plan lines 1604-1646; Zod patterns `src/protocol/events.ts:40-71`; barrel style `src/protocol/schemas.ts`; test style `tests/cartographer/inventoryStore.sqlite.test.ts:1-50`.
  Acceptance criteria (agent-executable): `npm test -- capabilitySchemas` passes; `npm run check` clean; schema rejects a case missing `oracle`.
  QA scenarios: happy — a fixture case with full oracle parses and round-trips; failure — `mustIncludePaths` as non-array throws ZodError with a clear path. Evidence `.omo/evidence/task-2-phase-0-benchmarks.txt`
  Fake-risk check: ALLOWED — pure schema/validation tests with deterministic fixtures. No mocked success.
  Commit: Y | feat(capabilities): add CapabilityEvalCase/Result schemas with tests

- [x] 3. Define raw-artifact-store contract + local filesystem implementation
  What to do: Create `src/capabilities/eval/artifactStore.ts` with a `RawArtifactStore` interface (`store(input)`, `read(ref)`, `list(runId?)`) and a `LocalFsRawArtifactStore` writing to `.rector/artifacts/<runId>/<hash>.<ext>`. Each stored artifact records `uri`, `sha256`, `sizeBytes`, `redactionState`. Reuse the existing redaction util. Add `tests/capabilities/artifactStore.test.ts` using a real temp-dir fixture proving store→read round-trip, hash stability, and that secret-like strings are redacted before write.
  Must NOT do: do NOT dump artifacts into model context; store-by-handle only. Do NOT use an in-memory mock as the only test — use a real temp directory (`os.tmpdir()`).
  Parallelization: Wave 1/2 | Blocked by: 1 | Blocks: 6 | parallel with 2
  References: redaction util via `grep -rn "redactSecrets" src/security src/tools/builtinTools.ts:127`; raw artifact fact shape plan lines 945-951; real-temp-dir convention `tests/cartographer/*`; `.rector/` path plan lines 1122,1728-1731.
  Acceptance criteria (agent-executable): `npm test -- artifactStore` passes; round-trip returns identical bytes; recorded `sha256` matches an independent hash; a planted fake secret does not appear in the written file.
  QA scenarios: happy — store a 50KB blob, read byte-identical, ref carries correct size+hash; failure — store input with an `sk-...`-style secret and assert persisted file is redacted and `redactionState` flags it. Evidence `.omo/evidence/task-3-phase-0-benchmarks.txt`
  Fake-risk check: ALLOWED — real temp-dir fixtures + deterministic hash oracle. No mocked success; redaction asserted against real file bytes.
  Commit: Y | feat(capabilities): add raw-artifact-store contract + local fs impl

- [x] 4. Define cost/context metric module with the 8 Phase-0 thresholds
  What to do: Create `src/capabilities/eval/metrics.ts` exporting named threshold constants (plan lines 1631-1639: schema_valid≥0.99, recall≥0.95, omission≤0.02, secret_leak==0, compression≥10x, raw_token_reduction≥0.80, line_ref_accuracy≥0.90, root_cause_accuracy≥0.85) and `scoreEvalResults(results): MetricSummary`. Add `tests/capabilities/metrics.test.ts` with deterministic input arrays proving each metric computes correctly and threshold pass/fail flags set.
  Must NOT do: do NOT invent thresholds; mirror the plan exactly. Do NOT measure any live model.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 6 | parallel with 3,5
  References: thresholds plan lines 1630-1639; metric defs plan lines 504-513,2386-2389; `CapabilityEvalResult` from Todo 2.
  Acceptance criteria (agent-executable): `npm test -- metrics` passes; a results array with known recall produces the expected number; threshold flags flip at boundary values.
  QA scenarios: happy — 10 results, 1 critical omission → omission 0.10 → flagged failing vs 0.02 max; failure — empty array returns a defined "insufficient data" state, not NaN. Evidence `.omo/evidence/task-4-phase-0-benchmarks.txt`
  Fake-risk check: ALLOWED — pure arithmetic over deterministic fixtures. No mocked success.
  Commit: Y | feat(capabilities): add eval metric thresholds + scoring module

- [x] 5. Create test-corpus layout + manifest schema + 3 real-artifact fixtures
  What to do: Create `tests/fixtures/eval-corpus/` with `manifest.schema.ts` (Zod), `manifest.json`, and ≥3 committed REAL fixture cases (captured real `rg` output over a tiny fixture repo, a real `tsc --noEmit` error transcript, a real `git diff` transcript) each paired with a deterministic oracle answer and the recorded production command. Add `tests/capabilities/corpus.test.ts` validating the manifest parses and every referenced fixture exists.
  Must NOT do: do NOT fabricate tool output by hand and label it "real" — each artifact must be genuinely produced by running the actual tool over a committed fixture, command recorded. Do NOT require network.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6 | parallel with 4
  References: corpus layout plan lines 2408-2422; case shape plan lines 2426-2442; real-artifact rule plan lines 2339-2356; fixture-repo convention `tests/cartographer/repoScannerTestHarness.ts`.
  Acceptance criteria (agent-executable): `npm test -- corpus` passes; manifest validates; each fixture's production command is present; oracle answers committed alongside.
  QA scenarios: happy — manifest with 3 fixtures parses, all files resolve; failure — manifest referencing a missing fixture fails validation naming the missing path. Evidence `.omo/evidence/task-5-phase-0-benchmarks.txt`
  Fake-risk check: ALLOWED + core "no fake" guarantee — artifacts are real tool output, oracles deterministic. Hand-faked output explicitly banned here.
  Commit: Y | test(capabilities): add eval corpus layout, manifest schema, real fixtures

- [x] 6. Build the offline eval runner emitting JSON + Markdown reports
  What to do: Create `scripts/evals/run-capability-evals.ts` that loads the corpus manifest, scores each case against its committed DETERMINISTIC oracle (no live provider — Phase 0 proves harness wiring by comparing committed expected answers), aggregates via `scoreEvalResults`, and writes `.omo/evidence/eval-report.json` + `eval-report.md`. Create `scripts/evals/score-capability-results.ts` (formatter). Add `tests/evals/runner.test.ts` invoking the runner programmatically against the committed corpus and asserting a report with all metrics is produced.
  Must NOT do: do NOT call any model. Runner must run WITHOUT product chat and WITHOUT credentials. Do NOT mark a case "passed" without comparing to its committed oracle.
  Parallelization: Wave 2/3 | Blocked by: 2,3,4,5 | Blocks: 8
  References: exit criteria plan lines 1641-1646; runner targets plan lines 1556-1559,2002-2006; metrics Todo 4; corpus Todo 5; artifact store Todo 3.
  Acceptance criteria (agent-executable): `npm run eval:capabilities` exits 0 offline and writes both reports; report contains all 8 metrics; a deliberately wrong oracle expectation produces a recorded failure case, not a silent pass.
  QA scenarios: happy — run over 3-fixture corpus → report shows per-case pass/fail + aggregate; failure — corrupt one oracle → runner records that case failed and writes a regression artifact. Evidence `.omo/evidence/task-6-phase-0-benchmarks.txt`
  Fake-risk check: ALLOWED — scores against committed deterministic oracles, no model. Offline-by-design; no mocked output counted as proof.
  Commit: Y | feat(evals): add offline capability eval runner + report formatter

- [x] 7. Build the REPORT-ONLY no-production-fakes audit script
  What to do: Create `scripts/audit/no-production-fakes.ts` scanning `src/**` (excluding `tests/**`) for the 6 fake-leak patterns (plan lines 2586-2593). NOTE (verified): 4 patterns have CURRENT matches and 2 are FORWARD-LOOKING with zero current matches — `src/** imports tests/support/**` and `src/** imports runFakeChatRun` both currently return NONE (`grep -rn` confirmed). The script must implement all 6 detectors but the test/acceptance must assert the 4 currently-present patterns are found AND the 2 forward-looking patterns return zero matches today (they guard against future regressions). It PRINTS a findings report (count + file:line per pattern) and exits 0 even when fakes are found; it exits NONZERO only on its own internal error (e.g. cannot read src). Add `tests/audit/noProductionFakes.test.ts` proving (a) it detects the 4 currently-known fakes at their real locations, (b) the 2 forward-looking patterns report zero current matches, (c) it exits 0 in report-only mode, (d) it exits nonzero pointed at a nonexistent root.
  Must NOT do: do NOT fail CI on detected fakes this phase. Do NOT modify or remove any fake — detection only. Do NOT drop the 2 forward-looking detectors just because they have no current matches.
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 8 | parallel with 5,6
  References: audit rules plan lines 2576-2605; VERIFIED current-match fake locations `src/providers/llm.ts:172,905,927` (FakeLLMProvider), `src/orchestration/planner.ts:164,816,826` (createFakePlan/fallbackPlan), `src/tools/builtinTools.ts:111` (fake validate passed:true),`:119,:127` (simulator.echo), executorSimulator importers `src/orchestration/{chatRunner,validationHealing,synthesizer,index,sandboxExecutor}.ts` + `src/api/server.ts`; VERIFIED zero-current-match (forward-looking): `runFakeChatRun` and `tests/support` imports in `src/` both return NONE; report-only requirement (user note); fake-purge flow plan lines 2572-2605.
  Acceptance criteria (agent-executable): `npm run audit:no-fakes` exits 0 and prints a findings table listing the 4 currently-known fakes at their verified line numbers and showing 0 matches for the 2 forward-looking patterns; test confirms exit 0 with findings present; test confirms nonzero exit on a broken/missing scan root.
  QA scenarios: happy — run against current `src/` → report lists FakeLLMProvider, createFakePlan, simulator.echo, fake validate (4 patterns matched), runFakeChatRun + tests/support imports (0 matches), exit 0; failure — point at `/nonexistent` → errors, exits nonzero with a clear message. Evidence `.omo/evidence/task-7-phase-0-benchmarks.txt`
  Fake-risk check: ALLOWED — test asserts the detector finds REAL fakes at real locations and that forward-looking patterns are genuinely absent; no faked success. Report-only is the deliberate, stated design.
  Commit: Y | feat(audit): add report-only no-production-fakes detector with tests

- [x] 8. Un-ignore the phases mirror dir, wire npm scripts, commit tracked plan mirror, update concerns doc
  What to do: FIRST add negation patterns to `.gitignore` immediately after line 50 (`docs/plans/2-0`): add `!docs/plans/2-0/phases/` and `!docs/plans/2-0/phases/**` so the `phases/` subdir becomes trackable while the rest of `docs/plans/2-0/` stays ignored; verify with `git check-ignore -v docs/plans/2-0/phases/phase-0-benchmarks.md` printing NOTHING (exit 1 = not ignored). THEN add `audit:no-fakes`, `eval:capabilities`, `eval:capabilities:report` to `package.json` scripts. Create the tracked mirror `docs/plans/2-0/phases/phase-0-benchmarks.md` and `git add` it (confirm it stages — not ignored). Append a Phase 0 entry to `docs/plans/concerns-and-vulnerabilities.md` recording the known fakes detected (report-only, deferred to purge phases) and any test gaps. Run the full gate suite and capture output.
  Must NOT do: do NOT make `audit:no-fakes` a CI failing gate yet (Phase 13). Do NOT alter unrelated package.json scripts. Do NOT broaden the negation to un-ignore the whole `docs/plans/2-0/` source package — only `phases/`.
  Parallelization: Wave 3 | Blocked by: 6,7 | Blocks: none
  References: gitignore conflict VERIFIED `git check-ignore -v` -> `.gitignore:50:docs/plans/2-0`; negation-pattern semantics (a `!` line un-ignores a subpath of a previously-ignored dir; the parent dir itself must remain matchable, which `docs/plans/2-0` is since it has no trailing-only file match); script names plan lines 2598-2603,2002-2006; concerns-doc rule AGENTS.md (Security / Concerns Rule); mirror requirement (user note); tracked-doc rationale (`.omo/` gitignored at `.gitignore:43`).
  Acceptance criteria (agent-executable): `git check-ignore -v docs/plans/2-0/phases/phase-0-benchmarks.md` exits 1 (no output = not ignored); `git add docs/plans/2-0/phases/phase-0-benchmarks.md` stages the file (appears in `git status --short`); all of `npm test`, `npm run check`, `npm run build`, `npm run audit:no-fakes`, `npm run eval:capabilities` pass/exit-0; concerns doc has a dated Phase 0 entry.
  QA scenarios: happy — after the `.gitignore` negation, the mirror stages and commits, full gate suite green, PR opened to rector-0.3.0; failure — if `git check-ignore` still reports the file ignored (negation typo) the agent fixes the pattern before proceeding and does NOT force-add. Evidence `.omo/evidence/task-8-phase-0-benchmarks.txt`
  Fake-risk check: N/A (gitignore + wiring + docs). Verification runs the REAL gate suite, not a stand-in.
  Commit: Y | chore(phase0): un-ignore phases mirror, wire eval/audit scripts, mirror plan, update concerns

- [ ] 9. Sync source-of-truth docs so nothing goes stale (worker does this directly — NO subagent)
  What to do: As the FINAL step before opening the PR, the executing agent directly updates the broader source-of-truth docs to reflect Phase 0 completion. Update each of the following only where the phase changed reality: (a) `docs/plans/rector-master-roadmap.md` — mark Phase 0 (benchmarks + eval scaffolding) status as done/landed with the PR/branch reference; (b) `AGENTS.md` — refresh the test baseline line to the FRESH `npm test` counts captured in Todo 8 (do NOT hand-wave; copy the real numbers), and note the new `src/capabilities/eval/*`, `scripts/evals/*`, `scripts/audit/*` surfaces + the new npm scripts under Build/Test commands; (c) confirm the Phase 0 entry already appended to `docs/plans/concerns-and-vulnerabilities.md` in Todo 8 is present and accurate (do not duplicate). Capture a before/after diff summary to the evidence file.
  Must NOT do: do NOT delegate this to a librarian/explore/oracle subagent — AGENTS.md mandates foreground-only and flags subagents as flaky in this repo; the worker who holds the real diff does it directly. Do NOT invent test numbers — use the actual Todo 8 gate output. Do NOT rewrite unrelated doc sections or touch architecture docs the phase did not affect. Do NOT mark any later phase done.
  Parallelization: Wave 3 (tail) | Blocked by: 8 | Blocks: none
  References: roadmap `docs/plans/rector-master-roadmap.md`; baseline + commands `AGENTS.md` ("Current Implemented Chunks", "Build / Test Commands", test-baseline line e.g. "213 files / 1369 tests"); concerns `docs/plans/concerns-and-vulnerabilities.md`; foreground-only rule `AGENTS.md` ("No background/async subagents; foreground only") + global AGENTS.md ("Background subagents... fail or go stale... Prefer direct tools").
  Acceptance criteria (agent-executable): `git diff --name-only` for this commit includes `docs/plans/rector-master-roadmap.md` and `AGENTS.md`; the AGENTS.md test-baseline number matches the count in `.omo/evidence/task-8-phase-0-benchmarks.txt`; roadmap shows Phase 0 done and no later phase marked done; `npm test` + `npm run build` still green after the doc edits.
  QA scenarios: happy — roadmap + AGENTS.md updated to match real Phase 0 state, diff captured, gates still green, PR opened; failure — if the captured test count and the AGENTS.md number disagree, the agent fixes AGENTS.md to the real number before committing (never the reverse). Evidence `.omo/evidence/task-9-phase-0-benchmarks.txt`
  Fake-risk check: N/A (docs). The acceptance ties doc numbers to REAL gate output, so docs cannot record a fake baseline.
  Commit: Y | docs(phase0): sync roadmap + AGENTS.md baseline to reflect Phase 0 completion

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — every Must-have delivered; every Must-NOT-have respected (no live calls, no purges, audit report-only); each todo committed separately.
- [ ] F2. Code quality review — schemas/types clean under `npm run check`; no `src/providers` or model imports in `src/capabilities/eval/**`; redaction reused not reimplemented.
- [ ] F3. Real manual QA — operator runs `npm run eval:capabilities` and `npm run audit:no-fakes` from a clean checkout of the worktree; confirms both exit 0 offline and reports are produced; confirms the audit lists the known fakes without failing.
- [ ] F4. Scope fidelity — no scope creep into Phase 0.5+ (no GlobalScenarioSchema, no specialist contracts, no Regolo provider in this PR).
- [ ] F5. Doc freshness — roadmap + AGENTS.md reflect Phase 0 done; AGENTS.md test baseline matches the real `npm test` count; no later phase prematurely marked done; concerns doc has the Phase 0 entry.

## Commit strategy
- One commit per todo (commit-per-task rule). Conventional Commits, scopes: `capabilities`, `evals`, `audit`, `phase0`, `docs`.
- Work happens in worktree branch `rector-0.3.0-phase0-benchmarks`; open ONE PR into `rector-0.3.0` after F1-F4 pass.
- The tracked plan mirror (`docs/plans/2-0/phases/phase-0-benchmarks.md`) is committed in Todo 8 so reviewers see the plan in the PR diff.
- Do NOT squash away the per-task commits; the PR should show the 8-commit progression.

## Success criteria
- `npm test`, `npm run check`, `npm run build` all green.
- `npm run eval:capabilities` runs fully offline (no credentials, no network) and emits JSON + Markdown reports covering all 8 metrics.
- `npm run audit:no-fakes` is report-only: prints the known fakes at their verified locations and exits 0; exits nonzero only on its own internal error.
- `src/capabilities/eval/{schemas,artifactStore,metrics}.ts` exist with tests; `tests/fixtures/eval-corpus/` holds ≥3 real-artifact fixtures with deterministic oracles.
- No fake-success test exists in this PR (no mocked validator pass, no mocked SLM accuracy, no fake planner output as proof).
- Tracked mirror committed; concerns doc updated with the Phase 0 entry; PR opened into `rector-0.3.0`.
- Source-of-truth docs synced (roadmap + AGENTS.md) so they are not stale; AGENTS.md test baseline matches the real Phase 0 gate count.
