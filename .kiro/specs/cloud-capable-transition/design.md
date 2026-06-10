# Design Document

## Overview

This design transitions Rector from a provider-free, local-only simulation baseline into a
cloud-capable commercial codebase, **without disturbing the existing local-mode regression
baseline**. Almost every building block already exists in the tree as a stub, a partial
implementation, or a fully-formed component that is simply not yet wired into the live path. The
transition is therefore primarily an exercise in **completing and connecting** existing seams:

| Area | Current state | Transition target |
| --- | --- | --- |
| Startup validation (Req 1) | `parseOrchestrationConfig(process.env)` reads env only and **throws** in external mode when no provider validates (the catch-22) | Boot-tolerant resolution that awaits the Provider_Config_Store + Secret_Store, warns instead of crashing, and only hard-exits on an invalid mode value |
| Model discovery (Req 2, 3) | `Model_Discovery_Service` + four `Discovery_Adapter`s exist and normalize candidates | Confirm per-kind dispatch, Cloudflare task filtering, Azure `requiresDeployment`/management-plane classification, OpenAI-compatible manual-model fallback, 30s abort |
| Settings discovery API (Req 4) | `createApp` accepts stores; no discovery route wired | Add a Settings_API discovery endpoint that calls the service, classifies `not_found`/`timeout`, and is inert in local mode |
| Provider routing (Req 5) | `buildConfiguredRouter` honors the Active_Route_Map with capability-priority fallback | Confirm per-record routing for all kinds, fallback substitution recorded in the trace, fake fallback in local mode |
| Sandbox (Req 6) | `WorkspaceSandboxAdapter` (real, network-free) + `createE2BSandboxAdapterStub` (no-network) | Replace the stub with a real `E2B_Sandbox_Adapter` that runs commands/patches in a container, captures + truncates + redacts streams, and is never constructed in local mode |
| Synthesizer (Req 7) | `runLiveSynthesizer` exists with budget preflight, repair, and deterministic fallback | Gate it on External_Mode + a valid flagship route for Heavy_Developer_Routes, with a 60s deadline and Legacy_Status_Response fallback |
| Persistence (Req 8) | `SqlRectorStore` already speaks the `mysql` dialect; `createTiDBDriver` + `createRectorStore` exist | Add connection pooling, a 30s connect deadline, an explicit Startup_Migration verify/provision step, and field-level config validation |
| Local baseline (Req 9) | Provider-free fake router, deterministic synthesizer, in-memory store | Preserve exactly: zero network, zero external sandbox, Config_Bridge not consulted, deterministic output |
| Redaction (Req 10) | `Redaction_Layer` (`redactString`/`redactSecrets`/`redactOutbound`) is mature | Confirm universal coverage of every log/telemetry sink with the fixed placeholder |
| Build/test (Req 11) | Optional deps (`sync-mysql`, E2B client) lazily required | Keep the build green with optional deps absent; emit a clear error when an absent dependency is selected |

Two cross-cutting invariants govern every area and are restated as correctness properties:

1. **Local-mode isolation** — when `Orchestrator_Mode` is `local`, Rector performs **zero** outbound
   provider network calls and **zero** external sandbox execution, never consults the Config_Bridge,
   and produces deterministic output.
2. **Secret confinement** — every secret-bearing value is redacted before it reaches any log or
   telemetry sink, and no secret value is ever returned through an API/UI surface.

## Architecture

### Mode-gated component graph

The orchestration mode is the master switch. The same process serves both modes; the mode selects
which collaborators are constructed and consulted.

```mermaid
flowchart TD
    Boot[server.ts bootstrap] --> Resolve[resolveOrchestrationConfig<br/>env + stores, boot-tolerant]
    Resolve -->|mode invalid| Halt[exit non-zero<br/>redacted config error]
    Resolve -->|local| LocalRouter[buildModelRouter mode=local<br/>FakeLLMProvider only]
    Resolve -->|external| Bridge[buildConfiguredRouter<br/>Config_Bridge]

    Bridge --> Router[Model_Router]
    LocalRouter --> Router

    subgraph External-only
      Bridge
      Discovery[Model_Discovery_Service]
      E2B[E2B_Sandbox_Adapter]
      Live[runLiveSynthesizer]
    end

    subgraph Always
      Router --> Orchestrator[chat pipeline]
      Orchestrator --> Synth[Synthesizer]
      Store[(RectorStore:<br/>memory | sqlite | tidb)]
    end

    Synth -->|external + valid flagship + heavy route| Live
    Synth -->|local OR fallback| Legacy[Legacy_Status_Response]

    SettingsAPI[Settings_API] --> Discovery
    SettingsAPI -->|local mode| InertDiscovery[Discovery unavailable error]
    Discovery --> Registry[Discovery_Adapter registry]
    Registry --> Together & Cloudflare & Azure & OpenAICompat
```

### Boot-tolerant startup sequence (Req 1, 8)

The central architectural change in this transition is moving orchestration-config resolution from
a **synchronous, env-only, throw-on-missing** function to an **async, store-aware, warn-on-missing**
resolution. The new `resolveOrchestrationConfig` is the only function permitted to halt startup, and
it does so for exactly one reason: an `ORCHESTRATOR_MODE` value that is neither `local` nor
`external` (case-sensitive).

