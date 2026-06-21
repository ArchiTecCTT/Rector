# 051-inspection-cleanup - Work Plan

## TL;DR (For humans)

**What you'll get:** A clean pass over the static-analysis (JetBrains/Qodana) warnings that actually live in the product source code — redundant boolean checks simplified, a dead disabled-route block removed, unused imports and leftover variables cleared out, and a handful of genuinely-dead exports deleted. A few flagged spots that are intentional (an exhaustiveness guard, a localhost startup banner) get a one-line "ignore this on purpose" marker instead of a risky change.

**Why this approach:** Every change is behavior-preserving, verified line-by-line against the real source, and grouped so the three security-touching spots (file-write gating, tool-halt logic, auth route allowlist) are isolated in their own commits with lock-in tests written first. Nothing in tests, scripts, or browser assets is touched — those are out of scope by your call.

**What it will NOT do:** It will not change any runtime behavior, will not delete any symbol that is referenced anywhere (including from tests), and will not force https on the local-bind log line or run `npm audit fix --force`.

**Effort:** Medium
**Risk:** Low — all edits are behavior-preserving; the only sensitive spots are isolated and test-locked first.
**Decisions to sanity-check:** Security-path edits each get their own test-first commit; unused *exported* symbols are deleted only when zero references exist repo-wide (incl. tests + dynamic imports), otherwise documented as intentional public surface.

Your next move: Approve to write nothing further (the plan is already written) — or tell me to start the worker, optionally after a high-accuracy review. Full execution detail below.

---

> TL;DR (machine): Medium effort, Low risk. Fix verified src/-only JetBrains/Qodana findings (PointlessBoolean+Unreachable, TrivialIf, unused imports/locals, verified-dead exports, 2 documented suppressions) in 7 behavior-preserving commits, security edits isolated + test-first, each authored as the user, gated by fresh npm test && npm run build.

## Scope
### Must have
- Fix the 5 PointlessBooleanExpressionJS findings + the paired UnreachableCodeJS at `src/api/server.ts:3792`.
- Collapse the 9 TrivialIfJS findings in `src/`, with boolean-type confirmation per site.
- Remove the 19 unused imports + 16 unused local symbols in `src/` (after per-import classification).
- Remove only the JSUnusedGlobalSymbols exports that have ZERO references repo-wide (incl. tests + dynamic-import forms); document every kept one as intentional public surface.
- Resolve the 4 UnnecessaryLocalVariableJS + 1 JSUnusedAssignment findings in `src/` (collapse where safe, suppress `_exhaustive`).
- Suppress + document the `http://` startup banner at `src/bin/server.ts:595`.
- Triage the 6 ExceptionCaughtLocallyJS findings: fix only catch-and-rethrow-unchanged cases; document the rest in the commit message.
- Add 3 characterization tests (file-write gating, `shouldHalt`, auth allowlist) BEFORE their security-path simplifications.
- Document every suppression / kept-false-positive / deferred-empty inspection in `docs/plans/concerns-and-vulnerabilities.md`.
- Every commit authored as `Lanz Skyler B. Busa <busalanz76@gmail.com>`; fresh `npm test && npm run build` green before completion.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- NO edits to `tests/`, `scripts/`, `src/public/app.js`, `src/public/theme.js`.
- NO behavior change anywhere. TrivialIf collapses only when the condition is statically `boolean`; otherwise wrap `Boolean(...)`.
- NO deletion of any symbol/import with ANY reference repo-wide (static, dynamic `import()`, `require()`, test-only, or documented extension contract).
- NO forcing `https://` on the localhost startup banner.
- NO `npm audit fix --force`. NO `--no-verify`. NO commit authored as any agent identity (sisyphus etc.).
- NO touching the merged `qodana.yaml` or adding project-wide suppression config (use inline `// noinspection` only).
- NO scope creep into the deferred-empty inspections (JSDeprecatedSymbols, BadExpressionStatementJS, JSCheckFunctionSignatures, DuplicatedCode_aggregate — 0 src/ findings).

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **hybrid** — vitest (project test runner). TDD/test-first ONLY for the 3 security-relevant simplifications (characterization test committed before the production change). All other findings are behavior-preserving refactors with NO feasible failing-first test; their guarantee is the full suite staying green + `tsc` build passing. This infeasibility is documented (not worked around with fake tests).
- Per-todo evidence: `.omo/evidence/task-<N>-051-inspection-cleanup.txt` capturing the relevant `npm test`/`npm run build`/grep output.
- Global gates (run from the worktree root `.worktrees/rector-0.3.0-cartographer`):
  - `npm test` → expect ≥1369 passing / 0 failing (baseline 213 files / 1369 tests; 4+1 skipped allowed).
  - `npm run build` → exit 0.
  - `npm run check` (`tsc --noEmit`) → exit 0 (catches truly-needed deleted symbols).
