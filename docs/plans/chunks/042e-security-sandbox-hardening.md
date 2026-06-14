# Chunk 042e — Security and Sandbox Hardening

> Created: 2026-06-12
> Phase: 5 of 6
> Components: Rate Limiting, Sandbox, Budget/Safety Gates

## Goal

Harden Rector's production safety envelope: rate limiting, sandbox execution,
policy enforcement, and budget/security failure behavior.

## Scope

### In Scope

- `src/api/server.ts` rate limiter
- `src/security/*`
- `src/sandbox/index.ts`
- E2B adapter paths if present
- sandbox execution integration points
- security tests and property tests

### Out of Scope

- Full RBAC/billing/quotas
- Container orchestration/infrastructure provisioning
- Replacing E2B with another provider

## Design Principles

1. **Deny by default.** Unknown operations, paths, commands, or provider states fail closed.
2. **Policies are explicit and testable.** No hidden stringly-typed policy behavior.
3. **Local mode stays safe.** Local mode cannot accidentally become arbitrary shell execution.
4. **Distributed-ready interfaces.** Local in-memory implementations remain default, but production adapter boundaries exist.
5. **Redaction everywhere.** Rate-limit, sandbox, and provider errors must not leak secrets.

## Work Items

### 1. Rate Limiting Interface

Current state:

- In-memory bucket in `src/api/server.ts`.
- Per-process only.

Planned work:

- Extract `RateLimiter` interface:
  - `check(key, route, now)`
  - `commit(key, route, now)`
  - `reset?`
- Provide `InMemoryRateLimiter` local default.
- Add future-compatible `DistributedRateLimiter` contract stub.
- Support keys:
  - auth user ID when available
  - IP fallback
  - route bucket
- Add config:
  - global chat limit
  - provider test-connection limit
  - auth login limit
  - memory provider test limit
- Add tests:
  - independent buckets per user/IP/route
  - headers correct
  - clock injection deterministic
  - fail-closed option

### 2. Sandbox Policy Hardening

Current state:

- Workspace containment and patch approval exist.
- Command model allows fake/local/shell kinds but local execution is effectively mocked/default-safe.

Planned work:

- Add explicit `SandboxPolicy`:
  - allowed command names
  - denied command patterns
  - allowed cwd roots
  - max stdout/stderr bytes
  - max runtime
  - network allowed false by default
  - secrets injection allowed false by default
- Enforce policy before operation mapping.
- Add command normalization:
  - no shell interpolation by default
  - args array only for local safe runner
  - reject `&&`, `|`, redirects unless explicitly allowed
- Add path checks:
  - normalize Windows/POSIX paths
  - reject symlink escape when possible
  - reject absolute paths unless allowlisted
- Add tests:
  - path traversal blocked
  - destructive command denied
  - output truncated and redacted
  - network/secrets disabled by default

### 3. Safe Local Runner Option

- Keep current fake runner as default.
- Add opt-in safe local runner for vetted commands only:
  - disabled unless config flag true
  - command allowlist required
  - timeout required
  - cwd must be contained
  - env allowlist only
- Add tests proving default local mode cannot execute real commands.

### 4. E2B Adapter Hardening

- Keep optional external-only behavior.
- Add adapter readiness check:
  - API key present
  - network mode explicit
  - timeout configured
- Add stream capture constraints:
  - cap stdout/stderr
  - truncation flags
  - redaction before trace/event persistence
- Add optional live smoke skipped by default.
- Fix/retain Property 21 stream-capture invariant if not already fixed in 042b.

### 5. Budget/Safety Gate Integration

- Ensure sandbox operations include runtime estimate/use.
- Ensure budget denial produces `NEEDS_DECISION` or safe fail, not unhandled exception.
- Add safety reason codes for UI/operator console.

## Tests

Run:

```bash
npm test
npm run build
npm audit
```

Target tests:

- `tests/rateLimiterHardening.test.ts`
- `tests/sandboxPolicyHardening.test.ts`
- `tests/safeLocalRunner.guard.test.ts`
- `tests/e2bAdapterHardening.test.ts`
- `tests/sandboxRedaction.property.test.ts`

## Acceptance Criteria

- Default local mode still cannot execute arbitrary shell.
- Rate limiting is extracted, deterministic, and per-user/per-route capable.
- Sandbox policies fail closed and are fully tested.
- E2B remains optional and live-smoke-gated.
- No secret leaks in sandbox/rate-limit errors.
- `npm test`, `npm run build`, and `npm audit` pass.

## Commit

Suggested commit:

```text
feat(chunk-042e): harden security and sandbox policy
```
