# Rector Concerns and Vulnerabilities Register

> Running register for implementation concerns, security risks, review notes, and deferred fixes discovered while implementing chunks. Keep updated through final chunk.

## Open

### External mode fail-fast startup check ignores UI-persisted configurations

- **Source:** User report / startup validation audit.
- **Severity:** High usability/onboarding blocker.
- **Status:** Open.
- **Root cause:** When `ORCHESTRATOR_MODE=external`, the server runs a fail-fast synchronous check `parseOrchestrationConfig(process.env)` at startup. This check only reads variables from `process.env` (loaded from `.env`). It does not look at the persisted UI provider store (`.rector/providers.json` & `.rector/secrets.enc`), which is loaded asynchronously later. If the user only sets up their credentials in the browser UI (which writes to the JSON and encrypted key files) but leaves the `.env` variables blank, Rector fails to boot with `EXTERNAL_MODE_NO_PROVIDER`.
- **Plan:** Fix the startup sequencing so the fail-fast orchestration mode parser either integrates the persisted UI configuration asynchronously, or clearly document that to run in `external` mode, at least one provider's environment variables must be populated in `.env` as a bootstrap signal even if UI-based overrides are configured.

### Dependency audit: vitest major-upgrade vulnerabilities deferred (require maintainer approval)

- **Source:** `npm audit` during the `dependency-security-triage` spec; see `docs/security/dependency-audit-2026-06-04.md`.
- **Severity:** 1 critical + 3 moderate, all dev-tooling only (not in the `dist` runtime).
  - `vitest` — critical, GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/exec; UI server is not used by `npm test`).
  - `vite` — moderate, GHSA-4w7w-66w2-5vf9 (path traversal in optimized-deps `.map` handling; dev server only).
  - `@vitest/mocker` — moderate (transitive via vulnerable `vite`).
  - `vite-node` — moderate (transitive via vulnerable `vite`).
- **Status:** Open / deferred — awaiting maintainer approval.
- **Root cause:** Rector pins `vitest@^2.1.0` (resolves `vitest@2.1.9`). npm's only offered remediation for all four findings is `vitest@4.1.8`, flagged `isSemVerMajor: true` and only applicable via `npm audit fix --force`.
- **Plan:** Per the no-forced-fix policy (Requirement 4 / steering `security.md`), the `vitest@4` major upgrade was **not** applied autonomously because it requires `npm audit fix --force` and is a breaking change to the test toolchain. Deferred for explicit maintainer approval. When approved, upgrade `vitest` to `>=4.1.8`, re-run the full verification baseline (`npm test`/`build`/`check`), and confirm the advisories clear. Runtime exposure is nil today: these are dev/test dependencies, not shipped in `dist`, and `npm test` runs `vitest run` (no UI server). Traceability: `docs/security/dependency-audit-2026-06-04.md`.

### SLM preprocessor (Chunk 26) adds a new cheap-model call surface before flagship planning in external mode

- **Source:** Chunk 26 (SLM Preprocessor + Structured Tool Calls) implementation.
- **Severity:** Medium (new LLM surface + JSON proposal boundary, but heavily mitigated).
- **Status:** Open.
- **Root cause:** In `runExternalChatRun`, a router-selected cheap/SLM provider is now invoked (via `runSLMPreprocessor`) after context building and before the live planner. It produces `distilledContext` + `proposedToolCalls`. Even though the preprocessor runs `evaluateBudget` + `invokeWithBudget`, forces json_object, validates with Zod, filters tools against a conservative allowlist, and redacts output, this is a new place where model output influences downstream flagship prompts and is visible in traces.
- **Plan / Mitigations (already implemented in this chunk):**
  - Local mode (`runFakeChatRun`) is completely untouched — preprocessor is never called.
  - The preprocessor never throws; every failure path (budget denial, provider error, bad JSON, schema failure) produces a safe deterministic fallback with empty `proposedToolCalls`.
  - Original `prompt` + full `contextPack` are retained and passed to skeptic/crucible/healing/synthesis for cross-validation.
  - `proposedToolCalls` are only *proposals*; they are filtered to `ALLOWED_PREPROCESSOR_TOOLS` and still flow through the full symbolic pipeline (`WorkspaceSandboxAdapter` containment/allowlist/approvals, skeptic, crucible, validation/healing, budget).
  - Usage (if any) is intended to be accounted (Step 1 keeps accounting lightweight; later refinement can commit preprocessor usage explicitly before the planner preflight).
  - Property test (fast-check) asserts that arbitrary bloat always produces schema-valid output with only allowlisted (or zero) tool proposals and no obvious secret leakage.
