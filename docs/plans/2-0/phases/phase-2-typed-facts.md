# Phase 2 — Typed Fact Protocol Implementation Plan

**Repository:** `ArchiTecCTT/Rector`  
**Target integration branch:** `rector-0.3.0` / current `main` after Phase 1 merge  
**Plan branch:** `rector-0.3.0-phase-2-plan`  
**Status:** `phase2-offline-complete-live-unverified` (gates at `45768e5`; see `phase-2-completion-report.md`)
**Phase:** 2 — Typed fact protocol
**North-star goal:** prove the neuro-symbolic kernel by making Rector convert messy model/tool/system output into typed, replayable, grounded, governable facts.

---

## Decision

Phase 2 is **not** a generic refactor, a new agent swarm, a Memory OS build, or a Capability-SLM implementation. Phase 2 is the contract layer that every later neuro-symbolic subsystem depends on.

Build Phase 2 as a strict but adaptable substrate:

```text
Phase 2A - Fact contracts, IDs, envelopes, provenance, and trust levels
Phase 2B - Append-only fact ledger / blackboard with replay and diff
Phase 2C - Adapters from existing Rector evidence surfaces into facts
Phase 2D - Fact validation gates: schema, provenance, grounding, scope, and redaction
Phase 2E - Phase 2 evals, reports, and global harness integration
Phase 2F - Live-model shadow tests for schema/provenance stress testing
Phase 2G - Completion gate, docs sync, and deviation ledger
```

The key promise is:

```text
No downstream subsystem receives trusted natural-language output directly when that output should have been a typed fact.
```

Phase 2 completion means Rector can ingest existing Cartographer results, tool/capability eval artifacts, run events, and optional live model outputs into a typed fact stream that can be validated, replayed, diffed, rejected, or surfaced as insufficient evidence.

---

## Why this phase matters

Rector already has the runway:

- Phase 0: capability eval schemas, metrics, raw artifacts, and offline gates.
- Phase 0.5: global reliability scenarios, scorecards, run traces, and specialist-system contract stubs.
- Phase 1: Cartographer moved beyond file inventory into structural graph, query service, tool/capability/eval graph adapters, and self-scan artifacts.

Phase 2 is where Rector becomes visibly neuro-symbolic. The neural side can propose. The symbolic side needs a typed state language to decide what is admissible, grounded, safe, validated, or rejected.

The phase should be judged by one question:

```text
Can Rector turn messy model/tool behavior into typed, grounded, replayable evidence that later rules, DAGs, validators, MemoryGate, and Capability-SLMs can trust only after gates pass?
```

---

## Source-grounded current baseline

This plan assumes the following current codebase facts.

### Product architecture constraints

`docs/architecture/configured-product-architecture.md` says Rector is a chat-first orchestration system whose value is the control plane around the model: schema-validated planner/skeptic/synthesizer outputs, budget gates, redaction, safe workspace execution, validation/healing loops, append-only run events, trace UI, and durable persistence. Product chat must use one orchestration path and deterministic doubles are CI-only.

### Existing package and scripts

`package.json` currently exposes `./cartographer`, uses Node `>=22.5.0`, and already has core scripts including:

```text
npm run check
npm test
npm run build
npm run audit:no-fakes
npm run audit:no-fakes:check
npm run eval:capabilities:gate
npm run test:global
npm run test:global:gate
npm run test:systems
npm run cartographer:self-scan
npm run cartographer:self-scan:check
```

Phase 2 should add fact-specific scripts without breaking these.

### Cartographer baseline after Phase 1

`src/cartographer/index.ts` now exports:

```text
inventory schemas / stores / scans
structural graph schemas
GraphSnapshot
CartographerGraphStore
in-memory and SQLite graph stores
buildGraphSnapshot
TypeScript symbol extraction
import extraction
findTests
CartographerQueryService
tool graph adapter
capability graph adapter
capability graph record loader
eval suite graph adapter
```

This is enough to ground Phase 2 facts in repository state without rebuilding Cartographer.

### Graph schema baseline

`src/cartographer/graphSchemas.ts` already defines graph node kinds including `Project`, `Package`, `Directory`, `File`, `Symbol`, `Function`, `Class`, `Interface`, `TypeAlias`, `Enum`, `Route`, `Test`, `Config`, `EnvironmentVariable`, `Doc`, `Tool`, `Capability`, `Skill`, `Rule`, and `RunTrace`, plus edge kinds including `CONTAINS`, `DEFINES`, `IMPORTS`, `CALLS`, `REFERENCES`, `TESTS`, `VALIDATED_BY`, `DEPENDS_ON`, `PROVIDED_BY`, and `WRAPPED_BY`.

Phase 2 should reference these graph IDs and node/edge schemas; it should not invent a parallel repository ontology.

### Tool registry baseline