```mermaid
sequenceDiagram
    participant Boot as server.ts
    participant Cfg as resolveOrchestrationConfig
    participant PCS as Provider_Config_Store
    participant SS as Secret_Store
    participant Store as createRectorStore

    Boot->>Cfg: resolve(env, providerConfigStore, secretStore)
    alt mode not in {local, external}
        Cfg-->>Boot: throw OrchestrationConfigError(MODE_INVALID)
        Boot->>Boot: log redacted error, process.exit(1)
    else mode = local
        Cfg-->>Boot: { mode: local, configuredProviders: [] }
    else mode = external
        Cfg->>PCS: await getState()
        Cfg->>SS: await hasSecret(ref) for each record
        Note over Cfg,SS: store read failure ⇒ treat as absent, redacted error, continue
        Cfg-->>Boot: { mode: external, configuredProviders: [...] }
        alt configuredProviders empty
            Boot->>Boot: emit redacted warning naming env keys; do NOT exit; bind + listen
        end
    end
    Boot->>Store: createRectorStore(persistence)
    alt driver = tidb
        Store->>Store: validate fields ⇒ StoreConfigError before any connection
        Store->>Store: Startup_Migration: connect (≤30s) + verify/provision tables
    end
    Boot->>Boot: listen(port)
```

The key behavioral inversion from the current code: external mode with no configured provider must
**warn and serve** (so the operator can open the UI and enter credentials) rather than **throw and
exit**. The hard-exit is reserved for an invalid mode value.

### Optional dependency strategy (Req 11)

Two cloud clients are optional peer dependencies that must not break the build or the local test
suite when absent:

- **TiDB MySQL driver** (`sync-mysql`) — already lazily loaded via `createRequire` in
  `tidbRectorStore.ts`; only required when `driver: "tidb"` is actually constructed.
- **E2B client** — the new `E2B_Sandbox_Adapter` follows the identical pattern: a dynamic
  `createRequire(import.meta.url)(...)` inside the adapter's initialization, never a static import,
  so the module graph compiles without the package.

When an operator selects a path whose optional dependency is absent, the load throws a clear,
actionable error (e.g. "install `@e2b/code-interpreter` to enable the E2B sandbox") rather than a
module-not-found stack trace.

## Components and Interfaces

### 1. `resolveOrchestrationConfig` (Req 1, 9)

Replaces the synchronous, env-only `parseOrchestrationConfig` on the live path. The existing
function is retained for pure-env callers/tests; the new async resolver is the boot entry point.

```ts
export interface OrchestrationConfig {
  mode: OrchestratorMode;            // "local" | "external"
  configuredProviders: string[];     // provider ids; never a secret value
}

export interface ResolveOrchestrationDeps {
  env: Record<string, string | undefined>;
  providerConfigStore: ProviderConfigStore;
  secretStore: SecretStore;
}

// Boot-tolerant resolution.
// - mode resolves to "local" when ORCHESTRATOR_MODE is unset/empty/whitespace (Req 9.5)
// - throws ONLY when the mode value is a non-empty string that is not exactly
//   "local" or "external" (Req 1.6)
// - external: a provider is "configured" when all required env keys are present & non-empty,
//   OR a Provider_Config_Record exists whose required secrets are all reported present (Req 1.3)
// - store read failure ⇒ treat stored creds as absent, emit redacted error, continue (Req 1.8)
// - external + zero configured providers ⇒ emit redacted warning naming env keys; resolve
//   normally (the caller binds + listens) (Req 1.4, 1.5, 1.7)
export async function resolveOrchestrationConfig(
  deps: ResolveOrchestrationDeps
): Promise<OrchestrationConfig>;
```

Provider descriptors carry, per kind, the required env-key names and the set of required secret refs
the Secret_Store must report present. The resolver computes the configured-provider list as the
**union** of env-satisfied providers and store-satisfied records, and never reads a secret *value*
(presence-only via `hasSecret`).

### 2. Model discovery (Req 2, 3) — confirm and complete

The `Model_Discovery_Service` and the four-adapter registry already implement the required shape.
The transition verifies and hardens these behaviors:

- **Per-kind dispatch** (Req 2.1): `service.discover` already dispatches `adapters[record.kind]` and
  returns the adapter result. No change.
- **30s abort** (Req 2.9, 4.6): the service wraps each adapter call with an `AbortController` +
  timer so a catalog request that does not respond within 30 000 ms is aborted and classified
  (`network_error` at the adapter layer, `timeout` at the Settings_API layer).
- **Together fallback** (Req 2.2): native `/models`, fall back to `/v1/models` **only on 404** —
  already implemented in `together.ts`.
- **Cloudflare task filter** (Req 2.3): the Cloudflare adapter retains only entries whose task is
  exactly `text-generation`, `chat`, or `embeddings`, discarding all others before normalization.
- **Azure** (Req 2.4, 2.5): every emitted candidate sets `requiresDeployment: true` and emits **no**
  deployment id; a request asking for deployment enumeration returns a `requires_management_plane`
  Discovery_Error.
- **OpenAI-compatible** (Req 2.6, 3.4–3.7): attempt `/v1/models` first; on failure/timeout/non-OK/
  empty, build candidates from the record's `Manual_Model_List` when present, else return a
  classified error.
- **Validation drop** (Req 2.7, 2.8): each retained entry is normalized against
  `ModelCandidateSchema`; entries that fail validation are dropped and processing continues.
- **Empty is success** (Req 2.14): zero retained entries returns an empty candidate set, not an
  error.
- **Redaction** (Req 2.13): error messages exclude every credential value and raw response body
  (routed through `redactString`).
