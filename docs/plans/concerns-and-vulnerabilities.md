# Rector Concerns and Vulnerabilities Register

> Running register for implementation concerns, security risks, review notes, and deferred fixes discovered while implementing chunks. Keep updated through final chunk.

## Open

### Dependency audit reports vulnerabilities

- **Source:** `npm install` / `npm audit` output during branch setup; Gemini final audit.
- **Severity:** Medium-high for dev-server exposure; npm reported 5 vulnerabilities (4 moderate, 1 critical). Confirmed known root includes vulnerable `esbuild <=0.24.2` via dev dependencies, associated with DNS rebinding/local dev server exposure (GHSA-67mh-4wv8-2f99).
- **Status:** Open.
- **Plan:** Address in a dedicated dependency/security chunk or before public release. Prefer upgrading `vitest`/`tsx` or adding a safe dependency override for `esbuild >=0.25.0`; do not run `npm audit fix --force` blindly because it may introduce breaking changes.

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
- **Status:** Open until issue catalog generation is integrated into release/CI workflow.
- **Plan:** The issue catalog and generated Markdown drafts are deterministic and checked by `node scripts/generate-roadmap-issues.js --check`, but they are not automatically derived from the roadmap text and do not sync to GitHub or Linear. When roadmap chunks change, maintainers must update `docs/issues/roadmap-issues.json`, regenerate docs, and run the check command. A future release workflow can add CI enforcement or a one-way issue creation tool behind explicit maintainer approval.

## Closed / Mitigated

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

- **Source:** Chunk 0 reviews.
- **Severity:** Major planning risk.
- **Fix:** Added source-of-truth docs/README and stale banners to old docs/specs/implementation-plan files.
- **Status:** Closed.

### Open-source project lacked license/community scaffolding

- **Source:** Chunk 1 scope.
- **Severity:** Release blocker.
- **Fix:** Added Apache-2.0 LICENSE, NOTICE, trademarks, contributing, security, CoC, issue/PR templates.
- **Status:** Closed.