`src/tools/types.ts` already defines `ToolSchemaDefinition` with `name`, `description`, `inputSchema`, `risk`, `requiresApproval`, and `requiresSandbox`; `ToolResult` with `ok`, `output`, `error`, `halt`, `approvalGateId`, and `metadata`; and `ToolHandlerContext` with run, workspace, command, budget, sandbox, permissions, policy, and run event sink fields. `src/tools/registry.ts` validates tool definitions, lists redacted tool metadata, dispatches handlers, and parses/redacts tool results.

Phase 2 should wrap ToolRegistry events/results into facts. It should not replace ToolRegistry.

### Existing eval baseline

`src/capabilities/eval/schemas.ts` already has capability eval cases and metric scores for `schema_valid`, `recall`, `omission`, `secret_leak`, `compression`, `raw_token_reduction`, `line_ref_accuracy`, and `root_cause_accuracy`.

`src/evals/globalScenarioSchema.ts` already has strict global scenario schemas, safe relative path validation, validator command allowlists, structured validators, scenario oracles, budgets, expected outcomes, setup, and operation fields.

Phase 2 should build on these metrics and add fact-specific measurements rather than creating a disconnected eval format.

### Provider baseline

`src/providers/llm.ts` already defines `LLMProvider`, `LLMRequest`, `LLMResponse`, provider metadata, JSON response format support, usage accounting, and `isLiveLLMProvider`. It still includes `FakeLLMProvider`; Phase 2 must treat fake/deterministic providers as test-only and never use them as evidence of live model reliability.

---

## Research-backed engineering constraints

These constraints are not decorative. They should affect code review.

1. **Agent-computer interfaces beat raw text dumps.** SWE-agent supports giving coding agents structured navigation, editing, and test interfaces instead of only raw terminal/file interaction. Phase 2 should therefore favor typed fact adapters over raw transcript ingestion.
2. **Multi-agent workflow needs typed state, not free-form chat.** MetaGPT documents cascading hallucinations in naive chained multi-agent systems and argues for standardized intermediate artifacts and workflows. Phase 2 should make all subagent outputs pass through strict facts before they can affect later phases.
3. **Capability/tool descriptors are not automatically trusted.** MCP-style tooling standardizes tool access, but later research on MCP tool descriptions and MCP attacks shows that tool metadata can be ambiguous, stale, poisoned, or changed after approval. Phase 2 must treat descriptions as untrusted source material until admitted through facts, provenance, and gates.
4. **JSON/Zod schemas are necessary but insufficient.** Schema validation checks shape. It does not prove truth, grounding, safety, or completeness. Phase 2 must pair schemas with provenance, scope checks, artifact refs, grounding checks, and explicit `insufficient_evidence` states.
5. **Live model tests should be shadow tests first.** Live model calls are required to stress the schema, but Phase 2 must not let live outputs mutate code, trusted memory, or production state.

Reference links for the research basis:

- SWE-agent: <https://arxiv.org/abs/2405.15793>
- MetaGPT: <https://arxiv.org/abs/2308.00352>
- Model Context Protocol: <https://modelcontextprotocol.io/>
- MCP tool-description quality research: <https://arxiv.org/abs/2602.14878>
- MCP tool poisoning / adversarial attacks: <https://arxiv.org/abs/2512.06556>
- JSON Schema formalization / complexity: <https://arxiv.org/abs/2307.10034>

---

## Non-negotiable Phase 2 boundaries

Do **not** implement these in Phase 2:

```text
Memory OS durable semantic/core memory
Pondering daemon swarm
Capability-SLM manager
Universal Capability Contract Generator
Rule engine / Crucible hard gates
Planner/skeptic ensembles
Validation-aware DAG executor
Safe transformation engine
Production specialist execution
Production memory promotion
Production live provider dependence
Autonomous multi-agent chat layer
```

Phase 2 may define fact shapes those systems will later consume, but it must not quietly implement their authority.

Phase 2 must remain:

```text
offline CI-safe by default
live-model capable by explicit opt-in
strictly schema-validated
replayable from stored artifacts
honest about insufficiency
safe against path/provenance spoofing
```

---

## Core design rule

Every fact must answer five questions:

```text
What is being claimed?
Who or what produced the claim?
What source artifact or graph object backs the claim?
What trust level does it currently have?
What later gate is allowed to promote, reject, or use it?
```

If a claim cannot answer those questions, it should be raw evidence or `insufficient_evidence`, not a trusted fact.

---

## Fact authority ladder

Use this ladder consistently:

```text
raw_text
  -> schema_valid_fact
  -> provenance_attached_fact
  -> graph_grounded_fact
  -> scope_checked_fact
  -> validation_linked_fact
  -> admissible_for_rules_or_memory
```

Phase 2 owns the first five layers. Later phases own rule admission, execution, validation, and memory promotion.

---

## Required fact families

