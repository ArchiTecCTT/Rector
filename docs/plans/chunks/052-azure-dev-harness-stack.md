# Chunk 052 — Azure Dev Harness Stack

**Status:** DONE  
**Branch:** `rector-0.3.0`  
**Goal:** Wire opt-in Azure Blob evidence sync, Key Vault `SecretStore` backing, and Application Insights telemetry for daily Grok Build dev — without changing the local/`npm test` zero-network baseline.

## Azure resources (rg-rector-dev, southeastasia)

| Resource | Name | Notes |
|---|---|---|
| Storage account | `stgrectordev` | Containers: `harness-evidence`, `cartographer`, `backups` (pre-existing) |
| Key Vault | `kv-rector-dev` | CLI user access policy; secrets seeded |
| Log Analytics | `log-rector-dev` | Created in this chunk |
| Application Insights | `appi-rector-dev` | Workspace-based; foundational-service usage |

Auth: `az login` user credentials (`DefaultAzureCredential`). VM managed identity deferred.

## Code delivered

- `src/azure/evidenceSync.ts` + `scripts/azure/sync-evidence.ts` — `npm run evidence:sync` gated by `RECTOR_EVIDENCE_SYNC=azure-blob`
- `src/security/azureKeyVaultStore.ts` + `src/security/secretStoreFactory.ts` — `RECTOR_SECRET_STORE=azure-key-vault`
- `src/observability/appInsightsAdapter.ts` — `APPLICATIONINSIGHTS_CONNECTION_STRING`; harness events from eval scripts
- `forwardObservabilityTrace` wired in `runOrchestratedChatRun` finally block
- Tests: `azureEvidenceSync`, `azureKeyVaultStore`, `secretStoreFactory`, extended `telemetryAdapters`

## Daily Grok Build usage

```bash
az login
direnv allow
npm run azure:daily-touch    # KV + Blob + App Insights (one command)
npm run dev                # Foundry via models; KV when RECTOR_SECRET_STORE=azure-key-vault
npm run eval:capabilities
npm run evidence:sync
npm run cartographer:self-scan && npm run cartographer:sync
```

See `AGENTS.md` § Azure Daily Ritual and `.grok/skills/rector-azure-daily-ritual/SKILL.md`.

## Verification

- `npm test`: 367 files passed (2534 tests)
- `npm run build`: pass
- CI unchanged when Azure env vars unset

## Deferred

- UI `runtime-settings.json` for Azure providers
- VM managed identity on `ornyx-1`
- Marketplace app `strectorddev` cleanup
- Blob RBAC propagation (Storage Blob Data Contributor assigned; smoke upload may need a few minutes)