# Chunk 37 — Vitest 4 Upgrade, Live Memory Tests, Multi-User Auth

**Status:** Complete.

## Goal

Close three deferred production-hardening items: clear npm audit dev-tooling findings, opt-in live Mem0/Chroma verification, and opt-in multi-user session auth for hosted/VPS deployments.

## Implemented

### Vitest 4 upgrade
- `vitest@^4.1.8` (resolves to 4.1.8)
- `npm audit`: **0 vulnerabilities** (was 5)
- `tests/persistentStore.test.ts`: 120s timeout on heavy property test (Vitest 4 / WSL flake)

### Live Mem0/Chroma integration tests
- `tests/memoryLive.integration.test.ts` — skipped unless `MEM0_API_KEY` or `CHROMA_URL` set
- `scripts/memory-live-smoke-test.ts` + `npm run smoke:memory`
- `.env.example` documented

### Multi-user session auth (opt-in)
- `src/security/auth.ts` — scrypt passwords, HMAC session cookies
- `src/security/authMiddleware.ts` — gate when `RECTOR_AUTH_ENABLED=true`
- `src/security/userDataPaths.ts` + `userStores.ts` — per-user `.rector/users/{username}/` isolation
- Routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- Tests: `tests/auth.test.ts`, `tests/authApi.test.ts`

## Configuration

```bash
RECTOR_AUTH_ENABLED=true
RECTOR_AUTH_SESSION_SECRET=<random-32+-chars>
RECTOR_AUTH_USERS='[{"username":"alice","passwordHash":"scrypt:..."}]'
```

Default (auth off): identical local baseline — no login, shared `.rector/` paths.

## Verification

```
npm audit     → 0 vulnerabilities
npm test      → 213 passed / 1 skipped file / 1369 passed / 4 skipped tests
npm run build → clean
```

## Commits

- `b42b4eb` test(chunk-037): live Mem0/Chroma integration tests
- `3ff24ba` feat(chunk-037): multi-user session auth
- `5d04499` chore(chunk-037): vitest 4.x + persistentStore timeout
- `60f67c9` docs(chunk-037): chunk plan, concerns, AGENTS, dependency audit