- Authorship gate: `git log --format="%an <%ae>" <base>..HEAD | sort -u` → exactly one line `Lanz Skyler B. Busa <busalanz76@gmail.com>`.

## Execution strategy
### Parallel execution waves
> All work is on ONE file set with overlapping files (server.ts appears in A, B, C, D). Edits to the same file MUST be serialized to avoid clobber. Therefore waves are sequential by commit; within a wave, distinct-file edits may batch.

- **Wave 1 (security, test-first, isolated):** Todos 1, 2, 3 — each = [characterization test commit] then [simplification commit]. Sequential (different files, but each is its own atomic test→fix pair).
- **Wave 2 (non-security behavior-preserving simplifications):** Todos 4 (remaining PointlessBoolean + Unreachable), 5 (remaining TrivialIf).
- **Wave 3 (dead code):** Todos 6 (unused imports), 7 (unused local symbols), 8 (verified-dead exports), 9 (unnecessary locals + unused assignment).
- **Wave 4 (documented suppressions):** Todo 10 (http banner), 11 (ExceptionCaughtLocally triage).
- **Wave 5 (docs):** Todo 12 (concerns-and-vulnerabilities.md).
- **Final verification wave:** F1–F4.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 dagCompiler allowFileWrite (test+fix) | — | 4 (same domain) | 2, 3 |
| 2 shouldHalt (test+fix) | — | — | 1, 3 |
| 3 auth allowlist (test+fix) | — | 5 (same file area) | 1, 2 |
| 4 PointlessBoolean rest + Unreachable | 1 | 6,7,8,9 (server.ts) | 5 |
| 5 TrivialIf rest | 3 | 9 | 4 |
| 6 unused imports | 4,5 | 7,8 (server.ts) | — |
| 7 unused local symbols | 6 | 8 | — |
| 8 verified-dead exports | 7 | 9 | — |
| 9 unnecessary locals + unused assignment | 8 | 10 | — |
| 10 http banner suppress | 9 | 11 | — |
| 11 ExceptionCaughtLocally triage | 10 | 12 | — |
| 12 concerns doc | 1-11 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. dagCompiler `allowFileWrite` — characterization test, then simplify `task.approvalRequired === false` → `!task.approvalRequired`
  What to do / Must NOT do: FIRST commit a vitest characterization test that locks the `capabilityPolicyFor` truth table: for `type === "FILE_OPERATION"`, `approvalRequired: false` → `allowFileWrite: true`; `approvalRequired: true` → `allowFileWrite: false`; for non-FILE_OPERATION types `allowFileWrite` is `false` regardless. THEN the production simplification commit. Must NOT change the gate's truth table. Verified safe: `PlannerTask.approvalRequired` is `z.boolean()` REQUIRED (`src/orchestration/planner.ts:36`), never undefined, so `=== false` and `!x` are identical.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 4
  References: `src/orchestration/dagCompiler.ts:352` (`allowFileWrite: type === "FILE_OPERATION" && task.approvalRequired === false`), function `capabilityPolicyFor` at `dagCompiler.ts:347-358`; `src/orchestration/planner.ts:36` (`approvalRequired: z.boolean()`), `planner.ts:478` (`PlannerTaskSchema.parse` factory). Existing dagCompiler tests: search `tests/` for `dagCompiler` or `capabilityPolicy` to extend the right file; if none, create `tests/orchestration/dagCompiler.capabilityPolicy.test.ts`.
  Acceptance criteria (agent-executable): `npm test -- dagCompiler` (or the chosen file) shows the new truth-table test passing; `git show` of the fix commit shows ONLY the line-352 change; `npm run check` exit 0.
  QA scenarios: happy — test with `approvalRequired:false` asserts `allowFileWrite===true`; failure — test with `approvalRequired:true` asserts `allowFileWrite===false` (would catch an accidental `!` inversion). Evidence `.omo/evidence/task-1-051-inspection-cleanup.txt`.
  Commit: Y (×2) | `test(dag): lock capabilityPolicy allowFileWrite truth table` then `refactor(dag): simplify approvalRequired boolean check (PointlessBooleanExpressionJS)`