- **Future work:** Prompt hardening / few-shot examples for the preprocessor, richer usage accounting, optional exposure of preprocessor output in the UI trace drawer, and quality metrics once real cheap providers are exercised.
- **Traceability:** `docs/plans/chunks/026-slm-preprocessor-structured-tool-calls.md`, `src/orchestration/preprocessor.ts`, `tests/preprocessor.test.ts`, wiring in `src/orchestration/chatRunner.ts`.

### Advanced memory (Chunk 27) introduces new write path (/api/notes) and pruning logic in the store

- **Source:** Chunk 27 (Advanced Memory System / neuro-symbolic Step 2) implementation.
- **Severity:** Medium (new persistent-ish state in local mode, pruning decisions, note capture as user-controlled input).
- **Status:** Open.
- **Root cause:** New MemoryEntry entities (layered working/episodic/core) stored in InMemoryRectorStore (and interface extended for future durable stores). `POST /api/notes` allows quick capture into episodic. `pruneMemory` uses heuristic scoring (recency + access + source bonuses) and can create auto-summaries in core. Time fields (`timestamp`, `lastMentioned`) are injected into ContextPack as natural language phrases. All new paths must respect redaction.
- **Plan / Mitigations (implemented in this chunk):**
  - Local/in-memory baseline only; no new network or paid services required (Chroma/Mem0/TiDB stubs or future adapters follow existing pattern).
  - All memory content goes through `redactString` on note creation and search results are simple keyword for alpha.
  - Prune is bounded (`maxEntries`) and opportunistic on note writes; high-value items (user notes, high access) are protected by scoring.
  - Time context is derived client-side in buildContextPack (no external clock dependency beyond store `now`).
  - Existing ContextPack consumers (preprocessor, planner, skeptic) see additive `memoryContext` field; original paths unchanged.
  - Tests include pruning invariants and time fields.
- **Future work:** Real vector similarity in prune/search when Chroma or Mem0 adapters are activated (using stack credits); durable memory entities in sql/tidb stores; full ponder swarm (Step 6) that reads/writes this memory; UI for captured notes; retention policies per layer.
- **Traceability:** `docs/plans/chunks/027-advanced-memory-system.md`, `src/store/schemas.ts` (MemoryEntry), `src/store/inMemoryRectorStore.ts` (impl + prune), `src/api/server.ts` (/api/notes + context enrichment), `src/orchestration/contextBuilder.ts` (time-aware injection), `tests/memoryAdvanced.test.ts`.

### Chat store is in-memory and resets on restart

- **Source:** Chunk 6 worker/reviewer.
- **Severity:** Expected prototype limitation.
- **Status:** Open until MongoDB/local durable store adapter chunk.
- **Plan:** Keep documented. Replace/augment with durable store in later persistence/provider chunks.

### Chat run progress is polling/list only, no SSE/WebSocket

- **Source:** Chunk 6 worker.
- **Severity:** Product UX limitation.
- **Status:** Open.
- **Plan:** Add streaming/SSE in a future chat UX chunk after state/events stabilize.

### Chat synthesis is deterministic trace summary, not semantic answer generation

- **Source:** Chunk 15 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until provider-backed/local-model synthesis chunks.
- **Plan:** Current final assistant response summarizes local trace evidence from triage/context/planning/review/arbitration/DAG/execution/validation/healing without provider calls. It is safe and testable for alpha brainstem proof, but it does not yet generate rich task-specific prose, cite real external sources, or explain code changes from actual filesystem execution.

