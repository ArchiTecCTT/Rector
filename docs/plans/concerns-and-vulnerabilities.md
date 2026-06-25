# Rector Concerns and Vulnerabilities Register

> Running register for implementation concerns, security risks, review notes, and deferred fixes discovered while implementing chunks. Keep updated through final chunk.


## Open

### Full security/architecture audit 2026-06-15 — HIGH findings

- **Source:** Kilo multi-agent security audit (see `audits/security-architecture-audit-2026-06-15.md` for full report).
- **Severity:** High (8 findings).
- **Status:** **RESOLVED** (all 8 findings fully resolved in Chunk 049).
- **Audit baseline:** `npm test` 213 files / 1369 tests passing, `npm audit` 0 vulnerabilities.
- **Post-fix baseline:** `npm test` 309 files / 2105+ tests passing, `npm audit` 0 vulnerabilities.

#### H1 — SQLite database unencrypted at rest — RESOLVED
- **File:** `src/store/sqlRectorStore.ts:41-62`, `src/store/index.ts:115`
- **Risk:** Default SQLite path `.rector/rector.db` stores conversation history, messages, run data, and memory entries as unencrypted JSON. Any process/user with filesystem access can read all historical data.
- **Resolution:** AES-256-GCM encryption at rest with `ENC1:` prefix; backward-compatible plaintext reads for legacy DBs; `RECTOR_DB_ENCRYPTION` env var (default true when key available, auto-detects legacy DBs); HKDF-derived key from master secret with info `"rector.db-encryption.v1"`.
- **Code reference:** `src/store/sqlRectorStore.ts` (serialize/deserialize), `src/bin/server.ts` (deriveDbEncryptionKey/shouldEnableDbEncryption), `src/store/index.ts` (encryptionKey wired through store construction), `src/api/server.ts` (dbEncryptionKey in ApiSecurityOptions).
- **Test reference:** `tests/sqlEncryption.test.ts` (12 tests: encryption roundtrip, raw prefix, plaintext baseline, backward compat, missing key, wrong key, HKDF derivation, update operations).

#### H2 — No file permission enforcement on .rector/ directory — RESOLVED
- **File:** `src/store/index.ts:186-187`, `src/security/secretStore.ts:183-188`
- **Risk:** Directories and files created under `.rector/` inherit the process umask (typically 0022 on Unix), making them world-readable. The encryption key file (`secret.key`) uses `mode: 0o600` but this has no effect on Windows (NTFS ACLs are not controlled by Node.js mode).
- **Resolution:** All `mkdir`/`mkdirSync` calls replaced with `ensureRestrictedDir()` (0o700 POSIX, icacls on Windows); all sensitive file writes followed by `ensureRestrictedFile()`; `fixExistingDirPermissions()` on server startup for upgrade path; 10 files updated across store, security, providers, config, and modules.
- **Code reference:** `src/security/filePermissions.ts` (ensureRestrictedDir/ensureRestrictedFile/fixExistingDirPermissions), `src/bin/server.ts`, `src/security/secretStore.ts`, `src/providers/configStore.ts`, `src/providers/memoryConfigStore.ts`, `src/providers/orchestrationAssignments.ts`, `src/providers/memoryAssignmentStore.ts`, `src/config/runtimeSettings.ts`, `src/security/auditLog.ts`, `src/modules/moduleConfigStore.ts`.
- **Test reference:** `tests/filePermissions.test.ts` (10 tests: POSIX/win32 paths, best-effort icacls failure, all three functions).

#### H3 — Encryption key lifecycle: no rotation, weak Windows protection — RESOLVED
- **File:** `src/bin/server.ts:93`, `src/security/secretStore.ts`
- **Risk:** Master encryption key (`secret.key`) is auto-generated on first run and never rotated. If compromised, all historical secrets are exposed. On Windows, the key file is not protected by file permissions.
- **Resolution:** Key rotation CLI (`src/bin/rotate-key.ts`) reads old key, generates new key, re-encrypts all envelopes, atomically writes new v2 key file; v2 JSON format `{ key, version, createdAt }` with backward-compatible v1 hex read; best-effort DPAPI protection on Windows; `RECTOR_ROTATE_KEY_ON_BOOT` for automated rotation; `listSecretIds()` added to SecretStore interface.
- **Code reference:** `src/bin/rotate-key.ts`, `src/bin/server.ts` (writeSecretKeyFile/applyDpapiProtection/performKeyRotation), `src/security/secretStore.ts` (listSecretIds).
- **Test reference:** `tests/keyRotation.test.ts` (16 tests: listSecretIds, rotation re-encrypt, old key fails, empty store, partial failure, v1/v2 format, RECTOR_ROTATE_KEY_ON_BOOT, DPAPI protection).

