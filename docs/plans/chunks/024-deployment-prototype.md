# Chunk 24 — Deployment Prototype

## Goal

Add a no-network deployment prototype for the alpha release: documented Heroku backend shape, optional Cloudflare frontend/proxy notes, typed environment validation/redaction helpers, and a reusable graceful shutdown helper.

## Scope

Implement only local, deterministic deployment support:

- Deployment environment schema and parser for local/Heroku/Cloudflare prototype configuration.
- Optional config fields for MongoDB, Redis, Chroma, Sentry, and PostHog.
- Redacted config/report helper safe for logs and support bundles.
- Graceful shutdown helper for HTTP servers with idempotent shutdown, signal install/uninstall, timeout handling, and injectable exit/logger behavior for tests.
- Deployment documentation for Heroku backend and optional Cloudflare frontend/proxy setup placeholders.
- `.env.example` entries for deployment prototype variables.
- Unit tests for env validation, config redaction, and graceful shutdown behavior.
- Concerns register update documenting deployment prototype limitations.

## Out of Scope

- Real Heroku, Cloudflare, MongoDB, Redis, Chroma, Sentry, or PostHog network calls.
- CI/CD pipeline execution or provider credentials.
- Production auth, durable persistence wiring, cache/vector adapter implementation, or hosted release automation.
- Cloudflare Worker/Pages implementation beyond documented placeholder config.
- Production process manager replacement.

## Design

Add `src/deployment/index.ts` exporting:

- `DEPLOYMENT_API_VERSION`.
- `DeploymentEnvironmentSchema` and `DeploymentConfigSchema`.
- `parseDeploymentEnvironment(env)` / `buildDeploymentConfig(env)` to normalize env values without side effects.
- `redactDeploymentConfig(config)` to redact keys and credential-bearing URLs before logging.
- `createDeploymentReadinessReport(config)` to expose target, configured optional services, and redacted config.
- `createGracefulShutdownHandler(options)` for HTTP-server shutdown with signal handling and test-friendly injected process/exit/logger functions.

Update `src/index.ts` to parse deployment config and install graceful shutdown for the existing HTTP server. Keep local defaults unchanged.

## Test Plan

Follow TDD:

1. Add failing tests for valid local/Heroku-style env parsing and invalid URLs/ports.
2. Add failing tests proving redaction hides secrets and credential-bearing URIs.
3. Add failing tests for graceful shutdown idempotency, close callback handling, signal install/uninstall, and timeout error path.
4. Implement the deployment module and wire server startup.
5. Run focused deployment tests.
6. Run full `npm test` and `npm run build`.

## Acceptance Criteria

- Deployment helpers perform no network or deploy actions.
- Local contributor setup remains default and provider-free.
- Heroku/Cloudflare/dependency env variables are documented and optional.
- Invalid deployment config fails with clear validation errors.
- Redacted config can be logged without exposing API keys, tokens, passwords, DSNs, or credential-bearing URLs.
- Graceful shutdown can be installed by the runtime and unit-tested without killing the test process.
