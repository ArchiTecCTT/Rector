# Rector Full Security/Architecture Audit — 2026-06-15

**Auditor:** Kilo (automated multi-agent audit)
**Scope:** Complete Rector codebase — `src/`, `src/api/`, `src/orchestration/`, `src/security/`, `src/providers/`, `src/memory/`, `src/sandbox/`, `src/store/`, `src/modules/`, `src/public/`, `src/web/`, `src/config/`, `.rector/`, `.env`, dependencies
**Baseline:** Branch `rector-0.3.0-configured-product`, 213 files / 1369 tests passing, `npm audit` 0 vulnerabilities

---

## Executive Summary

Rector demonstrates **security-conscious design at every layer** for a pre-production system. Strengths include AES-256-GCM encrypted secrets, scrypt password hashing with timing-safe comparison, comprehensive output redaction, CSRF protection, sandbox command allowlisting with `shell: false`, Zod schema validation on all inputs, bounded healing loops, budget gates before every LLM call, and deterministic skeptic verdicts that cannot be overridden by LLMs.

However, **8 HIGH-severity** and **28 MEDIUM-severity** findings require remediation before production deployment. The most critical categories are:

1. **Unencrypted data at rest** — SQLite database, memory assignment files, and event logs are not encrypted
2. **Missing security headers** — No Content-Security-Policy or HSTS headers
3. **Information leakage in error responses** — 25+ catch blocks expose raw `err.message` to clients
4. **SSRF via user-configurable provider URLs** — No private-IP validation
5. **File permission gaps on Windows** — `mode: 0o600` has no effect on NTFS
6. **Orchestration resource exhaustion** — No overall timeout, no prompt length cap, unbounded steer queue

---

## Finding Summary

### Severity Distribution

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 0 | No immediate exploitable vulnerabilities |
| HIGH | 8 | Must fix before production |
| MEDIUM | 28 | Should fix before public deployment |
| LOW | 30+ | Defense-in-depth improvements |

---

## HIGH Severity Findings

### H1 — SQLite Database Unencrypted at Rest
- **File:** `src/store/sqlRectorStore.ts:41-62`, `src/store/index.ts:115`
- **Risk:** The default SQLite path `.rector/rector.db` stores all conversation history, messages, run data, and memory entries as unencrypted JSON. Any process/user with filesystem access can read all historical data.
- **Remediation:** Integrate SQLCipher or similar encrypted SQLite extension. Alternatively, rely on OS-level disk encryption and enforce restrictive file permissions (0o600). Document the risk for operators.

### H2 — No File Permission Enforcement on `.rector/` Directory
- **File:** `src/store/index.ts:186-187`, `src/security/secretStore.ts:183-188`
- **Risk:** Directories and files created under `.rector/` inherit the process umask (typically 0022 on Unix), making them world-readable. The encryption key file (`secret.key`) uses `mode: 0o600` but this has **no effect on Windows** (NTFS ACLs are not controlled by Node.js `mode`).
- **Remediation:** Explicitly set `mode: 0o700` on `.rector/` and subdirectories, `0o600` on all files. On Windows, document the limitation and recommend `RECTOR_SECRET_KEY` env injection from a secret manager. Consider Windows ACL API for Windows production deployments.

### H3 — Encryption Key Lifecycle: No Rotation, Weak Windows Protection
- **File:** `src/bin/server.ts:88-113`, `src/security/secretStore.ts`
- **Risk:** The master encryption key (`secret.key`) is auto-generated on first run and never rotated. If the key is compromised, all historical secrets are exposed. On Windows, the key file is not protected by file permissions.
- **Remediation:** Implement key rotation support (re-encrypt all secrets with new key). Consider OS keychain integration for the master key. Enforce file permissions at creation and verify on startup.

### H4 — Missing Content-Security-Policy Header
- **File:** `src/api/server.ts:3757-3761`
- **Risk:** No CSP header means an XSS vulnerability anywhere in the frontend can load external scripts, exfiltrate data, and execute inline scripts without restriction.
- **Remediation:** Add a restrictive CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'`. The `'unsafe-inline'` for scripts is needed for the theme boot script in `index.html`, but a nonce-based approach would be stronger.