- [x] 2. `shouldHalt` — characterization test, then simplify the triple boolean
  What to do / Must NOT do: FIRST commit a vitest test locking `shouldHalt(result)` against zod-parsed `ToolResult`: `{halt:true}`→true; `{halt:false,middlewareHalt:false,ok:true}`→false; `{middlewareHalt:true}`→true; `{ok:false}`→true; a ToolResult parsed with `halt`/`middlewareHalt` ABSENT (→ default `false`) and `ok:true` → false. THEN simplify `result.halt === true || result.middlewareHalt === true || result.ok === false` → `result.halt || result.middlewareHalt || !result.ok`. Must NOT change semantics. Verified safe: `ToolResultSchema` (`src/tools/types.ts:46-56`) — `ok: z.boolean()`, `halt: z.boolean().default(false)`, `middlewareHalt: z.boolean().default(false)`; `shouldHalt` takes the parsed `ToolResult` type, all three are non-undefined booleans.
  Parallelization: Wave 1 | Blocked by: — | Blocks: —
  References: `src/tools/middleware.ts:209-211` (`export function shouldHalt(result: ToolResult): boolean`); `src/tools/types.ts:46-56` (schema + `ToolResult` type), `types.ts:114`/`134` (`ToolResultSchema.parse` constructors). Find existing `tests/` middleware test (search `shouldHalt`/`middleware`); else create `tests/tools/middleware.shouldHalt.test.ts`.
  Acceptance criteria: `npm test -- middleware` (or chosen file) green incl. the absent-field default case; fix commit diff shows only line 210; `npm run check` exit 0.
  QA scenarios: happy — `{halt:false,middlewareHalt:false,ok:true}` → false; failure — parsed result with fields absent + `ok:true` → false (proves `.default(false)` path, catches an `undefined`-truthiness regression). Evidence `.omo/evidence/task-2-051-inspection-cleanup.txt`.
  Commit: Y (×2) | `test(tools): lock shouldHalt truth table incl zod defaults` then `refactor(tools): simplify shouldHalt boolean expression (PointlessBooleanExpressionJS)`

- [x] 3. Auth allowlist `isPublicAuthRoute` — characterization test, then collapse TrivialIf at line 59
  What to do / Must NOT do: FIRST commit a vitest test pinning `isPublicAuthRoute(method, path)`: `GET /`→true; `POST /api/auth/login`→true; `GET /api/setup/status`→true; `GET /public/x.css` (non-/api GET)→true; `GET /api/runs`→false; `POST /api/setup/status`→false. THEN apply the TrivialIfJS simplification at line 59 ONLY if it preserves the exact allowlist semantics; the function already returns literal `true`/`false` from a `: boolean` signature (verified `src/security/authMiddleware.ts:54-61`), so the collapse is the `if (cond) return true; return false` → `return cond` form on line 59's guard — confirm the collapsed expression stays `boolean`-typed (the condition is `method === "GET" && !path.startsWith("/api/")`, already boolean). Must NOT widen or narrow which routes are public.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 5
  References: `src/security/authMiddleware.ts:54-61` (`isPublicAuthRoute`, TrivialIfJS at :59). Search `tests/` for `authMiddleware`/`isPublicAuthRoute`; extend or create `tests/security/authMiddleware.publicRoute.test.ts`.
  Acceptance criteria: new test green (all 6 cases); fix commit diff confined to authMiddleware.ts; `npm run check` exit 0; `npm test` full suite still green.
  QA scenarios: happy — allowlisted routes return true; failure — `GET /api/runs` returns false and `POST /api/setup/status` returns false (catches an over-broad collapse). Evidence `.omo/evidence/task-3-051-inspection-cleanup.txt`.
  Commit: Y (×2) | `test(security): pin isPublicAuthRoute allowlist` then `refactor(security): collapse trivial-if in isPublicAuthRoute (TrivialIfJS)`

