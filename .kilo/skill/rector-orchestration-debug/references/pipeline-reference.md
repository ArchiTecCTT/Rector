# Pipeline Reference

## Event Types (17 total, defined in `src/protocol/events.ts`)

```
RUN_CREATED, PHASE_CHANGED, ENVELOPE_SENT, DAG_COMPILED,
DAG_NODE_STARTED, DAG_NODE_COMPLETED, DAG_NODE_FAILED,
VALIDATION_PASSED, VALIDATION_FAILED, HEALING_STARTED,
HEALING_APPLIED, DECISION_REQUESTED, RUN_COMPLETED,
RUN_FAILED, RUN_ABORTED, BUDGET_CHECKED, ARTIFACT_CREATED
```

## RunEvent Schema

```typescript
{
  id: string;                         // UUID
  runId: string;                      // Links to parent Run
  type: RunEventType;                 // One of 17 types above
  phase: RunPhase;                    // Current phase when event was created
  payload: Record<string, unknown>;   // Rich, redacted metadata
  traceId?: string;                   // Links to observability trace
  redactionState?: string;
  createdAt: string;                  // ISO datetime
}
```

## Key Types by Stage

### Triage

```typescript
TriageResult {
  route: TriageRoute;       // DIRECT_ANSWER | PLAN_ONLY | CODE_EDIT | RESEARCH | LONG_RUNNING | NEEDS_CLARIFICATION
  confidence: number;
  complexity: "low" | "medium" | "high";
  reasons: string[];
  riskFlags: string[];
}
```

### Context Building

```typescript
ContextPack {
  id: string;
  userIntentSummary: string;
  conversationRef: string;
  messageRefs: string[];
  relevantDocs: DocRef[];
  relevantMemory: MemoryRef[];
  constraints: string[];
  availableProviders: string[];
  availableTools: string[];
  riskFlags: string[];
  triage: TriageResult;
  artifactHandles: ArtifactHandle[];
  inlineContext: InlineContext[];
  memoryContext?: MemoryContext;
  subGoals?: string[];
}
```

### Planner

```typescript
PlannerOutput {
  goal: string;
  assumptions: string[];
  tasks: PlannerTask[];
  dependencies: DependencyEdge[];
  validation: ValidationCriteria;
  riskLevel: string;
  approvalGates: ApprovalGate[];
}

PlannerTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  expectedArtifacts: string[];
  validation: string;
  risk: string;
  approvalRequired: boolean;
}

PlannerBlocker {
  code: "BUDGET_DENIED" | "PLANNER_INVALID" | "PROVIDER_ERROR";
  message: string;
  details?: unknown;
}
```

### Skeptic

```typescript
SkepticReview {
  verdict: "SOUND" | "NEEDS_REVISION" | "BLOCKED";
  findings: SkepticFinding[];
  reviewedPlanId?: string;
  planGoal?: string;
  createdAt: string;
}

SkepticFinding {
  id: string;
  severity: "BLOCKER" | "MAJOR" | "MINOR" | "INFO";
  taskId?: string;
  category: string;
  message: string;
  evidence: string;
  recommendation: string;
}
```

### Crucible

```typescript
CrucibleDecision {
  verdict: "ACCEPTED" | "NEEDS_REVISION" | "ESCALATED" | "BLOCKED";
  reason: string;
  acceptedPlan?: PlannerOutput;
  revisionRequest?: string;
  escalation?: string;
  blockerFindings: SkepticFinding[];
  round: number;
  maxRounds: number;       // Always 2
  createdAt: string;
}
```

### DAG

```typescript
CompiledDag {
  id: string;
  runId: string;
  version: number;
  nodes: DagNode[];
  edges: DagEdge[];
  validationPolicy: object;
  budgetPolicy: object;
  metadata: object;
  createdAt: string;
}

DagNode {
  id: string;
  type: "LLM_EXECUTION" | "FILE_OPERATION" | "VALIDATION" | "SHELL_COMMAND";
  label: string;
  dependsOn: string[];
  toolPermissions: string[];
  input: object;
  expectedOutputs: string[];
  retryPolicy: { maxAttempts: number; backoffMs: number };
  timeoutMs: number;
  metadata: object;
}
```

### Execution

```typescript
DagExecutionResult {
  dagId: string;
  runId: string;
  status: "SUCCESS" | "FAILED" | "PARTIAL" | "SKIPPED";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  nodeResults: NodeExecutionResult[];
  events: ExecutionEvent[];
  error?: string;
}

NodeExecutionResult {
  nodeId: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED" | "TIMEOUT";
  attempts: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
  dependencies: string[];
}
```

### Validation / Healing