### Store list ordering relies on insertion order

- **Source:** Chunk 4 GLM review.
- **Severity:** Low.
- **Status:** Accepted for in-memory prototype.
- **Plan:** Production/durable store should sort explicitly by `createdAt` where UX requires chronological order.

### Store deletes are shallow and do not cascade

- **Source:** Chunk 4 GLM review.
- **Severity:** Low.
- **Status:** Documented in code.
- **Plan:** Production store should define cascade/retention policy explicitly.

### RunEvent IDs require uniqueness across distributed systems

- **Source:** Chunk 5 GLM review.
- **Severity:** Low in local mode, higher in distributed mode.
- **Status:** Mitigated locally with duplicate rejection and random UUID default.
- **Plan:** Production stores must enforce unique event IDs and transaction/conditional-write semantics.

### Security controls are local-process baselines only

- **Source:** Chunk 7 implementation; Gemini final audit.
- **Severity:** Medium for production deployment.
- **Status:** Open.
- **Plan:** Replace in-memory rate limiting with shared/distributed limiter, add real auth/session enforcement, centralize budget enforcement at provider call boundaries, and continue hardening redaction with structured secret classifiers before public multi-user deployment. Confirmed camelCase secret-key and username-only URI redaction gaps were fixed after final audit with regression tests.

### In-memory rate limiter is local-only and requires distributed backend in production

- **Source:** Chunk 7 review fixes.
- **Severity:** Low for local-MVP, High for multi-instance production.
- **Status:** Mitigated locally via opportunistic expiry cleanup in middleware.
- **Plan:** The current rate limiter uses an in-memory `Map` with opportunistic cleaning of expired buckets on each request. While this prevents unbounded memory growth locally, a production-grade deployment with multiple API instances requires a distributed rate limiter (e.g. Redis, Memcached, or Cloudflare KV/Durable Objects) to enforce rate limits consistently across instances and prevent local `Map` memory overhead under high concurrency.

### Triage and context builder are deterministic placeholders

- **Source:** Chunk 8 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until planner/provider orchestration chunks replace or augment the baseline.
- **Plan:** Current routing uses local keyword heuristics and placeholder provider/tool/doc/memory inventories. It is safe for the no-provider chat shell, but production routing should add learned/LLM-assisted classification, confidence calibration, workspace-aware tool/provider inventory, and retrieval-backed docs/memory selection.

### Oversized context artifacts are in-memory only

- **Source:** Chunk 8 implementation.
- **Severity:** Low for local-MVP, Medium for longer sessions or restart durability.
- **Status:** Open until durable artifact storage chunk.
- **Plan:** Context packs omit raw oversized content and reference artifact handles, but artifact records are still stored only in `InMemoryRectorStore` metadata and reset on restart. Current in-memory artifacts keep raw oversized content in `artifact.metadata.content`; durable stores must separate blob content from metadata and define retention, access controls, redaction, and encryption before production use.

### Planner is deterministic fake and does not execute or optimize plans

- **Source:** Chunk 9 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until crucible/DAG/provider chunks replace the fake planner shell.
- **Plan:** Current planner validates schema shape, route-specific task templates, validation coverage, and unsafe approval gates. It does not use LLM reasoning, workspace-aware dependency analysis, real tool availability, or execution DAG compilation yet.

### Skeptic review is heuristic-only

- **Source:** Chunk 10 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until provider-backed review chunks.
- **Plan:** Current skeptic review deterministically checks validation coverage, dangling dependencies, approval gates, empty-task clarification, absent context references, and low-risk underestimates. It does not perform semantic plan critique, real filesystem/API existence checks, exploit analysis, or multi-reviewer consensus yet.

### Crucible arbitration is deterministic and does not repair plans

- **Source:** Chunk 11 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until planner revision/healing/provider-backed arbitration chunks.
- **Plan:** Current Crucible accepts sound plans, blocks blocker findings, requests targeted revisions, and escalates after two rounds. It does not mutate plans, invoke alternate reviewers, run external validation, or automatically produce revised planner output yet.

