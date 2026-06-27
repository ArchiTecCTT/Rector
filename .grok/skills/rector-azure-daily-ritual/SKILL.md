---
name: rector-azure-daily-ritual
description: "MUST USE at the start of Grok Build / coding-agent sessions on the Rector VM when Azure Founders Hub 5-service daily usage is the goal. Covers az login, npm run azure:daily-touch, harness sync, cartographer sync, and Azure MCP namespaces (storage, keyvault, monitor, foundry). Triggers: daily ritual, azure touch, founders hub, start session, evidence sync."
metadata:
  project: rector
  workflow: azure-daily-ritual
---

# rector-azure-daily-ritual

Five Azure services count toward Founders Hub daily usage when building Rector with Grok Build:

| Service | How it is touched |
|---|---|
| VM (`ornyx-1`) | Grok Build runs on the dev VM (automatic) |
| Foundry / Azure OpenAI | Model calls during agent sessions (automatic) |
| Blob (`stgrectordev`) | `npm run azure:daily-touch` or `npm run evidence:sync` |
| Key Vault (`kv-rector-dev`) | `npm run azure:daily-touch` lists secrets; `RECTOR_SECRET_STORE=azure-key-vault` on `npm run dev` |
| App Insights (`appi-rector-dev`) | `npm run azure:daily-touch` heartbeat; `npm run dev` + harness scripts when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set |

## Session start checklist (agent-executable)

Run at the beginning of each coding session (after `direnv allow` / `.envrc` loaded):

```bash
az account show >/dev/null 2>&1 || az login
npm run azure:daily-touch
```

If cartographer artifacts are stale or missing:

```bash
npm run cartographer:self-scan
npm run cartographer:sync
```

After harness runs:

```bash
npm run eval:capabilities    # optional
npm run test:global            # optional
npm run evidence:sync          # when RECTOR_EVIDENCE_SYNC=azure-blob
```

## Required env (`.envrc` on dev VM)

```bash
export AZURE_STORAGE_ACCOUNT_NAME="stgrectordev"
export AZURE_STORAGE_CONTAINER_HARNESS="harness-evidence"
export AZURE_STORAGE_CONTAINER_CARTOGRAPHER="cartographer"
export AZURE_KEY_VAULT_URL="https://kv-rector-dev.vault.azure.net/"
export APPLICATIONINSIGHTS_CONNECTION_STRING="..."
export RECTOR_EVIDENCE_SYNC="azure-blob"
export RECTOR_SECRET_STORE="azure-key-vault"   # optional; touches KV on npm run dev
```

Auth: `az login` user credentials (`DefaultAzureCredential`). No VM managed identity.

## Azure MCP (Grok Build)

Server name: `azure` (stdio: `@azure/mcp`). Useful namespaces:

- `storage` — list containers, verify uploads on `stgrectordev`
- `keyvault` — list/get secrets (user confirmation for sensitive reads)
- `monitor` / App Insights — query recent `rector.azure.daily_touch` events
- `foundry` — deployments and endpoints

Example prompts:

- "List blobs in harness-evidence on stgrectordev"
- "List secrets in kv-rector-dev"
- "Query App Insights for rector.azure.daily_touch in the last hour"

## Do not

- Use Confidential Ledger marketplace app `strectorddev` (accidental install; ignore)
- Commit `.envrc` (gitignored; contains secrets)
- Enable Azure sync in CI — all Azure features are opt-in and offline-safe when env unset