- [x] 4. Remaining PointlessBooleanExpressionJS (3) + UnreachableCodeJS (1)
  What to do / Must NOT do: (a) `src/api/server.ts:1186` — simplify `error instanceof SyntaxError && typeof error === "object" && error !== null && "body" in error` → `error instanceof SyntaxError && "body" in error` (after `instanceof SyntaxError`, `typeof==="object"` and `!==null` are provably true). (b) `src/api/server.ts:3791-3792` — delete the entire dead `if (false) { app.post("/api/dev/proactive-trigger", ...) }` block (this resolves both PointlessBoolean:3791 and UnreachableCode:3792). FIRST run `git -C . log -S 'if (false)' --oneline -- src/api/server.ts` to confirm it's dead scaffolding (comment already says "no-op guard; real one registered earlier") — if blame shows a recently-toggled live route, leave a `// TODO` instead; expectation is clean delete. (c) `src/providers/discovery/adapters/regional.ts:231` — `match.available === false` → `!match.available` (`available: boolean` required, `regional.ts:81`). Must NOT alter the `"body" in error` guard behavior or the regional unavailability branch.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6,7,8,9
  References: `src/api/server.ts:1185-1191` (malformedJsonBodyHandler), `server.ts:3788-3793` (dead block + comment), `src/providers/discovery/adapters/regional.ts:229-233`, type at `regional.ts:81`.
  Acceptance criteria: `npm run check` exit 0; `npm test` green; grep confirms the `if (false)` block is gone; the 4 findings no longer match their source lines.
  QA scenarios: happy — malformed-JSON request still returns redacted 400 (existing chatApi/server test covers it); failure — confirm deleting the dead block did not remove a live route: `grep -rn "proactive-trigger" src/` shows the real registration still present elsewhere. Evidence `.omo/evidence/task-4-051-inspection-cleanup.txt`.
  Commit: Y | `refactor(api,providers): simplify pointless boolean expressions and remove dead route block (PointlessBooleanExpressionJS, UnreachableCodeJS)`

- [x] 5. Remaining TrivialIfJS (8)
  What to do / Must NOT do: Collapse the `if (cond) return true; else return false` (or assignment) patterns at: `src/api/server.ts:3986`, `src/orchestration/crucible.ts:444`, `src/orchestration/validationHealing.ts:672`, `src/providers/memoryAssignmentStore.ts:81`, `src/providers/memoryAssignmentStore.ts:226`, `src/sandbox/index.ts:510`, `src/setup/readiness.ts:225`, `src/setup/readiness.ts:263`. For EACH: read the condition expression and confirm it is statically typed `boolean`; if it is truthy/falsy (non-boolean), wrap `Boolean(...)` instead of a bare return. Must NOT change which branch is taken for any input.
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 9
  References: the 8 lines above (read ±5 lines each before editing).
  Acceptance criteria: `npm run check` exit 0; `npm test` green; each collapsed return is `boolean`-typed (no `string|boolean` leak).
  QA scenarios: happy — full suite green (these paths are covered by orchestration/setup/provider tests); failure — `npm run check` would flag a type widening if a non-boolean condition was returned raw. Evidence `.omo/evidence/task-5-051-inspection-cleanup.txt`.
  Commit: Y | `refactor: collapse trivial if/else boolean returns (TrivialIfJS)`

