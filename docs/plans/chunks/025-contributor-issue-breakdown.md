# Chunk 25 — Contributor Issue Breakdown

## Scope

Convert the Rector roadmap chunks into contributor-ready issue metadata and generated issue documents without making network calls.

## Goals

- Add a canonical local issue catalog for roadmap chunks 0–25.
- Include labels, acceptance criteria, validation commands, difficulty, and `good first issue` candidates.
- Generate GitHub-ready Markdown issue files from the local catalog.
- Document project board and Linear sync guidance as optional/manual workflow guidance.
- Keep local contributor setup provider-free and deterministic.

## Non-goals

- No GitHub API calls.
- No Linear API calls.
- No project board mutation.
- No issue tracker credentials or secret handling.
- No changes to orchestration runtime behavior.

## Implementation Plan

1. Add failing tests for issue metadata schema, roadmap coverage, generated Markdown count/content, and no-network generation.
2. Add `docs/issues/roadmap-issues.json` as the canonical issue catalog.
3. Add `scripts/generate-roadmap-issues.js` to validate the catalog and render Markdown issue files under `docs/issues/generated/` or a caller-supplied output directory.
4. Commit generated docs for all 26 roadmap chunks plus a docs/issues README with project board and Linear sync guidance.
5. Update `docs/README.md` so contributors can find the issue catalog.
6. Update the concerns register if the generated issues reveal any deferred limitation.
7. Run focused tests, then `npm test` and `npm run build`.

## Acceptance Criteria

- Exactly 26 roadmap chunk issues are represented, numbered 0 through 25.
- Every issue has labels, acceptance criteria, test commands, difficulty, and project board/Linear sync metadata.
- At least several safe documentation/schema tasks are marked as `good first issue`.
- Issue generation is local-only and deterministic.
- Tests validate schema, issue coverage, generated Markdown count, generated content, and that generation does not call network APIs.
- `npm test` and `npm run build` pass.