### DAG compiler emits safe local metadata, not executable sandbox policies

- **Source:** Chunk 12 implementation.
- **Severity:** Medium production-hardening limitation.
- **Status:** Partially mitigated by Chunk 13 simulator; still open for real execution.
- **Plan:** Current DAG compilation is deterministic and denies unsafe shell permissions by default, and the Chunk 13 fake executor enforces shell denial in the simulated path. Real provider/tool execution must still enforce these policies at sandbox/tool boundaries, define real sandbox capabilities, prevent metadata drift from granting shell/file access, and harden `budgetPolicy` merging so caller-provided overrides cannot weaken local/default limits without explicit approval.

### Executor simulator is deterministic fake execution only

- **Source:** Chunk 13 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until real sandbox/provider executor chunks.
- **Plan:** The executor simulator runs in memory, never calls shell/providers, and only compares deterministic metadata for retries, dependency blocking, timeout, and unsafe shell denial. Production execution still needs sandbox isolation, durable execution logs, cancellation, real timeout enforcement, tool allowlists, filesystem/network controls, and provider budget enforcement at call boundaries.

### Validation/healing loop replays the whole fake DAG

- **Source:** Chunk 14 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until real executor/healing chunks.
- **Plan:** The alpha healing loop is deterministic, bounded, provider-free, shell-free, and safe for local simulation. It heals only transient/timeout simulator failures by re-running the DAG with adjusted simulator options. Real execution needs node-level replay, artifact isolation/rollback, durable attempt records, richer failure taxonomy, human decision UX for permission/destructive actions, and real timeout/root-cause diagnostics.

### Observability baseline is in-memory/no-op only

- **Source:** Chunk 16 implementation.
- **Severity:** Low for local alpha, Medium for production operations.
- **Status:** Open until durable telemetry/provider integrations.
- **Plan:** Current traces, spans, latency, and cost/model-call counters are process-local and reset on restart. Sentry/PostHog/OpenTelemetry adapters are explicit no-ops with no network calls. Production/provider chunks must add durable/exportable traces, bounded retention, redaction review for telemetry payloads, real token/model/cost metering at provider call boundaries, sampling, and SDK-backed adapters.

### Provider adapter layer Phase 1 is not live-provider production ready

- **Source:** Chunk 17 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until later provider/runtime hardening chunks.
- **Plan:** Phase 1 defines LLM contracts, deterministic fake local provider, router, budget gate, and a Together AI request/config adapter with network calls disabled by default. Token/cost estimates are approximate, Together live calls require explicit opt-in and mocked tests, provider selection is heuristic, and chat brainstem wiring still defaults to fake/local. Before production/provider-backed flows, add exact provider pricing metadata, robust response/error taxonomy, retry/backoff policy, redaction at provider payload boundaries, streaming/tool-call handling, durable usage accounting, and broader adapter contract tests.

### Budget approval is hard-blocked until approval UX exists (NEEDS_DECISION)

- **Source:** Chunk 17 polish review.
- **Severity:** Medium product limitation.
- **Status:** Open / NEEDS_DECISION.
- **Plan:** While budget limits are correctly evaluated at the provider call boundary, any request exceeding budget or requiring manual human approval is hard-blocked because the corresponding approval interactive UX (user-in-the-loop permissioning) does not yet exist. This needs a product/architecture decision on how human approval responses are solicited, formatted, and injected back into the execution flow.

### Provider adapter layer Phase 2 remains opt-in and not production hardened

- **Source:** Chunk 18 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** Open until provider runtime hardening and chat integration chunks.
- **Plan:** Cloudflare Workers AI, Azure OpenAI, and Perplexity adapters now have config validation, request builders, mocked response parsing tests, budget-gated invocation compatibility, route-based router selection, and network-disabled-by-default behavior. They are still optional adapters with approximate token/cost estimates, no streaming/tool calls, no retry/backoff/circuit breaker policy, no provider-side redaction audit beyond existing baseline utilities, and no live-provider CI. Production flows must add exact pricing/version metadata, richer provider error normalization, retry/backoff, timeout controls, redaction at payload boundaries, durable usage accounting, and explicit user approval UX before enabling live calls broadly.

