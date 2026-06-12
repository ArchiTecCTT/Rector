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
  type OrchestrationConfig,
} from "../deployment";
import { buildModelRouter, FakeLLMProvider, type ModelRouter } from "../providers/llm";
import { buildConfiguredRouter } from "../providers/configBridge";
import { WorkspaceSandboxAdapter, type SandboxAdapter } from "../sandbox";
import { createE2BSandboxAdapter } from "../sandbox/e2bSandboxAdapter";
import {
  describeRequiredProviderEnvKeys,
  resolveOrchestrationConfig,
} from "../providers/orchestrationConfig";
import { createLocalSecretStore } from "../security/secretStore";
import { createLocalProviderConfigStore } from "../providers/configStore";
import { createLocalMemoryConfigStore } from "../providers/memoryConfigStore";
import { createLocalMemoryAssignmentStore } from "../providers/memoryAssignmentStore";
import { redactString } from "../security/redaction";
import { parseAuthConfig } from "../security/auth";
import {
  PersistenceInitializationError,
  StoreConfigError,
  runStartupMigration,
  type RectorStore,
} from "../store";
import { TaskManager } from "../thalamus/router";

const deploymentConfig = parseDeploymentEnvironment();
const port = deploymentConfig.port;
const host = process.env.HOST?.trim() || "127.0.0.1";

// The orchestration config is resolved inside the async bootstrap below, after the BYOK stores are
// constructed: the boot-tolerant resolver (design C1; Req 1.1-1.3, 1.8) awaits both the
// Provider_Config_Store and the Secret_Store (presence-only) so credentials that live only in the
// UI configuration stores still count as "configured". The resolver halts startup for exactly one
// reason — an ORCHESTRATOR_MODE value that is neither `local` nor `external` (Req 1.6) — and that
// hard-exit is handled in `resolveStartupOrchestrationConfig`. The binding is assigned once during
// bootstrap and exported for downstream consumers/tests.
let orchestrationConfig: OrchestrationConfig;

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

// Chunk 34: always create the memory config store for the real app. When no
// .rector/memory-providers.json exists yet we get the empty state + default
// local-inmemory provider (zero-config, identical to pre-34 baseline).
const memoryConfigStore = createLocalMemoryConfigStore({ filePath: ".rector/memory-providers.json" });
const memoryAssignmentStore = createLocalMemoryAssignmentStore({ filePath: ".rector/memory-assignments.json" });

/**
 * Build the model router for the resolved orchestration mode (design C6, Req 13.3/14.3).
 *
 * External_Mode builds the router via the {@link buildConfiguredRouter} Config_Bridge so persisted
 * Provider_Config_Records (including every `openai-compatible` deployment) and their Secret_Store
 * secrets participate in selection, honoring the persisted Active_Route_Map with fallback to the
 * capability-priority selection. The live server explicitly opts the constructed providers into the
 * network (`enableNetwork: true`); `process.env` remains the documented fallback when the user has
 * not set a field in-app (precedence: persisted UI config over env).
 *
 * Local_Mode is the provider-free regression baseline (Req 17.1, Correctness Property 7): it uses
 * the fake router and NEVER consults the Config_Bridge, so no persisted configuration or secret can
 * ever cause a provider/network call. The bridge is deliberately not invoked on this path, and the
 * router is constructed with ONLY the {@link FakeLLMProvider} so no network-capable provider is even
 * instantiated in local mode (cloud-capable-transition Req 9.1/9.3) — the mode gate is therefore
 * provably inert rather than merely never-selected.
 *
 * No network call is made at startup — the router only selects providers lazily per request.
 */
async function buildStartupRouter(config: OrchestrationConfig): Promise<ModelRouter> {
  if (config.mode === "external") {
    return buildConfiguredRouter({
      store: providerConfigStore,
      secrets: secretStore,
      mode: "external",
      baseEnv: process.env,
      enableNetwork: true,
      fetchImpl: fetch,
    });
  }
  return buildModelRouter({ mode: "local", providers: [new FakeLLMProvider()] });
}

// Workspace containment boundary for every sandbox operation. Mirrors the chat-runner / workspace
// safety defaults: an explicit `RECTOR_WORKSPACE_ROOT` wins, otherwise the process cwd is used.
const SANDBOX_WORKSPACE_ROOT = process.env.RECTOR_WORKSPACE_ROOT?.trim() || process.cwd();

// The Secret_Store key (and env fallback) under which the E2B container API key is stored. Read
// transiently at construction; the value never leaves this module.
const E2B_SECRET_REF = "e2b";

/**
 * Resolve the E2B API key, preferring an in-app Secret_Store entry and falling back to the
 * documented `E2B_API_KEY` environment variable. The value is read transiently and never logged.
 * A store read failure is treated as "absent" so it can never crash startup (boot-tolerant).
 */
async function resolveE2BApiKey(): Promise<string | undefined> {
  try {
    const stored = await secretStore.getSecret(E2B_SECRET_REF);
    if (stored.ok && stored.value.trim().length > 0) {
      return stored.value;
    }
  } catch {
    // Treat an unreadable secret store as absent credentials; fall through to the env fallback.
  }
  const envKey = process.env.E2B_API_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : undefined;
}

/**
 * Select the Sandbox_Adapter for the resolved orchestration mode (design C6, Req 6.1/6.7).
 *
 * Local_Mode is the provider-free regression baseline: it constructs the network-free local runner
 * ({@link WorkspaceSandboxAdapter}, which never spawns a container or touches the network) and
 * initializes NO E2B client (Req 6.7).
 *
 * External_Mode constructs the real {@link createE2BSandboxAdapter} so sandbox commands and patches
 * run inside a real E2B container — but only when an E2B API key is present in the Secret_Store (or
 * the `E2B_API_KEY` env fallback), per Req 6.1. When no key is configured, External_Mode degrades to
 * the same network-free local runner so the server still serves and the operator can add the key in
 * the UI; no E2B client is initialized in that case either.
 *
 * No container is contacted at startup — the adapter only initializes its client lazily on first use.
 */
