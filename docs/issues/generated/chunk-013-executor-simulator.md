# Chunk 13 — Executor Simulator

Run DAGs locally with fake providers and safe node types while enforcing dependencies, retries, timeouts, and shell denial.

## Metadata

- chunk: 013
- labels: roadmap, chunk:013, executor, simulation, local-mode, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Simulator executes DAG nodes in dependency order with structured results.
- [ ] Retry policy, timeout metadata, dependency blocking, and unsafe shell denial are enforced in simulation.
- [ ] No real shell, provider, or external network execution occurs.

## Test commands

- `npm test -- tests/executorSimulator.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:013, executor, simulation, local-mode, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
