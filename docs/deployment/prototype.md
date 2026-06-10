# Deployment Prototype — v0.1.0-alpha (HISTORICAL)

**STATUS: HISTORICAL.** This described early alpha prototype deployment shapes (Heroku etc.) under the old local-first MVP vision.

For the current cloud-capable transition (hassle-free VPS/cloud product with web-UI configuration for providers, memory backends like local/Mem0/TiDB, etc.):
- See `.kiro/specs/cloud-capable-transition/`
- See `docs/architecture/current-rector-byok-architecture.md`
- Real deployment will emphasize UI-driven config and pluggable non-rigid backends.

Original content (kept for reference only):

Rector alpha remains local-first. This document describes deploy-shaped configuration only. It does not perform Heroku, Cloudflare, MongoDB, Redis, Chroma, Sentry, or PostHog network actions.

## Backend prototype: Heroku

Suggested shape for a later Heroku backend app:

- Runtime: Node.js 22.5.0+ (`node:sqlite` is used by the local persistence path).
- Start command: `npm run build && node dist/index.js` or a release-specific equivalent.
- Required local defaults: `NODE_ENV=production`, `PORT` supplied by Heroku.
- Optional app metadata: `DEPLOYMENT_TARGET=heroku`, `HEROKU_APP_NAME`, `HEROKU_RELEASE_VERSION`.
- Optional public URLs: `PUBLIC_APP_URL`, `API_BASE_URL`.

Prototype env keys:

```env
DEPLOYMENT_TARGET=heroku
NODE_ENV=production
PORT=3000
HEROKU_APP_NAME=rector-alpha
HEROKU_RELEASE_VERSION=
PUBLIC_APP_URL=https://rector-alpha.example.com
API_BASE_URL=https://rector-alpha.example.com
```

## Optional frontend/proxy prototype: Cloudflare

Cloudflare is optional and placeholder-only for alpha:

- Cloudflare Pages may host future static UI assets.
- Cloudflare proxy/DNS may front the Heroku backend.
- Cloudflare Workers are not required by this chunk.
- No API calls or deploy automation are included.

Prototype env keys:

```env
DEPLOYMENT_TARGET=cloudflare
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_PROJECT_NAME=rector-ui
CLOUDFLARE_PROXY_ENABLED=false
PUBLIC_APP_URL=https://rector.example.com
API_BASE_URL=https://api.rector.example.com
```

## Optional backing services

All backing services remain optional. The current alpha code validates and redacts configuration, but does not connect these services here.

```env
MONGO_URI=mongodb://localhost:27017/rector
MONGO_DB=rector_core
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000
CHROMA_API_KEY=
```

Production use still needs durable adapters, migrations, connection health checks, retry policy, backups, and secret management.

## Optional telemetry placeholders

Observability exporters are placeholder/no-op unless a later chunk wires real SDKs behind explicit approval.

```env
SENTRY_DSN=
POSTHOG_API_KEY=
POSTHOG_HOST=https://app.posthog.com
```

Use `redactDeploymentConfig()` or `createDeploymentReadinessReport()` before logging config. These helpers redact API keys, DSNs, tokens, passwords, and credential-bearing URLs.

## Graceful shutdown

The runtime installs the shared graceful shutdown helper for `SIGINT` and `SIGTERM`:

1. Stop accepting new HTTP connections via `server.close()`.
2. Wait for the close callback or timeout.
3. Exit with `0` on clean close or `1` on timeout/error.

The helper is injectable and unit-tested without killing the test process.

## Validation commands

```bash
npm test -- tests/deployment.test.ts
npm test
npm run build
```
