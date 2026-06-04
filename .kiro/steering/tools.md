# Tool Usage Guidance

## Git Inspection (GitKraken MCP)

Use the GitKraken MCP for git inspection when useful:

- Check branch state and status.
- View diffs and compare against `main`.
- Review commit history.
- Stage/commit only when the user explicitly asks.

Plain terminal git is also fine for read-only inspection:

```bash
git status --short
git diff
```

## Terminal

Use the terminal for verification and local checks:

```bash
npm test
npm run build
npm run check
node scripts/generate-roadmap-issues.js --check
```

Prefer dedicated file/search/read tools over shell `cat`/`find`/`grep`/`ls`. Use file-search
before editing to locate the right module.

## Hard Tool Rules

- **Do not push by default.** Never push or tag unless the user explicitly asks.
- **No destructive git.** No force push, `reset --hard`, `clean -f`, or branch deletion
  without explicit user permission.
- **No live provider calls.** Do not run real provider/network calls unless the user
  explicitly asks. Provider-free/local mode is the default.
- **No live web/provider tools** for routine work unless the user explicitly requests current
  external information.
- **Never paste or log secrets.**
- Do not run `npm audit fix --force` without explicit user approval.

## Long-Running Processes

Do not block on long-running commands (`npm run dev`, watchers). Recommend the user run dev
servers manually, or start them as background processes. Use `vitest run` (`npm test`), not
watch mode, for verification.

## Behavior Summary

When implementing: read steering + source-of-truth docs, inspect code/tests, make a small
plan, write/update tests first where feasible, implement minimal deterministic code, update
the concerns register if risk changed, run focused tests, then run full verification, and
summarize changed files with evidence.

When auditing: report only valid, reproducible findings with file/line, impact, proof, and a
suggested fix. Distinguish already-documented limitations from new bugs.