async function buildStartupSandboxAdapter(config: OrchestrationConfig): Promise<SandboxAdapter> {
  if (config.mode === "external") {
    const apiKey = await resolveE2BApiKey();
    if (apiKey) {
      return createE2BSandboxAdapter({ apiKey, workspaceRoot: SANDBOX_WORKSPACE_ROOT });
    }
  }
  // Local mode (Req 6.7) — and external mode with no configured E2B key — use the network-free
  // local runner and initialize no E2B container client.
  return new WorkspaceSandboxAdapter({ workspaceRoot: SANDBOX_WORKSPACE_ROOT });
}

/**
 * Resolve the orchestration config on the live boot path (design C1; Req 1.1-1.8).
 *
 * Unlike the legacy synchronous `parseOrchestrationConfig`, the boot-tolerant
 * {@link resolveOrchestrationConfig} consults the initialized Provider_Config_Store and Secret_Store
 * (presence-only via `hasSecret`) in addition to `process.env`, so credentials entered through the
 * UI count as configured. The ONLY condition that halts startup is an `ORCHESTRATOR_MODE` value that
 * is neither `local` nor `external` (`ORCHESTRATOR_MODE_INVALID` — Req 1.6): we log the redacted,
 * secret-free error/setup hint (which names the accepted values `local`/`external`) and exit
 * non-zero. Every other condition — including external mode with zero configured providers — resolves
 * normally so the server can bind, listen, and let the operator enter credentials in the UI.
 */
async function resolveStartupOrchestrationConfig(): Promise<OrchestrationConfig> {
  try {
    return await resolveOrchestrationConfig({
      env: process.env,
      providerConfigStore,
      secretStore,
    });
  } catch (error) {
    if (error instanceof OrchestrationConfigError && error.code === "ORCHESTRATOR_MODE_INVALID") {
      // Req 1.6: invalid mode value is the sole hard-exit path. Both message and setupHint are
      // already routed through the Redaction_Layer by OrchestrationConfigError.
      console.error(`Rector startup failed (${error.code}): ${error.message}`);
      console.error(error.setupHint);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Async startup. The boot-tolerant orchestration config is resolved first (after the BYOK stores are
 * constructed above), then the router build, app construction, listen, and graceful-shutdown wiring
 * are sequenced. External mode with zero configured providers does NOT exit (Req 1.5): instead a
 * redacted warning naming each provider's required env keys is emitted (Req 1.4, 1.7) and the server
 * binds + listens so credentials can be entered through the UI.
 */
async function bootstrap(): Promise<{ app: Awaited<ReturnType<typeof createApp>>; server: http.Server; gracefulShutdown: ReturnType<typeof createGracefulShutdownHandler> }> {
  orchestrationConfig = await resolveStartupOrchestrationConfig();

  // Req 1.4 / 1.5 / 1.7: external mode with no configured provider warns and serves (rather than
  // crashing) so the operator can open the configuration panel. The warning names every supported
  // provider's required environment-variable keys and contains no secret value; it is additionally
  // routed through the Redaction_Layer as a defense-in-depth guarantee before reaching the sink.
  if (orchestrationConfig.mode === "external" && orchestrationConfig.configuredProviders.length === 0) {
    console.warn(
      redactString(
        "Rector is starting in external mode with no configured providers. " +
          "Enter provider credentials in the configuration UI before issuing requests. " +
          `Supported providers and required environment variables: ${describeRequiredProviderEnvKeys()}.`,
      ),
    );
  }

  const orchestrationRouter = await buildStartupRouter(orchestrationConfig);
  const orchestrationSandbox = await buildStartupSandboxAdapter(orchestrationConfig);

  const persistenceDriver = deploymentConfig.persistence?.driver;
  let bootstrappedStore: RectorStore | undefined;
  if (persistenceDriver === "sqlite" || persistenceDriver === "tidb") {
    bootstrappedStore = await runStartupMigration(deploymentConfig.persistence);
  }

  const authConfig = parseAuthConfig(process.env);
  const secretEncryptionKey = resolveSecretEncryptionKey();

  const app = createApp(manager, {
    orchestration: { mode: orchestrationConfig.mode, router: orchestrationRouter, sandbox: orchestrationSandbox },
    persistence: deploymentConfig.persistence,
    ...(bootstrappedStore !== undefined ? { store: bootstrappedStore } : {}),
    secretStore,
    providerConfigStore,
    memoryConfigStore,
    memoryAssignmentStore,
    auth: authConfig,
    secretEncryptionKey,
  });
  const server = http.createServer(app);
  const gracefulShutdown = createGracefulShutdownHandler({
    server,
    cleanup: () => {
      app.locals.neuroAliveState?.()?.backgroundHooks?.stop();
    },
  });

  server.listen({ port, host }, () => {
    console.log(`Rector MVP running on http://${host}:${port} (orchestration mode: ${orchestrationConfig.mode})`);
  });

  gracefulShutdown.install();

  return { app, server, gracefulShutdown };
}

const bootstrapPromise = bootstrap().catch((error) => {
  const message =
    error instanceof PersistenceInitializationError || error instanceof StoreConfigError
      ? redactString(error instanceof Error ? error.message : String(error))
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`Rector startup failed: ${message}`);
  process.exit(1);
});

export { bootstrapPromise, deploymentConfig, manager, orchestrationConfig, telemetry };
