# First-Run Setup

Use this path for new Rector installs. The product is **configured orchestration** — you complete guided setup before chat unlocks.

## What to expect

1. Start the server (`npm run dev` or your deployment).
2. Open `http://localhost:3000` (or your host).
3. An **uncloseable onboarding overlay** appears until setup is complete.
4. Configure providers, memory, sandbox, and budget through the web UI.
5. When readiness checks pass, chat unlocks and runs live orchestration.

There is **no fake demo chat** and no provider-free product path. Tests use `SpyLLMProvider` doubles in CI only.

## Prerequisites

- Node.js 22.5.0 or newer
- npm 10 or newer
- At least one LLM provider API key (Together AI, Azure OpenAI, Cloudflare Workers AI, or OpenAI-compatible endpoint)

## Install

```bash
npm install
```

## Verify (contributors / CI)

```bash
npm test
npm run build
npm audit
```

`npm test` uses in-memory stores and `SpyLLMProvider` — no live provider keys required for the test suite. `npm audit` must stay clean before pushing so dependency regressions are caught locally before CI.

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000` and complete the onboarding wizard.

## Configuration source of truth

Product state is persisted at:

```text
.rector/runtime-settings.json
```

Written by the setup UI — not by hand-editing `.env` for normal use.

| Field | Meaning |
| --- | --- |
| `orchestrationProfile: "unconfigured"` | Setup incomplete; chat gated |
| `orchestrationProfile: "configured"` | Setup complete; chat unlocked |

Related UI-managed stores:

- `.rector/providers.json` — provider records (no secrets)
- `.rector/secrets.enc` — encrypted API keys
- `.rector/orchestration-assignments.json` — per-role model routing
- `.rector/memory-assignments.json` — per-role memory providers

## Setup checklist

Complete each category in the onboarding overlay:

| Category | What to configure |
| --- | --- |
| **Provider** | Add at least one BYOK provider; run connection test |
| **Persistence** | SQLite (recommended for local/VPS) or TiDB Cloud |
| **Workspace** | Local sandbox or E2B for isolated execution |
| **Memory** | SQLite/local, Mem0, Chroma, or other supported backend |
| **Budget** | Cumulative spend limits (defaults are safe) |

Optional: apply a **preset template** (e.g., BYOK Starter) to pre-fill assignments.

## After setup

- Chat dispatches through `runOrchestratedChatRun` with your configured providers.
- The symbolic brainstem (triage → plan → skeptic → crucible → execute → heal → synthesize) runs beneath every message.
- Open the trace drawer to inspect run events, costs, and evidence.

## Advanced / deprecated

`ORCHESTRATOR_MODE` env var is **deprecated**. It exists only for one-time migration from older installs and advanced operator overrides. New installs should configure everything through the UI.

For contributor test-only workflows (no UI), see the redirect banner in [`provider-free-quickstart.md`](./provider-free-quickstart.md).

## Related docs

- [`docs/architecture/configured-product-architecture.md`](../architecture/configured-product-architecture.md) — canonical architecture
- [`docs/README.md`](../README.md) — documentation index