- [x] 6. Unused imports (19) — classify then remove
  What to do / Must NOT do: For EACH of the 19, classify before deleting: all are confirmed `import { X }` named imports (NO `import 'x'` side-effect imports exist in the set — verified). For `import type {...}` specifiers, delete the specifier; for value named imports, run `grep -rn "\bX\b" src/ tests/ scripts/` to confirm the specifier is unused in THIS file's scope and not re-exported. Remove only the unused specifier (keep the rest of a multi-name import line). Targets: `src/api/server.ts:112` MemoryRoleSchema, `:139` createInMemoryModuleConfigStore; `src/benchmark/runBenchmark.ts:27` BenchmarkTaskOutcome; `src/bin/rotate-key.ts:22` SecretStore; `src/domain/transitions.ts:1` STATES; `src/modules/manifest.ts:4` PUBLIC_EXTENSION_API_VERSION; `src/observability/posthogAdapter.ts:9` redactString; `src/orchestration/chatRunner.ts:3` CrucibleDecision, `:51` MAX_MESSAGE_CONTENT_LENGTH; `src/orchestration/dagCompiler.ts:3` CrucibleDecision; `src/orchestration/externalPostPlanning.ts:28` ModelRouter; `src/orchestration/prompts.ts:3` PlannerOutput, `:5` TriageResult; `src/orchestration/runControl.ts:2` RunPhase; `src/providers/memoryConfigStore.ts:8` MemoryProviderRecordSchema; `src/providers/memoryRoleRouter.ts:13` MEMORY_ROLE_DEFINITIONS; `src/store/sqlRectorStore.ts:64` createHmac + timingSafeEqual; `src/thalamus/router.ts:2` VALID_TRANSITIONS. Must NOT delete a specifier still referenced anywhere in the file; `tsc` is the backstop.
  Parallelization: Wave 3 | Blocked by: 4,5 | Blocks: 7,8
  References: the 19 sites above; `tsconfig.json` confirmed NO `experimentalDecorators`/`emitDecoratorMetadata` (no reflection risk).
  Acceptance criteria: `npm run check` exit 0 (proves none were actually needed); `npm test` green; `npx eslint`/inspection re-run would show ES6UnusedImports cleared (or manual grep of each removed name shows 0 in-file uses).
  QA scenarios: happy — build compiles clean after removals; failure — if any name was a type used later, `tsc` errors and the removal is reverted for that one + documented. Evidence `.omo/evidence/task-6-051-inspection-cleanup.txt`.
  Commit: Y | `refactor: remove unused import specifiers (ES6UnusedImports)`

- [x] 7. Unused local symbols (16)
  What to do / Must NOT do: Remove the unused local declarations/parameters: `src/api/server.ts:2559` synthesis; `src/bin/server.ts:235` secretKey param, `:474` resolveStartupOrchestrationConfig; `src/orchestration/chatRunner.ts:181` prompt + triage, `:183` traceId; `src/orchestration/deepPlanner.ts:350` basePlan param; `src/orchestration/externalPostPlanning.ts:111` preprocessorOutput, `:114` pathsExplored, `:118` traceId; `src/orchestration/preprocessor.ts:55` PreprocessorToolCallSchema; `src/orchestration/triage.ts:247` hasQuestionMark; `src/security/budget.ts:222` intFrom; `src/security/rateLimiter.ts:164` policy readonly field; `src/store/sqlRectorStore.ts:137` EntityRow interface; `src/templates/templateService.ts:307` costRank. For UNUSED PARAMETERS that are part of a fixed call signature (e.g. callbacks), prefix `_` instead of deleting (preserves arity); for a readonly field assigned in a constructor, confirm it is not set for a side effect before removing. Must NOT change any function's external signature/arity for exported/callback functions.
  Parallelization: Wave 3 | Blocked by: 6 | Blocks: 8
  References: the 16 sites above. Note `policy` (rateLimiter:164) and `EntityRow` (sqlRectorStore:137) — confirm zero use before delete.
  Acceptance criteria: `npm run check` exit 0; `npm test` green; each removed/underscored symbol confirmed unused via in-file grep.
  QA scenarios: happy — suite green post-removal; failure — `tsc` flags a still-used symbol → keep + document. Evidence `.omo/evidence/task-7-051-inspection-cleanup.txt`.
  Commit: Y | `refactor: remove unused local symbols (JSUnusedLocalSymbols)`