### Truth library is in-memory keyword retrieval only

- **Source:** Chunk 19 implementation.
- **Severity:** Low for local alpha, Medium for production knowledge workflows.
- **Status:** Open until durable memory/search/provider integrations.
- **Plan:** Current truth library is provider-free and process-local. It validates TRUSTED/UNVERIFIED/REJECTED status, provenance, and citations; excludes rejected items by default; and uses deterministic keyword scoring. It does not provide durable persistence, embeddings, semantic ranking, access controls beyond in-process callers, citation freshness checks, or Chroma/Algolia network integrations. Production memory/search must add durable storage, retention/deletion policy, permission filtering, redaction review for stored content, semantic retrieval, and explicit trust-review workflows before enabling shared or hosted use.

### Public extension contracts have no loader or isolation

- **Source:** Chunk 20 implementation.
- **Severity:** Low for local alpha, Medium for production extension ecosystems.
- **Status:** Open until extension runtime/security hardening.
- **Plan:** Current public extension contracts define typed schemas, manifests, API version compatibility, and no-network sample interfaces only. Rector does not yet load third-party packages, verify signatures, isolate extension code, enforce runtime permissions beyond schema-level `networkAccess: false`/`networkCalls: 0`, or provide a durable extension registry. Production extension support must add explicit permission grants, sandboxing/isolation, provenance/signing, version negotiation, revocation, audit logging, and network/file-system policy enforcement before accepting untrusted extensions.

### Operator console API is local-only and unauthenticated

- **Source:** Chunk 21 implementation.
- **Severity:** Low for local alpha, High if exposed beyond localhost/trusted dev networks.
- **Status:** Open until production operator access controls and real control-plane semantics exist.
- **Plan:** Current `/api/operator/*` endpoints are explicitly marked `localOnly: true` / `auth: local-only-no-auth`, use the in-memory store, expose run/event/cost/artifact metadata for optional Retool consumption, keep retry/abort/approval decisions as non-mutating placeholders, and stub Linear issue creation with zero network calls. Final audit found the dev server implicitly bound to all interfaces; bootstrap now defaults to `127.0.0.1` via `HOST`. Before any hosted or shared deployment, add authentication, authorization/RBAC, CSRF/origin hardening, audit logs, durable persistence, real approval/retry/abort semantics, artifact access controls, and a real Linear adapter behind explicit env/budget gates.

### Safe code execution is contract-only and not an isolation boundary

- **Source:** Chunk 22 implementation.
- **Severity:** Low for local deterministic alpha, High if mistaken for production sandboxing.
- **Status:** Open until real sandbox isolation and approval UX exist.
- **Plan:** Current safe code execution adds typed sandbox contracts, a hardened local allowlist, patch artifacts, file-write approval metadata, and E2B/Depot no-network stubs. It intentionally does not run arbitrary shell, apply patches, isolate processes, enforce OS/container controls, or call cloud sandboxes. Production execution still needs real sandbox isolation, filesystem/network policy enforcement, durable audit logs, patch application/rollback, human approval UX, timeout/cancellation controls, and live E2B/Depot adapters behind explicit budget/env/user approval gates.

### External workflow integrations are contract/stub-only and network-disabled

- **Source:** Chunk 23 implementation.
- **Severity:** Low for local alpha, Medium for production/operator workflows.
- **Status:** Open until workflow approvals, durable audit logging, and live integration hardening exist.
- **Plan:** Current Linear and Make integrations provide typed payload schemas, config validation, request builders, and default network-disabled invocation gates. Requestly and BrowserStack are docs-only plan stubs with zero network calls. Note that Linear's integration maps escalation `labels` directly to `labelIds`, which are provider-specific UUIDs rather than human-readable text display labels; string display label resolution is deferred to a future iteration. Production use still needs explicit user/operator approval UX, authentication/RBAC for workflow actions, durable audit logs, webhook signature verification, retry/backoff/idempotency, provider error normalization, rate limiting, secret management, and live-provider CI isolated from local contributor tests.

