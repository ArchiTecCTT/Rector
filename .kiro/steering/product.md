# Product

## What Rector Is

Rector is Apache-2.0 open-source software: a chat-first, self-healing AI engineering
orchestration system. The user experience is a normal chat surface like Claude or ChatGPT.
Beneath the chat, Rector runs hidden deterministic orchestration:

```
chat -> triage -> context building -> planner -> skeptic review -> crucible arbitration
     -> DAG compilation -> executor simulator / safe execution -> validation -> healing
     -> synthesis -> final assistant response
```

Users should never have to manually choose agents, model routes, validators, retries,
healing steps, or workflow integrations. They chat; Rector orchestrates underneath and
returns a useful answer with optional trace details.

## Core Product Principles

1. **Chat first, orchestration hidden.** The UI is a chat surface with an optional trace
   drawer, not an agent dashboard.
2. **Deterministic control plane.** LLMs propose; Rector validates, routes, retries, and
   commits state deterministically.
3. **Self-healing by default.** Validation failure is not terminal. It opens a bounded,
   safe repair loop.
4. **Evidence over vibes.** Plans, patches, retrievals, and answers carry evidence pointers.
5. **Small models first.** Cheap/fast models do mechanical work; flagship models are
   reserved for hard synthesis and unresolved conflicts.
6. **Provider-free mode is mandatory.** Rector must run fully without API keys using
   deterministic fake/local adapters.
7. **Fast, light, responsive.** Prefer small deterministic modules over heavy frameworks,
   background daemons, or always-on network calls.

## Current Target: `v0.1.0-alpha`

The current goal is a **local developer preview**, not production SaaS. It proves the full
hidden architecture through one complete vertical slice running on fake/local adapters.

Roadmap chunks 0–25 are implemented. The brainstem pipeline runs end-to-end locally with
no provider calls and zero cost.

## What Rector Is Not Yet

- Not production SaaS. No multi-user auth, quotas, or billing.
- Not a real sandbox isolation boundary (safe execution is contract + allowlist only).
- Not backed by durable storage (the store is in-memory and resets on restart).
- Not wired to live providers, workflows, or deployment targets by default (these are
  stubs/contracts disabled by default).
- Synthesis is a deterministic trace summary, not provider-backed semantic generation yet.

## Release Path (high level)

- **v0.1.0-alpha** — local brainstem preview (current target).
- **Public alpha** — optional real providers, durable persistence, better UI, basic auth
  for a hosted demo.
- **Beta** — safe sandbox execution, operator console, memory/search, integrations.
- **v1 / production** — multi-user auth, quotas/billing, durable infra, robust sandboxing,
  compliance, monitoring/SLOs.

Do not describe Rector as production-ready. It is an alpha developer preview.

## Source of Truth

If docs conflict, the authoritative documents win in this order:

1. `docs/architecture/rector-0.1.0-architecture.md`
2. `docs/plans/rector-master-roadmap.md`
3. `docs/plans/concerns-and-vulnerabilities.md`
4. `docs/audits/final-gemini-audit.md`

Older local-MVP / cloud-heavy docs are preserved but quarantined with banners. The
README "Architecture Overview" still uses older "Thalamus" naming; the brainstem pipeline
above and the architecture doc are the current source of truth.
