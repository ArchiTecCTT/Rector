# Security Constraints

These are hard constraints for Rector. Recent audit fixes hardened several of these; do not
regress them.

## Secrets and Redaction

- Never log, print, or echo secret values (API keys, tokens, passwords, DSNs, credential
  URIs). Reference secrets by key name, not value.
- Redaction must support **camelCase** secret keys (e.g. `githubToken`, `dbPassword`,
  `awsSecretAccessKey`, `sessionCookie`) in addition to snake_case and kebab-case. This was
  fixed in `src/security/redaction.ts`; keep the regression tests in `tests/security.test.ts`
  passing.
- Credential URI redaction must redact **all userinfo before `@`**, covering both
  `username:password@host` and **username-only** forms like `mongodb://token@host/db`.
- Use deployment redaction helpers (`redactDeploymentConfig()` /
  `createDeploymentReadinessReport()`) before logging any config.

## Providers and Network

- External providers are **disabled by default**. Live calls require explicit config plus an
  `enableNetwork`-style opt-in flag.
- The budget gate must run **before** any provider invocation.
- No unmocked network in tests. All provider/integration tests mock `fetch` and assert no
  network where appropriate.

## Operator API

- The operator API (`/api/operator/*`) is **local-only and unauthenticated** (`localOnly: true`,
  `auth: local-only-no-auth`). It must not be exposed beyond trusted local development.
- The dev server defaults to `HOST=127.0.0.1`. Do not bind to a wildcard host by default.
- Any flagging of network-exposed endpoints without auth must call out the security
  implication explicitly.

## Sandbox and Execution

- The safe sandbox denies arbitrary shell by default; only allowlisted fake/local commands run.
- It is a contract + allowlist, **not** a real isolation boundary. Do not present it as
  production sandboxing.
- Patch artifacts must use **safe relative paths** (no absolute paths, no `..` traversal).
- File writes require approval metadata. E2B/Depot are no-network stubs.

## Healing and Risk

- High-risk, destructive, or approval-required work must not be auto-healed. Such failures
  escalate to `NEEDS_DECISION` (`isUnsafeToAutoHeal` treats `risk: "high"` like destructive work).

## Open / Tracked Security Items

Document and track these in `docs/plans/concerns-and-vulnerabilities.md`; do not silently
"fix" them with unsafe shortcuts:

- Dependency audit vulnerabilities, including `esbuild <=0.24.2` (DNS rebinding advisory
  GHSA-67mh-4wv8-2f99) via dev tooling. Prefer safe upgrades/overrides; do not run
  `npm audit fix --force` without explicit user approval.
- Operator API has no auth/RBAC/CSRF/audit yet.
- Local store is in-memory only.
- Provider/workflow/deployment integrations are stubs/contracts.
- Real sandbox isolation is not implemented.

## Updating the Concerns Register

Whenever you discover or introduce a dependency vulnerability, secret/PII leakage risk,
sandbox risk, provider/budget risk, stale/confusing docs, test gap, or production-hardening
limitation, add it to `docs/plans/concerns-and-vulnerabilities.md` with source, severity,
status, and plan.