Create these as strict Zod discriminated unions. Prefer one `kind` discriminator and one top-level `schemaVersion`.

### 1. Core envelope facts

```ts
type FactEnvelope = {
  schemaVersion: "rector.fact.v1";
  factId: string;
  kind: FactKind;
  runId: string;
  taskId?: string;
  createdAt: string;
  producer: FactProducer;
  provenance: FactProvenance[];
  trust: FactTrust;
  scope: FactScope;
  redactionState: "none" | "redacted" | "contains_sensitive" | "unknown";
};
```

Required supporting contracts:

```text
FactId
FactProducer
FactProvenance
FactTrust
FactScope
ArtifactRef
GraphRef
SourceSpan
EvidenceRef
ValidationRef
FactValidationError
InsufficientEvidence
```

### 2. Intent and task facts

```text
IntentFact
TaskConstraintFact
SuccessCriteriaFact
RiskToleranceFact
UnknownOrAmbiguityFact
```

These normalize the user request but are advisory until grounded or confirmed.

### 3. Cartographer / context facts

```text
CartographerSnapshotFact
GraphNodeFactRef
GraphEdgeFactRef
ContextSliceFact
FileContextFact
SymbolContextFact
ImpactContextFact
TestLinkContextFact
CapabilityGraphContextFact
```

These must reference Cartographer graph snapshot IDs, node IDs, edge IDs, or query status. Do not copy whole graph payloads into every fact unless a compact snapshot is required for replay.

### 4. Tool and capability facts

```text
ToolDefinitionFact
ToolCallFact
ToolResultFact
CapabilityRequestFact
CapabilityCallFact
CapabilityEvidenceFact
CapabilityCoverageFact
CapabilityWarningFact
CapabilityFailureFact
```

`CapabilityEvidenceFact` must require source refs: path/line span, graph ref, command/log artifact, URL/source ID, or explicit `insufficient_evidence`.

### 5. Raw artifact facts

```text
RawArtifactFact
RawArtifactChunkFact
ArtifactHashFact
ArtifactRedactionFact
```

Raw artifacts are evidence, not interpretation. Store hashes and byte/token counts. Do not inline huge logs into facts.

### 6. Planning-adjacent proposal facts

Phase 2 may define these contracts but must not make them authoritative:

```text
PlanCandidateFact
CritiqueFact
ValidationObligationFact
RepairCandidateFact
MemoryPatchCandidateFact
```

These are future-facing contracts for Phase 3+ and Phase 7+, not executable authority in Phase 2.

### 7. Fact validation facts

```text
FactSchemaValidationFact
FactGroundingValidationFact
FactScopeValidationFact
FactProvenanceValidationFact
FactReplayValidationFact
```

These make validation of facts itself observable and replayable.

---

## Required source layout

Implement Phase 2 under a narrow module boundary:

```text
src/facts/
  index.ts
  schemas.ts
  types.ts
  ids.ts
  provenance.ts
  trust.ts
  scope.ts
  validation.ts
  ledger.ts
  diff.ts
  replay.ts
  adapters/
    cartographerFacts.ts
    toolFacts.ts
    capabilityEvalFacts.ts
    globalHarnessFacts.ts
    runEventFacts.ts
    llmShadowFacts.ts
  reports/
    factReport.ts
    markdown.ts

scripts/facts/
  validate-phase2.ts
  replay-facts.ts
  run-fact-evals.ts
  run-live-fact-shadow.ts

tests/facts/
  schemas.test.ts
  ids.test.ts
  provenance.test.ts
  scope.test.ts
  ledger.test.ts
  diff.test.ts
  replay.test.ts
  adapters.cartographer.test.ts
  adapters.tool.test.ts
  adapters.capabilityEval.test.ts
  adapters.globalHarness.test.ts
  liveShadow.contract.test.ts
  security.test.ts
  property.test.ts
```

Avoid placing Phase 2 code inside Cartographer, ToolRegistry, or provider modules unless adding a tiny adapter export is necessary. The fact protocol should sit above existing subsystems.

---

## Required npm scripts

Add these scripts after the implementation exists:

```json
{
  "scripts": {
    "eval:facts": "tsx scripts/facts/run-fact-evals.ts",
    "eval:facts:live": "LIVE_FACT_EVALS=1 tsx scripts/facts/run-live-fact-shadow.ts",
    "facts:replay": "tsx scripts/facts/replay-facts.ts",
    "verify:phase2": "npm run check && npm test && npm run eval:facts && npm run test:global && npm run test:systems"
  }
}
```

`eval:facts:live` must never run by accident in CI. It requires explicit env flags and provider credentials.

---

# Phase 2A — Fact contracts, IDs, envelope, provenance, and trust

## Goal

Define Rector's typed state language without coupling it to one future subsystem.

## Required implementation

