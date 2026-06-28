---
name: rector-evidence-gatekeeper
description: "MUST USE for evals, validators, evidence packets, typed facts, memory promotion, validation/healing, Capability-SLM summaries, and any code that turns tool/model output into trusted facts."
metadata:
  project: rector
  invariant: evidence
---

# rector-evidence-gatekeeper

Use whenever Rector turns raw output, model text, logs, eval results, or tool responses into facts or decisions.

Phase 2 typed facts: `docs/plans/2-0/phases/phase-2-typed-facts.md` defines envelopes, ledger, adapters, and validation gates. Until that lands, apply the trust ladder and prefer `insufficient_evidence` over guessing.

## Trust ladder

1. Raw tool output is stored as artifact, not trusted fact.
2. Extraction produces structured evidence.
3. Zod/schema validation checks shape.
4. Evidence is grounded by path, line, command, artifact, source, or test.
5. Rules/checks validate scope, risk, and coverage.
6. Validators confirm behavior where applicable.
7. Only validated traces promote memory, facts, or skills.

## Hard rules

- Do not mark validation `passed: true` without artifact, command, test, or trusted validator result.
- Do not promote durable memory/facts from unvalidated model text.
- Preserve warnings and coverage gaps.
- Return `insufficient_evidence` when support is missing or contradictory.