- **Local inertness** (Req 2.15): the service is never invoked on the local path; the Settings_API
  guard (below) short-circuits before any service call.

```ts
export interface ModelDiscoveryService {
  discover(providerId: string, options?: DiscoverOptions): Promise<DiscoveryResult>;
}
// DiscoveryResult = { ok: true, candidates: ModelCandidate[] } | { ok: false, error: DiscoveryError }
```

### 3. BYOK OpenAI-compatible provider with manual model entry (Req 3)

`ProviderConfigRecord` already carries `label` (Provider_Label) and `model`/`models`. The
transition adds an explicit **`Manual_Model_List`** field and the Settings_API validation that a
non-empty `label` is required for `openai-compatible` records.

```ts
// Extension to ProviderConfigRecordSchema (non-secret):
manualModels: z.array(z.string().min(1)).optional(); // Manual_Model_List (Req 3.3)
```

- Settings_API rejects an `openai-compatible` record whose `label` is missing/empty/whitespace with
  a validation error and persists nothing (Req 3.2).
- `manualModels` is persisted as non-secret config; no secret value is ever written to the record
  (Req 3.3).
- The OpenAI_Compatible_Discovery_Adapter consumes `manualModels` as the fallback source, emitting
  exactly one `ModelCandidate` per identifier, each schema-valid (Req 3.6).
- The Active_Route_Map can designate any `manualModels` identifier as the `flagship`/`slm` model id
  for that record (Req 3.8) — `models.flagship` / `models.slm` reference an entry from the list.

### 4. Settings_API discovery endpoint (Req 4)

A new route on the Express app calls the `Model_Discovery_Service` for a configured provider.

```
POST /api/config/providers/:id/discover   (or GET; body/query carries refresh flag)
```

Behavior:

- **Local mode** (Req 4.3, 4.7): when `orchestration.mode === "local"`, the handler returns a
  `Discovery_Error` indicating discovery is unavailable in local mode **without** invoking the
  service or making any network call.
- **Unknown provider** (Req 4.2): the service returns `not_found`; the handler relays it.
- **Success/known error** (Req 4.1, 4.5): the handler invokes the service and returns the
  `Model_Candidate`s, or relays a classified `Discovery_Error` without throwing.
- **30s deadline** (Req 4.6): the handler races the service call against a 30 000 ms timer; on
  expiry it returns a `Discovery_Error` with category `timeout`.
- **Redaction** (Req 4.4): the response is sent through the existing `sendRedacted` /
  `redactOutbound` boundary so no secret value or authorization header escapes.

The Settings_API depends only on `ModelDiscoveryService` and the resolved mode, both injected through
the existing `securityOptions` (orchestration, secretStore, providerConfigStore) already threaded
into `createApp`.

### 5. Provider routing — `buildConfiguredRouter` (Req 5) — confirm

The Config_Bridge already constructs all kinds with `enableNetwork` driven by the caller, honors the
Active_Route_Map by **record id**, and falls back to capability-priority selection. The transition
verifies and adds:

- **Fallback trace marker** (Req 5.5): when the router substitutes a fallback for a designated
  route, it records a non-secret substitution indication in the run trace (a `ModelSelection.reason`
  already carries this; the orchestrator surfaces it as a trace event).
- **Local fallback** (Req 5.6): in local mode `buildConfiguredRouter` is never called; the fake
  router is used. The bridge additionally refuses to construct external providers when `mode` is
  `local`.

### 6. `E2B_Sandbox_Adapter` (Req 6)

Replaces `createE2BSandboxAdapterStub` with a real adapter implementing the same `SandboxAdapter`
contract and reusing the `WorkspaceSandboxAdapter`'s policy gates (allowlist, destructive denylist,
approval gates, path containment) **before** any container call.

```ts
export interface E2BSandboxOptions {
  apiKey: string;                       // read transiently from Secret_Store at construction
  workspaceRoot: string;
  allowlistedCommands?: string[];
  riskyCommands?: string[];
  approvals?: SandboxApproval[];
  clientFactory?: (apiKey: string) => E2BClient; // injectable for tests; real factory lazy-loads
  now?: () => string;
}

export function createE2BSandboxAdapter(options: E2BSandboxOptions): SandboxAdapter;
```

Pipeline for `operate`/`execute`:

1. **Policy gates first** (Req 6.6): destructive denylist → allowlist → approval gates. A denied
   operation returns `DENIED` / `NEEDS_APPROVAL` **without** spawning any container process.
2. **Client init** (Req 6.1, 6.9): the E2B container client is initialized from the Secret_Store API
   key. If initialization fails, the adapter returns a failure `Sandbox_Execution_Result` with a
   redacted error and spawns no process.
3. **Run command** (Req 6.2): an approved, allowlisted `RUN_COMMAND` executes inside the container.
4. **Apply patch** (Req 6.3, 6.10): an approved `PROPOSE_PATCH` applies the file change inside the
   container; on failure it returns a failure result with a redacted error and leaves the target
   file unchanged.
5. **Capture** (Req 6.4): exit code, stdout, stderr captured into the result.
6. **Truncate** (Req 6.5): each stream exceeding `MAX_CAPTURED_STREAM_BYTES` (262 144) is truncated
   to that bound with a truncation indicator set.
7. **Redact** (Req 6.8): captured streams and artifact content are routed through the
   Redaction_Layer before being recorded.

Local mode (Req 6.7): the server constructs the network-free local runner (`WorkspaceSandboxAdapter`
with its default runner) and **never** initializes an E2B client.