1. Create core schemas in `src/facts/schemas.ts`.
2. Create stable exported types in `src/facts/types.ts`.
3. Create deterministic ID helpers in `src/facts/ids.ts`.
4. Create provenance helpers in `src/facts/provenance.ts`.
5. Create trust and scope helpers in `trust.ts` and `scope.ts`.
6. Export only stable public contracts from `src/facts/index.ts`.

## Design requirements

- Use strict Zod objects.
- Use discriminated unions.
- All schema versions must be literals.
- Every fact must include `factId`, `kind`, `runId`, `createdAt`, `producer`, `provenance`, `trust`, `scope`, and `redactionState`.
- Every producer must be one of:

```text
user
system
cartographer
tool_registry
capability_eval
global_harness
llm_shadow
validator
human_operator
```

- Trust must be one of:

```text
raw
schema_valid
provenance_attached
graph_grounded
scope_checked
validation_linked
rejected
insufficient_evidence
```

- A fact may never jump directly from `raw` to `validation_linked`.
- Use explicit `insufficient_evidence`, not omitted fields or fake confidence.
- Keep JSON-compatible properties. No functions inside durable facts.

## Tests

```text
tests/facts/schemas.test.ts
tests/facts/ids.test.ts
tests/facts/provenance.test.ts
tests/facts/scope.test.ts
tests/facts/property.test.ts
```

Acceptance criteria:

```text
invalid extra fields are rejected
missing provenance is rejected except for raw user intent facts with explicit source=user
unsupported schemaVersion is rejected
deterministic IDs are stable across runs
deterministic IDs change when meaningfully relevant fields change
path scopes reject absolute paths, drive prefixes, UNC paths, and .. segments
facts serialize to JSON and parse back losslessly
prototype pollution keys are rejected or neutralized
```

---

# Phase 2B — Append-only fact ledger / blackboard

## Goal

Create the local, replayable fact stream. This is not Memory OS. It is per-run evidence state.

## Required implementation

1. `FactLedger` interface.
2. `InMemoryFactLedger` for tests.
3. `JsonlFactLedger` or artifact-backed ledger for local run traces.
4. `appendFact`, `appendMany`, `getFact`, `queryFacts`, `listByRun`, `sealRun`, and `replayRun` APIs.
5. Fact diff and replay utilities.

Suggested contracts:

```ts
type FactLedger = {
  append(fact: RectorFact): Promise<AppendFactResult>;
  appendMany(facts: RectorFact[]): Promise<AppendFactsResult>;
  get(factId: string): Promise<RectorFact | undefined>;
  query(input: FactQuery): Promise<RectorFact[]>;
  listRun(runId: string): Promise<RectorFact[]>;
  sealRun(runId: string): Promise<SealedFactRun>;
};
```

## Ledger rules

- Append-only. No in-place mutation.
- Corrections are new facts linked by `supersedesFactId` / `contradictsFactId`.
- Durable JSONL records must be individually parseable.
- A corrupted record must fail replay loudly unless the caller explicitly asks for best-effort diagnostics.
- Fact ordering must be deterministic by append sequence and timestamp.
- Ledger does not promote memory.

## Tests

```text
tests/facts/ledger.test.ts
tests/facts/replay.test.ts
tests/facts/diff.test.ts
```

Acceptance criteria:

```text
append rejects invalid facts
append preserves order
replay reconstructs the same fact list
sealed run hash changes if any fact changes
fact diff reports added/removed/changed facts by factId
corrupt JSONL fails with a useful error
correction facts do not mutate prior records
```

---

# Phase 2C — Adapters from existing Rector surfaces

## Goal

Prove Phase 2 is grounded in current code, not an abstract protocol with no ingestion path.

## Required adapters

### 1. Cartographer adapter

File:

```text
src/facts/adapters/cartographerFacts.ts
```

Inputs:

```text
GraphSnapshot
CartographerGraphNode
CartographerGraphEdge
CartographerQueryService results
```

Outputs:

```text
CartographerSnapshotFact
GraphNodeFactRef
GraphEdgeFactRef
ContextSliceFact
FileContextFact
SymbolContextFact
ImpactContextFact
TestLinkContextFact
CapabilityGraphContextFact
```

Rules:

```text
must preserve graph snapshot ID
must preserve node/edge IDs
must preserve query status, including not_found / ambiguous / unsupported
must not convert not_found into empty success
must mark graph facts graph_grounded only when backed by graph IDs
```

### 2. ToolRegistry adapter

File:

```text
src/facts/adapters/toolFacts.ts
```

Inputs:

```text
ToolSchemaDefinition
ToolResult
ToolHandlerContext event sink payloads
```

Outputs:

```text
ToolDefinitionFact
ToolCallFact
ToolResultFact
ToolFailureFact
```

Rules:

```text
must preserve risk, approval, sandbox flags
must preserve toolName and runId
must redact using existing redaction rules before durable write
must distinguish handler failure from policy/budget/permission failures
```