- [x] 8. Verified-dead exported symbols (subset of 33)
  What to do / Must NOT do: For EACH of the 33 JSUnusedGlobalSymbols candidates, run a repo-wide reference check BEFORE any deletion: `grep -rn "\bNAME\b" src/ tests/ scripts/ docs/` PLUS dynamic forms `grep -rEn "import\(|require\(" src/ tests/` near the name. DELETE only symbols with ZERO references anywhere. KEEP + document (do NOT delete) any symbol that is: referenced in tests; part of the public extension contract surface (`src/extensions/`, `src/modules/`, anything exported from `src/index.ts` or a documented `rector.extensions.v1alpha1` contract — see chunk 20 / `docs/extensions/public-contracts.md`); a zod schema/type alias re-exported for consumers. Candidates likely KEPT-as-public (verify, expect keep): `src/domain/states.ts:20` TERMINAL_STATES, `src/modules/registry.ts:159/196`, `src/modules/manifest.ts:10` ModuleTier, `src/observability/index.ts:23` ObservabilityEvent, `src/protocol/envelope.ts:32` ProtocolEnvelope, `src/store/schemas.ts:110` StoreEvent, `src/tools/types.ts:16` ToolRisk, `src/templates/templateSchema.ts:16/19`. `src/public/theme.js:315` createRectorTheme is EXCLUDED (browser asset, out of scope). Must NOT delete a symbol with any reference; when in doubt, KEEP + document.
  Parallelization: Wave 3 | Blocked by: 7 | Blocks: 9
  References: all 33 from `inspections/JSUnusedGlobalSymbols.xml` (src/ subset enumerated in the draft); `docs/extensions/public-contracts.md`; `src/index.ts` export surface.
  Acceptance criteria: `npm run check` exit 0; `npm test` green; for each of the 33, evidence file records DELETE (with the zero-ref grep) or KEEP (with the reference found / public-contract reason).
  QA scenarios: happy — deleted symbols had zero refs and build is clean; failure — a symbol referenced only in a test is KEPT (grep found the test ref), proving the test-inclusive check works. Evidence `.omo/evidence/task-8-051-inspection-cleanup.txt` (the per-symbol decision table).
  Commit: Y | `refactor: remove verified-dead exported symbols; document intentional public surface (JSUnusedGlobalSymbols)`

- [x] 9. UnnecessaryLocalVariableJS (4) + JSUnusedAssignment (1)
  What to do / Must NOT do: (a) Inline the redundant locals where it preserves behavior: `src/bin/server.ts:508` newKey, `src/orchestration/chatRunner.ts:318` result, `src/orchestration/preprocessor.ts:107` unique. (b) `src/templates/templateService.ts:909` `_exhaustive` — DO NOT inline; this is an intentional TS exhaustiveness-check pattern. Add inline `// noinspection UnnecessaryLocalVariableJS` (matching the suppression style used in Todo 10) and a one-line comment explaining the exhaustiveness guard. (c) `src/store/sessionSearch.ts:87` JSUnusedAssignment — remove the redundant initializer (e.g. `let x = <init>` where init is overwritten before use → drop the init). Must NOT remove a `_exhaustive` guard or change control flow.
  Parallelization: Wave 3 | Blocked by: 8 | Blocks: 10
  References: the 5 sites above; read ±6 lines each.
  Acceptance criteria: `npm run check` exit 0; `npm test` green; `_exhaustive` retained with suppression comment; sessionSearch initializer change is behavior-preserving (var overwritten before first read).
  QA scenarios: happy — suite green; failure — `tsc` would error if `_exhaustive` were wrongly removed (exhaustiveness break on a union), confirming we kept it. Evidence `.omo/evidence/task-9-051-inspection-cleanup.txt`.
  Commit: Y | `refactor: inline redundant locals; suppress intentional exhaustiveness guard (UnnecessaryLocalVariableJS, JSUnusedAssignment)`

- [x] 10. HttpUrlsUsage — suppress + document the localhost startup banner
  What to do / Must NOT do: At `src/bin/server.ts:595`, the `http://${host}:${port}` is inside a `console.log` startup banner printing the LOCAL bind address — not a live fetch/connect target. Add inline `// noinspection HttpUrlsUsage` immediately above the statement plus a one-line comment ("local bind address banner, not a network target"). Must NOT change `http` to `https` (would misrepresent the actual bind) and must NOT alter the logged string.
  Parallelization: Wave 4 | Blocked by: 9 | Blocks: 11
  References: `src/bin/server.ts:593-597` (the `server.listen` callback + console.log).
  Acceptance criteria: the noinspection comment present; `npm run build` exit 0; banner string unchanged (grep shows identical `http://${host}:${port}` text).
  QA scenarios: happy — `npm run dev` (or build) still prints the same banner; failure — N/A (doc-only change). Evidence `.omo/evidence/task-10-051-inspection-cleanup.txt`.
  Commit: Y | `chore(bin): document intentional http localhost startup banner (HttpUrlsUsage false positive)`

