# Contributor Issue Breakdown

This directory contains the local, provider-free issue breakdown for the Rector roadmap.

## Files

- [`roadmap-issues.json`](./roadmap-issues.json) — canonical issue metadata for chunks 0 through 25.
- [`generated/`](./generated/) — GitHub-ready Markdown issue drafts generated from the catalog.

## Regenerate issue drafts

```bash
node scripts/generate-roadmap-issues.js
node scripts/generate-roadmap-issues.js --check
```

The generator is deterministic and local-only. It does not call GitHub, Linear, project boards, or any network service.

## Project board guidance

Maintainers can copy each generated draft into GitHub Issues and add it to the `v0.1.0-alpha` project board with status `Ready`. Keep labels from the draft exactly where possible so filtering by `roadmap`, `chunk:NNN`, `difficulty:*`, and `good first issue` works consistently.

Suggested columns:

1. `Ready` — contributor-ready issue with acceptance criteria and test commands.
2. `In progress` — assigned or actively being worked.
3. `Review` — pull request open or implementation awaiting maintainer review.
4. `Done` — merged and validated with required commands.

## Linear sync guidance

Linear sync is disabled by default. Open-source contributors do not need Linear access.

If maintainers mirror issues manually into Linear:

- Use team key `RECTOR`.
- Preserve the issue title, acceptance criteria, labels, and test commands.
- Do not paste API keys, private board URLs, user data, or maintainer-only notes into public issue bodies.
- Treat GitHub Issues as the public source of truth unless maintainers explicitly document another workflow.