### 3. Capability eval adapter

File:

```text
src/facts/adapters/capabilityEvalFacts.ts
```

Inputs:

```text
CapabilityEvalCase
CapabilityEvalResult
rawArtifactRefs
metricScores
```

Outputs:

```text
CapabilityRequestFact
CapabilityEvidenceFact
CapabilityCoverageFact
CapabilityFailureFact
FactValidationFact
```

Rules:

```text
metrics are evidence, not truth
rawArtifactRefs are required for evidence facts
omissions become explicit facts
failed eval cases produce facts, not exceptions only
```

### 4. Global harness adapter

File:

```text
src/facts/adapters/globalHarnessFacts.ts
```

Inputs:

```text
GlobalScenario
Global scorecards
RunEvent traces
Regression artifact metadata
```

Outputs:

```text
ScenarioFact
ScenarioOracleFact
ScenarioBudgetFact
ScenarioExpectedOutcomeFact
GlobalScoreFact
RunTraceFact
```

Rules:

```text
expected.status and actual.status must both be represented
skipped live scenarios must emit skipped facts, not disappear
validator command IDs must be preserved
safe relative path constraints must be preserved
```

### 5. RunEvent adapter

File:

```text
src/facts/adapters/runEventFacts.ts
```

Inputs:

```text
RunEvent
RunPhase
RunEventType
```

Outputs:

```text
RunEventFact
RunPhaseFact
ArtifactCreatedFact
ValidationEventFact
BudgetEventFact
```

Rules:

```text
never invent phases
event payload stays bounded and JSON-compatible
large payloads become RawArtifactFact refs
```

## Tests

```text
tests/facts/adapters.cartographer.test.ts
tests/facts/adapters.tool.test.ts
tests/facts/adapters.capabilityEval.test.ts
tests/facts/adapters.globalHarness.test.ts
```

Acceptance criteria:

```text
all adapters preserve source IDs and provenance
all adapters emit schema-valid facts
all negative statuses are represented honestly
no adapter marks facts validation_linked unless validation refs exist
no adapter requires live provider credentials
```

---

# Phase 2D — Fact validation gates

## Goal

Make facts governable before Phase 3 rule/Crucible exists.

## Required gates

File:

```text
src/facts/validation.ts
```

Required validators:

```text
validateFactSchema
validateFactProvenance
validateFactScope
validateFactGrounding
validateFactArtifactRefs
validateFactRedactionState
validateFactTrustTransition
validateFactBatch
```

These are not the Phase 3 rule engine. They are structural gates for facts.

## Required validations

### Schema validation

- strict object shape
- known `kind`
- known `schemaVersion`
- JSON-compatible payloads

### Provenance validation

- every non-raw fact has provenance
- provenance source type is explicit
- source artifact refs exist when required
- live LLM claims cannot self-certify

### Grounding validation

- graph-grounded facts must reference Cartographer snapshot/node/edge IDs
- path/line spans must be safe and positive
- `not_found` is valid only as a negative evidence fact, not a success evidence fact

### Scope validation

- paths must remain in workspace
- absolute paths rejected unless they are redacted artifact URIs under an allowed artifact scheme
- forbidden scope facts are marked rejected or scope-failed

### Redaction validation

- facts must not contain raw secret values
- raw artifacts with sensitive content must be redacted or marked `contains_sensitive`
- markdown reports must never print sensitive raw payloads

### Trust transition validation

- no fact jumps to a stronger trust state without required supporting facts
- rejected facts remain queryable but not admissible
- insufficient evidence is terminal until new evidence is appended

## Tests

```text
tests/facts/security.test.ts
tests/facts/validation.test.ts
```

Acceptance criteria:

```text
path traversal facts are rejected
fake file/line references fail grounding
live LLM facts without artifact refs fail provenance
schema-valid but ungrounded evidence remains only schema_valid/provenance_attached
secret-like payloads are redacted or blocked in durable facts
trust transition validator rejects impossible promotions
```

---

# Phase 2E — Fact evals, reports, and global harness integration

## Goal

Make Phase 2 measurable and visible.

## Required implementation

1. `scripts/facts/run-fact-evals.ts` — offline fixture-based fact evals.
2. `scripts/facts/validate-phase2.ts` — completion gate.
3. `src/facts/reports/factReport.ts` and `markdown.ts`.
4. `.omo/evidence/fact-report.json` and `.omo/evidence/fact-report.md` outputs.
5. At least one global scenario that expects fact refs.

## Suggested fact eval metrics

```text
schema_valid_rate
provenance_complete_rate
grounding_success_rate
insufficient_evidence_correctness
hallucinated_reference_count
secret_leak_count
replay_success_rate
fact_diff_accuracy
raw_artifact_ref_coverage
trust_transition_violation_count
```

## Minimum offline fixture cases

