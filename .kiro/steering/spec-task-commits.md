---
inclusion: fileMatch
fileMatchPattern: 'tasks.md'
---

# Commit Cadence During Spec Task Execution

When executing spec tasks (running tasks from a `tasks.md`), commit after each task so the
history shows exactly what each task added and so partial progress survives interruptions
(e.g. a cancelled subagent or a crashed session). This scope is deliberate: it applies to
spec task execution, not to ad-hoc edits during exploratory work.

## Rule

After a task (or a small, coherent wave of related tasks) is **complete and verified**, make a
local commit before moving to the next one.

A task is "complete and verified" only when:

1. Its deliverable files exist and contain the expected work (confirmed against disk, not just
   a subagent's success message — see `spec-task-orchestration.md`).
2. The focused checks pass: `npm run check` plus the task's relevant test file(s).

Do not commit a task that left the tree red. Fix or revert first.

## What to commit

- Stage only the files that belong to the task. Prefer explicit paths over `git add .` so
  unrelated working-tree changes are not swept in.
- One task → one commit is the default. A small wave of tightly-related tasks that only make
  sense together (e.g. an implementation task plus its dedicated test task) may share a commit.
- Keep the spec's `tasks.md` checkbox update in the same commit as the work it marks done, when
  practical, so the ledger and the code move together.

## Commit message format

Use Conventional Commits, with a body that names the task/requirement:

```
feat(<area>): <what the task added>

<one or two lines on the behavior; reference the task or requirement id,
e.g. "Task 3.2 / ORN-34">
```

Use `test(...)` for test-only tasks, `docs(...)` for docs/steering, `fix(...)` for bug fixes.

## Hard limits (unchanged)

- **Local commits only.** Never `push` or tag as part of task execution. Pushing/tagging
  happens only when the user explicitly asks (see `tools.md` and `release.md`).
- **No destructive git.** No force push, `reset --hard`, `clean -f`, or branch deletion without
  explicit user permission.
- **Never commit secrets.** Do not stage `.env`, credential files, or anything containing keys.
- **No `--amend` of pushed commits.** Prefer new commits; only amend your own unpushed commit
  when fixing the immediately preceding one.
