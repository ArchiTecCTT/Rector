---
inclusion: fileMatch
fileMatchPattern: 'tasks.md'
---

# Spec Task Orchestration Resilience

Guidance for the orchestrator agent when running spec tasks (especially "Run All Tasks"),
where work is delegated to `spec-task-execution` subagents. Captured from a real run where
subagents were repeatedly interrupted by transient cancellations / network errors.

## Core principle: disk is the source of truth, not the tool report

A subagent can report "cancelled" or fail with a network error *after* it has already written
some or all of its files. Never trust the completion message alone. Before re-running anything,
reconcile against the working tree:

1. Check whether the deliverable files exist and contain the expected symbols.
2. Run the focused verification (type-check + the relevant test file) to see if the partial
   work is actually complete and correct.
3. Only re-dispatch the part that is genuinely missing or broken.

This avoids redoing finished work and avoids clobbering a subagent's correct output with a
fresh, possibly-different implementation.

## Cancellation / network-error recovery protocol

When a subagent dispatch returns "cancelled" or a network error:

1. **Reconcile.** Inspect disk (read the target files; `git status` to see what changed).
   Cancelled subagents frequently leave complete or partial deliverables behind.
2. **Verify partial work.** If files exist, run `npm run check` and the task's focused test
   (e.g. `npx vitest run tests/<file>.test.ts`). Passing == treat as done; failing == note the
   exact defect.
3. **Retry once.** Re-dispatch the task. If partial work exists, tell the subagent it is
   *finishing/fixing* existing work (give it the current file contents and the specific
   failure), not starting fresh.
4. **Two-failure fallback.** If a task fails/cancels twice, stop delegating and implement it
   directly in the main agent. Gather context (read the module under test, the shared test
   helpers, the design/requirements clauses), write the file, and verify it yourself. This was
   necessary for the local-mode regression test, the end-to-end redaction test, and a
   leftover failing assertion in the external-runner unit tests.
5. **Keep the task ledger honest.** If the task-tracking tool is temporarily unavailable,
   update the `tasks.md` checkboxes directly (`- [ ]` → `- [x]`) so the persistent record stays
   accurate, and reconcile statuses once the tool recovers (a reverted status does not mean the
   work was undone — re-verify against disk).

## Batching to limit blast radius

Dispatching a large wave of parallel subagents made the *last* task in the batch the most
likely to be cancelled. Prefer:

- Dispatch a wave's independent tasks in parallel, but keep batches modest (≈2–4).
- Ensure parallel tasks touch **disjoint files** (e.g. one edits `planner.ts`, another adds a
  new `*.test.ts`) so a retry never races a sibling's writes.
- When only one task is left, dispatch it solo.

## Gotcha: search tools give false negatives in git-ignored worktrees

In a git-ignored worktree (e.g. under `.worktrees/`), `grep_search` / `file_search` can return
"no matches" even when the symbol exists, because they respect `.gitignore`. Do **not** conclude
a deliverable is missing from a failed search. Confirm by reading the file directly, or pass
`includeIgnoredFiles: "yes"` to file search. Several false "task not started" diagnoses in the
BYOK run traced back to this.

## Verification gate (unchanged)

A task is only done when its tests and the project gates pass. For the full checkpoint, run the
complete set and confirm green:

```bash
npm test
npm run build
npm run check
node scripts/generate-roadmap-issues.js --check
node scripts/export-linear-issues.js --check
```

## Note on auto-resume

The orchestrator cannot change subagent runtime behavior to silently auto-resume after a
network error — interruption handling is environment-level. The protocol above is the agent-side
equivalent: detect the interruption, reconcile against disk, and continue from the real state.
