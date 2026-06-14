# Chunk Plan Template

## Planning Format (use when starting a new chunk)

```markdown
# Chunk {NNN} — {Full Descriptive Title}

## Goal

{1-3 sentences describing what this chunk accomplishes and why.}

## Scope

- {What is IN scope — bullet list}
- {Explicitly state what is OUT of scope}

## Acceptance Criteria

1. {Testable assertion — deterministically verifiable}
2. {Testable assertion}
3. {Testable assertion}
N. `npm test` and `npm run build` pass with zero regressions.

## Implementation Notes

- {Design constraints}
- {Key decisions or trade-offs}
- {Dependencies on prior chunks}
- {Items explicitly deferred to future chunks}

## Wave Decomposition (for complex chunks)

### Wave 1 — {Label}

#### 1A — {Sub-task title}
- {Detail}

#### 1B — {Sub-task title}
- {Detail}

### Wave 2 — {Label}

#### 2A — {Sub-task title}
- {Detail}
```

## Retrospective Format (use after chunk completion)

```markdown
# Chunk {NNN} — {Full Descriptive Title}

**Status:** Complete (Waves 1-N).

## Goal

{Description of motivation and what was closed}

## Wave 1 — {Label} (commits `{hash}`-`{hash}`)

### 1A — {Sub-task title} (`{commit_hash}`)
- {Bullet details of what was done}

### 1B — {Sub-task title} (`{commit_hash}`)
- {Bullet details}

## Wave 2 — {Label} (commits `{hash}`-`{hash}`)

### 2A — {Sub-task title} (`{commit_hash}`)
- {Detail}

## Verification

```bash
npm test    # {X} files / {Y} tests passing ({Z} skipped)
npm run build  # passing
```

## All commits (chronological)

| Hash | Message |
|------|---------|
| `{hash}` | {conventional commit message} |

## Deferred / follow-on

- {Bullet items explicitly punted to future chunks}
```

## Numbering Rules

- Zero-padded 3-digit: `002`, `010`, `037`
- Strictly sequential, no gaps
- Filename: `{NNN}-{kebab-case-title}.md`
- Heading: `# Chunk {N} — {Title}` (em-dash separator)

## Commit Message Convention

Format: `{type}(chunk-{NNN}): {description}`

Types:
- `feat` — new functionality
- `test` — test additions/changes only
- `fix` — bug fix
- `chore` — build, config, cleanup
- `docs` — documentation only
- `perf` — performance improvement

Examples:
- `feat(chunk-038): add Anthropic provider adapter`
- `test(chunk-038): property tests for Anthropic adapter discovery`
- `docs(chunk-038): update concerns register with rate-limit risk`

## Invariants (must hold for every chunk)

1. Local-mode (zero-API-key, zero-network) never broken
2. `npm test` passes with zero regressions
3. `npm run build` succeeds
4. Concerns register updated for any discovered issues
5. No secrets, credentials, or PII in committed code
6. Each commit is atomic and conventional-commit formatted
