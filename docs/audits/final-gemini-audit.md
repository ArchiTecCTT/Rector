# Final Gemini Audit — Confirmed Findings

Date: 2026-06-03
Scope: full `rector-0.1.0` worktree after roadmap chunks 0–25.

Four `google-vertex/gemini-3.5-flash` reviewers audited security, correctness, tests/performance, and release/deployment/package readiness. Findings below are only issues the reviewers reported as valid or directly verifiable.

## Fixed after audit

### CamelCase secret keys bypassed redaction

- **Impact:** secret-like keys such as `githubToken`, `dbPassword`, `awsSecretAccessKey`, and `sessionCookie` could remain unredacted.
- **Fix:** `src/security/redaction.ts` now normalizes key names and detects compact sensitive tokens across camelCase/snake/kebab keys.
- **Regression tests:** `tests/security.test.ts` covers camelCase secret-key redaction.

### Username-only credential URIs bypassed redaction

- **Impact:** connection strings like `mongodb://token@host/db` were not redacted by generic `redactString`.
- **Fix:** credential URI redaction now redacts any userinfo before `@`, not only `username:password` pairs.
- **Regression tests:** `tests/security.test.ts` covers username-only credential URI redaction.

### Dev server could bind to all network interfaces

- **Impact:** local/no-auth APIs could be reachable from LAN if the server listened on the wildcard host.
- **Fix:** server bootstrap moved to `src/bin/server.ts` and defaults to `HOST=127.0.0.1`; `.env.example` documents this.
- **Remaining concern:** operator APIs are still unauthenticated and must not be exposed beyond trusted local development; tracked in `docs/plans/concerns-and-vulnerabilities.md`.

### Side-effectful root package import

- **Impact:** package root import would have started the HTTP server if exported.
- **Fix:** `src/index.ts` is now export-only; executable bootstrap lives in `src/bin/server.ts`.

### Missing root package export / broken ESM dist imports

- **Impact:** `import "rector"` did not work; after adding exports, TypeScript emitted extensionless ESM imports that Node could not resolve.
- **Fix:** `package.json` now exports `.` and public submodules; build runs `scripts/fix-dist-esm-imports.js` after `tsc` to make emitted relative ESM imports Node-resolvable.
- **Verification:** `node -e "import('rector')"` and `node -e "import('rector/sandbox')"` pass after build.

### Empty DAG clarification flow marked failed

- **Impact:** clarification/zero-task flows could execute as `SKIPPED` but validate as `FAILED`, producing bad user-facing status.
- **Fix:** validation/healing now treats `SKIPPED` execution with no classified failures as `VALIDATED`.
- **Regression tests:** `tests/validationHealing.test.ts` covers empty DAG validation.

### High-risk tasks could be auto-healed

- **Impact:** high-risk task timeout/transient failures could be retried by the healing loop without human decision.
- **Fix:** `isUnsafeToAutoHeal` treats `risk: "high"` like destructive/approval-required work and returns `NEEDS_DECISION`.
- **Regression tests:** `tests/validationHealing.test.ts` covers high-risk failure decision escalation.

### Executor reported dependency cascade with zero successes as PARTIAL

- **Impact:** a failed root node with only skipped downstream nodes looked partially successful despite zero successful nodes.
- **Fix:** `dagStatus` now returns `FAILED` when failures exist and successful node count is zero.
- **Regression tests:** updated executor and E2E expectations.

### Rate-limit reset test timing flake

- **Impact:** real-time 50ms window could flake in slow CI.
- **Fix:** expanded test window/buffer to reduce scheduler sensitivity.

### Missing `MAKE_WEBHOOK_SECRET` setup checklist item

- **Impact:** setup diagnostics omitted a documented workflow secret.
- **Fix:** added to `SETUP_ITEMS` and sensitive-key display.
- **Regression tests:** `tests/releasePackaging.test.ts` covers it.

### Missing `npm run check`

- **Impact:** agent/developer docs referenced check command that did not exist.
- **Fix:** package script `check: tsc --noEmit` added.

### Static public directory resolved from `process.cwd()` only

- **Impact:** server static UI could break when started outside repo root.
- **Fix:** `resolvePublicDir()` now resolves relative to module location first, with source/dev fallback.

## Still open / tracked

### Dependency audit vulnerabilities

- **Confirmed:** audit highlighted vulnerable `esbuild <=0.24.2` via dev tooling and DNS rebinding advisory GHSA-67mh-4wv8-2f99.
- **Status:** Open in `docs/plans/concerns-and-vulnerabilities.md`.
- **Planned fix:** upgrade `vitest`/`tsx` or add safe override for `esbuild >=0.25.0`; avoid blind force fixes.

### Synthesizer lacks isolated unit tests

- **Status:** Not yet fixed. E2E tests cover synthesis, but direct unit tests would lock response formatting and status fallbacks.

### Contributor issue generator uses child processes in tests

- **Status:** Not fixed. Tests pass, but `tests/contributorIssues.test.ts` can be faster if the generator exports an in-process runner.

### Operator API still no-auth local-only

- **Status:** Expected alpha limitation. Host defaults to loopback now, but production/shared deployment still requires auth/RBAC/CSRF/audit controls.

## Final verification commands

Run after applying fixes:

```bash
npm test
npm run build
npm run check
node -e "import('rector').then(m=>console.log(typeof m.createApp))"
node -e "import('rector/sandbox').then(m=>console.log(typeof m.SafeLocalSandboxAdapter))"
```
