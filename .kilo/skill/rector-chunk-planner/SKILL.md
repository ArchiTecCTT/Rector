---
name: rector-chunk-planner
description: "This skill should be used when planning, creating, or completing a new Rector development chunk. Covers chunk plan authoring, numbering conventions, wave decomposition, commit discipline, concerns register updates, and verification gates. Triggers on tasks like 'create chunk plan', 'plan next chunk', 'start chunk N', or any new feature work requiring chunk discipline."
---

# Rector Chunk Planner

Plan and execute Rector development chunks following established project conventions.

## Purpose

Every Rector feature, fix, or enhancement follows "chunk discipline" — a structured workflow ensuring traceability, test coverage, and architectural integrity. This skill encodes the full chunk lifecycle from plan creation through verification and commit.

## When to Use

- Planning a new feature, fix, or enhancement
- Creating a new chunk plan document
- Starting implementation of a planned chunk
- Completing and documenting a finished chunk
- Updating the concerns register after discovering issues

## Workflow

### 1. Determine the Next Chunk Number

To find the next chunk number, list existing plans in `docs/plans/chunks/` and identify the highest-numbered file. The next chunk uses `N+1` with zero-padded 3-digit format.

- **Filename convention:** `{NNN}-{kebab-case-short-title}.md`
- **Examples:** `037-vitest-auth-live-memory.md`, `010-skeptic-review.md`

### 2. Write the Chunk Plan

Create the plan file at `docs/plans/chunks/{NNN}-{title}.md`. Use the format from `references/chunk-template.md`. Every plan must include:

- A clear **Goal** (1-3 sentences, motivation + what is closed)
- **Scope** bullets (what's in and explicitly out)
- **Acceptance Criteria** (numbered, testable assertions)
- Final AC is always: `npm test` and `npm run build` pass
- **Implementation Notes** (constraints, design decisions, deferred items)

For complex chunks, decompose into **Waves** with lettered sub-tasks (1A, 1B, 2A...).

### 3. Implement Following Chunk Discipline

During implementation:

1. Work one wave/sub-task at a time
2. Write tests before or alongside implementation (TDD preferred)
3. Preserve local-mode baseline — never break zero-API-key, zero-network execution
4. Use conventional commit messages: `{type}(chunk-{NNN}): {description}`
   - Types: `feat`, `test`, `chore`, `docs`, `perf`, `fix`
5. Keep each commit atomic — one logical change per commit

### 4. Update the Concerns Register

After each chunk (or when discovering issues during implementation), update `docs/plans/concerns-and-vulnerabilities.md`. See `references/concerns-format.md` for the entry format.

- New concerns go under `## Open`
- Resolved concerns get `**Status:** RESOLVED` with traceability, then migrate to `## Closed / Mitigated`
- Always include: Status, Traceability (file paths + line numbers), Source, Severity, Root cause, Plan/Mitigations

### 5. Verify and Document Completion

Before declaring a chunk complete:

```bash
npm test
npm run build
```

Record the test baseline (e.g., "215 files / 1380 tests passing") in the completed chunk plan.

For post-completion documentation, update the chunk plan to the retrospective format:
- Add `**Status:** Complete`
- Add `## Verification` section with commands
- Add `## All commits (chronological)` table with hashes
- Add `## Deferred / follow-on` for items explicitly punted

### 6. Update AGENTS.md

After completing a chunk, update the "Current Implemented Chunks" section and test baseline in `AGENTS.md`.

## Reference Files

- `references/chunk-template.md` — The standard chunk plan template with both planning and retrospective formats
- `references/concerns-format.md` — Format for concerns register entries