```typescript
HealingLoopResult {
  status: "VALIDATED" | "HEALED" | "NEEDS_DECISION" | "FAILED";
  attempts: number;
  failures: ValidationFailure[];
  actions: HealingAction[];
  finalExecutionResult: DagExecutionResult;
  rounds: HealingRoundRecord[];
}

ValidationFailure {
  nodeId?: string;
  classification: "TRANSIENT" | "TIMEOUT" | "PERMISSION" | "DEPENDENCY" | "VALIDATION" | "UNKNOWN";
  errorCode?: string;
  message: string;
  rootCauseNodeId?: string;
  rootCauseClassification?: string;
  dependencyChain?: string[];
  details?: unknown;
}

HealingAction {
  type: "RETRY_NODE" | "MARK_SKIPPED" | "REQUEST_DECISION" | "FAIL_RUN" | "NOOP" | "APPLY_PATCH";
  nodeId?: string;
  attempt?: number;
  classification?: string;
  reason?: string;
}

HealingRoundRecord {
  round: number;
  failureClassification: string;
  nodeId?: string;
  repairApplied: boolean;
  patchArtifactId?: string;
  revalidationStatus: string;
  explanation: string;
}
```

### Synthesis

```typescript
BrainstemSynthesis {
  status: string;
  route: TriageRoute;
  traceId: string;
  evidence: string[];
  providerCalls: ProviderCallMetadata[];
  observability?: ObservabilitySummary;
  response: string;
}

SynthesisCitation {
  kind: string;
  ref: string;
  detail: string;
}
```

### Run (state model)

```typescript
Run {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: "running" | "completed" | "failed" | "aborted" | "needs_decision";
  phase: RunPhase;
  route: TriageRoute;
  complexity: "low" | "medium" | "high";
  budget: Budget;
  costEstimate: number;
  actualCost?: number;
  tokenEstimate: number;
  actualTokens?: number;
  traceId: string;
  dagId?: string;
  attempts: number;
  healingAttempts: number;
  validationAttempts: number;
  lastError?: string;
  decisionRequest?: DecisionRequest;
  createdAt: string;
  updatedAt: string;
}

Budget {
  maxUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxModelCalls: number;
  maxRuntimeMs: number;
  maxHealingAttempts: number;
  allowedProviders: string[];
  approvalRequiredAboveUsd: number;
}
```

## Failure Mode Diagnosis Table

| Failure Mode | Manifests As | Phase | Diagnosis |
|---|---|---|---|
| Budget denied | `PlannerBlocker { code: "BUDGET_DENIED" }` | PLANNING / SKEPTIC / SYNTHESIZING | Compare `run.budget` vs `run.actualCost`; preflight projects cost and denies pre-call |
| Provider error | `PlannerBlocker { code: "PROVIDER_ERROR" }` | PLANNING / SKEPTIC | Provider threw or timed out; check provider config / API keys |
| Invalid planner output | `PlannerBlocker { code: "PLANNER_INVALID" }` | PLANNING | Model returned non-conformant JSON after repair prompt; check issue paths |
| Skeptic BLOCKED | Crucible verdict=BLOCKED | CRUCIBLE | Plan has BLOCKER-severity findings; inspect `skepticReview.findings` |
| DAG validation failure | `ExecutionError { code: "DAG_VALIDATION_FAILED" }` | EXECUTING | Malformed DAG (cycles, missing nodes); inspect `compiledDag` |
| Permission denied | `ExecutionError { code: "PERMISSION_DENIED" }` | EXECUTING / VALIDATING | Shell permissions denied; healing escalates to NEEDS_DECISION |
| Timeout | `ExecutionError { code: "TIMEOUT" }` | EXECUTING | Duration exceeded `node.timeoutMs`; healing retries with clamped duration |
| Healing exhausted | `HealingLoopResult { status: "FAILED" }` | VALIDATING | `maxHealingAttempts` reached; check `rounds[]` for each attempt |
| No repair proposal | `FAIL_RUN` action | VALIDATING | Repair agent returned undefined; budget denied or no safe fix |
| Unsafe auto-heal | `REQUEST_DECISION` action | VALIDATING | Node is SHELL_COMMAND or `approvalRequired: true`; requires human |
| Dependency cascade | Multiple SKIPPED nodes | EXECUTING | Trace `rootCauseNodeId` + `dependencyChain` to find root |
| Stale run reference | `Error("Run not found: ...")` | Any | Store inconsistency; run ID deleted or store corrupted |
| Invalid transition | `Error("Invalid run phase transition: X -> Y")` | Any | Orchestrator logic bug; check code path |

## Diagnostic Commands

```typescript
// Get run state
const run = await store.getRun(runId);
console.log(run.status, run.phase, run.lastError);

// List all events chronologically
const events = await store.listEvents(runId);
events.forEach(e => console.log(e.type, e.phase, e.payload));

// Find last phase change
const lastPhaseChange = events.filter(e => e.type === "PHASE_CHANGED").at(-1);

// Check healing rounds
const healingEvents = events.filter(e =>
  e.type === "HEALING_STARTED" || e.type === "HEALING_APPLIED"
);

// Check budget state
console.log("Budget:", run.budget);
console.log("Actual cost:", run.actualCost);
console.log("Actual tokens:", run.actualTokens);

// Check decision request (if NEEDS_DECISION)
console.log("Decision:", run.decisionRequest);
```