#### H4 — Missing Content-Security-Policy header — RESOLVED
- **File:** `src/api/server.ts:3757-3761`
- **Risk:** No CSP header means an XSS vulnerability anywhere in the frontend can load external scripts, exfiltrate data, and execute inline scripts without restriction.
- **Resolution:** Full CSP header with 10 directives (`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `font-src 'self'`, `img-src 'self' data:`, `connect-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`, `object-src 'none'`); HSTS in production mode with env var configurability; inline `<script>` moved to external `boot.js`.
- **Code reference:** `src/api/server.ts` (securityHeadersMiddleware CSP/HSTS), `src/public/boot.js` (extracted theme boot), `src/public/index.html` (external script reference).
- **Test reference:** `tests/cspHeaders.test.ts` (9 tests: CSP directive parsing, HSTS absence in non-production, baseline headers, HSTS env var combinations).

#### H5 — Error messages leak to clients without redaction (25+ instances) — RESOLVED
- **Files:** `src/api/server.ts:2216,2238,2297,2535,2678,3708,3728`, `src/api/routes/operator.ts:39,64,83,99,122,131,149,169,179,215`, `src/api/routes/tasks.ts:44,53,63,79,91,105,116,127`
- **Risk:** Catch blocks return `{ error: err.message }` without passing through `redactString()`. Internal paths, SQL details, stack traces, and potentially connection strings could leak to clients.
- **Resolution:** All 25 `res.status(N).json({ error: err.message })` instances replaced with `sendRedactedRouteError(sendRedacted, res, N, err)` or `sendRedacted(res, N, { error: redactString(errorMessageOf(err)) })`; defense-in-depth Express error middleware added as safety net.
- **Code reference:** `src/api/server.ts` (7 replacements + error middleware), `src/api/routes/operator.ts` (10 replacements), `src/api/routes/tasks.ts` (8 replacements), `src/api/routes/routeError.ts` (sendRedactedRouteError helper).
- **Test reference:** `tests/api.test.ts` (17 tests), `tests/authApi.test.ts` + `tests/chatApi.test.ts` (26 tests combined).

#### H6 — SSRF via user-configurable provider URLs — RESOLVED
- **Files:** `src/providers/llm.ts:202,257,369,621`, `src/memory/chromaMemoryAdapter.ts:220,239`
- **Risk:** Provider `baseUrl` and `endpoint` fields are user-configurable and used directly for outbound HTTP requests. No validation against private/internal IP ranges.
- **Resolution:** `validateProviderUrl()` checks protocol, blocked hostnames (metadata endpoints), private IP ranges (loopback, RFC1918, link-local, CGNAT, current-network), DNS resolution for hostnames; lightweight non-production checks (blocked hostnames + raw private IP literals only, no DNS); local-dev bypass for localhost/127.0.0.1/::1 in non-production; applied in all 4 provider `invoke()` methods and Chroma `validateChromaBaseUrl()`.
- **Code reference:** `src/security/ssrfProtection.ts` (validateProviderUrl/PRIVATE_RANGES/BLOCKED_HOSTNAMES/isPrivateIp), `src/providers/llm.ts` (validateProviderUrlForSsrf in 4 providers), `src/memory/chromaMemoryAdapter.ts` (async validateChromaBaseUrl with SSRF).
- **Test reference:** `tests/ssrfProtection.test.ts` (36 tests: PRIVATE_RANGES, BLOCKED_HOSTNAMES, protocol checks, blocked hostnames, private IPv4/IPv6, public IPs, DNS resolution).

#### H7 — No explicit body size limit; no provider response size limit — RESOLVED
- **File:** `src/api/server.ts:1822`, `src/providers/llm.ts:293,443,589,717`
- **Risk:** `express.json()` uses the default 100KB limit implicitly. No response body size limit on outbound `fetch` calls to provider APIs — a malicious/compromised provider could send unbounded response data.
- **Resolution:** Explicit `express.json({ limit: "1mb" })`; `DEFAULT_MAX_PROVIDER_RESPONSE_BYTES = 5MB`; Content-Length pre-check in `fetchWithAbort()`; bounded byte-counting stream wrapper that aborts at limit; `PROVIDER_RESPONSE_TOO_LARGE` error code; all 4 provider `invoke()` methods pass `maxResponseBytes`.
- **Code reference:** `src/api/server.ts` (express.json limit), `src/providers/llm.ts` (DEFAULT_MAX_PROVIDER_RESPONSE_BYTES, fetchWithAbort maxResponseBytes, Content-Length pre-check, bounded stream consumption).
- **Test reference:** `tests/sizeLimits.test.ts` (9 tests: constant value, error code, Content-Length pre-check, bounded stream rejection, explicit maxResponseBytes passing).

#### H8 — JSON payloads in SQLite not MAC-protected — RESOLVED
- **File:** `src/store/sqlRectorStore.ts:511-513`
- **Risk:** Stored JSON entity payloads use plain `JSON.stringify` without integrity verification. An attacker with database file access can tamper with payloads without detection.
- **Resolution:** HMAC-SHA256 MAC per row with `mac TEXT` column; `macKey` derived from master secret via `"rector.payload-mac.v1"`; `timingSafeEqual` verification on read; legacy rows without MAC produce warning and proceed (backward compat); idempotent `ALTER TABLE ... ADD COLUMN mac TEXT` migration.
- **Code reference:** `src/security/payloadIntegrity.ts` (deriveMacKey/computePayloadMac/verifyPayloadMac), `src/store/sqlRectorStore.ts` (macKey option, mac column, insertRow/updateRow/parsePayload MAC handling), `src/bin/server.ts` (derivePayloadMacKey), `src/store/index.ts` (macKey wired through), `src/api/server.ts` (dbMacKey option).
- **Test reference:** `tests/payloadMac.test.ts` (18 tests: MAC stored on insert, MAC updated, tamper detection payload/MAC swap, legacy rows, combined encryption+MAC, commitRunTransition MAC), `tests/payloadIntegrity.test.ts` (12 tests: deriveMacKey, computePayloadMac, verifyPayloadMac).

- **Traceability:** `audits/security-architecture-audit-2026-06-15.md`.

### Full security/architecture audit 2026-06-15 — MEDIUM findings

- **Source:** Kilo multi-agent security audit.
- **Severity:** Medium (28 findings).
- **Status:** **RESOLVED** (26 fully resolved, 2 accepted with documented residual risk in Chunk 049).
- **Remediation priority:** Pre-production blockers first, then pre-public-alpha, then pre-beta.

| ID | Finding | File:Line | Status | Resolution | Code reference | Test reference |
|---|---------|-----------|--------|------------|----------------|----------------|
| M1 | Windows file permissions ineffective (mode: 0o600) | `src/bin/server.ts:111` | **RESOLVED** | icacls on Windows via ensureRestrictedFile; part of H2 fix | `src/security/filePermissions.ts` | `tests/filePermissions.test.ts` (10 tests) |
| M2 | In-memory rate limiting state (not distributed) | `src/api/routes/auth.ts:44`, `src/security/rateLimiter.ts:246-316` | **RESOLVED** | RedisRateLimiter with `rate-limiter-flexible` + `ioredis`; `RECTOR_REDIS_URL` env var; fallback to InMemoryRateLimiter with warning | `src/security/rateLimiter.ts` (RedisRateLimiter/createRateLimiterFromEnv), `src/bin/server.ts` | `tests/redisRateLimiter.test.ts` (9 tests) |
| M3 | EventBus publishes arbitrary payloads without redaction | `src/adapters/eventBus.ts:24` | **RESOLVED** | `publishRedacted()` calls `redactSecrets()` before dispatch; SSE/streaming boundaries use `publishRedacted`; internal orchestration keeps `publish` | `src/adapters/eventBus.ts` (publishRedacted), `src/api/server.ts` (withEventBroadcast) | `tests/adapters.test.ts` (4 publishRedacted tests) |
| M4 | CORS allows all localhost origins in non-production | `src/api/server.ts:3864-3871` | **RESOLVED** | `DEV_LOCALHOST_PORTS` set restricts to known dev ports (3000,3001,5173,5174,4173,8080,8081); `CORS_DEV_LOCALHOST_ENABLED` env var; portless localhost rejected unless HTTPS | `src/api/server.ts` (isDevLocalhostOrigin/DEV_LOCALHOST_PORTS) | `tests/api.test.ts` (17 tests) |
| M5 | Missing Strict-Transport-Security (HSTS) header | `src/api/server.ts:3757-3761` | **RESOLVED** | HSTS added in production mode with configurable `HSTS_MAX_AGE`, `HSTS_INCLUDE_SUB_DOMAINS`, `HSTS_PRELOAD` env vars; part of H4 CSP fix | `src/api/server.ts` (securityHeadersMiddleware HSTS) | `tests/cspHeaders.test.ts` (9 tests) |
| M6 | Zero-key fallback in test mode (Buffer.alloc(32)) | `src/api/server.ts:1835` | **RESOLVED** | Explicit logic: provided key used; auth enabled without key throws; else warn + use zero-key only for unauthenticated local dev | `src/api/server.ts` | Existing tests pass explicit keys |
| M7 | SSE stream authorization is optional | `src/api/server.ts:1007-1018` | **RESOLVED** | `defaultDenyAuthorizeRunRead()` returns 403 by default; `authorizeRunRead ?? defaultDenyAuthorizeRunRead` | `src/api/server.ts` (defaultDenyAuthorizeRunRead) | `tests/api.test.ts`, streaming tests |
| M8 | Session secret lacks entropy validation | `src/security/auth.ts:83,89-91` | **RESOLVED** | `validateSessionSecretEntropy()` throws on <32 chars or <8 unique chars with hint; `checkSessionSecretEntropy()` returns warning for readiness; called from `parseAuthConfig()` | `src/security/auth.ts` (validateSessionSecretEntropy/checkSessionSecretEntropy), `src/deployment/readiness.ts` | `tests/sessionSecretEntropy.test.ts` (19 tests) |
| M9 | innerHTML with server-supplied discovery data | `src/public/app.js:2229` | **RESOLVED** | Replaced `renderCandidate()` with `buildCandidateElement()` using `createElement`/`appendChild`/`DocumentFragment`; `textContent` for dynamic values | `src/public/app.js` (buildCandidateElement) | `tests/renderedCandidateDetail.property.test.ts` (1 property, 200 runs) |
| M10 | Template import body lacks Zod schema gate | `src/api/routes/templates.ts:53,67` | **RESOLVED** | `TemplateImportBodySchema` with `z.string().min(1).max(1_000_000) | z.record(z.unknown())`; safeParse before importTemplate; invalid body returns 400 | `src/api/routes/templates.ts` (TemplateImportBodySchema) | `tests/templateApi.test.ts` |
| M11 | API keys held in memory as plaintext strings | `src/memory/mem0Adapter.ts:155`, `src/memory/chromaMemoryAdapter.ts:207` | **RESOLVED** | `apiKey: string` changed to `apiKeyBuffer: Buffer`; `zeroKey()` fills with zeros; called in `close()`/`destroy()`; JSDoc notes V8 limitation | `src/memory/mem0Adapter.ts`, `src/memory/chromaMemoryAdapter.ts`, `src/providers/llm.ts` (4 providers) | `tests/llmProviders.test.ts`, `tests/mem0Adapter.test.ts`, `tests/chromaAdapter.test.ts` |
| M12 | No TLS enforcement for remote Chroma connections | `src/memory/chromaMemoryAdapter.ts:123-133` | **RESOLVED** | Reject `http:` for non-localhost hostnames; allow `http:` for localhost/127.0.0.1/::1/0.0.0.0; `RECTOR_ALLOW_HTTP_CHROMA` override for air-gapped networks | `src/memory/chromaMemoryAdapter.ts` (validateChromaBaseUrl/CHROMA_LOCALHOST_HOSTNAMES) | `tests/chromaTlsEnforcement.test.ts` (16 tests) |
| M13 | Default memory budget extremely permissive ($100/1M tokens) | `src/memory/defaultRun.ts:4-13` | **RESOLVED** | Tightened: maxUsd 10, maxInputTokens/maxOutputTokens 500K, maxModelCalls 1000, maxHealingAttempts 10, approvalRequiredAboveUsd 1 | `src/memory/defaultRun.ts` | No direct test imports (all tests use explicit budgets) |
| M14 | Event payload schema unconstrained (no redaction/size limit) | `src/protocol/events.ts:44` | **RESOLVED** | Max 50 keys, max key length 128, no undefined values (stripped via transform), max 100KB serialized size | `src/protocol/events.ts` (RunEventSchema.payload) | `tests/adapters.test.ts` (10 payload constraint tests) |
| M15 | No module signature verification | `src/modules/registry.ts:37-46` | **RESOLVED** | `verifyModuleSignature()` using Ed25519 (`node:crypto.verify`); `RECTOR_MODULE_PUBLIC_KEY` env var; unsigned modules restricted (no onBoot hooks) when key configured | `src/modules/manifest.ts` (signature field), `src/modules/registry.ts` (verifyModuleSignature/getModulePublicKey/isSignatureVerified) | `tests/moduleSignature.test.ts` (17 tests) |
| M16 | No authorization on truth item mutations | `src/memory/truthLibrary.ts:128-143` | **RESOLVED** | `authorizingTruthLibrary(library, subject)` decorator; checks `truth.mutate` permission; no subject = backward compat; auth disabled = allow | `src/memory/truthLibrary.ts` (TruthLibrary interface/AuthorizationError/authorizingTruthLibrary), `src/security/rbac.ts` (truth.mutate permission) | `tests/truthLibraryAuth.test.ts` (12 tests) |
| M17 | No authorization on assignment store mutations | `src/providers/memoryAssignmentStore.ts:121-133` | **RESOLVED** | `AuthorizingMemoryAssignmentStore` + `AuthorizingOrchestrationAssignmentStore` decorators; check `providers.configure` permission | `src/providers/memoryAssignmentStore.ts`, `src/providers/orchestrationAssignments.ts` | `tests/assignmentStoreAuth.test.ts` (26 tests) |
| M18 | Shared defaultStores when auth disabled (all stores share the same in-memory/SQLite instance when auth is off) | `src/security/userStores.ts:31-68` | **ACCEPTED (mitigated)** | Framing corrected from "shared SQLite DB" to "shared defaultStores when auth disabled"; inherent to single-user local mode; `warnIfAuthDisabledInProduction()` logs warning | `src/security/rbac.ts` (warnIfAuthDisabledInProduction) | `tests/auth.test.ts` |
| M19 | RBAC bypassed when auth disabled | `src/security/rbac.ts:129-133` | **ACCEPTED (mitigated)** | Accepted by design for local mode; production warning added via `warnIfAuthDisabledInProduction()` | `src/security/rbac.ts` (warnIfAuthDisabledInProduction) | `tests/auth.test.ts` |
| M20 | NEEDS_DECISION state overly permissive as hub | `src/orchestration/runStateMachine.ts:50-63` | **RESOLVED** | Reduced from 12 to 5 allowed transitions: EXECUTING, SYNTHESIZING, PLANNING, FAILED, ABORTED | `src/orchestration/runStateMachine.ts` | `tests/needsDecisionRestriction.test.ts` (16 tests), `tests/runStateMachine.test.ts` |
| M21 | TOCTOU race on phase transitions | `src/orchestration/runStateMachine.ts:75-98` | **RESOLVED** | Optimistic concurrency: `version` field in RunSchema; compare-and-swap in `commitRunTransition()`; `ConcurrentTransitionError` with retry (max 3); `WHERE version = expectedVersion` in SQL | `src/orchestration/runStateMachine.ts` (ConcurrentTransitionError/maxTransitionRetries), `src/store/sqlRectorStore.ts` (WHERE version), `src/store/inMemoryRectorStore.ts` (CAS) | `tests/optimisticConcurrency.test.ts` (14 tests) |
| M22 | No hard prompt length cap at API boundary | `src/orchestration/chatRunner.ts:169` | **RESOLVED** | `MAX_MESSAGE_CONTENT_LENGTH = 100_000`; 413 response on exceed; `MessageSchema.content` capped via `z.string().max(100_000)` | `src/store/schemas.ts` (MAX_MESSAGE_CONTENT_LENGTH/MessageSchema), `src/api/server.ts` (413 check) | `tests/messageLengthCap.test.ts` (5 tests) |
| M23 | No overall orchestration timeout | `src/orchestration/chatRunner.ts:164-493` | **RESOLVED** | `DEFAULT_MAX_ORCHESTRATION_RUNTIME_MS = 30 min`; `AbortController` with `setTimeout`; on timeout leads to FAILED; configurable via `runtimeSettings.orchestration.maxRuntimeMs` | `src/orchestration/chatRunner.ts` (runOrchestratedChatRun timeout), `src/config/runtimeSettings.ts` (OrchestrationSettingsSchema) | `tests/orchestrationTimeout.test.ts` (8 tests) |
| M24 | Unbounded steerQueue growth | `src/orchestration/runControl.ts:74` | **RESOLVED** | `MAX_STEER_QUEUE_SIZE = 20`; FIFO eviction via `shift()` with `console.warn` on drop | `src/orchestration/runControl.ts` (enqueueSteer/MAX_STEER_QUEUE_SIZE) | `tests/steerQueueBounds.test.ts` (9 tests) |
| M25 | User input in JSON lacks semantic isolation from system instructions | `src/orchestration/prompts.ts:144-180` | **RESOLVED** | `wrapUserInput()` wraps in `<user_input>` XML tags; isolation instruction appended to all 4 system rule arrays | `src/orchestration/prompts.ts` (wrapUserInput/PROMPT_ISOLATION_INSTRUCTION) | `tests/promptIsolation.test.ts` (20 tests) |
| M26 | Memory context allows user-controlled prompt injection | `src/orchestration/prompts.ts:14-19` | **RESOLVED** | `wrapMemoryContext()` wraps in `<memory_context type="untrusted">` XML tags; isolation instruction appended | `src/orchestration/prompts.ts` (wrapMemoryContext/PROMPT_ISOLATION_INSTRUCTION) | `tests/promptIsolation.test.ts` (20 tests) |
| M27 | Residual risk: skill activation gated by crucible with caps, catalog lookup, high-risk gate, and prerequisite checks | `src/orchestration/crucible.ts:263-295` | **ACCEPTED (mitigated)** | Reclassified from "capability escalation via prompt injection" to "residual risk mitigated by existing controls"; crucible gates, caps, catalog lookup, high-risk gate, prerequisite checks remain as mitigation | `src/orchestration/crucible.ts:263-295` | Existing crucible tests |
| M28 | Redacted content persists across compression generations | `src/orchestration/contextCompression.ts:104-145` | **RESOLVED** | `redactString()` applied to inlineContext carry-forward and artifact handle summaries; `verifyCompressedOutput()` scans for 7 known secret patterns post-compression | `src/orchestration/contextCompression.ts` (redaction in carry-forward + verifyCompressedOutput) | `tests/compressionRedaction.test.ts` (13 tests) |

- **Traceability:** `audits/security-architecture-audit-2026-06-15.md`.

### Full security/architecture audit 2026-06-15 — confirmed architecture strengths

The audit confirmed the following security features are correctly implemented:

1. AES-256-GCM encrypted secret store with atomic writes
2. Scrypt password hashing with timingSafeEqual (per-user salts, 64-byte key length)
3. HMAC-SHA256 signed session tokens (HttpOnly, SameSite=Lax, conditional Secure)
4. Comprehensive redaction layer (URI credentials, Bearer/Basic tokens, API keys, passwords, connection strings)
5. CSRF protection via Origin validation for state-changing requests
6. Sandbox command allowlisting with `shell: false`, destructive command denylist, metacharacter detection
7. Zod `.strict()` on all input schemas (prevents prototype pollution)
8. Parameterized SQL everywhere (no SQL injection vectors)
9. Secret/config separation (config records contain only secretRef, never key value)
10. Budget gates before every LLM call (planner, skeptic, preprocessor, repair, synthesizer)
11. Deterministic skeptic verdicts (LLM cannot override BLOCKER findings)
12. Bounded healing loops (DEFAULT_MAX_HEALING_ATTEMPTS = 2, clamped to 1..10)
13. Task decomposition caps (sub-goals <= 8, concurrency <= 8, risk-flagged capped to 3)
14. Stable tier mutation detection (detects mid-run corruption of system instructions)
15. Atomic file writes everywhere (temp file + rename pattern)
16. Audit logging with hashed IP/UA and redacted reason fields
17. Login rate limiting (5 attempts / 15 min with audit trail)
18. Duplicate event rejection (prevents event replay/injection)
19. User ID sanitization (prevents path traversal via user IDs)
20. Core modules cannot be disabled
21. enableNetwork: false by default on all providers
22. npm audit: 0 vulnerabilities; no eval()/Function()/vm.* usage in production code

### Chunk 048 configured product readiness and gating (G1)

- **Source:** Chunk 048 product model hardening.
- **Severity:** Low (mitigated).
- **Status:** Resolved / Closed.
- **Root cause:** Conversation creation was previously ungated, which allowed unconfigured clients to bypass the first-run onboarding screen via API calls.
- **Plan / Mitigations:** Gate both conversation creation (`POST /api/chat/conversations`) and message creation on setup readiness (returning `409 SETUP_REQUIRED` when unconfigured). Verified via unit tests (`tests/productGate.test.ts`) and end-to-end integration tests (`tests/productModel.integration.test.ts`).
- **Traceability:** `src/api/server.ts`, `tests/productGate.test.ts`, `tests/productModel.integration.test.ts`.

### Chunk 048 deprecation of ORCHESTRATOR_MODE in runtime paths (G3)

- **Source:** Chunk 048 product model hardening.
- **Severity:** Low (mitigated).
- **Status:** Resolved / Closed.
- **Root cause:** Boot routing previously checked environment variables directly instead of the authoritative `runtime-settings.json` file.
- **Plan / Mitigations:** Remove `ORCHESTRATOR_MODE` checks from active server boot sequence. It remains only for one-time legacy migration in `ensureRuntimeSettings()`. Post-migration startup router and sandbox adapter check `runtime-settings.json`'s `orchestrationProfile`.
- **Traceability:** `src/bin/server.ts`.

### Chunk 048 TogetherAIProvider HTTP integration smoke tests (G5)

- **Source:** Chunk 048 product model hardening.
- **Severity:** Low (mitigated).
- **Status:** Resolved / Closed.
- **Root cause:** TogetherAIProvider network calls are disabled in default CI, meaning the real HTTP request serialization, headers, response parsing, and error-retryable mapping code paths lacked integration test coverage.
- **Plan / Mitigations:** Added an integration test (`tests/providerSmoke.test.ts`) utilizing Node's built-in `http.createServer` to spin up a local mock server. Verifies that headers, request shape, token usage parsing, and retryable/non-retryable HTTP error mappings are correct on the live fetch path without hitting real external API endpoints.
- **Traceability:** `tests/providerSmoke.test.ts`, `src/providers/llm.ts`.

### Local performance baseline thresholds are advisory until history exists

- **Source:** Performance baseline benchmark (`scripts/performance-baseline.ts`).
- **Severity:** Low/medium — measurement exists, but production performance readiness is not claimed from local in-process timings alone.
- **Status:** Open (monitoring).
- **Root cause:** After Chunks 042–046 the codebase is large (orchestration hardening, assignment stores, templates, RBAC, expanded test suite). We need repeatable evidence before refactoring for speed, but a single developer-machine run cannot define production SLOs.
- **Plan / Mitigations:** Run `npm run benchmark:performance` locally or in CI for trend tracking (after `npm run build` so compiled cold-start and dist-backed probes are available). Thresholds in `docs/benchmarks/performance-baseline.md` are advisory unless `--enforce` is passed. Cold subprocess startup (`startup_cold_subprocess` tsx + `startup_cold_compiled_subprocess` node/dist) supplements warm in-process import timing. Pipeline phase rows (`pipeline_*`) break down `local_fake_pipeline` for regression targeting. Do not claim VPS/cloud performance readiness until multi-machine baseline history and hosted smoke timings exist.
- **Traceability:** `docs/benchmarks/performance-baseline.md`, `scripts/performance-baseline.ts`, `scripts/performance-baseline-cold-start.ts`, `scripts/performance-baseline-cold-start-compiled.mjs`, `tests/performanceBaseline.test.ts`, `package.json` (`benchmark:performance`).

> Updated during full system audit 2026-06-09 (subagents used; see audits/full-system-audit-2026-06-09.md); follow-up register cleanup 2026-06-10 after Gemini-led test fixes + neuro chunk commits (now 1241 tests green). See audit report for original matrix + evidence.
>
> 2026-06-12 042f stitch note: Chunks 042a-046 are merged on `work/042-046-stitch`; verification passed with `npm run build`, `npm test` (265 files / 1575 tests passed, 5 skipped), and `npm audit` (0 vulnerabilities). The table below supersedes older historical statuses where they conflict.

### Chunk 047a deterministic compression is safe for CI but lossy for production-quality context reduction

- **Source:** Chunk 047a tiered prompt assembly and compression lineage.
- **Severity:** Medium for long, high-context production conversations; low for deterministic spy CI.
- **Status:** Open / accepted for 047a.
- **Root cause:** Oversized context is summarized by deterministic truncation/bullet extraction so `npm test` stays network-free with `SpyLLMProvider` and in-memory stores. This preserves redaction and lineage but can drop nuance that a configured live summarizer may retain.
- **Plan / Mitigations:** Keep deterministic summarization as the default test-safe path. Add a configured, budget-aware live summarizer only after provider resilience and run-control semantics are in place; never call it in default CI. Chunk 047e should make compression lineage visible in the conversation UI so users can inspect parent/child context boundaries.
- **Traceability:** `docs/plans/chunks/047a-tiered-prompt-assembly.md`, `src/orchestration/contextCompression.ts`, `src/orchestration/promptTiers.ts`, `tests/contextCompression.test.ts`, `tests/promptTiers.test.ts`.

### Chunk 047a prompt tier stability is run-scoped, not assignment-scoped

- **Source:** Chunk 047a stable/context/volatile prompt assembly.
- **Severity:** Low/medium.
- **Status:** Open / expected behavior.
- **Root cause:** Stable tier hashes are enforced within a single run. A future model/template/assignment change between runs can legitimately change the stable tier contract, but there is not yet a product UX indicator explaining that distinction.
- **Plan / Mitigations:** Treat mid-run stable tier mutation as blocked. Record tier budget/compression events in traces, and add assignment/lineage visibility in later 047 chunks so operators can tell whether a prompt contract changed because of a deliberate configured assignment change.
- **Traceability:** `src/orchestration/promptTiers.ts`, `src/orchestration/prompts.ts`, `src/orchestration/chatRunner.ts`, `tests/promptTiers.test.ts`.

### Chunk 047b tool registry centralizes dispatch but still needs production ACL and sandbox readiness hardening

- **Source:** Chunk 047b tool registry and executor middleware.
- **Severity:** Medium for production extensibility and sandbox execution; low for current builtin-only CI coverage.
- **Status:** Open / accepted for 047b.
- **Root cause:** The builtin registry is an explicit TypeScript list, so new executor tools require manual catalog updates. Module-provided tools can register through `ModuleBootContext.toolRegistry`, but their ACL/review model is still minimal. The sandbox environment selector defaults to the safe `stub` path, while real `local`/`e2b` execution still depends on readiness checks, approvals, and future UI configuration polish.
- **Plan / Mitigations:** Keep `/api/tools` read-only and builtin-filtered for now, fail closed on unknown/unavailable tools, require middleware approval gates for write/destructive tools, and keep module tools unavailable when their module is disabled. Future chunks should add module tool ACL review, per-tool readiness diagnostics, and E2B network/isolation smoke tests behind explicit configured-product setup.
- **Traceability:** `docs/plans/chunks/047b-tool-registry-executor.md`, `src/tools/*`, `src/orchestration/sandboxExecutor.ts`, `tests/toolRegistry.test.ts`, `tests/toolMiddleware.test.ts`, `tests/sandboxExecutorRegistry.integration.test.ts`, `tests/toolsApi.test.ts`.

### Chunk 047c run control is in-memory and cooperative

- **Source:** Chunk 047c interrupt, steer, and turn-budget implementation.
- **Severity:** Medium for hosted/multi-instance deployments; low for current single-process local/product preview.
- **Status:** Open / accepted for 047c.
- **Root cause:** Run control state is process-local and cancellation is cooperative. Interrupts trip the registered abort signal and are observed by provider, sandbox, executor, and healing boundaries, but a multi-process deployment would need shared run-control state. Already-spawned local commands may also take a short time to terminate, depending on the command runner and OS behavior.
- **Plan / Mitigations:** Keep operator and user routes delegated to shared `interruptRun` / `steerRun`, emit `RUN_INTERRUPT_REQUESTED`, `RUN_STEER_ENQUEUED`, and `RUN_BUDGET_EXHAUSTED` events for auditability, and treat stop as best-effort cooperative cancellation until distributed run state and stronger sandbox process supervision land. Future hosted work should back run control with the durable run/event store or a shared coordinator.
- **Traceability:** `docs/plans/chunks/047c-run-control-budget.md`, `src/orchestration/runControl.ts`, `src/orchestration/turnBudget.ts`, `src/api/routes/runControl.ts`, `src/orchestration/sandboxExecutor.ts`, `src/tools/middleware.ts`, `tests/runControl.test.ts`, `tests/runControlApi.test.ts`, `tests/runInterrupt.integration.test.ts`, `tests/runSteer.integration.test.ts`.

### Chunk 047d user-supplied skills are prompt material, not trusted code

- **Source:** Chunk 047d procedural memory / skills catalog.
- **Severity:** Medium for prompt-injection and stale-procedure risk; low for bundled low-risk skills.
- **Status:** Open / accepted for 047d.
- **Root cause:** `.rector/skills/` files are user-supplied procedural text. The catalog is read-only and crucible-gated, but approved skill bodies still become prompt context and can contain stale or adversarial instructions.
- **Plan / Mitigations:** Keep skills passive: no automatic execution, no network install, and no file writes from the catalog. Crucible denies unknown skills, enforces a max activation cap, blocks high-risk skills without approval gates, and emits redacted skill activation events. Context injection is limited to approved skill IDs and capped by `maxSkillContextChars`. Future chunks should add stronger provenance/signature checks and skill write-guard scanning before marketplace/import support.
- **Traceability:** `docs/plans/chunks/047d-procedural-memory-skills.md`, `src/memory/skillsCatalog.ts`, `src/orchestration/crucible.ts`, `src/orchestration/contextBuilder.ts`, `tests/skillsCatalog.test.ts`, `tests/skillCrucible.integration.test.ts`.

### Chunk 047e SQLite FTS search is redacted and workspace-scoped but still a local keyword index

- **Source:** Chunk 047e session search and conversation lineage.
- **Severity:** Medium for production search quality and retention policy, low for default CI.
- **Status:** Open / accepted for 047e.
- **Root cause:** SQLite FTS5 indexes redacted message text for local persistence only. This prevents raw secret substrings from entering or matching the FTS table, but it is still keyword-only, stores redacted copies of message text, and does not cover future TiDB/vector-backed search semantics.
- **Plan / Mitigations:** Keep `npm test` hermetic with in-memory stores and SQLite `:memory:`. Continue redacting before FTS writes, API egress, and UI snippet rendering. Workspace filters stay mandatory on search routes. Follow-up production hardening should add retention-aware index pruning, TiDB/search-provider parity, and broader fuzz coverage for unusual FTS query syntax.
- **Traceability:** `docs/plans/chunks/047e-session-search-lineage.md`, `src/store/sessionSearch.ts`, `src/store/sqlRectorStore.ts`, `tests/sessionSearchSqlite.test.ts`, `tests/conversationSearchApi.test.ts`.

### Chunk 042f reconciliation matrix for known hardening concerns

| Concern | 042f status | Evidence | Remaining follow-up |
|---|---|---|---|
| SQL/TiDB advanced memory parity | RESOLVED for local/SQL contract coverage | `src/store/sqlRectorStore.ts`, `src/memory/tidbMemoryAdapter.ts`, `tests/sqlMemoryParity.test.ts`, `tests/memoryProviderContract.test.ts` | Live TiDB smoke remains env-gated and not run in default verification. |
| Startup migration boot path | RESOLVED | `src/bin/server.ts` calls `runStartupMigration` before `createApp` for sqlite/tidb; `tests/startupMigrationBoot.test.ts`, `tests/tidbStartupMigrationBoot.test.ts` | Production migrations still need operator backup/rollback policy. |
| Deterministic orchestration placeholders | RESOLVED | 042a/042b added schema validation, repair/fallback, explicit DAG/approval/validation policies; local deterministic mode preserved; Chunk 049 added full security hardening (M20-M28, H1-H8) with 2105+ tests; `tests/*Hardening.test.ts`, `tests/livePlanner.test.ts`, `tests/liveSkeptic.test.ts` | Local fake planner remains regression baseline; real provider quality/live smokes are optional. |
| Heuristic skeptic/crucible/planner | RESOLVED | Deterministic rules are named/deduped; live planner/skeptic paths are schema-gated and cannot suppress deterministic blockers; NEEDS_DECISION transitions restricted to 5 (M20); prompt isolation added (M25+M26); `src/orchestration/{planner,skeptic,crucible}.ts` | Deep semantic quality and human escalation UX need later product work. |
| Sandbox mock runner | RESOLVED | Sandbox policy and safe local runner guard added; E2B remains optional; module signature verification added (M15) for extension trust; `src/sandbox/index.ts`, `src/orchestration/sandboxExecutor.ts`, `tests/sandboxPolicyHardening.test.ts`, `tests/safeLocalRunner.guard.test.ts`, `tests/moduleSignature.test.ts` | Default local mode still avoids real execution; production isolation requires configured external sandbox and live smoke. |
| Rate limiter local-only | RESOLVED | `src/security/rateLimiter.ts` introduces RedisRateLimiter (M2) with `rate-limiter-flexible` + `ioredis`; `RECTOR_REDIS_URL` env var; fallback to InMemoryRateLimiter with warning; `tests/redisRateLimiter.test.ts`, `tests/rateLimiterHardening.test.ts` | Redis optional dep; in-memory fallback with warning when no Redis URL configured. |
| Truth library keyword-only | RESOLVED | Hybrid scoring/provenance validation added; authorization decorator added (M16); `src/memory/truthLibrary.ts`, `tests/truthLibraryHardening.test.ts`, `tests/truthLibraryAuth.test.ts` | Vector-backed truth retrieval remains future adapter work. |
| Provider adapter hardening | RESOLVED | SSRF protection added (H6/M2), API key zeroing (M11), size limits (H7), resilience retry budget (Task 4.3); `src/providers/*`, `tests/ssrfProtection.test.ts`, `tests/sizeLimits.test.ts`, `tests/resilienceBudget.test.ts` | Live provider smoke remains opt-in and was not run. |
| Telemetry no-ops | RESOLVED | Sentry and PostHog adapters implemented (Task 4.2) with lazy require, redaction, env var gating; `src/observability/sentryAdapter.ts`, `src/observability/posthogAdapter.ts`, `tests/telemetryAdapters.test.ts` (25 tests) | `@sentry/node` and `posthog-node` are optional deps; adapters gracefully degrade if packages missing. |
| Operator API auth/local-only | RESOLVED | RBAC middleware around `/api/operator`; error message redaction (H5); budget approval API (Task 4.4); `tests/rbacApiAuthorization.test.ts`, `tests/budgetApproval.test.ts` | Durable team membership/admin UX remains open. |
| Linear UUID labels | RESOLVED | `resolveLinearLabelIds()` with GraphQL pre-flight, 1-hour TTL cache, fallback on API failure (Task 4.1); `src/workflows/index.ts`, `tests/linearLabelResolution.test.ts` (19 tests) | Fallback passes labels as-is on API failure (existing behavior preserved). |
| `pruneMemory` determinism | RESOLVED for tested stores | Deterministic clock/contract coverage in memory hardening tests | Reassess when external memory pruning is live. |
| Template assignment stubs | RESOLVED by stitch | `TemplateService` now writes through durable `OrchestrationAssignmentStore`/`MemoryAssignmentStore`; `tests/templateService.test.ts`, `tests/templateApi.test.ts` | Restart-persistence UI smoke can be added later. |
| Commercial auth/RBAC | RESOLVED | Auth/RBAC/quotas/audit/readiness merged and tested; session secret entropy (M8), SSE auth default-deny (M7), auth-disabled production warning (M19), authorization decorators (M16+M17); `tests/sessionSecretEntropy.test.ts`, `tests/truthLibraryAuth.test.ts`, `tests/assignmentStoreAuth.test.ts` | Durable workspace membership, invitation flows, backup/restore, billing, and compliance are not production-ready. |

### Chunk 045 template assignments required stitch to durable Chunk 043/044 stores

- **Source:** Chunk 045 implementation wave; durable orchestration/memory assignment stores from Chunks 043/044 were not present in that isolated worktree.
- **Severity:** Low after stitch for current local/file-backed behavior; persistence coverage still needs final verification.
- **Status:** Resolved (Chunk 049 verified template apply writes through durable stores with MAC/encryption; `tests/templateApi.test.ts` green).
- **Root cause:** Template preview/apply needs role assignment targets, but the durable stores/routes from sibling chunks were unavailable during wave 2. Chunk 045 added secret-free additive interfaces plus in-memory assignment stores so template apply could be tested without touching provider secrets or provider records.
- **Plan:** Final 042f verification must confirm template apply writes through `OrchestrationAssignmentStore` and `MemoryAssignmentStore` from Chunks 043/044 and preserve the current template schema/API contract.
- **Traceability:** `src/providers/orchestrationAssignments.ts`, `src/providers/memoryAssignmentStore.ts`, `src/providers/memoryAssignments.ts`, `src/templates/templateService.ts`, `tests/templateService.test.ts`, `tests/templateApi.test.ts`.

### Chunk 046 commercial auth/RBAC baseline still needs durable workspace membership backing

- **Source:** Chunk 046 implementation.
- **Severity:** Medium for hosted/team production, low for local-dev.
- **Status:** Open.
- **Root cause:** RBAC, quotas, audit logging, deployment readiness checks, and workspace isolation helpers are now centralized and tested, but the default workspace directory is an in-memory helper. The live server persists audit events to `.rector/audit-events.jsonl`, and per-user provider/memory/secret stores already exist, but workspace/user/membership administration needs a durable store before relying on team membership changes across restarts.
- **Plan / Mitigations:** Local-dev auth-disabled mode remains implicit owner and zero-config. Auth-enabled deployments can inject a `WorkspaceDirectory` implementation; route-level authorization/audit/quota checks are centralized around that interface. Follow-up production hardening should add SQLite/TiDB-backed users/workspaces/memberships, invitation flows, owner-transfer constraints, and backup/restore coverage for membership state.
- **Traceability:** `docs/plans/chunks/046-commercial-readiness-auth-rbac.md`, `src/security/rbac.ts`, `src/security/workspaces.ts`, `src/security/auditLog.ts`, `src/security/quotas.ts`, `src/deployment/readiness.ts`, `tests/rbacApiAuthorization.test.ts`, `tests/workspaceIsolation.test.ts`.

### External mode fail-fast startup check ignores UI-persisted configurations

- **Status:** RESOLVED.
- **Traceability:** Boot-tolerant async resolution (Req 1) now on live path: `src/bin/server.ts:223` (bootstrap calls `resolveStartupOrchestrationConfig` which uses `resolveOrchestrationConfig` + BYOK stores), `src/providers/orchestrationConfig.ts:270` (full `resolveOrchestrationConfig` + union of env + Provider_Config_Store/Secret_Store presence-only via `hasSecret`; only hard-halt is `ORCHESTRATOR_MODE_INVALID` per Req 1.6; zero-provider external now warns + serves per Req 1.4/1.5/1.7; store-read failures tolerated per Req 1.8). Legacy synchronous env-only `parseOrchestrationConfig` (and `EXTERNAL_MODE_NO_PROVIDER` throw path) retained only in `src/deployment/index.ts` for pure-env callers + existing tests/property tests (e.g. `tests/deployment.test.ts:247` and `tests/deployment.test.ts:414`). Property tests for Req 1 / boot-tolerant resolution + local default + warnings: `tests/orchestrationConfigResolution.property.test.ts`, `tests/startupWarningEnvKeyNaming.property.test.ts`, `tests/orchestrationModeInvalidHalt.property.test.ts`, `tests/defaultLocalModeResolution.property.test.ts`. See `.kiro/specs/cloud-capable-transition/requirements.md` Requirement 1 (Boot-Tolerant Startup Validation) ACs 1-8 + 9.5. (Historical root cause/plan retained below for audit trail.)

- **Source:** User report / startup validation audit.
- **Severity:** High usability/onboarding blocker.
- **Root cause:** When `ORCHESTRATOR_MODE=external`, the server runs a fail-fast synchronous check `parseOrchestrationConfig(process.env)` at startup. This check only reads variables from `process.env` (loaded from `.env`). It does not look at the persisted UI provider store (`.rector/providers.json` & `.rector/secrets.enc`), which is loaded asynchronously later. If the user only sets up their credentials in the browser UI (which writes to the JSON and encrypted key files) but leaves the `.env` variables blank, Rector fails to boot with `EXTERNAL_MODE_NO_PROVIDER`.
- **Plan:** (Resolved on live boot path; legacy parser retained for pure-env/tests only. See traceability above.) Fix the startup sequencing so the fail-fast orchestration mode parser either integrates the persisted UI configuration asynchronously, or clearly document that to run in `external` mode, at least one provider's environment variables must be populated in `.env` as a bootstrap signal even if UI-based overrides are configured. (Historical plan text retained for audit trail.)

### Dependency audit: vitest major-upgrade vulnerabilities deferred (require maintainer approval)

- **Source:** `npm audit` during the `dependency-security-triage` spec; see `docs/security/dependency-audit-2026-06-04.md`.
- **Severity:** Was 1 critical + 3 moderate (dev-tooling only).
- **Status:** **RESOLVED** (Chunk 37). Upgraded to `vitest@4.1.8`; `npm audit` reports **0 vulnerabilities**. Full suite green (1369+ tests). `persistentStore` property test given explicit 120s timeout for Vitest 4 / slow I/O.
- **Traceability:** `docs/plans/chunks/037-vitest-auth-live-memory.md`, `package.json`.

### SLM preprocessor (Chunk 26) adds a new cheap-model call surface before flagship planning in external mode

- **Source:** Chunk 26 (SLM Preprocessor + Structured Tool Calls) implementation.
- **Severity:** Medium (new LLM surface + JSON proposal boundary, but heavily mitigated).
- **Status:** Open.
- **Root cause:** In `runExternalChatRun`, a router-selected cheap/SLM provider is now invoked (via `runSLMPreprocessor`) after context building and before the live planner. It produces `distilledContext` + `proposedToolCalls`. Even though the preprocessor runs `evaluateBudget` + `invokeWithBudget`, forces json_object, validates with Zod, filters tools against a conservative allowlist, and redacts output, this is a new place where model output influences downstream flagship prompts and is visible in traces.
- **Plan / Mitigations (already implemented in this chunk; mitigations implemented; see new gaps below):**
  - Local mode (`runFakeChatRun`) is completely untouched — preprocessor is never called.
  - The preprocessor never throws; every failure path (budget denial, provider error, bad JSON, schema failure) produces a safe deterministic fallback with empty `proposedToolCalls`.
  - Original `prompt` + full `contextPack` are retained and passed to skeptic/crucible/healing/synthesis for cross-validation.
  - `proposedToolCalls` are only *proposals*; they are filtered to `ALLOWED_PREPROCESSOR_TOOLS` and still flow through the full symbolic pipeline (`WorkspaceSandboxAdapter` containment/allowlist/approvals, skeptic, crucible, validation/healing, budget).
  - Usage (if any) is intended to be accounted (Step 1 keeps accounting lightweight; later refinement can commit preprocessor usage explicitly before the planner preflight).
  - Property test (fast-check) asserts that arbitrary bloat always produces schema-valid output with only allowlisted (or zero) tool proposals and no obvious secret leakage.
- **Future work:** Prompt hardening / few-shot examples for the preprocessor, richer usage accounting, optional exposure of preprocessor output in the UI trace drawer, and quality metrics once real cheap providers are exercised. (See new High gap on Chunks 29-32 stubs below.)
- **Traceability:** `docs/plans/chunks/026-slm-preprocessor-structured-tool-calls.md`, `src/orchestration/preprocessor.ts`, `tests/preprocessor.test.ts`, wiring in `src/orchestration/chatRunner.ts`.

### Advanced memory (Chunk 27) introduces new write path (/api/notes) and pruning logic in the store

- **Source:** Chunk 27 (Advanced Memory System / neuro-symbolic Step 2) implementation.
- **Severity:** Medium (new persistent-ish state in local mode, pruning decisions, note capture as user-controlled input).
- **Status:** Open.
- **Root cause:** New MemoryEntry entities (layered working/episodic/core) stored in InMemoryRectorStore (and interface extended for future durable stores). `POST /api/notes` allows quick capture into episodic. `pruneMemory` uses heuristic scoring (recency + access + source bonuses) and can create auto-summaries in core. Time fields (`timestamp`, `lastMentioned`) are injected into ContextPack as natural language phrases. All new paths must respect redaction.
- **Plan / Mitigations (implemented in this chunk; mitigations implemented; see new gaps below):**
  - Local/in-memory baseline only; no new network or paid services required (Chroma/Mem0/TiDB stubs or future adapters follow existing pattern).
  - All memory content goes through `redactString` on note creation and search results are simple keyword for alpha.
  - Prune is bounded (`maxEntries`) and opportunistic on note writes; high-value items (user notes, high access) are protected by scoring.
  - Time context is derived client-side in buildContextPack (no external clock dependency beyond store `now`).
  - Existing ContextPack consumers (preprocessor, planner, skeptic) see additive `memoryContext` field; original paths unchanged.
  - Tests include pruning invariants and time fields.
- **Future work:** Real vector similarity in prune/search when Chroma or Mem0 adapters are activated (using stack credits); durable memory entities in sql/tidb stores; full ponder swarm (Step 6) that reads/writes this memory; UI for captured notes; retention policies per layer.
- **Traceability:** `docs/plans/chunks/027-advanced-memory-system.md`, `src/store/schemas.ts` (MemoryEntry), `src/store/inMemoryRectorStore.ts` (impl + prune), `src/api/server.ts` (/api/notes + context enrichment), `src/orchestration/contextBuilder.ts` (time-aware injection), `tests/memoryAdvanced.test.ts`. (See new High gap on RectorStore memory methods + 034 plan below.)

### Proactive alive layer (Chunk 28) adds timer-driven and on-demand message initiation

- **Source:** Chunk 28 (Proactive / "Alive" Layer / neuro-symbolic Step 3).
- **Severity:** Low-Medium (new initiation path, potential for unwanted messages if timer misconfigured).
- **Status:** Open.
- **Root cause:** New ProactiveAgent that can call runChat with synthetic prompts using "proactive-companion" route and marks resulting assistant messages with source "proactive". Timer is strictly guarded (only external mode, long interval). Synthetic messages go through full budget/redaction/pipeline.
- **Plan / Mitigations:** (mitigations implemented; see new gaps below)
  - Local mode: agent is never instantiated with timer (startTimer is a no-op).
  - All proactive LLM calls (if router present) are budget-gated and redacted.
  - Dev trigger endpoint /api/dev/proactive-trigger is behind dev guard (similar to /api/dev/scenario).
  - Source field added as optional to Message (no breakage to existing creates/updates/tests).
  - Reuses existing runChat pipeline so all symbolic controls (skeptic, crucible, healing, sandbox) apply.
- **Future work:** Event-driven triggers (e.g. on long NEEDS_DECISION from memory), better frequency control using memory, UI badge using the source field.
- **Traceability:** `docs/plans/chunks/028-proactive-alive-layer.md`, `src/proactive/proactiveAgent.ts`, wiring in `src/api/server.ts`, `tests/proactive.test.ts`, schema extension in `src/store/schemas.ts`. (See new High gap on Chunks 29-32 stubs below.)

### Doc cleanup and vision shift (Chunk 33) + Cloud-capable transition

- **Source:** Direction change from lightweight local alpha MVP to hassle-free, web-UI-configurable cloud-capable VPS product (with pluggable memory providers: local/Mem0/TiDB/etc.).
- **Severity:** Medium (documentation debt, potential contributor confusion during transition; increased emphasis on UI surfaces for config may expand attack surface or complexity for pluggable backends).
- **Status:** Open / in progress.
- **Root cause:** Many docs, AGENTS.md, README, roadmap, architecture, .env, etc., were written for "v0.1.0-alpha local developer preview" as the target. The cloud-capable-transition .kiro spec exists but was not fully reflected in main docs. New requirement for non-rigid architecture + full UI config for memory DB providers adds pluggability needs beyond current persistence driver.
- **Plan / Mitigations:**
  - Created Chunk 33 plan + inventory (`docs/stale-docs-inventory.md`).
  - Updated AGENTS.md, root README, docs/README, added banners to historical architecture/deployment docs, aligned .env.example comments to prefer UI config and note pluggable memory vision.
  - Local baseline language preserved where it is factually a regression requirement.
  - Future cloud chunks will extend UI-managed config pattern (already used for providers) to memory/persistence backends.
  - Non-rigid design: avoid hard dependencies; use adapters/interfaces for memory providers.
- **Future work:** Complete remaining items from .kiro/cloud-capable-transition (E2B, synthesizer streaming, TiDB, etc.), adapted for hassle-free UI memory config (e.g. new MemoryProvider config store + UI flows, adapters for Mem0/TiDB/local). Update more docs, add cloud quickstart. Verify no breakage to local tests. Partial progress via 033 (see cross-ref); see new Medium/Low-Medium gaps + 034 plan below for pluggable memory + vision lag.
- **Traceability:** `docs/plans/chunks/033-stale-doc-cleanup-vision-alignment.md`, `docs/stale-docs-inventory.md`, edits to AGENTS.md/README/docs/README/etc., `.kiro/specs/cloud-capable-transition/`. (See 034 plan `docs/plans/chunks/034-ui-configurable-memory-providers.md`.)

### New risk from user vision: Pluggable memory providers via UI

- **Source:** User requirement for hassle-free configuration of agent memory database (local or Mem0/TiDB cloud) entirely through web UI, non-rigid architecture.
- **Severity:** Medium (expands config surface; requires careful abstraction so local baseline isn't affected; potential for misconfiguration leading to data loss or cost in cloud backends).
- **Status:** **RESOLVED** (Chunks 34–36 — Settings API, UI memory provider panel, and setup wizard readiness shipped; pluggable Mem0/TiDB/Chroma adapters implemented).
- **Root cause:** Current persistence is driven by RECTOR_PERSISTENCE + env / createRectorStore (memory/sqlite/tidb). Memory is layered on top (truth library + new hierarchical in-memory from 27). No UI-managed "MemoryProvider" equivalent to Provider_Config_Store yet. Adding Mem0 (external) or switching TiDB etc. via UI increases the need for runtime pluggable adapters, secure secret handling for cloud memory, and UI validation.
- **Plan / Mitigations (to be implemented in follow-on chunks; partial status from 033/transition + 034 plan in progress; see new audit gaps below):**
  - Extend the UI config pattern (non-secret records + encrypted secrets) to memory backends.
  - Create adapter interface for memory providers (local implementations + Mem0 client, TiDB-backed, etc.).
  - All config changes via Settings_API; local mode never uses external memory providers.
  - Redaction, budget (if applicable for cloud memory), and migration paths for data.
  - Keep in-memory/SQLite as zero-config local defaults.
  - Update neuro memory code (from 27) to work behind the pluggable layer.
- **Traceability:** This entry + future chunks after 033; reference in cloud-capable-transition adaptation. Use stack credits (Mem0, TiDB, Chroma) for optional adapters.
 (Cross-ref `docs/plans/chunks/034-ui-configurable-memory-providers.md`; see new High gap on RectorStore memory methods + Medium vision lag gap below.)

**Chunk 35 progress:** Real external memory adapters + neuro-symbolic wiring (see `docs/plans/chunks/035-durable-memory-neuro-symbolic-wiring.md`):
- Mem0/TiDB/Chroma `MemoryProvider` adapters with lazy optional deps, budget preflight, bridge factory (`src/memory/*Adapter.ts`, `src/providers/memoryBridge.ts`).
- Boot migration wired; store injection avoids double init.
- Neuro steps 4–7 wired in external pipeline (symbolic, deepPlanning, decomposition, ponder hooks).
- Optional `npm install mem0ai chromadb` for live cloud memory; build/tests pass without them.
- Ponder background jobs: budget-gated, 2h idle timer, fire-and-forget on run complete — monitor latency/cost in production.

**Chunk 34 progress (post-audit):** Core pluggable layer implemented and wired:
- MemoryConfigStore + schemas + local atomic + in-memory double (src/providers/memoryConfig*.ts) mirroring the Provider_Config_Store pattern exactly.
- MemoryProvider interface + LocalMemoryProvider (faithful reproduction of Chunk 27 inmem logic + sqlite-mem delegation using the backfilled sql methods) + external adapters (Chunk 35; stubs retained as unknown-kind fallback only).
- Bridge with local-mode guards, secret reuse (prefixed), graceful fallback (src/providers/memoryBridge.ts).
- Real bootstrap now always creates + passes memoryConfigStore (bin/server.ts); createApp resolves active provider (always a provider, default local-inmemory when omitted or local mode).
- Neuro call sites (chat context searchMemory for episodic, /api/notes create+prune) now go through activeMemoryProvider.
- Default path verified identical: memoryAdvanced.test.ts + new memoryConfigStore.test.ts green; build clean; the providerConfigApi harness was updated (await for async createApp) as part of fixing failures surfaced by the wiring.
- Chunk 36 completed the Settings API (`/api/memory-providers` CRUD + test-connection) and the settings UI memory-provider panel (cards, active toggle, secret-presence-only, test-connection). Setup status/wizard now surfaces memory-provider readiness.
- Local baseline preserved (pure local-inmemory default, zero net, identical outputs for all pre-34 memory features).
See the refined 034 plan doc for details + verification steps. The "RectorStore memory methods" High gap (now RESOLVED) was a prerequisite that enabled safe durable + pluggable memory.

### Chat store is in-memory and resets on restart

- **Source:** Chunk 6 worker/reviewer.
- **Severity:** Expected prototype limitation.
- **Status:** Open until MongoDB/local durable store adapter chunk.
- **Plan:** Keep documented. Replace/augment with durable store in later persistence/provider chunks.

**CI spy baseline (v0.3.0 Req 9):** `npm test` uses in-memory stores and `SpyLLMProvider` doubles — not a user-facing provider-free product path. Real installs use SQLite persistence and configured orchestration per `configured-product-architecture.md`. 

**External / Cloud paths (partially advanced by transition: E2B gated, live gated synth, SSE, boot-tolerant, discovery full, etc.):** See updates below for sandbox/synthesizer/streaming/startup (and cross-refs in new gaps + roadmap section). Startup item resolved (see top of Open). 

### Chat run progress is polling/list only, no SSE/WebSocket

- **Source:** Chunk 6 worker.
- **Severity:** Product UX limitation.
- **Status:** Open.
- **Plan:** Add streaming/SSE in a future chat UX chunk after state/events stabilize.
 (Updated: SSE events + early 202 for ?stream=1 now implemented on External path in `src/api/server.ts:1332` (runChatPipeline + registerRunStreamRoute + broker-wrapped store); polling preserved as fallback. Full answer streaming still gated.)

### Chat synthesis is deterministic trace summary, not semantic answer generation

- **Source:** Chunk 15 implementation.
- **Severity:** Medium product limitation.
- **Status:** Open until provider-backed/local-model synthesis chunks.
- **Plan:** Current final assistant response summarizes local trace evidence from triage/context/planning/review/arbitration/DAG/execution/validation/healing without provider calls. It is safe and testable for alpha brainstem proof, but it does not yet generate rich task-specific prose, cite real external sources, or explain code changes from actual filesystem execution.
 (Updated status: `src/orchestration/synthesizer.ts:56` (synthesizeChatBrainstemResponse + legacyStatusResponse for default/heavy routes), `selectResponseText:91`, `runLiveSynthesizer:401` (gated live flagship prose for Heavy_Developer_Routes in external when router + budget allow; falls back to deterministic Legacy_Status_Response per Req 7.4/7.5). Local always deterministic/0 calls (Req 9). Partial progress on cloud path; see 034 + new gaps.)

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
- **Status:** **RESOLVED** (Chunk 049 — all H1-H8 and M1-M28 findings addressed).
- **Resolution:** Distributed rate limiter (M2), SSRF protection (H6), CSP/HSTS (H4/M5), error redaction (H5), file permissions (H2/M1), payload integrity (H8), encryption at rest (H1), key rotation (H3), body/response size limits (H7), session entropy (M8), and all other M-findings resolved or accepted with documented residual risk.
- **Remaining:** Production hardening beyond v0.3.0 scope (multi-instance, billing, compliance) remains tracked in roadmap.

### Pre-existing modelPicker DOM test failure (2 tests in `tests/modelPicker.dom.test.ts`)

- **Source:** Chunk 047f configured-product `app.js` rewrite; present before Chunk 049.
- **Severity:** Low (test quality, not security).
- **Status:** **RESOLVED** (Chunk 049 / test fixes — added `document.createDocumentFragment` implementation in the fake DOM test harness and updated `appendChild` to unpack fragment elements).
- **Symptom:** `lastRefreshedAt` element stays hidden and empty after model discovery; refreshed timestamp text not rendered. Two tests fail: "discovers models and renders lastRefreshedAt (Req 19.3)" and "Refresh hits the cache-bypassing refresh endpoint (Req 19.2)".
- **Root cause:** The `discoverProviderModels()` function in `src/public/app.js:2289-2336` uses raw `fetch()` in the VM sandbox context. The test harness (`tests/support/providerPanelHarness.ts`) injects a mock `fetch` into the sandbox that routes through `setFetchHandler()`. The fetch call succeeds (URL/method assertions pass), but the async response processing (`await res.text()` → `JSON.parse` → `renderModelPickerCandidates()`) may not be completing before the test assertions in the `flush()` cycle. The `renderModelPickerCandidates` function correctly sets `refreshedEl.hidden = false` and `refreshedEl.textContent` when `snapshot.lastRefreshedAt` is present, but the DOM update appears to not propagate.
- **Fix needed:** Debug the VM sandbox async flush timing between fetch response resolution and DOM element mutation. Possibly needs an additional microtask flush or the `discoverProviderModels` function needs to resolve a promise that the test can await.
- **Not a security issue:** The model discovery endpoint itself works correctly; this is purely a test harness timing issue.

### In-memory rate limiter is local-only and requires distributed backend in production

- **Source:** Chunk 7 review fixes.
- **Severity:** Low for local-MVP, High for multi-instance production.
- **Status:** **RESOLVED** (M2, Chunk 049).
- **Resolution:** `RedisRateLimiter` implemented with `rate-limiter-flexible` + `ioredis` (optional deps); `RECTOR_REDIS_URL` env var; `createRateLimiterFromEnv()` factory; fallback to `InMemoryRateLimiter` with startup warning.
- **Code reference:** `src/security/rateLimiter.ts` (RedisRateLimiter/createRateLimiterFromEnv).
- **Test reference:** `tests/redisRateLimiter.test.ts` (9 tests).

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
- **Status:** **RESOLVED** (Chunk 35/36/47b — real sandbox execution integrated using SandboxExecutor and WorkspaceSandboxAdapter on external/durable paths).
- **Plan:** Current DAG compilation is deterministic and denies unsafe shell permissions by default, and the Chunk 13 fake executor enforces shell denial in the simulated path. Real provider/tool execution must still enforce these policies at sandbox/tool boundaries, define real sandbox capabilities, prevent metadata drift from granting shell/file access, and harden `budgetPolicy` merging so caller-provided overrides cannot weaken local/default limits without explicit approval.

### Executor simulator is deterministic fake execution only

- **Source:** Chunk 13 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** **RESOLVED** (Chunk 35/36/47b — execution bridge implemented with real file/command operations and validation checks).
- **Plan:** The executor simulator runs in memory, never calls shell/providers, and only compares deterministic metadata for retries, dependency blocking, timeout, and unsafe shell denial. Production execution still needs sandbox isolation, durable execution logs, cancellation, real timeout enforcement, tool allowlists, filesystem/network controls, and provider budget enforcement at call boundaries.

### Validation/healing loop replays the whole fake DAG

- **Source:** Chunk 14 implementation.
- **Severity:** Medium product/prod limitation.
- **Status:** **RESOLVED** (Chunk 47b — validation/healing operates on the real execution result, supporting node-level retry and budget recovery).
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
- **Status:** **RESOLVED** (Task 4.4, Chunk 049).
- **Resolution:** Budget approval API + SSE notification implemented: `POST /api/budget/approvals/:id/approve` and `POST /api/budget/approvals/:id/deny` routes; `GET /api/budget/approvals` lists pending; `BUDGET_APPROVAL_REQUESTED` SSE event emitted; `BudgetApprovalRegistry` with 5-min timeout; `handleBudgetApprovalNeeded()` in chatRunner polls for decision.
- **Code reference:** `src/security/budget.ts` (BudgetApprovalRegistry/recordBudgetApprovalDecision), `src/api/routes/approvals.ts`, `src/orchestration/chatRunner.ts` (handleBudgetApproval), `src/protocol/events.ts` (BUDGET_APPROVAL_REQUESTED).
- **Test reference:** `tests/budgetApproval.test.ts` (24 tests).

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
- **Plan:** (Local baseline intentionally preserved per Req 9 / cloud design in `src/sandbox/index.ts:622` (defaultCommandRunner) + `WorkspaceSandboxAdapter`.) External/Cloud path partially advanced: real E2B wired + gated (key from Secret_Store or E2B_API_KEY fallback) in `src/bin/server.ts:174` (buildStartupSandboxAdapter) + `src/sandbox/e2bSandboxAdapter.ts` (real client + runCommandInContainer when key present; reuses Workspace as gateway for local-only ops). See new High gap (RectorStore memory methods + 034) + roadmap item 3. Dummy/local stub remains for regression baseline + when no E2B key.

### Sandbox stubs deny cloud execution by default

- **Source:** Codebase audit.
- **Severity:** Medium.
- **Status:** Open.
- **Root cause:** The E2B and Depot adapters in `src/sandbox/index.ts` are completely stubbed out. Invoking them throws a `SANDBOX_PROVIDER_STUB_NO_NETWORK` denial error.
- **Plan:** (Updated: stubs largely replaced by real E2B adapter per above; still gated on config/key per Req 6.1/6.7. Local path + no-key external degrade to the network-free WorkspaceSandboxAdapter/dummy. See `src/sandbox/e2bSandboxAdapter.ts:131` and bin/server.ts wiring. Full UI config + key injection in later 034+ work.)

### Developer-oriented triage routes fall back to diagnostic traces instead of LLM prose

- **Source:** Codebase audit.
- **Severity:** Medium.
- **Status:** Open.
- **Root cause:** In `src/orchestration/synthesizer.ts`, all developer routes (`RESEARCH`, `CODE_EDIT`, `PLAN_ONLY`, `LONG_RUNNING`) default to returning `legacyStatusResponse` which formats diagnostic execution summaries (e.g. `Status: ... Observed: ...`) instead of calling the LLM router to formulate a rich prose response.
- **Plan:** (Updated: live path now exists and is gated in `runLiveSynthesizer` + `src/orchestration/synthesizer.ts:401` (and selectResponseText); heavy dev routes fall back to legacy per Req 7.4/7.5 when no router/key/budget or in local. Streaming events partial (see above). See roadmap item 4 + new gaps.)

### Linear workflow integration relies on raw string display labels instead of UUIDs

- **Source:** Codebase audit / workflows inspection.
- **Severity:** Low.
- **Status:** **RESOLVED** (Task 4.1, Chunk 049).
- **Resolution:** `resolveLinearLabelIds()` in `src/workflows/index.ts` performs GraphQL pre-flight query to fetch team label catalog, maps names to UUIDs, caches with 1-hour TTL, and falls back to as-is on API failure.
- **Code reference:** `src/workflows/index.ts` (resolveLinearLabelIds/LABEL_CACHE_TTL_MS/labelCache).
- **Test reference:** `tests/linearLabelResolution.test.ts` (19 tests).

### Telemetry integrations are all inert no-ops

- **Source:** Codebase audit.
- **Severity:** Low.
- **Status:** **RESOLVED** (Task 4.2, Chunk 049).
- **Resolution:** Sentry adapter (`src/observability/sentryAdapter.ts`) and PostHog adapter (`src/observability/posthogAdapter.ts`) implemented with lazy `require()`, env var gating (`SENTRY_DSN` / `POSTHOG_API_KEY`), and `redactSecrets()` before send. `createObservabilityAdapters()` factory returns real or no-op adapters based on env vars. Packages are optional deps; adapters gracefully degrade when missing.
- **Code reference:** `src/observability/sentryAdapter.ts`, `src/observability/posthogAdapter.ts`, `src/observability/index.ts` (createObservabilityAdapters).
- **Test reference:** `tests/telemetryAdapters.test.ts` (25 tests).

### RectorStore memory methods missing from sql/tidb implementations (Chunk 27 interface extension incomplete)

- **Status:** RESOLVED (implementation backfill landed; durable memory surface now present for sqlite/TiDB paths).
- **Traceability (post-audit fix):** `src/store/sqlRectorStore.ts:512` (createMemoryEntry), `531` (listMemoryEntries), `555` (searchMemory), `578` (pruneMemory) — full impls matching InMemoryRectorStore semantics + MemoryEntrySchema roundtrips. `src/store/index.ts:283` (`verifyStartupTables` now calls `listMemoryEntries()`), `209` (`STARTUP_MIGRATION_TABLES` includes "memories"). `src/api/server.ts:1294` (unconditional `searchMemory` for episodic context in runChatPipeline) + note create/prune on /api/notes now safe for all drivers returned by createRectorStore. Test updates: `tests/buildSmokeVerification.test.ts` (ENTITY_TABLES/assertions 5→6), `tests/tidbStartupMigration.integration.test.ts` (comments/names), budget accounting realign in byokExternalE2E + chatRunner tests for the preprocessor cheap call. Full suite: 192 files / 1241 tests passing + `npm run build` green after the fixes (see user's "Walkthrough - Test Suite Fixes and Commits" + commits e06861a0 + chore neuro chunks). The original crash risk for durable + neuro 27 (notes, time-aware context for preprocessor/planner) is eliminated.
- **Source:** Full system audit (server + store wiring + createRectorStore tests) + post-fix verification.
- **Severity:** High (was blocking durable/TiDB VPS + 034 pluggable memory).
- **Root cause:** (Historical — retained for audit trail) `RectorStore` interface in `src/store/index.ts:74` (post-Chunk 27) declares `createMemoryEntry`/`searchMemory`/`pruneMemory` + siblings. Only `InMemoryRectorStore` implements them (src/store/inMemoryRectorStore.ts:309+). `SqlRectorStore` (used for both sqlite + tidb via `createRectorStore` in src/store/index.ts:164 and src/api/server.ts:1155) has no implementations (file ends after artifacts without the methods). `src/api/server.ts:1284` (chat runChatPipeline, unconditional `searchMemory` for episodic injection into contextPack) + `src/api/server.ts:1420` (/api/notes POST, unconditional `createMemoryEntry` + `pruneMemory`) + proactive + other call sites will crash (or fail to type) on any durable/persistent driver. `runStartupMigration` + TiDB path (and 034 MemoryProvider abstraction) blocked. createRectorStore tests (persistentStore.test.ts etc.) do not cover the advanced memory surface for sql/tidb.
- **Plan / Mitigations:** Backfill completed (see traceability). Long-term: proper MemoryProvider abstraction + pluggable impls for hassle-free UI selection (local in-memory/SQLite vs. Mem0/TiDB cloud etc.) per user vision and 034 plan `docs/plans/chunks/034-ui-configurable-memory-providers.md`; keep in-memory as local baseline (Req 9 / cloud design). Add durable memory roundtrip/prune/search property tests if not already expanded in the 1241-test baseline. Do not assume all stores are equivalent until the abstraction layer lands. (See also TiDB migration wire item below and neuro 29-32 item.)

### Neuro-symbolic chunks 29-32 (symbolic engine, deep planner, ponder swarm, task decomposer) are dead/unwired stubs with zero callsites in main pipeline

- **Source:** Full system audit (orchestration/chat wiring + src/orchestration/index.ts + chunk plans).
- **Severity:** High (was blocking "alive" usability goal from AGENTS.md + neuro vision).
- **Status:** **RESOLVED** (Chunk 35).
- **Resolution (Chunk 35):** Wired into external chat pipeline: symbolic tool validation in preprocessor + healing hints; opt-in `deepPlanning` → `runDeepPlanner`; high-complexity `decomposeIntoTasks` + concurrent sandbox execution; `createNeuroBackgroundHooks` for ponder/subconscious (external mode). Local `runFakeChatRun` path unchanged. Tests: symbolicEngine, preprocessorSymbolic, deepPlanner, taskDecomposer, ponderSwarm, backgroundHooks + E2E regression green.
- **Remaining limitations:** `memoryContext` time phrases still not in all LLM prompts; ponder uses fixed 2h idle timer (not event-driven); task decomposition is alpha heuristic (max 4 sub-goals).
- **Traceability:** `docs/plans/chunks/035-durable-memory-neuro-symbolic-wiring.md`, commits `6da4800`, `b4c2181`.

### TiDB Startup_Migration (with 30s deadline + verify + redacted halt) fully coded but not invoked on live boot path (bin/server.ts + createApp)

- **Source:** Full system audit (store/index.ts vs. bin/server.ts + api/server.ts).
- **Severity:** Medium (was blocking TiDB path per Req 8 on live boot).
- **Status:** **RESOLVED** (Chunk 35).
- **Resolution (Chunk 35):** `src/bin/server.ts` bootstrap awaits `runStartupMigration` for `sqlite`/`tidb` drivers; passes pre-migrated store via `ApiSecurityOptions.store`; memory driver skips migration (Req 9). `tests/startupMigrationBoot.test.ts` + deadline timeout test added.
- **Traceability:** commit `c212b89`, `docs/plans/chunks/035-durable-memory-neuro-symbolic-wiring.md`.

### pruneMemory heuristic is non-deterministic (Date.now()) and only opportunistic; missing property tests for survival invariants

- **Source:** Full system audit (inMemoryRectorStore + memoryAdvanced.test.ts).
- **Severity:** Medium.
- **Status:** **RESOLVED** for survival-invariant property coverage (Chunk 036 Wave 1D). Opportunistic `Date.now()` scoring remains an accepted alpha limitation.
- **Resolution (Chunk 036):** `tests/memoryPrune.property.test.ts` adds fast-check properties for maxEntries bounds, user-note survival, high-access survival, and core-summary creation via `LocalMemoryProvider` with injected `now()` clock (deterministic prune semantics).
- **Root cause:** (Historical) `src/store/inMemoryRectorStore.ts:388` (pruneMemory) uses `Date.now() - Date.parse(...)` for recency scoring + opportunistic call only on /api/notes writes (and bounded). Tests (memoryAdvanced.test.ts:62) exercised happy paths but lacked fast-check property tests for survival invariants.
- **Remaining / follow-on:** Consider deterministic clock injection at all prune call sites (not only tests). Tie durable-store prune parity into future pluggable-layer hardening.
- **Traceability:** commit `f0d1209`, `docs/plans/chunks/036-hassle-free-ui-neuro-observability.md`.

### concerns register and some post-033 docs still carry heavy 'alpha prototype / local developer preview' framing; vision lag vs AGENTS + .kiro + user hassle-free UI memory requirement

- **Source:** Full system audit (docs + AGENTS.md + .kiro + 033/034 plans).
- **Severity:** Low-Medium.
- **Status:** Open / partial.
- **Root cause:** Post-033 cleanup (Chunk 33 plan) + banners + AGENTS/README updates done, but many entries here + some roadmap/deployment docs still frame as "local alpha prototype / v0.1.0-alpha local developer preview" as the primary target (vs. current hassle-free UI-configurable cloud/VPS product with pluggable memory per user vision + AGENTS.md + .kiro/specs/cloud-capable-transition/ + 034). Local baseline language is factually required (Req 9) but framing lags.
- **Plan / Mitigations:** Continue 033/034 doc sweeps. Update this register + remaining chunks/docs on each cloud chunk. Cross-ref 034.

## Closed / Mitigated

### Esbuild dev-server advisory resolved via npm overrides (GHSA-67mh-4wv8-2f99)

- **Source:** `npm audit` during branch setup and Gemini final audit; remediated by the `dependency-security-triage` spec.
- **Severity:** Moderate (CVSS 5.3, CWE-346) — esbuild dev server allowed any website to send requests and read responses (DNS-rebinding-style exposure). Dev/test tooling only; never shipped in the `dist` runtime.
- **Fix:** Added an additive npm `overrides` entry to `package.json` forcing `esbuild >=0.28.1`, then regenerated the lockfile with `npm install` (no `npm audit fix --force`, no runtime dependency change). `npm ls esbuild` now resolves every entry to `esbuild@0.28.1` (via both `tsx` and `vitest > vite`), and `npm audit` no longer reports GHSA-67mh-4wv8-2f99. The full verification baseline stayed green after the change: `npm test` 28 files / 278 tests (29 files / 280 tests with the added `tests/dependencySecurity.test.ts` override regression guard), `npm run build` and `npm run check` both succeeded. Chunk 047a reconfirmed the override with `npm test` (260 files / 1624 tests passed, 5 skipped), `npm run build`, and `npm audit` (0 vulnerabilities).
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

### Provider resilience retries can add provider spend beyond the initial preflight

- **Source:** Chunk 047f implementation.
- **Severity:** Medium provider/budget risk.
- **Concern:** The resilience wrapper preflights through the existing `invokeWithBudget` call before the first provider invocation, then may perform a bounded 429 retry, auth retry, or fallback substitution inside that call site. Those extra attempts are traced and bounded, but per-attempt budget preflight/accounting should be tightened in a follow-up so retry/fallback spend is projected before each recovery call.
- **Status:** Open follow-up before public alpha billing/quotas.

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
* **Status (post-audit)**: IMPLEMENTED (boot-tolerant path live). See `src/bin/server.ts:223` (resolveStartupOrchestrationConfig), `src/providers/orchestrationConfig.ts:270` (store-aware union + presence-only), property tests, and top resolved item in this register + `.kiro/specs/cloud-capable-transition/requirements.md` Req 1. (Legacy parser retained in deployment/index.ts for tests only.)
* **Implementation**: Modify the server startup block in `src/bin/server.ts` to defer validation of credentials. Check credentials lazily at request time or load them asynchronously from the database at startup, logging a warning rather than crashing with `EXTERNAL_MODE_NO_PROVIDER`.

#### 2. Implement Bring-Your-Own-Key (BYOK) Model Discovery
* **Goal**: Enable users to input their Cloudflare API Token or Together AI API Key and dynamically view and route models.
* **Status (post-audit)**: Partial / advanced in transition work (configBridge, discovery adapters, Settings_API, providerConfigStore + secretStore, route maps). Full UI flows + 034 memory extension pending. See providers/ + api/server.ts.
* **Implementation**: Wire the UI to trigger the `ModelDiscoveryService`. Fetch active models directly from the provider API, and write user preferences (role-to-model mappings) directly to the `.rector/providers.json` config store.

#### 3. Transition from Mock to Real Sandboxed Execution
* **Goal**: Enable executing code patches and shell commands inside containerized environments.
* **Status (post-audit)**: **RESOLVED** (Chunk 35/36/47b — real sandbox execution integrated using SandboxExecutor and WorkspaceSandboxAdapter on external/durable paths; safe local runner guarded, and E2B integration wired when key is present).
* **Implementation**: In `src/orchestration/sandboxExecutor.ts`, replace the dummy `defaultCommandRunner` with E2B Node SDK instance calls and Depot image builds to run test suites safely inside micro-containers, enforcing strict timeout and memory limits.

#### 4. Replace Diagnostic Traces with Streamed Assistant Prose
* **Goal**: Return human-like answers rather than execution traces to the user.
* **Status (post-audit)**: PARTIAL (live gated synth + SSE events advanced on cloud path; legacy/deterministic preserved for local + fallbacks per Req 7/9). See `src/orchestration/synthesizer.ts:401` (runLiveSynthesizer + 60s deadline + fallback to legacyStatusResponse), `src/api/server.ts:1332` (SSE ?stream=1 + 202 early + broker events; polling preserved). Heavy dev routes still often legacy. See updated prototype items + new gaps + roadmap item 4 cross-ref in synthesizer.
* **Implementation**: Connect `src/orchestration/synthesizer.ts` to the `ModelRouter` to request a natural language synthesis from the flagship model, instructing it to summarize what was done, what was verified, and what files were modified, referencing the trace drawer metadata only as an option.

#### 5. Implement Vector DB Retrieval and Storage
* **Goal**: Add durable memory storage for truth validation and user preferences.
* **Status (post-audit)**: **RESOLVED** (Chunks 34–36 — Settings API, UI memory provider panel, and setup wizard readiness shipped; pluggable Mem0/TiDB/Chroma adapters implemented).
* **Implementation**: Upgrade `src/memory/` and the truth library to sync documents and transcripts to Chroma DB, using Algolia to back fast keyword indexes.

## Cartographer

### Cartographer inventory slice deferred risks and limitations

- **Source:** Chunk 050 Cartographer inventory slice finalization.
- **Severity:** Medium implementation/operational risk; low security risk for the current deterministic inventory slice.
- **Status:** Open follow-ups before large-repo production use.
- **Root-only `.gitignore`:** The scanner loads only the repository-root `.gitignore` in this slice. Nested `.gitignore` files under subdirectories are deferred, so subdirectory-specific ignore behavior can differ from Git until the ignore policy is expanded.
- **TOCTOU hash window:** A file can change between the walker's `lstat` metadata read and the later hash `readAll`, so the recorded size/mtime and hash can reflect different instants for a concurrently modified file.
- **Synchronous SQLite:** `SqliteCartographerInventoryStore` uses synchronous `node:sqlite` driver calls. This is simple and deterministic for the slice, but can block the event loop on very large repositories or high-frequency inventory writes.
- **Size cap:** Files larger than `DEFAULT_MAX_FILE_SIZE_BYTES` (5 MiB by default) are ignored rather than indexed. This keeps scans bounded, but large source/data files are absent from the inventory until configurable sizing or streaming support is added.
- **Limited `LanguageId` set:** The classifier maps a fixed extension set to `LanguageId`; unknown extensions classify as `"unknown"` even when the file is source for an unsupported language.
- **Emitter-error isolation:** A throwing or rejecting Cartographer scan emitter is swallowed and recorded as a recoverable `ScanError` with `stage: "store"` and a message beginning with `"emitter failed:"`. This prevents observability hooks from aborting scans, but callers must inspect `ScanResult.errors` to notice emitter failures.
- **New dependency:** The `ignore` npm dependency was added in T0 to support `.gitignore` and `.rectorignore` matching. Keep it in dependency audits and supply-chain review.
- **`fastPrecheck` caveat:** `scanChangedFiles({ fastPrecheck: true })` can miss a same-size content edit that preserves mtime because it skips hashing when size and mtime match. The default mode always hashes and remains correctness-first.
- **Incremental persistence transactionality:** `scanChangedFiles` persists snapshots, scan errors, file upserts, and file removals as multiple store calls rather than a single transaction. A failure after snapshot creation but before file upsert/removal can leave snapshot history and current inventory out of sync. Follow-up should add transaction support for the SQLite inventory store or introduce a store-level transactional persistence method.

## Chunk 051 — Inspection Cleanup

### Baseline

- **Source:** Chunk 051 inspection cleanup.
- **Status:** Behavior-preserving cleanup completed for the inspected `src/` findings in scope.
- **Verification:** `npm run check` (`tsc --noEmit`) exited 0 after every commit.
- **Security-relevant characterization:** Three simplifications were locked with characterization tests committed before the simplification: `dagCompiler` `allowFileWrite`, `shouldHalt`, and `isPublicAuthRoute`.

### Inline suppressions added for intentional false positives

- **Label:** SUPPRESSED — `src/templates/templateService.ts:906` has `// noinspection UnnecessaryLocalVariableJS` on `const _exhaustive: never = mode;`. This is an intentional TypeScript exhaustiveness guard; the `never` assignment is load-bearing because `tsc` fails if the switch becomes non-exhaustive. It is not redundant.
- **Label:** SUPPRESSED — `src/bin/server.ts` server-listen banner has `// noinspection HttpUrlsUsage` on the `http://${host}:${port}` `console.log`. This is a local bind-address startup banner, not a network target; forcing HTTPS would misrepresent the actual bind.

### JSUnusedGlobalSymbols triage

- **Label:** FIXED — Eight exported symbols were deleted after verifying zero references repo-wide: `isSupportedProviderId`, `MemoryEntriesLayerQuery`, `bootstrapPromise`, `TERMINAL_STATES`, `PromptTierName`, `isWorkspaceRole`, `UserStatus`, and `ToolRisk`.
- **Label:** KEPT-false-positive — The remaining approximately 24 symbols were kept as intentional public surface. See `.omo/evidence/task-8-051-inspection-cleanup.md` for the full per-symbol decision table.
- **Kept categories:** Re-exported public barrels via `src/index.ts` and domain barrels, such as `ObservabilityEvent`, `ModuleTier`, `StoreEvent`, `TemplateRiskLevel`, and `TemplateCostTier`.
- **Kept categories:** Class/interface members and SDK callback shapes, such as `readSkillReference`, `workspaceRelativePath`, `listEnabled`, `invokeOnExternalRunPhase`, `usedIterations`, `usedToolCalls`, `stopTimer`, `unregister`, and Sentry `beforeSend`.
- **Kept categories:** Protocol, provider, sandbox, and template contract types or factories, such as `ProtocolEnvelope`, `OrchestrationProviderSelectionSchema`, `OrchestrationProviderSelection`, `SandboxCommandKind`, `ApprovalGateType`, `createSandboxEnvironment`, `TemplateApplyRequest`, and `TemplateSaveCurrentRequest`.
- **Kept categories:** Symbols referenced in tests or docs, including examples such as `TruthItemKind` and documented tool registry surface.

### ExceptionCaughtLocallyJS triage

- **Label:** KEPT-false-positive — All six `ExceptionCaughtLocallyJS` `src/` sites were kept as intentional; 0 were fixed. See `.omo/evidence/task-11-051-inspection-cleanup.md` for the full decision table.
- **Optional-dependency loaders:** Four sites are friendly-error loader patterns for optional dependencies in the Chroma, Mem0, and E2B adapters. The local throw intentionally routes to a catch that emits an install hint or normalized domain error.
- **Transactional/error-handling paths:** Two sites in `sqlRectorStore` are load-bearing: one performs transaction `ROLLBACK` before propagating a concurrent transition error, and one handles decryption failure with redaction context.

### Deferred empty-scope inspections

- **Label:** DEFERRED — `JSDeprecatedSymbols` had zero `src/` findings; occurrences were limited to `tests/chatApi.test.ts`, which was out of scope for this chunk.
- **Label:** DEFERRED — `BadExpressionStatementJS` had zero `src/` findings; occurrences were in `tests/`, which was out of scope for this chunk.
- **Label:** DEFERRED — `JSCheckFunctionSignatures` had zero `src/` findings, so no `src/` action was needed.
- **Label:** DEFERRED — `DuplicatedCode_aggregate` had zero `src/` findings, so no `src/` action was needed.

### Qodana test-scope config gap

- **Label:** DEFERRED — The merged `qodana.yaml` on `origin/main` does not contain exclude/scope rules for `tests/`. The chunk honored the user's stated intent that tests were out of scope; that scope is not enforced by configuration. If `tests/` findings should be permanently suppressed, `qodana.yaml` needs an explicit exclude block in a follow-up.

## Phase 0 — Capability eval harness + Phase-0 finish (Todo 6 / Todo 8)

**Status: DONE — gates passed on 2026-06-24 at 65f6557d8c57a9bf8489e5d6bd881e300afefb80.** All Phase 0 gates passed (`eval:capabilities:gate`, `baseline:phase0`, `verify:phase0`). 10 eval cases (2 efficiencyRelevant cases meet >=10x compression / >=0.80 raw_token_reduction). No ExecutiveRouter and no real specialist execution are involved (deferred to Phase 11/12). The fake-system purge is deferred (Phase 3 / fake-purge workstream); `npm run audit:no-fakes` remains report-only (non-blocking, never CI-failing) until Phase 13 (40 findings accepted as known deferral).

### Baseline (real gate output on `rector-0.3.0`, commit `80e809c`)

- **`npm test`:** exit 0 — 330 files (329 passed, 1 skipped), 2209 tests (2204 passed, 5 skipped). The skipped file is `tests/memoryLive.integration.test.ts` (live-memory tests gated behind absent live credentials, by design offline).
- **`npm run check` (`tsc --noEmit`):** exit 0.
- **`npm run build`:** exit 0.
- **`npm run audit:no-fakes`:** exit 0, report-only — 182 src files scanned, 40 fake-seam findings reported (non-blocking).
- **`npm run eval:capabilities`:** exit 0 — offline, no-model run; 3/3 cases pass committed oracles; aggregate `passed` honestly `false`.
- **`npm audit`:** exit 0, `found 0 vulnerabilities`. The previously-tracked 5-advisory dev-tooling item appears CLEARED on this branch by the package.json `overrides` for `esbuild`/`undici`/`ws`. (AGENTS.md test-baseline + "5 vulnerabilities" notes are owned by Todo 9 / a separate doc-refresh task; not edited here.)

### Honest limitation — offline eval efficiency metrics intentionally fail (NOT a defect)

- **Label:** BY-DESIGN — The offline Phase-0 eval corpus (`tests/fixtures/eval-corpus/`) ships three tiny committed real command artifacts (`rg`, `tsc --noEmit`, `git diff`). The runner (`scripts/evals/run-capability-evals.ts`) scores each artifact against its deterministic oracle with **no model**.
- The evidence metrics (`schema_valid`, `recall`, `omission`, `secret_leak`, `line_ref_accuracy`, `root_cause_accuracy`) are REAL artifact-vs-oracle comparisons and all pass.
- `compression` (>=10x) and `raw_token_reduction` (>=0.80) target large, noisy LIVE tool outputs. On tiny fixtures they are honestly low (aggregate compression ~1.24x), so the aggregate `passed` is truthfully `false`. We do **not** fabricate metric values to force a green report. The offline harness gate `npm run eval:capabilities` exits 0 on successful report PRODUCTION, not on aggregate threshold attainment.
- **Deferred:** Live efficiency-threshold attainment (real compression/token-reduction against large tool outputs) is Phase 2.5 work, not Phase 0.

### Report-only fake-seam audit is informational, not enforced

- **Label:** DEFERRED — `npm run audit:no-fakes` reports 40 fake-system seams in `src/` (FakeLLMProvider, `createFakePlan`/`fallbackPlan`, `workspace.validate` `passed:true`, `simulator.echo`, `executorSimulator` imports). It is intentionally non-blocking (exits 0) during the v0.3.0 transition; nonzero exits are reserved for internal audit errors. Phase 0 only MEASURES these seams: purging/modifying them is deferred to Phase 3 and the fake-purge workstream, and the audit only becomes a CI-failing gate in Phase 13. Until then seam reintroduction is not gate-blocked. These seams must be retired before the configured-only product GA per `docs/architecture/configured-product-architecture.md`.

### gitignore negation carve-out for tracked benchmark mirror

- **Label:** NOTE — `.gitignore` ignores the entire `docs/plans/2-0/` research tree. Phase 0 adds a single intentional exception: `docs/plans/2-0/phases/**` is re-included as the tracked benchmark mirror (`docs/plans/2-0/phases/phase-0-benchmarks.md`). To make the negation effective, the parent rule was changed from the bare directory `docs/plans/2-0` to `docs/plans/2-0/*` (git cannot re-include a path whose parent directory is itself excluded). Verified: the mirror is `git add`-able while all sibling `2-0` files and the whole `.omo/` tree remain ignored.

## Phase 0.5 — Global Reliability Harness

**Status: DONE — gates passed on 2026-06-24 at 65f6557d8c57a9bf8489e5d6bd881e300afefb80.** All Phase 0.5 gates passed (`test:global:gate`, `verify:phase0.5`, `verify:foundation`). 28 offline scenarios (21 strict-pass, 8 intentional regressions), all actual==expected. The ExecutiveRouter and real specialist execution are NOT implemented (deferred to Phase 11/12); the harness emits dry-run task packets/traces only. The fake-system purge is deferred (Phase 3 / fake-purge workstream); `npm run audit:no-fakes` remains report-only (non-blocking, never CI-failing) until Phase 13 (40 findings accepted as known deferral).

### Baseline (real gate output on `rector-0.3.0`, Phase 0.5 finish)

- **`npm test`:** exit 0 — 336 files (335 passed, 1 skipped), 2241 tests (2236 passed, 5 skipped). The skipped file is `tests/memoryLive.integration.test.ts` (live-memory tests gated behind absent credentials, offline by design).
- **`npm run check` (`tsc --noEmit`):** exit 0.
- **`npm run build`:** exit 0.
- **`npm run test:global`:** exit 0 — 4 offline scenarios, all executed (0 skipped), one scorecard each (8 dims + fake-path), writes `.omo/evidence/global-report.{json,md}`.
- **`npm run test:systems`:** exit 0 — validates the committed `coding.profile.json` (1/1 valid).
- **`npm run eval:capabilities`:** exit 0 (Phase 0 harness still green).
- **`npm run audit:no-fakes`:** exit 0, report-only — 187 src files scanned (rose from 182 as `src/systems/*` and `src/evals/*` landed), 40 fake-seam findings.

### Harness coverage and offline honesty

- **Label:** BY-DESIGN — The Global Reliability Harness ships 4 offline scenarios (coding-basic-fix, memory-boundary, fake-purge, delegation-routing), each producing one scorecard across the 8 reliability dimensions plus a fake-path-status dimension. It proves the harness WIRING (scenario load → task packet → trace capture → oracle → scorecard → replayable regression), NOT specialist execution.
- The aggregate is honestly `passed 0/4`: the `tests/fixtures/repos/rector-mini-fix/` fixture ships a genuinely failing test (the to-be-fixed state), so reliability scores 0 truthfully. The harness does not yet drive a specialist to MUTATE the repo and make the test pass — specialist-driven repair is Phase 11/12. We record 0/4 rather than fabricate a pass.
- The harness runner exits 0 on successful report PRODUCTION, not on aggregate scenario pass (mirrors the Phase 0 eval-runner posture).

### Live-scenario posture and fake-path surfacing

- **Label:** NOTE — Live scenarios are opt-in only: when no provider credentials are present the live path is SKIPPED (proven by a skipped-path test), never faked, and live scenarios are NOT added to default CI.
- **Label:** DEFERRED — fake-path-status is surfaced as a scorecard dimension (`fakes_present`, 40 seams), report-only — the same seams the `audit:no-fakes` scanner reports. Purge remains deferred to Phase 3 + the fake-purge workstream; CI-gating to Phase 13.

### src-cannot-import-scripts → injected fakePathAuditor

- **Label:** NOTE (design) — `src/**` cannot import from `scripts/**` (outside `tsconfig` `rootDir`), so the global harness does not statically import the `no-production-fakes` auditor. Instead the auditor is INJECTED into the runner as a `fakePathAuditor` seam; the CLI wires the real `auditNoProductionFakes` while tests inject a deterministic double. This keeps the fake-path dimension real in production runs without an illegal cross-rootDir import.

### Test gaps / limitations

- **Label:** DEFERRED — The harness measures reliability against committed oracles only; it does not exercise live providers or real specialist mutation (Phase 11/12). The single offline fixture repo (`rector-mini-fix`) is intentionally minimal; broader scenario corpora are future work.
- **Label:** DEFERRED — CodeScene "Complex Method" + "Code Duplication" (tests/**) and "String Heavy Function Arguments" (scripts/audit/**) suppressed via committed code-health-rules.json (test/audit legitimate patterns); production src/** untouched.
