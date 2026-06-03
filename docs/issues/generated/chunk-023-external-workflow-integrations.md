# Chunk 23 — External Workflow Integrations

Integrate Linear and Make request builders and disabled-by-default invocation gates, with Requestly and BrowserStack plans documented for later.

## Metadata

- chunk: 023
- labels: roadmap, chunk:023, integrations, workflows, linear, difficulty:advanced
- difficulty: advanced
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Linear and Make payload schemas, config validation, and request builders are tested locally.
- [ ] Network invocation is disabled by default and protected by explicit configuration gates.
- [ ] Requestly and BrowserStack integration plans are documented without adding required dependencies.

## Test commands

- `npm test -- tests/workflows.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:023, integrations, workflows, linear, difficulty:advanced.
- Do not paste credentials, API keys, or private board URLs into this issue.