### Deployment prototype is config/docs only and not production hosting

- **Source:** Chunk 24 implementation.
- **Severity:** Low for local alpha, High if treated as production deployment readiness.
- **Status:** Open until hosted alpha hardening exists.
- **Plan:** Current deployment support validates/redacts env config, documents Heroku/Cloudflare shapes, and installs graceful HTTP shutdown. It does not provision infrastructure, connect MongoDB/Redis/Chroma, configure real Sentry/PostHog SDKs, define release pipelines, add auth/RBAC, run migrations, enforce TLS/origin policy, or provide production health checks/rollback. Before any hosted/shared deployment, add secret management, durable adapters, CI/CD, infrastructure-as-code, migration/backup policy, runtime health checks, telemetry SDK wiring, and security review.

### Contributor issue drafts can drift from the roadmap

- **Source:** Chunk 25 implementation.
- **Severity:** Low for local alpha, Medium for contributor coordination if stale.
- **Status:** Partially mitigated — drift checks now enforced in CI; GitHub/Linear sync still manual.
- **Plan:** The issue catalog and generated Markdown drafts are deterministic and checked by `node scripts/generate-roadmap-issues.js --check`. As of the `ci-release-workflow` spec, this drift check runs as a required gate in GitHub Actions (`.github/workflows/ci.yml`) on Node 22 and Node 24, so catalog drift now fails CI. A deterministic, provider-free Linear export (`node scripts/export-linear-issues.js`, output under `docs/issues/linear/`) is also generated from the same catalog and drift-checked in CI, giving maintainers import-ready CSV/JSON without any network calls or credentials. The drafts are still not automatically derived from the roadmap text and are not pushed to GitHub or Linear automatically; an API-based importer would require `LINEAR_API_KEY` and a team id and remains deferred behind explicit maintainer approval. When roadmap chunks change, maintainers must update `docs/issues/roadmap-issues.json`, regenerate docs and the Linear export, and run the check commands.

### Safe local sandbox execution uses a dummy mock runner

- **Source:** Codebase audit.
- **Severity:** High (imminent commercial product blocker).
- **Status:** Open.
- **Root cause:** The `WorkspaceSandboxAdapter` executes allowlisted commands via `defaultCommandRunner` which is a dummy mockup returning `${[command, ...args].join(" ").trim()} completed`. It does not spawn any real child processes or apply actual unified patches, meaning code execution and validation is currently a local simulation rather than actual execution.
- **Plan:** Implement real command execution using Node's `child_process` API and actual unified diff application for local mode, and integrate E2B / Depot sandboxing for isolated cloud execution.

### Sandbox stubs deny cloud execution by default

- **Source:** Codebase audit.
- **Severity:** Medium.
- **Status:** Open.
- **Root cause:** The E2B and Depot adapters in `src/sandbox/index.ts` are completely stubbed out. Invoking them throws a `SANDBOX_PROVIDER_STUB_NO_NETWORK` denial error.
- **Plan:** Replace stubs with actual `@e2b/sdk` and Depot clients once billing/credentials are integrated in the settings panel.

### Developer-oriented triage routes fall back to diagnostic traces instead of LLM prose

- **Source:** Codebase audit.
- **Severity:** Medium.
- **Status:** Open.
- **Root cause:** In `src/orchestration/synthesizer.ts`, all developer routes (`RESEARCH`, `CODE_EDIT`, `PLAN_ONLY`, `LONG_RUNNING`) default to returning `legacyStatusResponse` which formats diagnostic execution summaries (e.g. `Status: ... Observed: ...`) instead of calling the LLM router to formulate a rich prose response.
- **Plan:** Connect the synthesizer to the configured model router and instruct flagship models to write user-facing summaries referencing the execution trace.