### H5 — Error Messages Leak to Clients Without Redaction (25+ instances)
- **Files:** `src/api/server.ts:2216,2238,2297,2535,2678,3708,3728`, `src/api/routes/operator.ts:39,64,83,99,122,131,149,169,179,215`, `src/api/routes/tasks.ts:44,53,63,79,91,105,116,127`
- **Risk:** Catch blocks return `{ error: err.message }` without passing through `redactString()`. Internal paths, SQL details, stack traces, and potentially connection strings could leak to clients.
- **Remediation:** Route ALL error responses through `redactString()`. Some routes already do this correctly (e.g., `runControl.ts:66`, `runApprovals.ts:89-94`); extend the pattern to all catch blocks.

### H6 — SSRF via User-Configurable Provider URLs
- **Files:** `src/providers/llm.ts:202,257,369,621`, `src/memory/chromaMemoryAdapter.ts:220,239`
- **Risk:** Provider `baseUrl` and `endpoint` fields are user-configurable and used directly for outbound HTTP requests. There is no validation against private/internal IP ranges (127.0.0.0/8, 10.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, ::1, fc00::/7).
- **Remediation:** Add URL validation that rejects private/internal IPs and link-local addresses. Validate DNS resolution doesn't resolve to private ranges (DNS rebinding protection). At minimum, validate `http(s)://` prefix and reject known private hostnames.

### H7 — No Body Size Limit Explicitly Configured on `express.json()`
- **File:** `src/api/server.ts:1822`
- **Risk:** `express.json()` uses the default 100KB limit implicitly. This should be explicitly configured and documented. More critically, there is no response body size limit on outbound `fetch` calls to provider APIs — a malicious/compromised provider could send unbounded response data.
- **Remediation:** Add explicit `express.json({ limit: '1mb' })` (or appropriate limit). Add response body size limits on provider `fetch` calls using `AbortController` with byte counting.

### H8 — JSON Payloads in SQLite Not MAC-Protected
- **File:** `src/store/sqlRectorStore.ts:511-513`
- **Risk:** Stored JSON entity payloads use plain `JSON.stringify` without integrity verification. An attacker with database file access can tamper with entity payloads (modify run budgets, inject false memory entries, alter run states) without detection.
- **Remediation:** Add an HMAC field to persisted rows using a server-side key, or use a tamper-evident column. Schema validation on read (already implemented) provides partial protection but cannot detect sophisticated tampering that preserves schema validity.

---

## MEDIUM Severity Findings

### M1 — Windows File Permissions Ineffective (`mode: 0o600`)
- **File:** `src/bin/server.ts:111`
- **Detail:** Unix `mode` has no effect on Windows. The `.rector/secret.key` file is readable by any user with directory access.
- **Remediation:** Document limitation. Recommend `RECTOR_SECRET_KEY` env injection for Windows. Consider Windows ACL API.

### M2 — In-Memory Rate Limiting State
- **File:** `src/api/routes/auth.ts:44`, `src/security/rateLimiter.ts:246-316`
- **Detail:** Rate limit counters are in-process memory. Server resets, horizontal scaling, or load balancing defeats the limits.
- **Remediation:** For production multi-instance, inject a distributed rate limiter (Redis-backed).

### M3 — EventBus Publishes Arbitrary Payloads Without Redaction
- **File:** `src/adapters/eventBus.ts:24`
- **Detail:** `publish(topic, payload)` accepts any payload without redaction. If a caller passes secret material into an event payload, it would be transmitted to all subscribers unsanitized.
- **Remediation:** Add a redaction pass at the publish boundary, or document the contract that callers must never publish secret values.

### M4 — CORS Allows All Localhost Origins in Non-Production
- **File:** `src/api/server.ts:3864-3871`
- **Detail:** `isDevLocalhostOrigin()` allows any `localhost`/`127.0.0.1`/`::1` origin on any port when `NODE_ENV !== "production"`.
- **Remediation:** Ensure `NODE_ENV=production` is always set on non-development deployments. Document this requirement.

