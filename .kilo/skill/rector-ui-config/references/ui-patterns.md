# UI Patterns Reference

## Provider Config Panel — Element IDs and Structure

### Panel Container

```html
<div id="provider-panel" class="modal-overlay" hidden>
  <div class="panel-content">
    <h2>Provider Configuration</h2>
    <div id="provider-cards">
      <!-- One card per PROVIDER_CONFIG_PRESETS entry -->
    </div>
    <div id="advanced-provider-section">
      <!-- OpenAI-compatible custom endpoint form -->
    </div>
  </div>
</div>
```

### Per-Provider Card

```html
<div class="provider-card" data-provider-id="{id}">
  <div class="provider-header">
    <span class="provider-status" data-status="not-configured|configured|active">
      <!-- Status icon (never color-only) -->
    </span>
    <span class="provider-label">{label}</span>
  </div>
  <div class="provider-fields">
    <!-- Dynamic fields from PROVIDER_CONFIG_PRESETS[].fields -->
    <input id="field-{id}-{key}" type="text" placeholder="{placeholder}">
  </div>
  <div class="provider-secret">
    <input id="secret-{id}" type="password" placeholder="API Key">
    <button class="toggle-visibility">Show/Hide</button>
  </div>
  <div class="provider-actions">
    <button id="save-{id}">Save</button>
    <button id="remove-{id}">Remove</button>
    <button id="test-{id}">Test Connection</button>
    <button id="activate-{id}">Set Active</button>
  </div>
  <div id="test-result-{id}" class="test-result" hidden>
    <!-- Connection test output -->
  </div>
</div>
```

## PROVIDER_CONFIG_PRESETS Format

```javascript
const PROVIDER_CONFIG_PRESETS = [
  {
    id: "together",
    kind: "together",
    label: "Together AI",
    fields: [
      { key: "model", label: "Model", placeholder: "meta-llama/Llama-3-70b-chat-hf" },
    ],
  },
  {
    id: "cloudflare",
    kind: "cloudflare",
    label: "Cloudflare Workers AI",
    fields: [
      { key: "cloudflare.accountId", label: "Account ID", placeholder: "abc123..." },
      { key: "model", label: "Model", placeholder: "@cf/meta/llama-3-8b-instruct" },
    ],
  },
  {
    id: "azure-openai",
    kind: "azure-openai",
    label: "Azure OpenAI",
    fields: [
      { key: "azure.endpoint", label: "Endpoint", placeholder: "https://my-resource.openai.azure.com" },
      { key: "azure.deploymentId", label: "Deployment ID", placeholder: "gpt-4-deployment" },
      { key: "azure.apiVersion", label: "API Version", placeholder: "2024-02-01" },
    ],
  },
];
```

## API Endpoints

### Save Provider Config

```
POST /api/providers
Content-Type: application/json

{
  "id": "together",
  "kind": "together",
  "label": "Together AI",
  "model": "meta-llama/Llama-3-70b-chat-hf",
  "apiKey": "sk-..."  // ONLY included when non-empty (write-once)
}
```

Response: `{ "ok": true }` or `{ "error": "..." }`

### Set Active Provider

```
POST /api/providers/active
Content-Type: application/json

{
  "role": "flagship",       // "flagship" | "slm"
  "providerId": "together"
}
```

### Test Connection

```
POST /api/providers/test
Content-Type: application/json

{
  "providerId": "together",
  "model": "meta-llama/Llama-3-70b-chat-hf"  // optional target
}
```

Response:
```json
{
  "ok": true,
  "latencyMs": 245,
  "model": "meta-llama/Llama-3-70b-chat-hf"
}
// or
{
  "ok": false,
  "error": "auth_invalid",
  "message": "Authentication failed (redacted)"
}
```

### Get Setup Status

```
GET /setup

Response:
{
  "providers": [
    { "id": "together", "kind": "together", "label": "Together AI", "configured": true, "active": true },
    ...
  ],
  "memory": { "kind": "local", "configured": true },
  "mode": "external"  // "local" | "external"
}
```

## Event Handling Patterns

### Connection Test with Client-Side Timeout

```javascript
async function runProviderTest(providerId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  setTestLoading(providerId, true);

  try {
    const response = await fetch("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
      signal: controller.signal,
    });
    const result = await response.json();
    showTestResult(providerId, result);
  } catch (error) {
    if (error.name === "AbortError") {
      showTestResult(providerId, { ok: false, error: "timeout", message: "Connection test timed out (30s)" });
    } else {
      showTestResult(providerId, { ok: false, error: "network", message: "Network error" });
    }
  } finally {
    clearTimeout(timeoutId);
    setTestLoading(providerId, false);
  }
}
```

### Save with Write-Once Secret

```javascript
async function saveProvider(providerId) {
  const record = collectFieldValues(providerId);
  const secretInput = document.getElementById(`secret-${providerId}`);
  const apiKey = secretInput?.value?.trim();

  // Only include apiKey if user entered a new value (write-once)
  if (apiKey && apiKey.length > 0) {
    record.apiKey = apiKey;
  }

  const response = await fetch("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });

  if (response.ok) {
    // Clear secret from DOM after successful save
    if (secretInput) secretInput.value = "";
    refreshProviderStatus();
  }
}
```

## Memory Provider Config Panel

Follows the identical pattern as LLM provider panels:

```javascript
const MEMORY_CONFIG_PRESETS = [
  {
    id: "local",
    kind: "local",
    label: "Local (In-Memory / SQLite)",
    fields: [
      { key: "storePath", label: "Database Path", placeholder: "./data/memory.sqlite" },
    ],
  },
  {
    id: "mem0",
    kind: "mem0",
    label: "Mem0 Cloud",
    fields: [],  // Only needs API key
  },
  {
    id: "tidb",
    kind: "tidb",
    label: "TiDB Cloud",
    fields: [
      { key: "host", label: "Host", placeholder: "gateway01.us-west-2.prod.aws.tidbcloud.com" },
      { key: "database", label: "Database", placeholder: "rector_memory" },
    ],
  },
  {
    id: "chroma",
    kind: "chroma",
    label: "Chroma",
    fields: [
      { key: "baseUrl", label: "URL", placeholder: "http://localhost:8000" },
      { key: "collection", label: "Collection", placeholder: "rector-memory" },
    ],
  },
];
```

## Accessibility Requirements

- Status indicators use icon + text label (never color alone)
- All interactive elements have ARIA attributes
- Keyboard navigation supported for all actions
- Focus management on panel open/close
- Error messages announced via aria-live regions