### 7. Synthesizer gating for Heavy_Developer_Routes (Req 7)

`runLiveSynthesizer` already implements budget preflight, a single repair attempt, validation, and
deterministic fallback. The transition adds the **gating decision** that selects between the live
synthesizer and the Legacy_Status_Response:

```ts
function shouldRunLiveSynthesizer(ctx): boolean {
  return ctx.mode === "external"
    && isHeavyDeveloperRoute(ctx.triage.route)        // RESEARCH | CODE_EDIT | PLAN_ONLY | LONG_RUNNING
    && ctx.activeRoute.flagshipProviderIsValid;       // Active_Route_Map designates a valid flagship
}
```

- When the gate is **closed** (local mode, non-heavy route, or no valid flagship), the deterministic
  `synthesizeChatBrainstemResponse` is returned with `providerCalls === 0` (Req 7.5).
- When **open**, `runLiveSynthesizer` requests a `Narrative_Answer` from the designated flagship
  model (Req 7.1), building the prompt from triage intent, compiled DAG, node logs, validation
  outcomes, and diffs, omitting absent inputs rather than failing (Req 7.2).
- A valid answer is capped at **2000 characters**, states what was attempted/fixed/changed, and
  references the trace drawer (Req 7.3). The `SynthesisDraftSchema` gains a max-length refinement and
  the validator rejects an over-length or unparseable/empty answer (Req 7.7).
- A budget denial, provider failure, invalid answer, or a **60 000 ms** deadline expiry yields the
  Legacy_Status_Response (Req 7.4). A new outer deadline races the live call.
- The answer text and every citation field are redacted before returning (Req 7.6).

### 8. TiDB Cloud persistence (Req 8) — complete

`SqlRectorStore` already maps all five entities to tables with the `mysql` dialect and provisions
them via `migrate()` using `CREATE TABLE IF NOT EXISTS`. The transition completes the hosted path:

- **Connection pooling** (Req 8.1): `createTiDBDriver` is upgraded to use a pooled MySQL-wire client
  rather than a single connection, behind the same synchronous `SqlDriver` contract.
- **Field validation** (Req 8.2): `createRectorStore` already throws `StoreConfigError` naming the
  missing field(s) before opening any connection. Confirmed; the named fields are host, port,
  database, user, password.
- **Entity mapping** (Req 8.3): conversations, messages, runs, run_events, artifacts — already
  mapped.
- **Startup_Migration** (Req 8.4): a boot-time step runs `migrate()` (verify + provision missing
  tables) and confirms all five tables exist **before** the server serves any request.
- **Round-trip** (Req 8.5): write-then-read-by-id returns a deep-equal entity. The store serializes
  the full entity as a JSON payload and re-parses through the entity's Zod schema, guaranteeing the
  round trip.
- **Memory driver** (Req 8.6): `memory` constructs the in-memory store with no DB connection.
- **Error redaction** (Req 8.7): TiDB error messages exclude the connection password and any URL
  userinfo credentials (via `redactString` / `redactCredentialUrl`).
- **Init deadline** (Req 8.8): the Startup_Migration races connect+provision against a 30 000 ms
  deadline; on timeout or provision failure the server halts startup with a redacted persistence
  error and serves no request.

### 9. Local-mode baseline preservation (Req 9) — invariants

No new component; a set of guarantees enforced by the mode gate:

- Zero outbound provider calls across orchestration, discovery, synthesis (Req 9.1).
- Zero external sandbox container execution (Req 9.2).
- Config_Bridge not consulted for router construction (Req 9.3).
- `providerCalls === 0` reported on run completion (Req 9.4).
- Unset/empty/whitespace `ORCHESTRATOR_MODE` resolves to `local` (Req 9.5).
- An attempted outbound provider/sandbox call in local mode is blocked and leaves persisted state
  unchanged (Req 9.6).
- Identical inputs produce deep-equal user-facing output across two runs (Req 9.7, determinism).

### 10. Redaction_Layer (Req 10) — confirm universal coverage

The `Redaction_Layer` (`redactString`, `redactSecrets`, `redactOutbound`, `redactStringOrSuppress`)
is mature. The transition's obligation is **coverage**: every new log/telemetry write (startup
warnings, discovery errors, sandbox stream capture, TiDB errors, synthesizer answers) routes through
it before the sink. Behaviors confirmed:

- Single fixed placeholder containing none of the original characters (Req 10.2).
- Output contains no substring of any secret/API key/credential (Req 10.3).
- Bearer/Basic schemes retained, token replaced (Req 10.4).
- Connection-URL userinfo replaced, other components retained (Req 10.5).
- On redaction failure, the raw value is suppressed and the fixed redaction-failed placeholder is
  emitted (Req 10.6, via `redactOutbound`/`redactStringOrSuppress`).

## Data Models

### Orchestration configuration

```ts
type OrchestratorMode = "local" | "external";

interface OrchestrationConfig {
  mode: OrchestratorMode;
  configuredProviders: string[];   // ids only; never secret values
}
```

### Provider configuration (extended)