```text
cartographer_snapshot_to_facts
cartographer_not_found_to_negative_fact
tool_registry_definition_to_fact
tool_failure_to_failure_fact
capability_eval_result_to_evidence_facts
global_scenario_to_oracle_facts
run_event_trace_to_facts
malformed_fact_rejected
fake_provenance_rejected
secret_payload_redacted_or_blocked
```

## Acceptance criteria

```text
npm run eval:facts writes JSON and markdown reports
report includes pass/fail counts and metric table
failed cases preserve failure reasons
reports link fact IDs to source artifact refs
no raw large logs are printed in markdown
```

---

# Phase 2F — Live-model shadow tests

## Goal

Use real models to break the fact protocol early while the system is still small.

This is required for confidence but must be opt-in and non-mutating.

## Live testing contract

Add:

```text
scripts/facts/run-live-fact-shadow.ts
tests/facts/liveShadow.contract.test.ts
```

The script runs only when:

```text
LIVE_FACT_EVALS=1
```

and when at least one configured live provider is available through existing provider abstractions. If credentials are missing, the script writes an honest skipped report and exits nonzero so live verification chains cannot look green before the gate.

## Live tests must never

```text
write source files
promote memory
open PRs
execute shell mutations
mark a model claim trusted without validation
run in default CI
use FakeLLMProvider as live evidence
```

## Minimum live scenarios

### Live 1 — Intent extraction stress

Input: messy user request.  
Expected: `IntentFact`, `TaskConstraintFact`, `UnknownOrAmbiguityFact` when needed.  
Failure mode to catch: model invents scope or success criteria.

### Live 2 — Evidence extraction from `rg` artifact

Input: committed raw `rg` artifact from Phase 0 corpus.  
Expected: `CapabilityEvidenceFact` with path/line spans that exist in artifact.  
Failure mode to catch: model fabricates files or line numbers.

### Live 3 — Test log diagnosis from real fixture log

Input: committed Vitest/test log artifact.  
Expected: root failing test, assertion/error class, source artifact ref, confidence.  
Failure mode to catch: model summarizes downstream noise as root cause.

### Live 4 — TypeScript diagnostic grouping

Input: committed `tsc` diagnostics artifact.  
Expected: root diagnostic candidates and cascaded diagnostics separated.  
Failure mode to catch: model claims fix or causality without evidence.

### Live 5 — Insufficient evidence

Input: intentionally ambiguous/incomplete artifact.  
Expected: `insufficient_evidence`, not a guess.  
Failure mode to catch: overconfident fake answer.

## Live report requirements

Write:

```text
.omo/evidence/live-fact-shadow-report.json
.omo/evidence/live-fact-shadow-report.md
```

The report must include:

```text
provider ID
model ID
route
case ID
schema validity
provenance completeness
hallucinated refs
insufficient_evidence correctness
token usage
estimated cost
latency
raw artifact refs
```

## Completion rule

Full Phase 2 completion requires at least one captured live shadow run from a real provider during the development sprint.

CI may skip live tests, but the phase completion report must say one of:

```text
phase2-complete-live-verified
phase2-offline-complete-live-unverified
```

Only `phase2-complete-live-verified` should be used for investor/demo claims about live-model reliability.

---

# Phase 2G — Completion gate, docs sync, and deviation ledger

## Goal

Make the implementation auditable and keep the plan honest.

## Required implementation

1. Add `verify:phase2` script.
2. Add Phase 2 completion report under:

```text
docs/plans/2-0/phases/phase-2-completion-report.md
```

3. Update `AGENTS.md` Phase status facts after completion.
4. Update `docs/plans/concerns-and-vulnerabilities.md` with any limitations.
5. If the plan changes materially, append a deviation note to this file.

## Completion report must include

```text
commit/PR list
implemented modules
test commands run
offline fact eval report path
live shadow report path or skipped reason
known limitations
explicit not-built list
next-phase handoff notes for Phase 2.1 / 2.2 / 2.4 / 2.5 / 3
```

---

## Orchestrator + worktree development workflow

Use an orchestrator-controlled workflow. This is especially important for Phase 2 because the fact protocol is cross-cutting and easy to accidentally fragment.

## Branch model

```text
main / rector-0.3.0
  -> rector-0.3.0-phase-2
      -> phase-2A-fact-contracts
      -> phase-2B-fact-ledger
      -> phase-2C-fact-adapters
      -> phase-2D-fact-validation
      -> phase-2E-fact-evals
      -> phase-2F-live-shadow
      -> phase-2G-docs-completion
```

If using Git worktrees locally:

```bash
git worktree add .worktrees/phase-2A-fact-contracts -b phase-2A-fact-contracts rector-0.3.0-phase-2
git worktree add .worktrees/phase-2B-fact-ledger -b phase-2B-fact-ledger rector-0.3.0-phase-2
```

## Orchestrator duties

