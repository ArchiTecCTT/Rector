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

### Fake orchestrator returns placeholder assistant text

- **Source:** Chunk 6 worker.
- **Severity:** Expected until cognitive modules/provider chunks.
- **Status:** Open.
- **Plan:** Replace with triage/context/planner/DAG/healing flow in chunks 8-15.

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

## Closed / Mitigated

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
