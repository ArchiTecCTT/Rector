# Chunk 7: Budget, Security, and Redaction Baseline

Status: implemented

Scope:
- Add deterministic budget policy evaluation helper.
- Add deterministic redaction utility for secret-looking keys and credentialed URIs.
- Integrate redaction into practical API payload paths without changing provider behavior.
- Add manual CORS allowlist middleware and dev behavior.
- Add basic in-memory rate limiting for chat POST endpoints.
- Cover with tests and update concerns register for deferred risks.

Verification:
- `npm test` — 10 files / 107 tests passed.
- `npm run build` — TypeScript compile passed.
