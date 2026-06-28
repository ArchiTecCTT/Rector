# Provider-Free Local Quickstart

> **REDIRECT — pre-v0.3.0.** This quickstart described the provider-free local demo as the default product path.  
> **Use instead:** [`first-run-setup.md`](./first-run-setup.md) for guided setup and the configured product model.  
> **Canonical architecture:** [`../architecture/configured-product-architecture.md`](../architecture/configured-product-architecture.md)

---

## Historical note

Before v0.3.0, contributors could run Rector without API keys using `ORCHESTRATOR_MODE=local` and a deterministic fake pipeline. That path is **no longer the product default**.

- **Product:** configured orchestration with mandatory first-run onboarding.
- **CI/tests:** `SpyLLMProvider` doubles only — see `npm test`.
- **Env knob:** `ORCHESTRATOR_MODE` is deprecated; use UI setup and `runtime-settings.json`.

The commands below still work for **test verification** but do not represent the user-facing product.

## Prerequisites

- Node.js 22.5.0 or newer
- npm 10 or newer

## Install

```bash
npm install
```

## Verify (CI / test doubles)

Run all three before pushing so local checks catch test, build, and dependency-audit failures before CI.

```bash
npm test
npm run build
npm audit
```

## Run locally (legacy)

```bash
npm run dev
```

Without completing UI setup, you will see the mandatory onboarding overlay (v0.3.0+), not a provider-free chat demo.

## Environment files

A `.env` file is optional for test verification. Do not commit `.env` or secrets.

For normal use, configure providers through the web UI. See [`first-run-setup.md`](./first-run-setup.md).