### M5 — Missing HSTS Header
- **File:** `src/api/server.ts:3757-3761`
- **Detail:** No `Strict-Transport-Security` header is emitted even when Secure cookies are used.
- **Remediation:** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` when serving over HTTPS in production.

### M6 — Zero-Key Fallback in Test Mode
- **File:** `src/api/server.ts:1835`
- **Detail:** `Buffer.alloc(32)` used as fallback encryption key when no key is supplied. A zero-filled key is trivially guessable.
- **Remediation:** Replace with `randomBytes(32)` as fallback. Even in test mode, a random key is safer.

### M7 — SSE Stream Authorization Is Optional
- **File:** `src/api/server.ts:1007-1018`
- **Detail:** `authorizeRunRead` is optional — when not injected, any client can subscribe to any run's SSE stream by ID.
- **Remediation:** Make `authorizeRunRead` mandatory in `RunStreamHandlerOptions`, defaulting to a deny-all check.

### M8 — Session Secret Lacks Entropy Validation
- **File:** `src/security/auth.ts:83,89-91`
- **Detail:** `RECTOR_AUTH_SESSION_SECRET` is mandatory when auth is enabled, but there is no minimum length/entropy validation. A short or predictable secret enables session forgery.
- **Remediation:** Require at least 32 bytes of entropy (or minimum 44 chars for base64-encoded).

### M9 — innerHTML with Server-Supplied Discovery Data
- **File:** `src/public/app.js:2229`
- **Detail:** Model discovery candidates are rendered via `innerHTML` with string concatenation. A rogue LLM provider returning a model name containing `<script>` would cause XSS.
- **Remediation:** Audit `renderCandidate()` to confirm HTML escaping. Use `document.createElement` + `textContent` instead of innerHTML.

### M10 — Template Import Body Lacks Zod Schema Gate
- **File:** `src/api/routes/templates.ts:53,67`
- **Detail:** `importTemplate(req.body ?? {})` passes raw body to the import function without Zod schema validation.
- **Remediation:** Add a Zod schema gate before the import function call.

### M11 — API Keys Held in Memory as Plaintext Strings
- **Files:** `src/memory/mem0Adapter.ts:155`, `src/memory/chromaMemoryAdapter.ts:207`
- **Detail:** Provider API keys are stored as private string fields for the provider's lifetime. A heap dump or debugger attachment would expose them.
- **Remediation:** Fetch from `SecretStore` on each operation, or zero the field on dispose.

### M12 — No TLS Enforcement for Remote Chroma Connections
- **File:** `src/memory/chromaMemoryAdapter.ts:123-133`
- **Detail:** `validateChromaBaseUrl` accepts both `http:` and `https:` protocols. A remote Chroma server configured with `http://` will receive data and auth tokens over unencrypted transport.
- **Remediation:** Warn or deny non-`https` URLs unless the host is `localhost`/`127.0.0.1`.

### M13 — Default Memory Budget Extremely Permissive
- **File:** `src/memory/defaultRun.ts:4-13`
- **Detail:** Fallback budget allows $100 USD, 10,000 model calls, 1,000,000 tokens. An attacker could invoke unbounded memory operations.
- **Remediation:** Reduce fallback budget significantly (e.g., $0.10, 100 ops) or require explicit run context for all budget-controlled operations.

### M14 — Event Payload Schema Is Unconstrained
- **File:** `src/protocol/events.ts:44`
- **Detail:** `RunEventSchema` payload field accepts `z.record(z.unknown()).default({})` without redaction or size limits. Secrets published in events persist unredacted.
- **Remediation:** Route event payloads through `redactSecrets()` before persistence. Add max-payload-size validation.

### M15 — No Module Signature Verification
- **File:** `src/modules/registry.ts:37-46`
- **Detail:** `ModuleRegistry.register()` accepts any conforming object with no cryptographic signature verification or origin check. A compromised dependency could register a malicious module.
- **Remediation:** Add module manifest signing or restrict registration to the trusted boot-time loader only.

### M16 — No Authorization on Truth Item Mutations
- **File:** `src/memory/truthLibrary.ts:128-143`
- **Detail:** `upsert()` accepts any input without checking who is performing the mutation. A compromised module could inject TRUSTED-status items.
- **Remediation:** Add authorization/provenance checks. Only system/operator actors should set `status: "TRUSTED"`.

### M17 — No Authorization on Assignment Store Mutations
- **File:** `src/providers/memoryAssignmentStore.ts:121-133`
- **Detail:** `upsertAssignment` and `removeAssignment` have no caller-authorization checks at the store layer.
- **Remediation:** Verify API layer enforces RBAC (`memory.configure` permission) before calling store mutations.

### M18 — Shared SQLite DB with Workspace-Only Scoping
- **Files:** `src/security/userStores.ts:31-68`, `src/store/index.ts`
- **Detail:** When multi-user, the `RectorStore` (SQLite) is shared across all users. Conversations are scoped by `workspaceId` but there is no row-level security. A bug in workspace filtering could expose one user's data to another.
- **Remediation:** For production multi-user, implement per-user databases or strict workspace-scoped queries with defense-in-depth checks. Add cross-workspace isolation integration tests.

