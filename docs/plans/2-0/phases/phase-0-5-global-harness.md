# phase-0-5-global-harness - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** A second kind of test that proves Rector behaves correctly as a whole assistant, not just that its TypeScript pieces compile. You get the scenario format (a YAML description of a task with success criteria and "must change / must not change" oracles), the contracts that describe a specialist system and the task/result envelopes it speaks, a runner that executes those scenarios against real fixture projects and produces a scorecard per scenario, and a first set of four real scenarios — all running offline.

**Why this approach:** "npm test proves components; the global harness proves behavior." Building the scenario format, contracts, scorecards, and an offline runner now gives every later phase one consistent way to prove an end-to-end claim with real artifacts. Live AI-provider runs are wired as opt-in and clearly marked skipped when keys are absent, so the suite is honest and never green-by-faking.

**What it will NOT do:** It won't run any real AI model by default. It won't actually execute a coding specialist or route between systems yet (that's a later phase). It won't delete or block the existing placeholder systems — it just reports their presence as one scorecard dimension.

**Effort:** Medium
**Risk:** Low — all new files, offline-by-default, no runtime behavior changed.
**Decisions to sanity-check:** offline-by-default with live opt-in + explicit skipped; registry is a contract-validation stub (no execution); scenarios run against a real fixture repo (no faked validators); plan mirrored into tracked docs.

Your next move: approve, or ask for the dual high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Medium / Low. 8 todos, offline-by-default, all-new files. Deliver GlobalScenarioSchema + specialist contract/packet schemas + 8-dim scorecard+reporter + offline globalRunner + 4 real-fixture scenarios + SystemRegistry validation stub; wire test:global/test:systems; mirror to docs/plans/2-0/phases/. Live opt-in+SKIPPED; no specialist execution; no purges.

## Scope
### Must have
- `GlobalScenarioSchema` (Zod) parsing the YAML/JSON scenario format from plan lines 471-500 (`schemaVersion`, `id`, `title`, `type`, `workspace`, `userGoal`, `allowedSystems`, `forbiddenSystems`, `expectedSpecialist`, `successCriteria`, `validators`, `oracles` {mustChange, mustNotChange, mustIncludeEvidence}, `budgets`).
- `SpecialistSystemContractSchema`, `SpecialistTaskPacketSchema`, `SystemResultPacketSchema` (Zod) from plan lines 352-407, plus a `SystemResultPacket` validator function.
- A `globalRunner` that loads a scenario, runs its validators against a real fixture workspace, evaluates oracles deterministically, and produces one scorecard per scenario.
- A scorecard schema covering the 8 global dimensions (plan lines 504-513: reliability, accuracy, safety, cost efficiency, memory correctness, delegation quality, evidence quality, simplicity) + fake-path status, with a JSON + Markdown reporter.
- A minimal `SystemRegistry` stub sufficient to register/validate a specialist contract (no real specialist execution — that is Phase 11/12).
- First batch of ≥4 real-fixture global scenarios under `tests/global/`: `coding-basic-fix.scenario.yaml`, `memory-boundary.scenario.yaml`, `fake-purge.scenario.yaml`, `delegation-routing.scenario.yaml` (plan lines 1590-1593).
- A tiny real fixture repo under `tests/fixtures/repos/` for the coding scenario to operate on.
- npm scripts: `test:global` (offline, runs the harness over fixture scenarios), `test:systems` (specialist contract tests). Live scenarios opt-in behind `LIVE_EVALS=1` and explicitly reported as SKIPPED when absent.
- A committed tracked mirror at `docs/plans/2-0/phases/phase-0-5-global-harness.md`.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- NO live providers required. `npm run test:global` must pass fully offline using real fixture artifacts. Any live-provider scenario is opt-in (`LIVE_EVALS=1`) and, when env vars are absent, is reported as SKIPPED (never silently passed, never failing the suite).
- NO real specialist-system execution / no Executive Orchestrator routing logic — those are Phase 11/12. This phase builds the CONTRACTS + HARNESS + SCORECARDS only; the registry is a validation stub.
- NO purging of fake systems and NO making the fake-path audit a failing gate (still report-only, surfaced as a scorecard dimension).
- NO mocked-success: a scenario does not "pass" because a stubbed validator returns true. Validators must run real commands against the real fixture, or the scenario records `not_run`. Oracles compare against real file/evidence state.
- NO dependency on Phase 0 internals beyond the published eval schemas/artifact-store contract; if Phase 0 has not merged, this plan re-declares the minimal shared types it needs rather than importing from an unmerged branch (noted in Todo 1).
- NO Regolo/Capability-SLM work — that is Phase 2.5.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **tests-after within the same todo** on the existing Vitest stack. Scenario fixtures are real; the runner is exercised programmatically in `tests/global/*.test.ts`.
- "No fake tests" precise rule (per user): deterministic fixtures + spies PERMITTED for schema/contract/scorecard-shape assertions. FORBIDDEN is fake success — a scenario marked passed without its validators actually running, a stubbed specialist whose result is counted as real execution proof, or a fake-path status that reports clean while fakes exist. Each todo carries a `Fake-risk check` line.
- Live-provider handling: the harness detects absent credentials and emits a SKIPPED record in the report (with reason), exit 0; it never fabricates a live result.
- Evidence: `.omo/evidence/task-<N>-phase-0-5-global-harness.<ext>`.
- Gate commands: `npm test`, `npm run check`, `npm run build`, `npm run test:global` (offline green), `npm run test:systems`.

## Execution strategy
### Worktree + PR preamble (executing agent reads this FIRST)
- Phase 0.5 starts from branch `rector-0.3.0`. Create worktree branch `rector-0.3.0-phase0-5-global-harness` off `rector-0.3.0`; open ONE PR back into `rector-0.3.0` when complete.
- Authoritative copy is the tracked mirror `docs/plans/2-0/phases/phase-0-5-global-harness.md` (`.omo/` is gitignored, `.gitignore:43`). Todo 1 verifies the local branch directly.
- GOTCHA (verified): the whole `docs/plans/2-0` tree is gitignored (`.gitignore:50`), so the mirror is NOT trackable until that is un-ignored. Todo 8 adds a negation pattern `!docs/plans/2-0/phases/` (+ `!docs/plans/2-0/phases/**`) so ONLY `phases/` becomes trackable; the bulky source package stays ignored. The user (who authored `.gitignore:50`) approved this un-ignore. NOTE: if Phase 0 already merged, the negation lines may already exist — Todo 8 makes the edit idempotent (only add if absent).
- Commit-per-task. Conventional Commits scoped `evals`/`systems`/`docs`.
- If Phase 0 (`phase-0-benchmarks`) has already merged into `rector-0.3.0`, reuse its `src/capabilities/eval/*` schemas/artifact-store; if not yet merged, declare the minimal shared types locally and note the future de-dup (see Todo 1).

### Parallel execution waves
> Target 5-8 todos per wave.
- **Wave 1:** Todo 1 (branch verify + Phase-0 dependency check) → Todo 2 (GlobalScenarioSchema) + Todo 3 (specialist contract/packet schemas) parallel.
- **Wave 2:** Todo 4 (scorecard schema + reporter), Todo 5 (fixture repo + 4 scenarios) parallel; Todo 6 (globalRunner) depends on 2,3,4,5.
- **Wave 3:** Todo 7 (SystemRegistry stub + contract tests), Todo 8 (npm scripts + tracked mirror + concerns update) — 7 parallel with 6 tail, 8 depends on 6,7.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 branch + dep check | — | all | — |
| 2 GlobalScenarioSchema | 1 | 6 | 3 |
| 3 contract/packet schemas | 1 | 6,7 | 2 |
| 4 scorecard + reporter | 1 | 6 | 5 |
| 5 fixture repo + scenarios | 2 | 6 | 4 |
| 6 globalRunner | 2,3,4,5 | 8 | — |
| 7 SystemRegistry stub + tests | 3 | 8 | 6 |
| 8 scripts + mirror + concerns | 6,7 | 9 | — |
| 9 doc sync | 8 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Verify local branch, create worktree, check Phase-0 dependency status
  What to do: Run `git branch --show-current` and `git status --short`; confirm base `rector-0.3.0` and a clean-enough tree; capture both to evidence. Create worktree `rector-0.3.0-phase0-5-global-harness`. Check whether `src/capabilities/eval/schemas.ts` exists on the base (Phase 0 merged) — record the answer; it decides whether later todos import Phase-0 schemas or locally declare minimal shared types.
  Must NOT do: do NOT proceed on an unexpected branch. Do NOT assume Phase 0 is merged — verify by file existence on the base branch.
  Parallelization: Wave 1 | Blocked by: none | Blocks: all
  References: AGENTS.md (Current Branch / Worktree); `.gitignore:43`; existing worktree `git worktree list`; Phase-0 schema path `src/capabilities/eval/schemas.ts` (may or may not exist).
  Acceptance criteria (agent-executable): evidence file has verbatim `git branch --show-current` + `git status --short`; `git worktree list` shows the new worktree; evidence records PHASE0_MERGED=yes|no.
  QA scenarios: happy — base is `rector-0.3.0`, worktree created, dependency status recorded; failure — wrong branch → recorded STOP. Evidence `.omo/evidence/task-1-phase-0-5-global-harness.txt`
  Fake-risk check: N/A (git/file inspection only).
  Commit: Y | chore(phase0.5): create global-harness worktree, record branch + Phase-0 dep status

- [x] 2. Define GlobalScenarioSchema (Zod) for the YAML/JSON scenario format
  What to do: Create `src/evals/globalScenarioSchema.ts` exporting `GlobalScenarioSchema` and its inferred type, matching plan lines 471-500 exactly (schemaVersion, id, title, type, workspace, userGoal, allowedSystems, forbiddenSystems, expectedSpecialist, successCriteria[], validators[], oracles {mustChange[], mustNotChange[], mustIncludeEvidence[]}, budgets {maxToolCalls, maxRuntimeMs, maxMainModelRawToolTokens}). Support loading from YAML (add a tiny YAML parse path) and JSON. Add `tests/global/globalScenarioSchema.test.ts` proving a real `.scenario.yaml` parses and an invalid one rejects.
  Must NOT do: do NOT add fields beyond the plan's format. Do NOT execute scenarios here — schema only.
  Parallelization: Wave 1/2 | Blocked by: 1 | Blocks: 6 | parallel with 3
  References: scenario format plan lines 471-500; Zod refine/transform style `src/protocol/events.ts:40-71`; test style `tests/cartographer/inventoryStore.sqlite.test.ts:1-50`. (YAML: prefer a minimal dependency-free parse for the constrained format, or a vetted parser — record the choice.)
  Acceptance criteria (agent-executable): `npm test -- globalScenarioSchema` passes; `npm run check` clean; a scenario missing `oracles` rejects with a clear path.
  QA scenarios: happy — `coding-basic-fix.scenario.yaml` parses to a typed object; failure — `budgets.maxToolCalls` as a string throws ZodError. Evidence `.omo/evidence/task-2-phase-0-5-global-harness.txt`
  Fake-risk check: ALLOWED — schema/validation only, deterministic fixtures. No mocked success.
  Commit: Y | feat(evals): add GlobalScenarioSchema with YAML/JSON loading + tests

- [x] 3. Define SpecialistSystemContract + TaskPacket + SystemResultPacket schemas
  What to do: Create `src/systems/contracts.ts` exporting `SpecialistSystemContractSchema`, `SpecialistTaskPacketSchema`, `SystemResultPacketSchema` (plan lines 352-407) with inferred types, plus `validateSystemResultPacket(value)` returning a typed result or structured error. Add `tests/systems/specialistSystem.contract.test.ts` proving valid contracts/packets parse and malformed ones reject, including a result packet missing `evidenceRefs`.
  Must NOT do: do NOT implement routing or execution. Contracts + validators only.
  Parallelization: Wave 1/2 | Blocked by: 1 | Blocks: 6,7 | parallel with 2
  References: contract/packet shapes plan lines 352-407; specialist memory boundary plan lines 409-424; Zod style `src/protocol/events.ts:40-71`.
  Acceptance criteria (agent-executable): `npm test -- specialistSystem.contract` passes; `npm run check` clean; a result packet without `status` rejects.
  QA scenarios: happy — a full coding-system contract + task packet + result packet round-trip; failure — `riskProfile: "extreme"` (not in enum) rejects naming the field. Evidence `.omo/evidence/task-3-phase-0-5-global-harness.txt`
  Fake-risk check: ALLOWED — schema/validation only. No mocked success.
  Commit: Y | feat(systems): add specialist contract/task/result schemas + validator

- [x] 4. Define scorecard schema (8 dimensions + fake-path status) and JSON/Markdown reporter
  What to do: Create `src/evals/scorecards.ts` with a `ScorecardSchema` covering the 8 dimensions (plan lines 504-513) plus `fakePathStatus`, and `renderScorecardMarkdown(scorecard)` / `renderScorecardJson(scorecard)`. Add `tests/global/scorecards.test.ts` proving a scorecard validates and renders deterministically (stable Markdown for a fixed input).
  Must NOT do: do NOT compute scores from a live run here — render/validate a provided scorecard object. Do NOT omit the fake-path dimension.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6 | parallel with 5
  References: score dimensions plan lines 504-513; scorecard outputs JSON+Markdown plan lines 1657,1680; reporter pattern (mirror Phase 0 report formatter if merged, else standalone).
  Acceptance criteria (agent-executable): `npm test -- scorecards` passes; rendering a fixed scorecard twice yields byte-identical Markdown; schema rejects a scorecard missing `fakePathStatus`.
  QA scenarios: happy — 8-dimension scorecard renders a stable table; failure — out-of-range dimension score (e.g. 1.4 where 0-1) rejects. Evidence `.omo/evidence/task-4-phase-0-5-global-harness.txt`
  Fake-risk check: ALLOWED — pure render/validate over deterministic input. No mocked success.
  Commit: Y | feat(evals): add scorecard schema (8 dims + fake-path) + JSON/MD reporter

- [x] 5. Create the real fixture repo + first 4 global scenarios
  What to do: Create `tests/fixtures/repos/rector-mini-fix/` — a tiny REAL repo (a couple of .ts files + a failing test) the coding scenario can operate on with a real validator command. Author the 4 scenarios under `tests/global/`: `coding-basic-fix.scenario.yaml` (oracle mustChange/mustNotChange against the fixture), `memory-boundary.scenario.yaml`, `fake-purge.scenario.yaml` (asserts the report-only audit surfaces known fakes), `delegation-routing.scenario.yaml`. Each must parse under `GlobalScenarioSchema`. Add `tests/global/scenarios.test.ts` validating all 4 parse and their referenced fixtures exist.
  Must NOT do: do NOT hand-fake a validator result inside a scenario — validators name real commands. Do NOT require network or a live provider in any of these 4 (those stay offline; live ones come later, opt-in).
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 6 | parallel with 4
  References: scenario filenames plan lines 1590-1593; example scenario plan lines 471-500; real-fixture convention `tests/cartographer/repoScannerTestHarness.ts`; fake-purge surfaced as scorecard dimension (this phase, report-only).
  Acceptance criteria (agent-executable): `npm test -- scenarios` passes; all 4 scenarios parse; the coding fixture's validator command runs against the fixture and is real (not stubbed); referenced paths resolve.
  QA scenarios: happy — 4 scenarios parse, fixture repo present, coding validator command executes; failure — a scenario pointing at a missing workspace fails validation naming the path. Evidence `.omo/evidence/task-5-phase-0-5-global-harness.txt`
  Fake-risk check: ALLOWED + core "no fake" guarantee — fixture repo is real, validators name real commands, oracles compare real state. Stubbed validator results explicitly banned.
  Commit: Y | test(evals): add real fixture repo + first 4 global scenarios

- [x] 6. Build the offline globalRunner producing one scorecard per scenario
  What to do: Create `src/evals/globalRunner.ts` and `scripts/evals/run-global-harness.ts`. The runner loads scenarios, runs each scenario's real validators against its fixture workspace, evaluates oracles deterministically (mustChange/mustNotChange/mustIncludeEvidence vs real state), computes a scorecard (incl. fake-path status via the report-only audit if present), and writes `.omo/evidence/global-report.json` + `global-report.md`. Live-provider scenarios are detected and emitted as SKIPPED with reason when `LIVE_EVALS`/creds absent — never failing, never faked. Add `tests/global/runner.test.ts` running the 4 offline scenarios and asserting 4 scorecards are produced and a failing scenario writes a replayable regression artifact.
  Must NOT do: do NOT call any model in the offline path. Do NOT mark a scenario passed without its validators actually executing. Do NOT let an absent live credential fail or silently pass — it must be SKIPPED+reported.
  Parallelization: Wave 2/3 | Blocked by: 2,3,4,5 | Blocks: 8
  References: exit criteria plan lines 1675-1681 ("test:global runs without live providers using real fixtures; live opt-in, reported skipped; every scenario emits one scorecard; failed scenario writes replayable regression artifact"); runner targets plan lines 1596-1599; scorecard from Todo 4; scenarios from Todo 5; report-only audit from Phase 0 (`scripts/audit/no-production-fakes.ts`) if merged, else fake-path status = "audit-not-present".
  Acceptance criteria (agent-executable): `npm run test:global` exits 0 fully offline and writes both reports; 4 scorecards produced; a deliberately failing scenario produces a regression artifact; a synthetic live-only scenario without creds is reported SKIPPED (exit still 0).
  QA scenarios: happy — 4 offline scenarios → 4 scorecards + reports; failure — break the coding fixture's expected change → that scenario scores fail + writes replayable artifact, suite still completes. Evidence `.omo/evidence/task-6-phase-0-5-global-harness.txt`
  Fake-risk check: ALLOWED — runs real validators against real fixtures; live path SKIPPED-not-faked. This todo is where the "no fake success" rule is enforced at runtime.
  Commit: Y | feat(evals): add offline global reliability harness runner + reports

- [x] 7. Add SystemRegistry validation stub + specialist contract test suite
  What to do: Create `src/systems/registry.ts` with a `SystemRegistry` that registers and validates `SpecialistSystemContract`s (rejects duplicates, validates each at registration) — NO execution/routing. Create `scripts/evals/run-specialist-system-contracts.ts` that loads any committed specialist profile JSONs (`src/systems/specialistProfiles/coding.profile.json` as a starter) and validates them. Add `tests/systems/registry.test.ts` proving duplicate IDs reject and an invalid profile fails validation.
  Must NOT do: do NOT implement ExecutiveRouter or real specialist execution (Phase 11/12). Registry validates contracts only.
  Parallelization: Wave 3 | Blocked by: 3 | Blocks: 8 | parallel with 6
  References: SystemRegistry/contract plan lines 1571-1578,2230-2243; specialist profile dir plan lines 1579-1582; contracts from Todo 3.
  Acceptance criteria (agent-executable): `npm run test:systems` passes; registering two contracts with the same `systemId` rejects; an invalid `coding.profile.json` fails validation with a clear message.
  QA scenarios: happy — register a valid coding contract, list it back; failure — register a contract missing `inputSchema` → rejected. Evidence `.omo/evidence/task-7-phase-0-5-global-harness.txt`
  Fake-risk check: ALLOWED — contract validation only; no faked execution claimed. The registry explicitly does NOT pretend to run specialists.
  Commit: Y | feat(systems): add SystemRegistry validation stub + contract tests

- [x] 8. Un-ignore phases mirror dir, wire npm scripts, commit tracked plan mirror, update concerns doc
  What to do: FIRST ensure `.gitignore` un-ignores the mirror dir — if the negation lines `!docs/plans/2-0/phases/` and `!docs/plans/2-0/phases/**` are absent (i.e. Phase 0 did not already add them), add them immediately after the `docs/plans/2-0` line; verify with `git check-ignore -v docs/plans/2-0/phases/phase-0-5-global-harness.md` printing NOTHING (exit 1 = not ignored). THEN add `test:global`, `test:systems` to `package.json` (optionally reserve `eval:global`, `eval:shadow` as documented-not-yet-wired). Create tracked mirror `docs/plans/2-0/phases/phase-0-5-global-harness.md` and `git add` it (confirm it stages). Append a Phase 0.5 entry to `docs/plans/concerns-and-vulnerabilities.md` (harness coverage, live-scenario opt-in posture, fake-path-status-as-scorecard, any gaps). Run the full gate suite and capture output.
  Must NOT do: do NOT add live scenarios to the default CI path. Do NOT alter unrelated scripts. Do NOT broaden the negation beyond `phases/`. Do NOT duplicate the negation lines if Phase 0 already added them.
  Parallelization: Wave 3 | Blocked by: 6,7 | Blocks: none
  References: gitignore conflict VERIFIED `git check-ignore -v` -> `.gitignore:50:docs/plans/2-0`; negation idempotency (grep for existing `!docs/plans/2-0/phases` before adding); script names plan lines 532-539; CI gate composition plan lines 2276,2769-2777; concerns rule AGENTS.md; mirror requirement (user note); `.gitignore:43`.
  Acceptance criteria (agent-executable): `git check-ignore -v docs/plans/2-0/phases/phase-0-5-global-harness.md` exits 1 (no output); `git add` stages the mirror; `npm test`, `npm run check`, `npm run build`, `npm run test:global`, `npm run test:systems` all pass/exit-0 offline; concerns doc has a dated Phase 0.5 entry.
  QA scenarios: happy — negation present (added or pre-existing), mirror stages and commits, full gate suite green offline, PR opened to rector-0.3.0; failure — `git check-ignore` still reports ignored → agent fixes the pattern before proceeding, does NOT force-add. Evidence `.omo/evidence/task-8-phase-0-5-global-harness.txt`
  Fake-risk check: N/A (gitignore + wiring + docs). Verification runs the REAL gate suite.
  Commit: Y | chore(phase0.5): un-ignore phases mirror, wire global/systems scripts, mirror plan, update concerns

- [x] 9. Sync source-of-truth docs so nothing goes stale (worker does this directly — NO subagent)
  What to do: As the FINAL step before opening the PR, the executing agent directly updates the broader source-of-truth docs to reflect Phase 0.5 completion. Update only where the phase changed reality: (a) `docs/plans/rector-master-roadmap.md` — mark Phase 0.5 (Global Reliability Harness) status as done/landed with the PR/branch reference; (b) `AGENTS.md` — refresh the test baseline line to the FRESH `npm test` counts from Todo 8, and add the new `npm run test:global` / `npm run test:systems` commands under Build/Test commands plus the new `src/evals/*` and `src/systems/*` surfaces; (c) confirm the Phase 0.5 entry appended to `docs/plans/concerns-and-vulnerabilities.md` in Todo 8 is present and accurate (no duplicate). Capture a before/after diff summary to evidence.
  Must NOT do: do NOT delegate to a librarian/explore/oracle subagent — AGENTS.md mandates foreground-only and flags subagents as flaky here; the worker holding the real diff does it directly. Do NOT invent test numbers — use real Todo 8 gate output. Do NOT touch architecture docs the phase did not affect, and do NOT mark Phase 11/12 or any future specialist phase done (this phase only built contracts + harness, not execution).
  Parallelization: Wave 3 (tail) | Blocked by: 8 | Blocks: none
  References: roadmap `docs/plans/rector-master-roadmap.md`; baseline + commands `AGENTS.md` ("Current Implemented Chunks", "Build / Test Commands", test-baseline line); concerns `docs/plans/concerns-and-vulnerabilities.md`; foreground-only rule `AGENTS.md` ("No background/async subagents; foreground only") + global AGENTS.md ("Background subagents... fail or go stale... Prefer direct tools").
  Acceptance criteria (agent-executable): `git diff --name-only` for this commit includes `docs/plans/rector-master-roadmap.md` and `AGENTS.md`; AGENTS.md test-baseline number matches `.omo/evidence/task-8-phase-0-5-global-harness.txt`; roadmap shows Phase 0.5 done and NO Phase 11/12 or specialist phase marked done; `npm test` + `npm run build` still green after the edits.
  QA scenarios: happy — roadmap + AGENTS.md updated to real Phase 0.5 state, diff captured, gates green, PR opened; failure — if the captured count and AGENTS.md disagree, agent fixes AGENTS.md to the real number before committing. Evidence `.omo/evidence/task-9-phase-0-5-global-harness.txt`
  Fake-risk check: N/A (docs). Acceptance ties doc numbers to REAL gate output, so docs cannot record a fake baseline.
  Commit: Y | docs(phase0.5): sync roadmap + AGENTS.md baseline to reflect Phase 0.5 completion

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit — every Must-have delivered; every Must-NOT respected (offline-by-default, no specialist execution, no purges, live opt-in+skipped); commit-per-task.
- [x] F2. Code quality review — schemas clean under `npm run check`; `src/systems/registry.ts` does NOT execute specialists; live-credential-absent path emits SKIPPED not pass/fail.
- [x] F3. Real manual QA — operator runs `npm run test:global` and `npm run test:systems` from a clean worktree checkout with NO credentials set; confirms both exit 0, 4 scorecards produced, live scenarios reported SKIPPED.
- [x] F4. Scope fidelity — no creep into Phase 11/12 (no ExecutiveRouter, no real coding-system execution) and none into Phase 2.5 (no Regolo/Capability-SLM).
- [x] F5. Doc freshness — roadmap + AGENTS.md reflect Phase 0.5 done; AGENTS.md test baseline matches the real `npm test` count; no Phase 11/12 or specialist phase prematurely marked done; concerns doc has the Phase 0.5 entry.

## Commit strategy
- One commit per todo (commit-per-task). Conventional Commits, scopes: `evals`, `systems`, `phase0.5`, `docs`.
- Work in worktree `rector-0.3.0-phase0-5-global-harness`; open ONE PR into `rector-0.3.0` after F1-F4 pass.
- Tracked plan mirror committed in Todo 8 so the plan appears in the PR diff.
- Preserve the per-task commit progression in the PR (no squash-away).

## Success criteria
- `npm test`, `npm run check`, `npm run build` green.
- `npm run test:global` runs fully offline (no creds, no network), executes real validators against real fixtures, and emits one scorecard per scenario as JSON + Markdown; a failing scenario writes a replayable regression artifact.
- Live-provider scenarios are opt-in (`LIVE_EVALS=1`) and reported as SKIPPED with reason when credentials are absent — never silently passed, never failing the suite.
- `npm run test:systems` validates specialist contracts (duplicate IDs and invalid profiles rejected); the registry performs NO specialist execution.
- Scorecards cover all 8 dimensions plus fake-path status.
- No fake-success test in this PR (no scenario passed without real validators, no stubbed specialist counted as execution).
- Tracked mirror committed; concerns doc updated with the Phase 0.5 entry; PR opened into `rector-0.3.0`.
- Source-of-truth docs synced (roadmap + AGENTS.md) so they are not stale; AGENTS.md test baseline matches the real Phase 0.5 gate count.
