---
name: rector-ui-config
description: "This skill should be used when building or modifying Rector's web UI configuration panels — provider config panels, memory backend panels, theme customization, or any hassle-free UI-configurable feature. Covers the providerPanelHarness for DOM testing, config-to-runtime flow, the theme system, and the pattern for adding new configurable providers. Triggers on tasks like 'add config panel', 'UI for new provider', 'modify provider panel', 'theme system', or 'hassle-free configuration'."
---

# Rector UI Config

Build and extend Rector's hassle-free web UI configuration system.

## Purpose

Rector's vision is that users configure all providers and backends entirely through the web UI without editing files or environment variables. This skill encodes the patterns for building config panels, the data flow from UI to runtime, the vm-based DOM testing harness, and the theme system.

## When to Use

- Adding a config panel for a new provider or backend
- Modifying existing provider configuration UI
- Working with the theme system (adding themes, customization tokens)
- Writing DOM tests for UI components
- Understanding how config changes flow from browser to runtime

## Config Panel Architecture

### Two-Tier BYOK Modal Overlay

- **Basic Tier** — Preset provider cards (Together AI, Cloudflare, Azure OpenAI) with stable record IDs, static labels, and configurable non-secret fields (dotted paths for nested config)
- **Advanced Tier** — OpenAI-compatible endpoints: freeform form for any custom `/chat/completions` endpoint

### Provider Card Elements

Each card renders:
- **Status indicator:** `not-configured` (circle), `configured` (filled circle), `active` (star) — never conveyed by color alone (accessible)
- **Non-secret fields:** model id, base URL, endpoint (editable)
- **Masked API key input:** `type="password"` with show/hide toggle
- **Action buttons:** Save, Remove, Test connection, Active_Route_Map toggle
- **Connection test result:** ok/err states + 30s client-side abort timeout

### Secrets Handling

- Secrets are **write-once** — upsert body includes `apiKey` ONLY when non-empty value entered
- Saving other fields without re-entering key never clears the stored secret
- After save, key input is cleared from DOM
- Server never returns raw secret values

## Data Flow: UI to Runtime

```
Browser (src/public/app.js)
  |  POST /api/providers { id, kind, label, ...fields, apiKey? }
  |  POST /api/providers/active { role, providerId }
  v
API Server (src/api/server.ts)
  |  Record -> ProviderConfigStore (providers.json, atomic write)
  |  Secret -> SecretStore (encrypted on disk via secretRef)
  v
ConfigBridge (src/providers/configBridge.ts)
  |  resolveProviderEnv(): records + secrets -> effective env map
  |  buildConfiguredRouter(): constructs LLMProvider instances + ModelRouter
  v
ModelRouter.select(input) -> ModelSelection { provider, model, reason }
```

### Key Principles

1. **Persisted UI config wins** over ambient env vars (explicit user choice > environment)
2. **Secret separation** — records hold `secretRef` keys, never raw values
3. **Sandbox isolation** — effective env (with secrets) NEVER forwarded to sandbox executor
4. **Active_Route_Map** — `role -> providerId` map (`flagship`/`slm`) for capability-tier designation
5. **Local mode refusal** — local mode constructs NO external provider, reads NO secret

## Adding a New Configurable Provider

### Step 1: Frontend (`src/public/app.js`)

Add to `PROVIDER_CONFIG_PRESETS` array:

```javascript
{
  id: "my-provider",
  kind: "my-provider",
  label: "My Provider",
  fields: [
    { key: "baseUrl", label: "Base URL", placeholder: "https://api.example.com/v1" },
    { key: "model", label: "Model ID", placeholder: "gpt-4" },
    { key: "custom.nested", label: "Nested Config", placeholder: "value" },
  ]
}
```

Fields support **dotted paths** for nested config (e.g., `"azure.endpoint"` maps to `record.azure.endpoint`).

### Step 2: Server (`src/api/server.ts`)

Add the id to `SUPPORTED_PROVIDER_IDS` so the API accepts it.

### Step 3: Config Schema (`src/providers/config.ts`)

Add to `PROVIDER_KINDS` and define any provider-specific schema.

### Step 4: ConfigBridge (`src/providers/configBridge.ts`)

Wire `overlayRecord()` and `buildProviderFromRecord()` for the new kind.

### Step 5: Discovery Adapter (optional)

If the provider supports model enumeration, create a discovery adapter in `src/providers/discovery/adapters/`.

### Step 6: DOM Tests

The `providerPanelHarness` handles any provider id generically — tests verify status/save/test/timeout behavior without provider-specific logic.

