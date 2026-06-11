# Chunk 12 — DAG Compiler

Compile accepted plans into validated JSON DAGs with dependencies, validation nodes, budget policy, permissions, retries, and timeouts.

## Metadata

- chunk: 012
- labels: roadmap, chunk:012, dag, compiler, schemas, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Accepted plans compile to valid DAG JSON with nodes and dependency edges.
- [ ] Validation, budget, retry, timeout, and tool permission metadata are included.
- [ ] Unsafe shell permissions are denied by default in compiled metadata.

## Test commands

- `npm test -- tests/dagCompiler.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:012, dag, compiler, schemas, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
