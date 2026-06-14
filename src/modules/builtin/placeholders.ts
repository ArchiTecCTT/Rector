import type { ModuleRegistry } from "../registry";
import type { ModuleManifest } from "../manifest";
import { PUBLIC_MODULE_API_VERSION } from "../manifest";

/**
 * Provider and integration module manifests reserved for Chunk 040 extraction.
 */
const PROVIDER_PLACEHOLDER_MANIFESTS: ModuleManifest[] = [
  {
    id: "@rector/builtin/memory-cloud",
    name: "Cloud Memory Backends",
    version: "0.2.0",
    apiVersion: PUBLIC_MODULE_API_VERSION,
    description: "Mem0, TiDB, and Chroma memory provider factories (Chunk 040).",
    tier: "builtin",
    hooks: [],
    capabilities: [{ point: "memory", operations: ["upsert", "search"] }],
    defaultEnabled: true,
    externalModeOnly: false,
  },
  {
    id: "@rector/builtin/sandbox-e2b",
    name: "E2B Cloud Sandbox",
    version: "0.2.0",
    apiVersion: PUBLIC_MODULE_API_VERSION,
    description: "Optional E2B sandbox adapter for external mode (Chunk 040).",
    tier: "builtin",
    hooks: [],
    capabilities: [{ point: "sandbox", operations: ["execute"] }],
    defaultEnabled: true,
    externalModeOnly: true,
  },
  {
    id: "@rector/builtin/workflows",
    name: "Workflow Integrations",
    version: "0.2.0",
    apiVersion: PUBLIC_MODULE_API_VERSION,
    description: "Linear, Make, and related issue-tracker workflow stubs.",
    tier: "optional",
    hooks: [],
    capabilities: [{ point: "issueTracker", operations: ["create", "update"] }],
    defaultEnabled: true,
    externalModeOnly: false,
  },
  {
    id: "@rector/builtin/observability",
    name: "Observability Exporters",
    version: "0.2.0",
    apiVersion: PUBLIC_MODULE_API_VERSION,
    description: "Sentry, PostHog, and OpenTelemetry exporter adapters.",
    tier: "optional",
    hooks: [],
    capabilities: [{ point: "telemetry", operations: ["emit"] }],
    defaultEnabled: true,
    externalModeOnly: false,
  },
];

export function registerBuiltinPlaceholders(registry: ModuleRegistry): void {
  for (const manifest of PROVIDER_PLACEHOLDER_MANIFESTS) {
    registry.register({ manifest });
  }
}