- [x] 11. ExceptionCaughtLocallyJS (6) — triage, fix obvious, document rest
  What to do / Must NOT do: For each of `src/memory/chromaMemoryAdapter.ts:89`, `:303`, `src/memory/mem0Adapter.ts:73`, `src/sandbox/e2bSandboxAdapter.ts:145`, `src/store/sqlRectorStore.ts:420`, `:752`: read the surrounding try/catch. A case is FIXABLE only if (a) the `catch` block does nothing except re-throw the SAME error unchanged AND (b) removing the try/catch produces identical observable behavior (no wrapping, no logging, no cleanup, no error transformation). Restructure those minimal cases to remove the local throw-catch. For ANY case that wraps/logs/transforms/adds context, KEEP it and record "kept — <reason>" in the commit message. Must NOT change error propagation, messages, or types for kept cases; behavior-preserving only.
  Parallelization: Wave 4 | Blocked by: 10 | Blocks: 12
  References: the 6 sites above; read the full try/catch each.
  Acceptance criteria: `npm test` green (memory/sandbox/store tests cover error paths); commit message lists all 6 with fix/keep + reason; `npm run check` exit 0.
  QA scenarios: happy — error-path tests for the adapters still pass with identical thrown errors; failure — if a "fix" changed the thrown error shape, the adapter error-path test fails → revert + keep. Evidence `.omo/evidence/task-11-051-inspection-cleanup.txt`.
  Commit: Y | `refactor(memory,sandbox,store): resolve obvious local throw-catch; document intentional ones (ExceptionCaughtLocallyJS)`

- [ ] 12. Update concerns-and-vulnerabilities.md + write chunk plan copy under docs/plans/chunks/
  What to do / Must NOT do: (a) Append a chunk-051 section to `docs/plans/concerns-and-vulnerabilities.md` documenting: every inline suppression added (`_exhaustive` UnnecessaryLocalVariableJS, http banner HttpUrlsUsage), every JSUnusedGlobalSymbols symbol KEPT as intentional public surface (with reason), every ExceptionCaughtLocallyJS case KEPT (with reason), and the 4 inspections with ZERO src/ findings that were therefore deferred/no-op (JSDeprecatedSymbols, BadExpressionStatementJS, JSCheckFunctionSignatures, DuplicatedCode_aggregate — all findings were in tests/, out of scope). (b) Copy the final plan to `docs/plans/chunks/051-inspection-cleanup.md` (chunk discipline requires a plan under docs/plans/chunks/). Must NOT introduce new concerns beyond what this chunk touched; must NOT claim a finding was fixed if it was suppressed/kept.
  Parallelization: Wave 5 | Blocked by: 1-11 | Blocks: F1-F4
  References: `docs/plans/concerns-and-vulnerabilities.md`; `docs/plans/chunks/` (numbering reaches 050).
  Acceptance criteria: concerns doc contains the chunk-051 section with all suppressions/kept/deferred items; `docs/plans/chunks/051-inspection-cleanup.md` exists and matches the executed plan.
  QA scenarios: happy — doc lists each suppression with file:line + reason; failure — a reviewer cross-checks a suppressed line and finds it documented. Evidence `.omo/evidence/task-12-051-inspection-cleanup.txt`.
  Commit: Y | `docs(chunk-051): record inspection-cleanup suppressions, kept false-positives, and deferred-empty inspections`