### Linear workflow integration relies on raw string display labels instead of UUIDs

- **Source:** Codebase audit / workflows inspection.
- **Severity:** Low.
- **Status:** Open.
- **Root cause:** The Linear integration adapter maps raw string display labels (e.g. `["bug", "rector"]`) directly to GraphQL variables `labelIds`. In the Linear API, label IDs are unique team-specific UUIDs. Passing raw string labels will cause mutation errors.
- **Plan:** Implement a pre-flight resolver query to fetch the team's label catalog and map human-readable names to their corresponding UUIDs.

### Telemetry integrations are all inert no-ops

- **Source:** Codebase audit.
- **Severity:** Low.
- **Status:** Open.
- **Root cause:** Although Sentry, PostHog, and OpenTelemetry adapters are defined in the schema and config check, their runtime implementations are inert mocks that perform no network I/O.
- **Plan:** Configure and initialize the actual Sentry Node SDK and PostHog Node SDK in `src/observability` behind user configuration toggles.

## Closed / Mitigated

### Esbuild dev-server advisory resolved via npm overrides (GHSA-67mh-4wv8-2f99)

- **Source:** `npm audit` during branch setup and Gemini final audit; remediated by the `dependency-security-triage` spec.
- **Severity:** Moderate (CVSS 5.3, CWE-346) — esbuild dev server allowed any website to send requests and read responses (DNS-rebinding-style exposure). Dev/test tooling only; never shipped in the `dist` runtime.
- **Fix:** Added an additive npm `overrides` entry to `package.json` forcing `esbuild >=0.25.0`, then regenerated the lockfile with `npm install` (no `npm audit fix --force`, no runtime dependency change). `npm ls esbuild` now resolves every entry to `esbuild@0.28.0` (via both `tsx` and `vitest > vite`), and `npm audit` no longer reports GHSA-67mh-4wv8-2f99. The full verification baseline stayed green after the change: `npm test` 28 files / 278 tests (29 files / 280 tests with the added `tests/dependencySecurity.test.ts` override regression guard), `npm run build` and `npm run check` both succeeded.
- **Status:** Closed / Mitigated for the esbuild advisory. The remaining `vitest`/`vite`/`@vitest/mocker`/`vite-node` findings (which require a forced `vitest@4` major upgrade) are tracked separately under `## Open` and deferred for maintainer approval.
- **Traceability:** `docs/security/dependency-audit-2026-06-04.md`.

### Fake orchestrator returned placeholder assistant text

- **Source:** Chunk 6 worker; replaced during Chunk 15.
- **Severity:** Expected until brainstem integration.
- **Fix:** Added deterministic synthesis from trace outcomes and wired chat responses to status/route/trace evidence instead of receipt-only placeholder text.
- **Status:** Closed for local alpha brainstem; richer semantic synthesis remains tracked as an open product limitation.

### Non-atomic run update then event append

- **Source:** Chunk 5 GLM review.
- **Severity:** Major.
- **Fix:** Added `commitRunTransition` and updated `transitionRun` to use atomic store method. Added regression tests.
- **Status:** Closed for in-memory store; production adapters must implement equivalent atomicity.

### Stale local-MVP docs could mislead agents/contributors

- **Source:** Chunk 0 reviews; follow-up aggressive doc cleanup audit.
- **Severity:** Major planning risk.
- **Fix:** Removed superseded local-MVP and cloud-heavy planning docs, then updated `docs/README.md`, `docs/architecture/rector-0.1.0-architecture.md`, and `.kiro/steering/docs.md` so current source-of-truth docs are the only active guidance.
- **Status:** Closed.

### Open-source project lacked license/community scaffolding

- **Source:** Chunk 1 scope.
- **Severity:** Release blocker.
- **Fix:** Added Apache-2.0 LICENSE, NOTICE, trademarks, contributing, security, CoC, issue/PR templates.
- **Status:** Closed.

## Cloud-Capable Transition Roadmap

