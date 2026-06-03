# Chunk 14 — Validation and Healing Loop

Implement bounded self-healing with validation failure classification, safe repair attempts, reruns, and escalation paths.

## Metadata

- chunk: 014
- labels: roadmap, chunk:014, validation, healing, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Validation failures are classified into deterministic categories.
- [ ] Safe bounded repairs are proposed and applied only when allowed by policy.
- [ ] Unresolved or unsafe failures escalate to NEEDS_DECISION or FAILED.

## Test commands

- `npm test -- tests/validationHealing.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **high**, and labels: roadmap, chunk:014, validation, healing, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