- [ ] 13. Doc-sync — fix stale branch/worktree/chunk facts in AGENTS.md + roadmap
  What to do / Must NOT do: Correct the verified-stale facts that caused the original chunk-numbering/branch confusion. In `AGENTS.md` (worktree root): line 13 active branch `rector-0.3.0-configured-product` → `rector-0.3.0-cartographer`; line 14 worktree path `C:/Users/MharSky/Dev/Projects/Rector/.worktrees/rector-0.2.0` → `/home/ornyx-opifex/projects/rector/.worktrees/rector-0.3.0-cartographer`; line 67 "Completed through Chunk 37 (see .../037-vitest-auth-live-memory.md)" → "Completed through Chunk 50 (see docs/plans/chunks/050-cartographer-inventory-slice.md)"; line 98 "Current test baseline after Chunk 37:" → "after Chunk 50:"; line 250 (Release Path) `Branch: rector-0.3.0-configured-product` → `rector-0.3.0-cartographer`. In `docs/plans/rector-master-roadmap.md`: line ~250 `Branch: rector-0.3.0-configured-product` → `rector-0.3.0-cartographer`. Must NOT change the test-count numbers (213/1369 still accurate — only the chunk reference is stale), must NOT rewrite the "configured-product-architecture.md" canonical-doc references (those are correct doc filenames, not the branch name), and must NOT touch prose unrelated to branch/worktree/chunk/baseline. Re-read each line before editing (line numbers may shift after earlier edits — match on text, not number).
  Parallelization: Wave 5 | Blocked by: — | Blocks: F1-F4 | Can parallelize with: 12
  References: explore findings — AGENTS.md:13,14,67,98,250; docs/plans/rector-master-roadmap.md branch line. Ground truth: branch rector-0.3.0-cartographer, worktree /home/ornyx-opifex/projects/rector/.worktrees/rector-0.3.0-cartographer, highest chunk 050-cartographer-inventory-slice.md, next 051.
  Acceptance criteria (agent-executable): `grep -n "configured-product" AGENTS.md docs/plans/rector-master-roadmap.md` returns ONLY canonical-architecture-doc filename references (no `Branch:` or `Active branch:` lines); `grep -n "Chunk 37\|MharSky\|rector-0.2.0" AGENTS.md` returns nothing; `npm run build` unaffected (docs-only).
  QA scenarios: happy — grep for the stale strings returns zero branch/path/chunk matches; failure — grep still finds `Active branch: .*configured-product` → re-edit. Evidence `.omo/evidence/task-13-051-inspection-cleanup.txt`.
  Commit: Y | `docs: sync AGENTS.md and roadmap to cartographer branch + chunk 50/51 state`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — every src/ finding in scope is fixed/suppressed/documented; no out-of-scope path (tests/, scripts/, public/*.js) was touched (`git diff --name-only <base>..HEAD` contains only src/ + docs/ + .omo/ + tests/ for the 3 added characterization tests).
- [ ] F2. Code quality review — GLM review (`vultr/zai-org/GLM-5.1-FP8-normalize:high`) over the diff: confirm all edits behavior-preserving, no type widening, security simplifications match their locked truth tables.
- [ ] F3. Real manual QA — fresh `npm test` (≥1369 pass / 0 fail) + `npm run build` (exit 0) + `npm run check` (exit 0) from worktree root; capture output.
- [ ] F4. Scope fidelity + authorship — `git log --format="%an <%ae>" <base>..HEAD | sort -u` == exactly `Lanz Skyler B. Busa <busalanz76@gmail.com>`; no `--no-verify`; `npm audit fix --force` never run.

## Commit strategy
- One commit per component (Todos 4-12); the 3 security todos (1-3) are each TWO commits: characterization test first, then the simplification.
- ~15 commits total, all on branch `rector-0.3.0-cartographer` in the worktree.
- EVERY commit authored explicitly as the user:
  `git -c user.name="Lanz Skyler B. Busa" -c user.email="busalanz76@gmail.com" commit -m "<message>"`
  (local git user.name/email are unset; the `-c` flags are mandatory on every commit). Never an agent identity, never `--no-verify`.
- Conventional-commit style matching repo history (`refactor(scope):`, `test(scope):`, `chore(scope):`, `docs(scope):`).
- Do NOT push or open a PR unless the user explicitly asks.

## Success criteria
- All 5 PointlessBoolean + 1 UnreachableCode + 9 TrivialIf + 19 unused imports + 16 unused locals + 4 unnecessary locals + 1 unused assignment src/ findings are fixed or (for `_exhaustive`) suppressed-with-doc.
- JSUnusedGlobalSymbols: every src/ candidate is either deleted (zero refs proven) or kept-and-documented; theme.js excluded.
- http banner suppressed + documented; ExceptionCaughtLocally triaged (obvious fixed, rest documented).
- 3 characterization tests added and green, each committed before its security simplification.
- `npm test` ≥1369 pass / 0 fail, `npm run build` exit 0, `npm run check` exit 0 — all fresh from worktree root.
- `concerns-and-vulnerabilities.md` updated; plan copied to `docs/plans/chunks/051-inspection-cleanup.md`.
- All commits authored as the user; no out-of-scope files changed; `npm audit fix --force` never run.