### M19 — RBAC Bypassed When Auth Disabled
- **File:** `src/security/rbac.ts:129-133`
- **Detail:** When `authEnabled === false`, every request gets `"owner"` role with full permissions. This is intentional for local dev but means the entire authorization layer is bypassed by default.
- **Remediation:** Ensure onboarding clearly communicates security implications. Consider making auth mandatory for network-exposed deployments (non-localhost binds).

### M20 — NEEDS_DECISION State Overly Permissive as Hub
- **File:** `src/orchestration/runStateMachine.ts:50-63`
- **Detail:** `NEEDS_DECISION` can transition to nearly every non-terminal state. An attacker who can call `transitionRun` directly could skip pipeline stages.
- **Remediation:** Enforce at the store layer that transitions from NEEDS_DECISION only return to the originating phase. Make `transitionRun` non-public and route through type-safe wrappers.

### M21 — TOCTOU Race on Phase Transitions
- **File:** `src/orchestration/runStateMachine.ts:75-98`
- **Detail:** `transitionRun` reads current phase, validates, then commits — without atomic compare-and-swap. Concurrent calls could cause race conditions.
- **Remediation:** `commitRunTransition` should verify `fromPhase` matches atomically within a database transaction or use an optimistic lock version field.

### M22 — No Hard Prompt Length Cap at API Boundary
- **File:** `src/orchestration/chatRunner.ts:169`
- **Detail:** The user `prompt` field is not capped at the entry point. An extremely long prompt (e.g., 10MB) could cause memory exhaustion or exceed LLM token limits with cost charged before rejection.
- **Remediation:** Enforce a hard character limit (e.g., 100K chars) at the API boundary before entering orchestration.

### M23 — No Overall Orchestration Timeout
- **File:** `src/orchestration/chatRunner.ts:164-493`
- **Detail:** Individual steps have timeouts (e.g., skeptic: 60s) but the total pipeline has no top-level timeout bounding the entire orchestration.
- **Remediation:** Add a configurable total orchestration timeout (e.g., 10 minutes) using `AbortSignal.timeout()` composed with the interrupt signal.

### M24 — Unbounded SteerQueue Growth
- **File:** `src/orchestration/runControl.ts:74`
- **Detail:** `steerQueue` grows unboundedly. Each `enqueueSteer` call appends a message. A malicious caller can cause unbounded memory growth.
- **Remediation:** Cap `steerQueue` length (e.g., max 20 messages) and reject/drop oldest messages beyond the cap.

### M25 — User Input in JSON Lacks Semantic Isolation from System Instructions
- **File:** `src/orchestration/prompts.ts:144-180, 303-359, 528-644`
- **Detail:** User input is embedded in prompts via `JSON.stringify()`. While JSON encoding provides structural escaping, the user input is NOT semantically isolated from system instructions. A user could craft a message that the LLM might interpret as directives.
- **Remediation:** Use more robust prompt structures that clearly delimit user content from system instructions. Current JSON embedding is acceptable but not perfect against sophisticated injection.

### M26 — Memory Context Allows User-Controlled Injection
- **File:** `src/orchestration/prompts.ts:14-19`
- **Detail:** `sanitizeMemoryContextForPrompt` caps entries to 8 items / 200 chars each and applies `redactString`, but user-controlled memory content (notes) like "IGNORE ALL PREVIOUS INSTRUCTIONS" flows into planner/skeptic/synthesizer prompts.
- **Remediation:** Apply prompt injection heuristics to memory context entries. Detect and strip instruction-like text patterns from memory before injection into prompts.

### M27 — Planner-Controlled Skill Activation
- **File:** `src/orchestration/crucible.ts:263-295`
- **Detail:** A manipulated planner (via prompt injection) could request skill IDs that exist in the catalog. Low-risk skills with met prerequisites would be auto-approved, expanding the LLM's capabilities.
- **Remediation:** Require explicit user confirmation for skill activation, or limit skill activation to skills mentioned in the user's request.

