---
name: rector-evidence-gatekeeper
description: "MUST USE for Rector evals, validators, capability outputs, SLM summaries, memory promotion, evidence packets, validation/healing, and any code that turns model/tool output into trusted facts. Enforces typed evidence, grounding, insufficient_evidence instead of guessing, and no ungrounded pass states. Triggers: 'evidence', 'validator', 'eval', 'memory promotion', 'Capability-SLM', 'insufficient_evidence'."
compatibility: opencode
metadata:
  project: rector
  invariant: evidence
---

# rector-evidence-gatekeeper

Use this skill whenever Rector turns raw output, model text, tool logs, or eval results into facts or decisions.

**Phase 2 alignment:** `docs/plans/2-0/phases/phase-2-typed-facts.md` defines the typed fact protocol (envelopes, ledger, adapters, validation gates). Until Phase 2 lands, apply the trust ladder below; do not treat natural-language summaries as durable facts. Prefer `insufficient_evidence` over inventing fact records.

## Trust ladder

Do not trust prose directly. Trust increases only through gates:

1. Raw tool exhaust is stored as raw artifact, not trusted fact.
2. Capability/SLM extraction produces structured evidence.
3. Zod/output schema validation checks shape.
4. Evidence is grounded by path, line, command, artifact, source, or test.
5. Rule engine checks scope, risk, coverage, and policy.
6. DAG validators confirm behavior where applicable.
7. Only validated traces promote memory or skills.

## Required fact vocabulary

Prefer typed records like:

```text
CapabilityRequest(task_id, capability_id, intent, scope, why)
CapabilityCall(call_id, capability_id, model, provider, started_at)
ToolCall(call_id, tool_name, args, scope)
RawArtifact(call_id, uri, hash, size_bytes, redaction_state)
EvidenceItem(call_id, kind, path, line_span, symbol, relevance, confidence)
Coverage(call_id, searched_scope, raw_count, returned_count, omitted_scope)
CapabilityWarning(call_id, warning, severity)
CapabilityFailure(call_id, reason, retryable)
```

## Hard rules

- If evidence is insufficient, return or record `insufficient_evidence` instead of guessing.
- Do not mark validation `passed: true` without an artifact, command, test, or explicitly trusted validator result.
- Do not promote memory, skills, or durable facts from unvalidated SLM output.
- Do not collapse warnings into success; preserve warnings with severity.
- Do not hide coverage gaps. Record searched scope and omitted scope.

## Review checklist

For every trusted result, ask:

- What raw artifact or command produced it?
- What schema validated it?
- What path/line/source/test grounds it?
- What coverage was searched and what was omitted?
- What happens when evidence is missing or contradictory?

If any answer is absent, the result is not trusted yet.