```ts
interface ProviderConfigRecord {
  id: string;
  kind: "together" | "cloudflare" | "azure-openai" | "openai-compatible";
  label: string;                   // Provider_Label — required, non-empty (Req 3.1, 3.2)
  baseUrl?: string;
  model?: string;
  models?: { flagship?: string; slm?: string };   // Active_Route_Map model ids per role
  manualModels?: string[];         // Manual_Model_List (Req 3.3, 3.6, 3.8) — NEW
  azure?: { endpoint?: string; apiVersion?: string; deployment?: string };
  cloudflare?: { accountId?: string };
  headers?: Record<string, string>;
  secretRef: string;               // Secret_Store key — never a value
  createdAt: string;
  updatedAt: string;
}

interface ActiveRouteMap { flagship?: string; slm?: string }   // role → record id
```

### Model discovery (existing)

```ts
interface ModelCandidate {
  providerId: string;
  kind: ProviderKind;
  scope: { accountId?; region?; endpoint?; azureResource?; subscriptionId?; resourceGroup? };
  displayName: string;
  capabilities: string[];          // e.g. text-generation, chat, embeddings
  requiresDeployment: boolean;     // true for every Azure candidate (Req 2.4)
  requiresRegion: boolean;
  source: string;
  lastRefreshedAt: string;         // ISO-8601
  modelId?: string;
  deploymentId?: string;           // never emitted for Azure (Req 2.4)
  contextWindow?: number;
  pricing?: { inputPer1k?; outputPer1k?; currency? };
  lifecycle?: "active" | "preview" | "deprecated" | string;
}

type DiscoveryError = {
  category:
    | "not_found" | "auth_invalid" | "endpoint_invalid" | "unsupported_response"
    | "network_error" | "rate_limited" | "requires_management_plane" | "timeout" | "unknown";
  message: string;                 // redacted; no raw body, no credentials
};

type DiscoveryResult =
  | { ok: true;  providerId: string; candidates: ModelCandidate[]; lastRefreshedAt: string }
  | { ok: false; providerId: string; error: DiscoveryError;        lastRefreshedAt: string };
```

### Sandbox execution (existing)

```ts
const MAX_CAPTURED_STREAM_BYTES = 262_144;   // 256 KiB hard cap per stream (Req 6.5)

type SandboxOperation =                       // RUN_COMMAND | PROPOSE_PATCH | READ_FILE | LIST_DIR
  { kind: SandboxOperationKind; path?; operation?; content?; command?; args; timeoutMs?; approvalId?; metadata };

interface SandboxExecutionResult {
  status: "SUCCEEDED" | "FAILED" | "DENIED" | "NEEDS_APPROVAL";
  exitCode: number;
  stdout: string;                  // truncated to cap, redacted
  stderr: string;                  // truncated to cap, redacted
  networkCalls: 0;                 // always 0 in result schema
  artifacts: SandboxArtifact[];    // redacted
  // truncation indicator carried in metadata when a stream was clipped (Req 6.5)
}
```

### Synthesis (existing, extended)

```ts
const MAX_NARRATIVE_ANSWER_CHARS = 2000;     // Req 7.3, 7.7

interface SynthesisDraft {
  response: string;                // ≤ MAX_NARRATIVE_ANSWER_CHARS, redacted
  citations: SynthesisCitation[];  // each field redacted
}

interface BrainstemSynthesis {
  status; route; traceId; evidence: string[];
  providerCalls: number;           // 0 in local mode and deterministic fallback (Req 7.5, 9.4)
  response: string;                // Narrative_Answer (external) or Legacy_Status_Response
}
```

### Persistence (existing)

