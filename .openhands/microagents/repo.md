---
name: rector_repo_context
type: knowledge
version: 1.0.0
agent: CodeActAgent
triggers:
  - rector
  - orchestration
  - provider
  - memory
  - sandbox
  - security
  - auth
  - rbac
---

# Rector Repository Context

Rector is an Apache-2.0, chat-first, self-healing AI engineering orchestration system.

## Core product constraints

- Local/provider-free mode is mandatory and must remain zero-config, deterministic, and network-free.
- Users configure providers, models, memory backends, sandbox, templates, and auth from the web UI.
- Cloud providers are optional. Never make Azure/OpenAI/Auth0/E2B/Mem0/Chroma/TiDB required for default tests.
- Secrets must go through SecretStore references. Never return or log raw secret values.
- Redact provider/sandbox/memory errors before API responses, traces, audit logs, and docs.

## Build and test

Use:

```bash
npm install
npm test
npm run build
npm run check
npm audit
```

Optional live smokes require explicit env and should remain skipped by default:

```bash
npm run smoke:memory
npm run smoke:tidb
```

## Source layout

- `src/orchestration`: triage, context, planner, skeptic, crucible, DAG, execution, validation/healing, synthesis, neuro-symbolic helpers.
- `src/providers`: LLM/provider config, discovery, orchestration/memory assignment bridges.
- `src/memory`: memory providers, truth library, Mem0/Chroma/TiDB adapters.
- `src/security`: auth, redaction, budgets, SecretStore, user data isolation.
- `src/sandbox`: sandbox policy, patch artifacts, local/E2B execution boundaries.
- `src/api/server.ts`: Express API and static UI host.
- `tests`: unit, integration, DOM, and property tests.
- `docs/plans/chunks`: implementation plans and chunk evidence.

## Completion rules

- Do not claim completion without verification output.
- Prefer additive compatibility layers over breaking existing local behavior.
- Update concerns register for new risks, security limits, production gaps, or resolved concerns.
