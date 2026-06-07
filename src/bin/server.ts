import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { createApp } from "../api/server";
import { LocalTelemetry } from "../adapters/providers";
import {
  OrchestrationConfigError,
  createGracefulShutdownHandler,
  parseDeploymentEnvironment,
  parseOrchestrationConfig,
  type OrchestrationConfig,
} from "../deployment";
import { buildModelRouter } from "../providers/llm";
import { createLocalSecretStore } from "../security/secretStore";
import { createLocalProviderConfigStore } from "../providers/configStore";
import { TaskManager } from "../thalamus/router";

const deploymentConfig = parseDeploymentEnvironment();
const port = deploymentConfig.port;
const host = process.env.HOST?.trim() || "127.0.0.1";

// Resolve and validate the orchestration mode before serving (fail fast — Req 1.2). In local mode
// (the default) no provider is required. In external mode this throws OrchestrationConfigError when
// no supported provider validates; we log the redacted setup hint (never any secret value) and exit
// non-zero rather than starting in a misconfigured state.
let orchestrationConfig: OrchestrationConfig;
try {
  orchestrationConfig = parseOrchestrationConfig(process.env);
} catch (error) {
  if (error instanceof OrchestrationConfigError) {
    console.error(`Rector startup failed (${error.code}): ${error.message}`);
    console.error(error.setupHint);
    process.exit(1);
  }
  throw error;
}

// Build the model router once for the lifetime of the app. Local mode uses the provider-free
// (fake) router; external mode builds the router from configured providers. No network call is made
// at startup — the router only selects providers lazily per request.
const orchestrationRouter =
  orchestrationConfig.mode === "external"
    ? buildModelRouter({ mode: "external", env: process.env })
    : buildModelRouter({ mode: "local" });

const telemetry = new LocalTelemetry();
const manager = new TaskManager({
  record: (event) => telemetry.record(event as Parameters<LocalTelemetry["record"]>[0]),
  getMetrics: () => telemetry.getMetrics(),
});

// Local-first persistence locations for the BYOK provider configuration (design C2/C3). Secrets
// live in the encrypted Secret_Store envelope; non-secret Provider_Config_Records live in a plain
// JSON file. Both sit under the same `.rector/` data directory used by the local SQLite store.
const RECTOR_DATA_DIR = ".rector";
const SECRETS_FILE = `${RECTOR_DATA_DIR}/secrets.enc`;
const PROVIDER_CONFIG_FILE = `${RECTOR_DATA_DIR}/providers.json`;
const SECRET_KEY_FILE = `${RECTOR_DATA_DIR}/secret.key`;

/**
 * Resolve the 32-byte AES-256-GCM key the local Secret_Store seals values with. The key must be
 * stable across restarts so previously stored secrets stay decryptable (Requirement 7.2).
 *
 * Precedence:
 *  1. `RECTOR_SECRET_KEY` (operator-supplied) — derived to 32 bytes via scrypt so the env value can
 *     be any length and is never used as a raw key. This lets an operator deliberately set/rotate a
 *     key (e.g. to move the encrypted store between machines).
 *  2. A locally-generated key persisted to `.rector/secret.key` (0600) on first run and read back
 *     on subsequent runs, so a developer needs no configuration for secrets to survive restarts.
 *
 * The key material itself is never logged.
 */
function resolveSecretEncryptionKey(): Buffer {
  const envKey = process.env.RECTOR_SECRET_KEY?.trim();
  if (envKey) {
    return scryptSync(envKey, "rector.secret-store.v1", 32);
  }

  try {
    if (existsSync(SECRET_KEY_FILE)) {
      const stored = readFileSync(SECRET_KEY_FILE, "utf8").trim();
      const key = Buffer.from(stored, "hex");
      if (key.length === 32) return key;
    }
  } catch {
    // An unreadable/garbled key file falls through to regenerating a fresh key below.
  }

  const key = randomBytes(32);
  mkdirSync(dirname(SECRET_KEY_FILE), { recursive: true });
  writeFileSync(SECRET_KEY_FILE, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return key;
}

// Construct the shared, disk-backed BYOK stores once for the lifetime of the real app and inject
// them into `createApp`. The Secret_Store backs both the setup-status presence booleans and the
// Provider_Config_API; the Provider_Config_Store backs the (non-secret) provider configuration.
// Tests do not use this entry point — they call `createApp` directly and can inject empty or
// in-memory stores — so no real disk store is ever forced in the test suite.
const secretStore = createLocalSecretStore({
  filePath: SECRETS_FILE,
  encryptionKey: resolveSecretEncryptionKey(),
});
const providerConfigStore = createLocalProviderConfigStore({ filePath: PROVIDER_CONFIG_FILE });

const app = createApp(manager, {
  orchestration: { mode: orchestrationConfig.mode, router: orchestrationRouter },
  persistence: deploymentConfig.persistence,
  secretStore,
  providerConfigStore,
});
const server = http.createServer(app);
const gracefulShutdown = createGracefulShutdownHandler({ server });

server.listen({ port, host }, () => {
  console.log(`Rector MVP running on http://${host}:${port} (orchestration mode: ${orchestrationConfig.mode})`);
});

gracefulShutdown.install();

export { app, deploymentConfig, gracefulShutdown, manager, orchestrationConfig, telemetry };