### M28 — Redacted Content Persists Across Compression Generations
- **File:** `src/orchestration/contextCompression.ts:104-145`
- **Detail:** During context compression, redacted forms persist in child conversation context. Patterns like `[REDACTED]@example.com` reveal that an email was discussed.
- **Remediation:** Add optional "scrub compression" mode that replaces all redaction markers with generic placeholders.

---

## Architecture Strengths (Positive Findings)

These are noteworthy security features that are correctly implemented:

1. **AES-256-GCM encrypted secret store** — Atomic writes, authenticated encryption, 32-byte random key
2. **Scrypt password hashing with `timingSafeEqual`** — Per-user salts, 64-byte key length
3. **HMAC-SHA256 signed session tokens** — `HttpOnly`, `SameSite=Lax`, conditional `Secure` flag
4. **Comprehensive redaction layer** — URI credentials, Bearer/Basic tokens, API keys, passwords, connection strings
5. **CSRF protection** — Origin validation for state-changing requests
6. **Sandbox command allowlisting with `shell: false`** — No shell injection, destructive command denylist, metacharacter detection
7. **Zod `.strict()` on all input schemas** — Prevents prototype pollution, extra fields rejected
8. **Parameterized SQL everywhere** — No SQL injection vectors
9. **Secret/config separation** — Config records contain only `secretRef`, never the key value
10. **Budget gates before every LLM call** — Planner, skeptic, preprocessor, repair, synthesizer
11. **Deterministic skeptic verdicts** — LLM cannot override BLOCKER findings; `recomputeSkepticVerdict` derives from severities
12. **Bounded healing loops** — `DEFAULT_MAX_HEALING_ATTEMPTS = 2`, clamped to 1..10
13. **Task decomposition caps** — Sub-goals <= 8, concurrency <= 8, risk-flagged contexts capped to 3
14. **Stable tier mutation detection** — Detects mid-run corruption of system instructions
15. **Atomic file writes everywhere** — Temp file + rename pattern prevents corruption
16. **Audit logging** — IP/UA hashed, reason fields redacted
17. **Login rate limiting** — 5 attempts / 15 min window with audit trail
18. **Duplicate event rejection** — Prevents event replay/injection
19. **User ID sanitization** — Prevents path traversal via user IDs
20. **Core modules cannot be disabled** — Prevents disabling critical security modules
21. **`enableNetwork: false` by default** — All providers require explicit opt-in for network access

---

## Dependency Audit

- **`npm audit`**: 0 vulnerabilities (post-Chunk 37 vitest@4.1.8 upgrade)
- **esbuild GHSA-67mh-4wv8-2f99**: Resolved via npm overrides (`esbuild >=0.28.1`)
- **No `eval()`/`Function()`/`vm.*` usage** found in production code
- **No hardcoded real API keys** found in source (test fixtures use clearly-fake keys for redaction testing)

---

## Remediation Priority Matrix

### Pre-Production Blockers (Must Fix)
1. **H5** — Route all error responses through `redactString()`
2. **H4** — Add Content-Security-Policy header
3. **H2** — Enforce file permissions on `.rector/` directory
4. **H6** — Add private-IP validation on provider URLs (SSRF)
5. **M5** — Add HSTS header for production HTTPS
6. **M8** — Validate session secret entropy

### Pre-Public-Alpha (Should Fix)
7. **H1** — Encrypt SQLite at rest or document OS-level encryption requirement
8. **H3** — Implement encryption key rotation
9. **H7** — Add explicit body size limits and provider response size limits
10. **H8** — Add HMAC integrity to persisted payloads
11. **M22** — Add hard prompt length cap at API boundary
12. **M23** — Add overall orchestration timeout
13. **M24** — Cap steerQueue size
14. **M7** — Make SSE stream authorization mandatory

### Pre-Beta (Nice to Have)
15. **M2** — Distributed rate limiter for multi-instance
16. **M18** — Row-level tenant isolation
17. **M15** — Module signature verification
18. **M16** — Truth item mutation authorization
19. **M25-M27** — Prompt injection hardening
20. All remaining MEDIUM findings

---

## Methodology

- Multi-agent parallel audit across 5 domains: (1) Auth/Secrets, (2) Sandbox/Injection, (3) Orchestration Pipeline, (4) Web UI/Frontend, (5) Memory/Data
- Each agent performed deep source code reading with specific file:line references
- Cross-referenced with existing concerns register
- Validated against `npm audit`, `.gitignore` coverage, and dependency tree
- No network calls were made; all findings are from static source analysis
