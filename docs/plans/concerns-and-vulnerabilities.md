# Rector Concerns and Vulnerabilities Register

> Running register for implementation concerns, security risks, review notes, and deferred fixes discovered while implementing chunks. Keep updated through final chunk.

## Open

### Dependency audit reports vulnerabilities

- **Source:** `npm install` / `npm audit` output during branch setup.
- **Severity:** Unknown; npm reported 5 vulnerabilities (4 moderate, 1 critical).
- **Status:** Open.
- **Plan:** Address in a dedicated dependency/security chunk or before public release. Do not run `npm audit fix --force` blindly because it may introduce breaking changes.

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

- **Source:** Chunk 7 implementation.
- **Severity:** Medium for production deployment.
- **Status:** Open.
- **Plan:** Replace in-memory rate limiting with shared/distributed limiter, add real auth/session enforcement, centralize budget enforcement at provider call boundaries, and harden redaction with structured secret classifiers before public multi-user deployment.

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