```ts
type PersistenceDriver = "memory" | "sqlite" | "tidb";

interface TiDBConnectionConfig {
  host?: string; port?: number; user?: string; password?: string; database?: string; tls?: boolean;
}
// Entities mapped to relational tables (mysql dialect): conversations, messages, runs, run_events, artifacts
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

This feature is strongly amenable to property-based testing. The transition is dominated by pure
decision logic (config resolution, discovery normalization, routing selection, redaction, stream
truncation) and round-trip behaviors (persistence, manual-model mapping) that hold universally
across large input spaces. Pure infrastructure wiring (constructing a pooled MySQL client, issuing a
single `/v1/models` request) is covered by integration/example tests in the Testing Strategy rather
than properties. The prework analysis was consolidated to remove redundancy: the several
per-area "local mode performs no network/sandbox call" criteria collapse into the local-isolation
properties, and the per-area "no secret leaks" criteria collapse into the central redaction-safety
property.

### Property 1: Configured-provider resolution is the union of env and stores

*For any* environment map and any Provider_Config_Store + Secret_Store contents, resolving the
Orchestration_Config in external mode yields a configured-provider list that contains a provider id
**iff** all of that provider's required env keys are present and non-empty in the environment, **or**
a Provider_Config_Record exists whose required secret refs are all reported present by the
Secret_Store.

**Validates: Requirements 1.1, 1.2, 1.3**

### Property 2: Empty or whitespace mode resolves to local

*For any* `ORCHESTRATOR_MODE` value that is unset, empty, or composed entirely of whitespace, the
resolved Orchestrator_Mode is `local` with an empty configured-provider list.

**Validates: Requirements 9.5**

### Property 3: An invalid mode value halts startup with a redacted, named error

*For any* non-empty string that is not exactly `local` or `external` (case-sensitive), resolving the
Orchestration_Config raises a configuration error whose redacted message names the accepted values
`local` and `external`.

**Validates: Requirements 1.6**

### Property 4: The startup warning names env keys and leaks no secret

*For any* set of secret values present in the stores or environment, when external mode resolves with
zero configured providers, the emitted startup warning names every supported provider's required
environment-variable keys and contains no substring of any secret value.

**Validates: Requirements 1.7**

### Property 5: Discovery dispatch returns the mapped adapter's result

*For any* Provider_Config_Record, the Model_Discovery_Service dispatches exactly the single
Discovery_Adapter registered for that record's Provider_Kind and returns that adapter's result
unchanged (aside from redaction of the error message).

**Validates: Requirements 2.1**

### Property 6: Together falls back to /v1/models only on HTTP 404

*For any* first-response HTTP status from the Together native `/models` request, the
Together_Discovery_Adapter issues the `/v1/models` fallback request **iff** that first status is 404,
and issues no fallback for any other status.

**Validates: Requirements 2.2**

### Property 7: Cloudflare retains only allowed-task entries

*For any* Cloudflare catalog response, the Cloudflare_Discovery_Adapter's retained entries are
exactly those whose task is one of `text-generation`, `chat`, or `embeddings`, and no entry with any
other task survives.

**Validates: Requirements 2.3**

### Property 8: Azure candidates require deployment and omit deployment ids

*For any* Azure catalog response, every emitted Model_Candidate has `requiresDeployment === true` and
carries no deployment identifier.

**Validates: Requirements 2.4**

### Property 9: Normalization keeps exactly the schema-valid entries

*For any* catalog response, the set of emitted Model_Candidates equals the set of retained entries
that validate against `ModelCandidateSchema`: every emitted candidate is schema-valid, every invalid
entry is excluded, and the remaining valid entries are all preserved.

**Validates: Requirements 2.7, 2.8**

### Property 10: Missing required coordinates produce the correct classified error

*For any* dispatched discovery where the required credential is absent (missing, empty, or
whitespace-only) the result is a Discovery_Error with category `auth_invalid`; and where the required
endpoint or account coordinate is absent the result is a Discovery_Error with category
`endpoint_invalid`.

**Validates: Requirements 2.10, 2.11**

### Property 11: Adapters never throw and always classify failures

*For any* transport error, non-OK HTTP status, timeout, or payload that does not match the expected
catalog structure, the Discovery_Adapter returns a classified, redacted Discovery_Error rather than
raising an exception.

**Validates: Requirements 2.12**

### Property 12: Manual-model fallback builds one valid candidate per identifier

*For any* OpenAI-compatible record carrying a Manual_Model_List, when the `/v1/models` request fails,
times out, returns a non-OK status, or returns no usable entries, the
OpenAI_Compatible_Discovery_Adapter builds the result from the Manual_Model_List, emitting exactly
one schema-valid Model_Candidate per list identifier (with matching model id) rather than returning
an error.

**Validates: Requirements 3.5, 3.6**

### Property 13: Provider_Label validation persists valid labels and rejects blank ones

*For any* `openai-compatible` record, the Settings_API persists the record with its Provider_Label
preserved when the label is a non-empty string, and rejects the record with a validation error
(persisting nothing) when the label is missing, empty, or whitespace-only.

**Validates: Requirements 3.1, 3.2**

### Property 14: Manual_Model_List round-trips with no secret in the record

*For any* `openai-compatible` record with a Manual_Model_List and an associated secret, persisting
then reading the record returns the same Manual_Model_List, and the persisted record contains no
substring of the secret value.

**Validates: Requirements 3.3**

### Property 15: Any manual-list identifier is designable as a route model

*For any* Manual_Model_List and any identifier drawn from it, designating that identifier as the
`flagship` or `slm` model for the record persists and resolves to exactly that identifier in the
record's role-to-model map.

**Validates: Requirements 3.8**

### Property 16: An unknown provider id yields not_found

*For any* provider id that has no Provider_Config_Record, a discovery request returns a
Discovery_Error with category `not_found` and performs no network call.

**Validates: Requirements 4.2**

### Property 17: The Settings_API relays any Discovery_Error category without throwing

*For any* Discovery_Error category returned by the Model_Discovery_Service, the Settings_API returns
that classified error to the caller without raising an exception.

**Validates: Requirements 4.5**

### Property 18: External selection constructs providers with network enabled

*For any* Provider_Config_Record of any Provider_Kind selected in External_Mode, the Config_Bridge
constructs that provider with network access enabled.

**Validates: Requirements 5.1**

### Property 19: A valid designated route resolves to that provider and model

*For any* role in `{flagship, slm}`, when the Active_Route_Map designates a Provider_Config_Record
that exists with its required credentials and endpoint coordinates present and a non-empty model id
for that role, the Model_Router routes that tier's requests to the designated model on that provider.

**Validates: Requirements 5.2, 5.3**

### Property 20: An invalid designation falls back and records a secret-free substitution

*For any* designated route that is absent, missing required credentials or endpoint coordinates,
designates no model id for the role, or raises while serving, the Model_Router selects the next
provider in the capability-priority fallback order (never failing the run) and records a
substitution indication in the run trace that contains no secret value.

**Validates: Requirements 5.4, 5.5**

### Property 21: Captured streams are recorded, truncated to the cap, and flagged

*For any* command result produced by the injected runner, the Sandbox_Execution_Result captures the
exit code and both streams; each captured stream's byte length is at most
`MAX_CAPTURED_STREAM_BYTES` (262 144); and the truncation indicator is set for a stream **iff** that
stream's original length exceeded the cap.

**Validates: Requirements 6.4, 6.5**

### Property 22: Denied operations never spawn a container process

*For any* Sandbox_Operation denied by the command allowlist, the destructive denylist, or a missing
approval, the E2B_Sandbox_Adapter returns a `DENIED` or `NEEDS_APPROVAL` result and spawns zero
container processes.

**Validates: Requirements 6.6**

### Property 23: A heavy route with a valid flagship requests a Narrative_Answer

*For any* run that resolves to a Heavy_Developer_Route while Orchestrator_Mode is `external` and the
Active_Route_Map designates a valid configured flagship provider, the Synthesizer requests a
Narrative_Answer from the designated flagship model.

**Validates: Requirements 7.1**

### Property 24: The narrative prompt includes present inputs and omits absent ones without failing

*For any* subset of the run inputs (triage intent, compiled DAG, node execution logs, validation
outcomes, generated diffs) being present or absent, the Synthesizer builds the Narrative_Answer
prompt successfully, including every present input and omitting every absent input rather than
failing.

**Validates: Requirements 7.2**

### Property 25: An accepted Narrative_Answer is bounded and references the trace drawer

*For any* valid Narrative_Answer returned by the flagship model, the Synthesizer returns a summary of
at most 2000 characters that references the trace drawer for raw data.

**Validates: Requirements 7.3**

### Property 26: Narrative validation rejects empty, unparseable, or over-length answers

*For any* model response that is empty, not parseable as the expected answer shape, or exceeds the
maximum answer length, the Synthesizer treats the Narrative_Answer as invalid.

**Validates: Requirements 7.7**

### Property 27: Synthesizer failure modes yield the Legacy_Status_Response

*For any* flagship request that is denied by budget, fails, or returns an invalid answer, the
Synthesizer returns the deterministic Legacy_Status_Response for the route.

**Validates: Requirements 7.4**

### Property 28: Local-mode synthesis is deterministic with zero provider calls

*For any* run that resolves to a Heavy_Developer_Route while Orchestrator_Mode is `local`, the
Synthesizer returns the deterministic Legacy_Status_Response and reports `providerCalls` equal to 0.

**Validates: Requirements 7.5, 9.4**

### Property 29: Incomplete TiDB config errors naming the missing fields before any connection

*For any* `tidb` connection block missing any subset of the required fields (host, port, database,
user, password), store construction raises a configuration error that names exactly the missing
field(s) and opens no network connection.

**Validates: Requirements 8.2**

### Property 30: Entity write-then-read round-trip is deep-equal

*For any* valid entity of type conversation, message, run, run_event, or artifact written to the
TiDB_Store and read back by its identifier, the returned entity is deep-equal to the entity written.

**Validates: Requirements 8.5**

### Property 31: Local mode performs zero outbound provider network calls

*For any* run in Local_Mode, the system performs zero outbound provider network calls across
orchestration, discovery, and synthesis.

**Validates: Requirements 9.1, 2.15, 4.3**

### Property 32: Local mode performs no external sandbox execution

*For any* sandbox operation in Local_Mode, the system executes it through the local provider-free
runner, executes zero external sandbox containers, and initializes no E2B client.

**Validates: Requirements 9.2, 6.7**

### Property 33: Local mode never consults the Config_Bridge and selects the provider-free fallback

*For any* router construction or selection in Local_Mode, the Config_Bridge is never consulted and
the Model_Router selects the provider-free fallback.

**Validates: Requirements 9.3, 5.6**

### Property 34: A blocked local outbound attempt leaves persisted state unchanged

*For any* code path that attempts an outbound provider network call or external sandbox execution
while Orchestrator_Mode is `local`, the attempt is blocked and the persisted state is unchanged.

**Validates: Requirements 9.6**

### Property 35: Local-mode runs are deterministic

*For any* Local_Mode run executed twice with identical inputs, the user-facing output is deep-equal
across the two executions.

**Validates: Requirements 9.7**

### Property 36: Every log/telemetry write is redacted before the sink

*For any* value containing an environment variable, API endpoint detail, or database identifier
written to a log or telemetry sink, the value reaching the sink has been routed through the
Redaction_Layer.

**Validates: Requirements 10.1**

### Property 37: Redaction uses a single fixed placeholder sharing no original character

*For any* redacted value, the Redaction_Layer replaces it with a single fixed placeholder string
that contains no character of the original redacted token.

**Validates: Requirements 10.2**

### Property 38: Redacted output contains no secret substring

*For any* secret, API key, authorization credential, raw provider response body, connection
password, or other secret-bearing value embedded in arbitrary surrounding text, the redacted output
contains no substring of that secret value. This central safety property is the guarantee every
component-level sink relies on (discovery error messages, the Settings_API discovery response,
captured sandbox streams and artifacts, the synthesizer answer and citations, and TiDB error
messages).

**Validates: Requirements 10.3, 2.13, 4.4, 6.8, 7.6, 8.7**

### Property 39: Authorization-scheme redaction retains the scheme and replaces the token

*For any* value containing a Bearer or Basic authorization header, the Redaction_Layer replaces the
credential token following the scheme keyword with the placeholder while retaining the scheme
keyword, leaking no token substring.

**Validates: Requirements 10.4**

### Property 40: Connection-URL redaction replaces userinfo and retains other components

*For any* value containing a credential-bearing connection URL, the Redaction_Layer replaces the
userinfo credential component with the placeholder while retaining the other URL components, leaking
no credential substring.

**Validates: Requirements 10.5**

## Error Handling

The transition's error philosophy is **classify, redact, and degrade — never crash on operational
failure**. The only hard-exit is an invalid `ORCHESTRATOR_MODE` value (Req 1.6) and a TiDB
persistence-initialization failure under the `tidb` driver (Req 8.8); every other failure resolves to
a safe, classified, redacted outcome.

| Failure | Handling | Requirements |
| --- | --- | --- |
| Invalid `ORCHESTRATOR_MODE` value | Throw `OrchestrationConfigError`; log redacted error naming `local`/`external`; `process.exit(1)` | 1.6 |
| External mode, no configured provider | Emit redacted warning naming env keys; **continue** (bind + listen) | 1.4, 1.5, 1.7 |
| Provider/Secret store unreadable at boot | Treat credentials as absent; emit redacted error; continue | 1.8 |
| Discovery transport/HTTP/payload failure | Return classified, redacted `Discovery_Error`; never throw | 2.12, 2.13 |
| Discovery exceeds 30s | Abort request; classify (`network_error` adapter / `timeout` Settings_API) | 2.9, 4.6 |
| Missing credential / endpoint | `auth_invalid` / `endpoint_invalid` | 2.10, 2.11 |
| Azure deployment enumeration requested | `requires_management_plane` | 2.5 |
| OpenAI-compatible endpoint down, manual list present | Build from manual list (not an error) | 3.5 |
| OpenAI-compatible endpoint down, no manual list | Classified, redacted `Discovery_Error` | 3.7 |
| Unknown provider id at Settings_API | `not_found` | 4.2 |
| Designated route invalid | Fall back to capability-priority provider; record secret-free trace marker | 5.4, 5.5 |
| E2B client init failure | Failure result, redacted error, spawn no process | 6.9 |
| E2B patch apply failure | Failure result, redacted error, target file unchanged | 6.10 |
| Sandbox operation denied by a gate | `DENIED` / `NEEDS_APPROVAL`, no container spawned | 6.6 |
| Flagship request denied/failed/invalid/>60s | Deterministic Legacy_Status_Response | 7.4 |
| Incomplete TiDB config | `StoreConfigError` naming missing fields, before any connection; do not listen | 8.2 |
| TiDB connect >30s or provision failure | Halt startup with redacted persistence error; serve nothing | 8.8 |
| Optional dependency absent but selected | Clear error naming the missing dependency (`sync-mysql` / E2B client) | 11.5 |
| Redaction itself throws | Suppress raw value; emit fixed redaction-failed placeholder | 10.6 |

All error messages crossing a log, telemetry, or response boundary pass through `redactString` /
`redactSecrets` / `redactOutbound` first, so no error path can leak a secret.

## Testing Strategy

### Dual approach

- **Property-based tests** verify the 40 universal properties above across large generated input
  spaces (config resolution, discovery normalization, routing, redaction, truncation, round-trips,
  determinism, local-isolation invariants).
- **Unit / example tests** verify concrete behaviors not amenable to universal quantification: the
  exact `/v1/models` request shape, Azure `requires_management_plane` for a deployment-enumeration
  request, the local-mode "discovery unavailable" response, the missing-dependency error messages,
  and the happy-path container exec/patch calls.
- **Integration tests** verify external-service wiring with 1–3 representative cases: TiDB_Store
  construction over an injected pooled driver and the Startup_Migration verify/provision sequence.
- **Smoke tests** verify one-shot configuration: `npm run build` and `npm test` exit clean, the build
  succeeds with the optional cloud dependencies absent, the MySQL-dialect DDL is emitted for all five
  tables, and the local + memory server boots and serves with optional deps absent.

### Property-based testing requirements

- Use the project's existing property-based testing library (`fast-check`, consistent with the
  TypeScript/Vitest stack); do **not** hand-roll a generator framework.
- Each property test runs a **minimum of 100 iterations**.
- Each property test is tagged with a comment referencing its design property, in the format:
  **Feature: cloud-capable-transition, Property {number}: {property_text}**.
- Each correctness property is implemented by a **single** property-based test.
- Network, filesystem, clock, sandbox client, and provider boundaries are injected with deterministic
  doubles (mirroring the existing `fetchImpl`, `fsImpl`, `clock`, `commandRunner`, and
  `clientFactory` seams) so property tests are hermetic and the "ran 0 times" / "zero network call"
  invariants are directly observable via counting doubles.

### Test data generators

- **Env + store states**: random env maps over the supported provider env-key names; random
  Provider_Config_Record sets with controllable secret-presence — drive Properties 1–4, 13–15.
- **Catalog responses**: random Together/Cloudflare/Azure/OpenAI-compatible payloads, including
  mixed-validity entries, disallowed tasks, empty lists, malformed bodies, and non-ASCII content —
  drive Properties 5–12, 16–17.
- **Secrets-in-text**: random secret tokens embedded in arbitrary surrounding strings, Bearer/Basic
  headers, and credential URLs — drive Properties 36–40 and the redaction obligations folded into
  Property 38.
- **Streams**: byte strings of random length straddling `MAX_CAPTURED_STREAM_BYTES` — drive
  Property 21.
- **Entities**: random valid conversations, messages, runs, run_events, artifacts per their Zod
  schemas — drive Property 30.
- **Run inputs**: random triage routes (including the four Heavy_Developer_Routes), DAG/log/diff
  presence combinations, and budget states — drive Properties 23–28, 31–35.

### Verification gates (Req 11)

After implementation, `npm run build` and `npm test` must both exit zero with no failures, including
when the optional `sync-mysql` and E2B client packages are absent from the environment.
