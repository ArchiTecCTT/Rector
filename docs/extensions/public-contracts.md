# Public Extension Contracts

Rector exposes a light alpha extension contract surface for contributors. These contracts are schema-first, typed, and provider-free by default.

## Import

After building the package, public extension contracts are exported from:

```ts
import {
  PUBLIC_EXTENSION_API_VERSION,
  ExtensionManifestSchema,
  assertExtensionCompatibility,
  type LlmExtension,
  type MemoryExtension,
  type SandboxExtension,
  type TelemetryExtension,
  type SearchExtension,
  type IssueTrackerExtension,
  type ValidatorExtension,
  type UiClientExtension,
} from "rector/extensions";
```

In-repo tests import the same module from `src/extensions`.

## API Version

Current version:

```ts
PUBLIC_EXTENSION_API_VERSION === "rector.extensions.v1alpha1"
```

Extension manifests must declare this exact `apiVersion` for the v0.1.0-alpha contract.

## Manifest

Every extension declares a manifest:

```ts
const manifest = ExtensionManifestSchema.parse({
  id: "local-sample",
  name: "Local Sample",
  version: "0.0.1",
  apiVersion: PUBLIC_EXTENSION_API_VERSION,
  networkAccess: false,
  capabilities: [
    { point: "llm", operations: ["invoke"] },
    { point: "validator", operations: ["validate"] },
  ],
});
```

Compatibility checks reject unsupported API versions and missing required capabilities:

```ts
assertExtensionCompatibility(manifest, {
  requiredCapabilities: ["llm", "validator"],
});
```

## Extension Points

Current alpha extension points:

| Point | Interface | Purpose |
|---|---|---|
| `llm` | `LlmExtension` | Estimate and invoke a local/model provider contract. |
| `memory` | `MemoryExtension` | Upsert/search local memory documents. |
| `sandbox` | `SandboxExtension` | Execute a sandbox command contract and return no-network execution results. |
| `telemetry` | `TelemetryExtension` | Capture structured telemetry events. |
| `search` | `SearchExtension` | Index/search local documents. |
| `issueTracker` | `IssueTrackerExtension` | Create/list issue records. |
| `validator` | `ValidatorExtension` | Validate artifacts and return findings. |
| `uiClient` | `UiClientExtension` | Send user-facing UI notifications. |

### LLM Extension Specification (`LlmExtension`)

LLM extensions provide text generation/completion and token/cost estimation capabilities.

#### Model Resolution Behavior
When executing either `estimate` or `invoke` on an `LlmExtension`, the `request.model` property in `ExtensionLlmRequest` is optional. 
- If `request.model` is provided, the extension should attempt to use that specified model.
- If `request.model` is **absent** (undefined), the LLM extension must choose and fall back to its own default model internally to process the request.


## Local / No-Network Rule

Chunk 20 does not add a plugin loader, runtime isolation, or live integrations. The manifest schema currently requires `networkAccess: false`, and sandbox results require `networkCalls: 0`. Real hosted extension loading, permissions, signing, and network policy enforcement are future production work.