This section documents the transition path from a local-only MVP/simulator to a fully functional commercial cloud product using your active stack credits.

### Integration Matrix & Credit Routing

| Service Layer | Cloud Provider | Credit Allocation | Commercial Role |
| --- | --- | --- | --- |
| **Relational Database** | TiDB Cloud | $2,000 | Stores persistent users, conversations, runs, and events. |
| **Unstructured Store** | MongoDB | $3,600 | Stores temporary cache, runs history, and raw context materials. |
| **LLM Inference (Flagship)** | Azure OpenAI | $5,000 | Flagship reasoning (planning, skeptic review, crucible). |
| **LLM Inference (SLM/Fast)** | Cloudflare Workers AI | $10,000 | Runs open-weight models (Llama 3, Phi 3) for fast execution/triage (prioritized initial provider). |
| **LLM Inference (SLM/Fast)** | Together AI | $15,000 | Alternate fast SLM model provider. |
| **Sandbox Execution** | E2B / Depot | $5,000 | Containerized build, test, and command sandbox execution. |
| **Vector Database** | Chroma | $5,000 | Semantic memory search for the truth library. |
| **Keyword Search** | Algolia | $10,000 | Indexes codebase, documentation, and files. |
| **Secrets Management** | Doppler | 3 months free | Safe injection of credentials, API keys, and environment variables. |
| **Observability (Error)** | Sentry | 1 year / 50K errors | Out-of-band error monitoring and diagnostics. |
| **Observability (Product)** | PostHog | $50,000 | Session recording, usage analytics, and feature flags. |
| **Observability (APM)** | DataDog / New Relic | 2 years | Real-time performance profiling and infrastructure metrics. |
| **Workflow Sync** | Linear / Make | 6 months / 240K calls | Issue tracking, escalation tickets, and notification routing. |
| **Testing** | BrowserStack | 1 parallel / 1 year | Automated browser testing of the frontend chat UI. |

### Architectural Transition Path

To successfully transition Rector to a cloud-ready commercial state, the following implementation order must be pursued:

#### 1. Decouple Config Validation from Boot Sequencing (Fix Startup Catch-22)
* **Goal**: Enable starting Rector in `external` mode when credentials are stored only in the browser database (`providerConfigStore` and `secretStore`) rather than hardcoded in the server environment (`process.env`).
* **Implementation**: Modify the server startup block in `src/bin/server.ts` to defer validation of credentials. Check credentials lazily at request time or load them asynchronously from the database at startup, logging a warning rather than crashing with `EXTERNAL_MODE_NO_PROVIDER`.

#### 2. Implement Bring-Your-Own-Key (BYOK) Model Discovery
* **Goal**: Enable users to input their Cloudflare API Token or Together AI API Key and dynamically view and route models.
* **Implementation**: Wire the UI to trigger the `ModelDiscoveryService`. Fetch active models directly from the provider API, and write user preferences (role-to-model mappings) directly to the `.rector/providers.json` config store.

#### 3. Transition from Mock to Real Sandboxed Execution
* **Goal**: Enable executing code patches and shell commands inside containerized environments.
* **Implementation**: In `src/orchestration/sandboxExecutor.ts`, replace the dummy `defaultCommandRunner` with E2B Node SDK instance calls and Depot image builds to run test suites safely inside micro-containers, enforcing strict timeout and memory limits.

#### 4. Replace Diagnostic Traces with Streamed Assistant Prose
* **Goal**: Return human-like answers rather than execution traces to the user.
* **Implementation**: Connect `src/orchestration/synthesizer.ts` to the `ModelRouter` to request a natural language synthesis from the flagship model, instructing it to summarize what was done, what was verified, and what files were modified, referencing the trace drawer metadata only as an option.

#### 5. Implement Vector DB Retrieval and Storage
* **Goal**: Add durable memory storage for truth validation and user preferences.
* **Implementation**: Upgrade `src/memory/` and the truth library to sync documents and transcripts to Chroma DB, using Algolia to back fast keyword indexes.