## DOM Testing with providerPanelHarness

### Setup

```typescript
import { createProviderPanelHarness } from "./support/providerPanelHarness";

const harness = createProviderPanelHarness();
```

### Harness Interface

```typescript
interface ProviderPanelHarness {
  sandbox: any;                    // vm global — top-level functions reachable
  getEl(id: string);               // Look up fake element by id
  openPanel();                     // Calls openProviderTest()
  selectProvider(id: string);      // Ticks checkbox and fires change event
  runTest();                       // Triggers runProviderTest(), returns promise
  setFetchHandler(handler);        // Override the fetch double
}
```

### How It Works

- Loads `src/public/app.js` into a Node.js `vm.createContext` sandbox
- `FakeElement` class: minimal DOM (querySelector, classList, dataset, style, events, tree)
- `fakeDocument`: getElementById (Map-backed), createElement, querySelector
- Injectable `fetch` double (defaults to empty-body 200 responses)
- Host-delegating timers (setTimeout/clearTimeout/setInterval/clearInterval) — vitest fake timers work

### Test Patterns

```typescript
// Test connection timeout
harness.setFetchHandler(async () => {
  await new Promise(resolve => setTimeout(resolve, 35_000)); // Exceed 30s
  return new Response("", { status: 200 });
});
harness.openPanel();
harness.selectProvider("together");
const testPromise = harness.runTest();
vi.advanceTimersByTime(30_000); // Deterministic timeout
await testPromise;
expect(harness.getEl("test-result").textContent).toContain("timeout");

// Test save flow
harness.setFetchHandler(async (url, opts) => {
  if (url.includes("/api/providers") && opts.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return new Response("", { status: 200 });
});
```

## Theme System

### Architecture

- **5 themes:** `halo` (default), `aether`, `cairn`, `penumbra`, `vellum`
- Each theme: single CSS file at `src/public/styles/themes/<name>.css`
- **Lazy loading:** single `<link id="theme-stylesheet">` with href swapped at runtime
- **No-flash boot:** inline `<script>` reads localStorage before first paint

### Runtime API (`window.RectorTheme`)

```javascript
RectorTheme.applyTheme("aether");
RectorTheme.setAccent("#ff6600");
RectorTheme.setDensity("compact");      // "comfortable" | "compact"
RectorTheme.setFontScale("large");      // "small" | "medium" | "large"
RectorTheme.setReducedMotion(true);
RectorTheme.resetCustomizations();
RectorTheme.getAppearance();            // Returns full state
RectorTheme.hydrate();                  // Restore from localStorage
```

### Persistence (localStorage key: `rector.appearance`)

```json
{
  "theme": "halo",
  "accents": { "halo": "#ff0000", "aether": "#00ff00" },
  "density": "compact",
  "fontScale": "large",
  "reducedMotion": true
}
```

Accents are per-theme — switching themes preserves each theme's custom accent.

### Customization Tokens

- `--density-scale` (1 = comfortable, 0.85 = compact) — applied to `--space-*` tokens via `calc()`
- `--font-scale` (0.9/1/1.15) — scales `--fs-base`
- `data-reduced-motion="true"` — honored by CSS to disable animation

### Theme Testing with themeDoubles

```typescript
import { createFakeRoot, createFakeStorage, createFakeLink, getThemeFactory } from "./support/themeDoubles";

const root = createFakeRoot();           // data-theme/data-reduced-motion + inline custom props
const storage = createFakeStorage();     // Map-backed localStorage (optional throw-on-read)
const link = createFakeLink();           // Single <link> whose href is swapped
const createTheme = getThemeFactory();   // Gets globalThis.createRectorTheme

const theme = createTheme({ root, storage, link });
theme.applyTheme("cairn");
expect(root.getAttribute("data-theme")).toBe("cairn");
expect(link.getAttribute("href")).toContain("cairn.css");
```

## Design Principles

| Principle | Implementation |
|-----------|---------------|
| Hassle-free | All config via web UI; no env/file editing required |
| Secret safety | Write-once, masked, never returned from server, never in browser storage |
| Non-rigid/pluggable | Zod schemas, kind-based dispatch, injectable doubles |
| Local-first baseline | Local mode = FakeLLMProvider only, no secrets, no network |
| Accessibility | Status never by color alone; icon + label text; ARIA attributes |
| Zero-dependency testing | vm-based harness, fake DOM, injectable fetch, host-delegating timers |
| Atomic persistence | temp-file + rename pattern in configStore and secretStore |

## Reference Files

- `references/ui-patterns.md` — Detailed frontend code patterns, element IDs, and event handling