The orchestrator is not a passive project manager. It must actively guard the architecture.

Required duties:

```text
read this plan and source-of-truth docs before assigning work
create one scoped task packet per subagent
assign one feature branch/worktree per independent feature
prevent overlapping edits unless explicitly approved
review code before commit
run targeted tests before integration
run full gates before opening or merging PRs
reject any private ad-hoc state protocol that should be a fact
require deviation notes when implementation diverges from this plan
```

## Subagent rules

Each subagent gets a specific slice and must return:

```text
changed files
implementation summary
test commands run
known limitations
questions/deviations
```

Subagents may improvise only within this boundary:

```text
They may choose implementation details that satisfy the contracts and tests.
They may not silently change the phase goal, trust model, source boundaries, or completion criteria.
```

If a subagent discovers the plan does not fit the codebase, it must produce a deviation note:

```text
Deviation ID:
Plan section affected:
Observed codebase fact:
Why the plan does not fit:
Proposed adjustment:
Tests proving the adjustment:
Risk / rollback:
```

## Review checklist per PR

Every feature PR must answer:

```text
Does this introduce or modify a fact kind?
Does every durable fact have provenance?
Are negative/insufficient states explicit?
Are raw artifacts referenced instead of inlined?
Are fake/deterministic providers clearly test-only?
Are live model outputs shadow-only?
Can the change replay from artifacts?
Does it preserve existing Phase 0/0.5/1 gates?
Does it avoid implementing future phases prematurely?
```

---

## Suggested PR sequence

### PR 1 — Phase 2 plan and branch discipline

Scope:

```text
docs/plans/2-0/phases/phase-2-typed-facts.md
```

No runtime code.

### PR 2 — Fact contracts and unit tests

Scope:

```text
src/facts/{index,schemas,types,ids,provenance,trust,scope}.ts
tests/facts/{schemas,ids,provenance,scope,property}.test.ts
```

Exit gate:

```text
npm run check
npm test -- tests/facts
```

### PR 3 — Fact ledger, replay, and diff

Scope:

```text
src/facts/{ledger,replay,diff}.ts
tests/facts/{ledger,replay,diff}.test.ts
```

Exit gate:

```text
npm run check
npm test -- tests/facts
```

### PR 4 — Cartographer, ToolRegistry, capability eval, and run event adapters

Scope:

```text
src/facts/adapters/*
tests/facts/adapters.*.test.ts
```

Exit gate:

```text
npm run check
npm test -- tests/facts
npm run cartographer:self-scan:check
```

### PR 5 — Fact validation gates and security tests

Scope:

```text
src/facts/validation.ts
tests/facts/validation.test.ts
tests/facts/security.test.ts
```

Exit gate:

```text
npm run check
npm test -- tests/facts
npm run audit:no-fakes
```

### PR 6 — Fact eval runner, reports, and global harness scenario

Scope:

```text
scripts/facts/run-fact-evals.ts
scripts/facts/replay-facts.ts
scripts/facts/validate-phase2.ts
src/facts/reports/*
tests/facts/*eval*.test.ts
package.json scripts
```

Exit gate:

```text
npm run eval:facts
npm run test:global
npm run test:systems
```

### PR 7 — Live shadow fact evals

Scope:

```text
scripts/facts/run-live-fact-shadow.ts
tests/facts/liveShadow.contract.test.ts
```

Exit gate:

```text
npm run eval:facts
RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live
```

If no live provider is available, mark the PR as offline-complete only, keep the skipped report as evidence, and expect the live script to exit nonzero in live-verification chains.

### PR 8 — Phase 2 completion report and docs sync

Scope:

```text
docs/plans/2-0/phases/phase-2-completion-report.md
AGENTS.md
docs/plans/concerns-and-vulnerabilities.md
```

Exit gate:

```text
npm run verify:phase2
npm run build
npm audit
```

---

## Phase 2 test matrix

| Test layer | Required? | Live? | Purpose |
|---|---:|---:|---|
| Unit schema tests | yes | no | fact shapes, strictness, discriminators |
| Property tests | yes | no | ID stability, serialization, path/scope invariants |
| Adapter fixture tests | yes | no | existing Rector surfaces convert to facts |
| Ledger/replay tests | yes | no | append-only stream, replay, diff, corruption behavior |
| Security/adversarial tests | yes | no | spoofed provenance, path traversal, secret leakage |
| Fact eval runner | yes | no | measurable offline fact quality |
| Global harness scenario | yes | no | Phase 2 surfaces in system behavior tests |
| Live shadow evals | yes for full completion | yes | real-model schema/provenance stress |
| Production mutation tests | no | no | future phases only |

---

## Phase 2 acceptance criteria

Phase 2 is complete only when all of these are true:

```text
fact contracts exist and are exported through src/facts/index.ts
all durable facts have schemaVersion, factId, kind, runId, producer, provenance, trust, scope, and redactionState
fact ledger is append-only and replayable
fact diff works across two fact runs
Cartographer results convert to grounded facts
ToolRegistry definitions/results convert to tool facts
Capability eval artifacts convert to capability evidence facts
Global harness scenarios/scorecards convert to facts
fact validators reject fake provenance, unsafe paths, and impossible trust jumps
insufficient_evidence is first-class and tested
raw artifacts are referenced, not dumped into fact payloads
fact eval reports are generated in JSON and markdown
verify:phase2 passes offline
live shadow report is captured or explicitly marked unavailable
completion report names what is and is not implemented
```

---

## Explicit not-done after Phase 2

After Phase 2, the system still will not have:

```text
durable Memory OS
MemoryGate promotion
Capability-SLM manager
rule engine / Crucible authority
planner/skeptic ensembles
DAG executor integration
safe transformation engine
healing loop
executive specialist routing
production live specialist execution
```

That is intentional. Phase 2 provides the typed substrate they will use.

---

## Handoff to later phases

Phase 2.1 / 2.2 Memory OS:

```text
consume MemoryPatchCandidateFact
promote only validation-linked facts
store raw artifacts separately from semantic/core memory
```

Phase 2.4 Capability Contract Generator:

```text
emit CapabilityContract facts
use ToolDefinitionFact and CapabilityGraphContextFact as input
admit contracts only after eval and provenance gates
```

Phase 2.5 Capability-SLM Fabric:

```text
SLM outputs must become CapabilityEvidenceFact / CapabilityCoverageFact / CapabilityFailureFact
raw outputs must become RawArtifactFact
cheap model outputs cannot bypass fact validation
```

Phase 3 Rule Engine / Crucible:

```text
rules consume facts, not prose
rule derivations become facts
GateDecision facts cite rule derivations and source facts
```

Phase 5 DAG Executor:

```text
DAG nodes cite approved facts
execution traces append ToolCallFact / ToolResultFact / ValidationEventFact
```

Phase 8 Run Explorer:

```text
render fact timeline, provenance graph, trust transitions, replay diff, and artifact refs
```

---

## Final directive

Build Phase 2 as the smallest strict substrate that proves the Rector brain is possible:

```text
persistent enough to replay
reliable enough to reject bad evidence
cheap enough to keep raw exhaust out of the main model
flexible enough to survive live-model weirdness
strict enough that later phases cannot devolve into vibes
```

If a feature does not help Rector produce typed, grounded, replayable, governable facts, it does not belong in Phase 2.

---

## Deviation ledger (Phase 2G)

Recorded when implementation differed materially from this plan. Full gate evidence: `docs/plans/2-0/phases/phase-2-completion-report.md`.

### DEV-2G-001 — Live shadow adapter location

- **Plan section:** Required source layout (`src/facts/adapters/llmShadowFacts.ts`)
- **Observed:** Live-model ingestion lives in `scripts/facts/run-live-fact-shadow.ts` plus `tests/facts/liveShadow.contract.test.ts`; no separate `llmShadowFacts.ts` adapter module.
- **Adjustment:** Shadow outputs are still schema-validated facts with `llm_shadow` producer semantics; offline adapters remain unchanged.
- **Risk / rollback:** Low; add a thin adapter module later if other callers need programmatic shadow conversion.

### DEV-2G-002 — Phase 2 gate script wiring

- **Plan section:** `validate-phase2.ts` as completion gate helper
- **Observed:** `npm run verify:phase2` runs `check`, `npm test`, `eval:facts`, `test:global`, and `test:systems`; `validate-phase2.ts` exists but is not invoked by that chain.
- **Adjustment:** Treat `verify:phase2` as the authoritative offline gate; keep `validate-phase2.ts` for optional standalone validation.
- **Risk / rollback:** Low; wire script into verify if stricter single entrypoint is desired.

### DEV-2G-003 — Report and test surface additions

- **Plan section:** Suggested layout under `src/facts/reports/` and `tests/facts/`
- **Observed:** Added `src/facts/reports/safety.ts`, `tests/facts/evals.test.ts`, and `tests/facts/adapters.runEvent.test.ts` beyond the minimum list.
- **Adjustment:** Documented in completion report; no contract changes.
- **Risk / rollback:** None.

### DEV-2G-004 — Live shadow and completion label

- **Plan section:** Full completion requires captured live shadow from a real provider
- **Observed:** `eval:facts:live` wrote `.omo/evidence/live-fact-shadow-report.json` with `skipped` — no configured non-fake live provider on the gate VM.
- **Adjustment:** Completion label set to `phase2-offline-complete-live-unverified`; do not claim live-model reliability until `phase2-complete-live-verified`.
- **Risk / rollback:** Re-run `RECTOR_LIVE_PROVIDER=zai npm run eval:facts:live` after UI provider setup.
