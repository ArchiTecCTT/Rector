import http from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { execSync } from "node:child_process";
import { createApp } from "../api/server";
import { LocalTelemetry } from "../adapters/providers";
import {
  OrchestrationConfigError,
  createGracefulShutdownHandler,
  parseDeploymentEnvironment,
  type OrchestrationConfig,
} from "../deployment";
import {
  createLocalRuntimeSettingsStore,
  migrateRuntimeSettingsFromEnv,
  type RuntimeSettings,
} from "../config/runtimeSettings";
import type { ModelRouter } from "../providers/llm";
import { buildConfiguredRouter } from "../providers/configBridge";
import { buildConfiguredAssignmentAwareRouter } from "../providers/orchestrationAssignments";
import {
  WorkspaceSandboxAdapter,
  createE2BSandboxAdapterStub,
  type SandboxAdapter,
  type SandboxEnvironmentKind,
} from "../sandbox";
import { checkE2BSandboxReadiness, createE2BSandboxAdapter } from "../sandbox/e2bSandboxAdapter";
import {
  describeRequiredProviderEnvKeys,
  resolveOrchestrationConfig,
} from "../providers/orchestrationConfig";
import { createLocalSecretStore } from "../security/secretStore";
import { createLocalProviderConfigStore } from "../providers/configStore";
import { createLocalMemoryConfigStore } from "../providers/memoryConfigStore";
import { createLocalMemoryAssignmentStore } from "../providers/memoryAssignmentStore";
import { createLocalOrchestrationAssignmentStore } from "../providers/orchestrationAssignments";
import { redactString } from "../security/redaction";
import { ensureRestrictedDir, ensureRestrictedFile, fixExistingDirPermissions } from "../security/filePermissions";
import { parseAuthConfig } from "../security/auth";
import { createLocalAuditLogService } from "../security/auditLog";
import { createRateLimiterFromEnv } from "../security/rateLimiter";
import {
  PersistenceInitializationError,
  StoreConfigError,
  runStartupMigration,
  type RectorStore,
} from "../store";
import { TaskManager } from "../thalamus/router";
import { createDefaultToolRegistry } from "../tools";

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
let orchestrationConfig: OrchestrationConfig = { mode: "external", configuredProviders: [] };

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
const ORCHESTRATION_ASSIGNMENTS_FILE = `${RECTOR_DATA_DIR}/orchestration-assignments.json`;
const MEMORY_ASSIGNMENTS_FILE = `${RECTOR_DATA_DIR}/memory-assignments.json`;
const RUNTIME_SETTINGS_FILE = `${RECTOR_DATA_DIR}/runtime-settings.json`;
const SECRET_KEY_FILE = `${RECTOR_DATA_DIR}/secret.key`;
const AUDIT_LOG_FILE = `${RECTOR_DATA_DIR}/audit-events.jsonl`;

interface SecretKeyFile {
  key: string;
  version: "v2";
  createdAt: string;
}

/**
 * Attempt Windows DPAPI protection on the key file (best-effort).
 * DPAPI encrypts the file contents so only the current Windows user can read it.
 * If DPAPI fails, we warn and continue with file-based key protection.
 */
function applyDpapiProtection(keyFilePath: string): void {
  if (process.platform !== "win32") return;
  try {
    // PowerShell DPAPI: read bytes → Protect → write back
    const ps = `
      Add-Type -AssemblyName System.Security
      $path = '${keyFilePath.replace(/'/g, "''")}'
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [System.IO.File]::WriteAllBytes($path, $protected)
    `;
    execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch {
    // DPAPI failed (e.g. missing PowerShell, permission issue). Best-effort: warn and continue.
    console.warn(
      "[SECURITY] DPAPI protection of secret.key failed. Key file is protected by filesystem permissions only.",
    );
  }
}

/**
 * Write the secret key file in the v2 JSON format and apply OS-level protection.
 */
function writeSecretKeyFile(keyFilePath: string, key: Buffer): void {
  const keyFile: SecretKeyFile = {
    key: key.toString("hex"),
    version: "v2",
    createdAt: new Date().toISOString(),
  };
  ensureRestrictedDir(dirname(keyFilePath));
  // Atomic write: temp file + rename
  const tempPath = join(
    dirname(keyFilePath),
    `.secret.key.tmp.${randomBytes(4).toString("hex")}`,
  );
  writeFileSync(tempPath, JSON.stringify(keyFile, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    renameSync(tempPath, keyFilePath);
  } catch {
    // Fallback: direct write if rename fails (e.g. cross-device)
    writeFileSync(keyFilePath, JSON.stringify(keyFile, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  // Windows DPAPI protection (best-effort) when RECTOR_SECRET_KEY env is not set
  if (!process.env.RECTOR_SECRET_KEY) {
    applyDpapiProtection(keyFilePath);
  }
  ensureRestrictedFile(keyFilePath);
}

/**
 * Resolve the 32-byte AES-256-GCM key the local Secret_Store seals values with. The key must be
 * stable across restarts so previously stored secrets stay decryptable (Requirement 7.2).
 *
 * Precedence:
 *  1. `RECTOR_SECRET_KEY` (operator-supplied) — derived to 32 bytes via scrypt so the env value can
 *     be any length and is never used as a raw key. This lets an operator deliberately set/rotate a
 *     key (e.g. to move the encrypted store between machines).
 *  2. A locally-generated key persisted to `.rector/secret.key` in v2 JSON format on first run and
 *     read back on subsequent runs, so a developer needs no configuration for secrets to survive
 *     restarts. The v2 format is `{ key, version: "v2", createdAt }`. Bare 64-char hex strings (v1)
 *     are still accepted for backward compatibility.
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
      // v2 JSON format
      try {
        const parsed = JSON.parse(stored) as Partial<SecretKeyFile>;
        if (parsed.version === "v2" && typeof parsed.key === "string") {
          const key = Buffer.from(parsed.key, "hex");
          if (key.length === 32) {
            ensureRestrictedFile(SECRET_KEY_FILE);
            return key;
          }
        }
      } catch {
        // Not valid JSON — fall through to v1 hex check
      }
      // v1 backward compat: bare 64-char hex string
      if (/^[0-9a-f]{64}$/i.test(stored)) {
        const key = Buffer.from(stored, "hex");
        if (key.length === 32) {
          ensureRestrictedFile(SECRET_KEY_FILE);
          // Auto-migrate to v2 format on next write (rotation or boot rotation)
          return key;
        }
      }
    }
  } catch {
    // An unreadable/garbled key file falls through to regenerating a fresh key below.
  }

  const key = randomBytes(32);
  writeSecretKeyFile(SECRET_KEY_FILE, key);
  ensureRestrictedFile(SECRET_KEY_FILE);
  return key;
}

/**
 * Derive a 32-byte DB encryption key from the master secret key using an
 * HKDF-like construction (HMAC-SHA256 with domain-separated info string).
 * The derived key is independent of the secret-store key so a DB key
 * compromise does not expose secrets and vice versa.
 */
function deriveDbEncryptionKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("rector.db-encryption.v1").digest();
}

/** Derive a 32-byte MAC key from the master secret key using an HKDF-like
 *  construction (HMAC-SHA256 with domain-separated info string). The derived
 *  key is independent of the DB encryption key so a MAC key compromise does
 *  not expose encrypted payloads and vice versa.
 */
function derivePayloadMacKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("rector.payload-mac.v1").digest();
}

/**
 * Determine whether DB encryption should be enabled. Logic:
 * - `RECTOR_DB_ENCRYPTION` env var explicitly set: honor it ("true"/"false").
 * - Otherwise: enable when a secret key is available, UNLESS an existing
 *   `.rector/rector.db` file contains unencrypted rows (no `ENC1:` prefix),
 *   in which case default to `false` to avoid making existing data unreadable.
 */
function shouldEnableDbEncryption(secretKey: Buffer): boolean {
  const envVal = process.env.RECTOR_DB_ENCRYPTION?.trim().toLowerCase();
  if (envVal === "true") return true;
  if (envVal === "false") return false;

  // Auto-detect: if the DB file exists, check if it has unencrypted rows.
  const dbPath = ".rector/rector.db";
  if (existsSync(dbPath)) {
    try {
      // Quick heuristic: read the file and look for ENC1: prefix.
      // If we find any JSON-like payload without ENC1:, it's a legacy DB.
      const content = readFileSync(dbPath, "utf8");
      if (content.includes('"payload":"') && !content.includes('"payload":"ENC1:')) {
        // Legacy DB with unencrypted payloads — default off to keep it readable.
        return false;
      }
    } catch {
      // If we can't read, fall through to enabling encryption.
    }
  }

  // Default: enable when we have a key (fresh installs).
  return true;
}

/**
 * Perform automated key rotation when RECTOR_ROTATE_KEY_ON_BOOT is set.
 * Generates a new key, re-encrypts all secrets with it, and writes the new key file.
 */
async function performKeyRotation(
  oldKey: Buffer,
  store: ReturnType<typeof createLocalSecretStore>,
): Promise<Buffer> {
  const newKey = randomBytes(32);
  const ids = store.listSecretIds ? await store.listSecretIds() : [];

  // Read all secrets with the old key, then re-encrypt with the new key
  const newStore = createLocalSecretStore({
    filePath: SECRETS_FILE,
    encryptionKey: newKey,
  });

  for (const id of ids) {
    const result = await store.getSecret(id);
    if (!result.ok) {
      console.warn(`[SECURITY] Key rotation: failed to read secret "${id}", skipping.`);
      continue;
    }
    const setResult = await newStore.setSecret(id, result.value);
    if (!setResult.ok) {
      console.warn(`[SECURITY] Key rotation: failed to re-encrypt secret "${id}", skipping.`);
    }
  }

  // Write the new key file in v2 format
  writeSecretKeyFile(SECRET_KEY_FILE, newKey);
  console.log(`[SECURITY] Key rotation completed successfully. ${ids.length} secret(s) re-encrypted.`);
  return newKey;
}

// Construct the shared, disk-backed BYOK stores once for the lifetime of the real app and inject
// them into `createApp`. The Secret_Store backs both the setup-status presence booleans and the
// Provider_Config_API; the Provider_Config_Store backs the (non-secret) provider configuration.
// Tests do not use this entry point — they call `createApp` directly and can inject empty or
// in-memory stores — so no real disk store is ever forced in the test suite.
let secretEncryptionKey = resolveSecretEncryptionKey();
const secretStore = createLocalSecretStore({
  filePath: SECRETS_FILE,
  encryptionKey: secretEncryptionKey,
});
const providerConfigStore = createLocalProviderConfigStore({ filePath: PROVIDER_CONFIG_FILE });

// Chunk 34: always create the memory config store for the real app. When no
// .rector/memory-providers.json exists yet we get the empty state + default
// local-inmemory provider (zero-config, identical to pre-34 baseline).
const memoryConfigStore = createLocalMemoryConfigStore({ filePath: ".rector/memory-providers.json" });
const orchestrationAssignmentStore = createLocalOrchestrationAssignmentStore({
  filePath: ORCHESTRATION_ASSIGNMENTS_FILE,
});
const memoryAssignmentStore = createLocalMemoryAssignmentStore({ filePath: MEMORY_ASSIGNMENTS_FILE });
const runtimeSettingsStore = createLocalRuntimeSettingsStore({ filePath: RUNTIME_SETTINGS_FILE });

/**
 * Ensure persisted runtime settings exist, migrating once from the legacy
 * `ORCHESTRATOR_MODE` env knob when the backing file is absent.
 */
async function ensureRuntimeSettings(): Promise<RuntimeSettings> {
  if (!existsSync(RUNTIME_SETTINGS_FILE)) {
    const orchestration = await resolveOrchestrationConfig({
      env: process.env,
      providerConfigStore,
      secretStore,
    });
    orchestrationConfig = orchestration;
    const migrated = migrateRuntimeSettingsFromEnv(
      process.env,
      orchestration.configuredProviders.length,
      { warn: (message) => console.warn(redactString(message)) },
    );
    const persisted = await runtimeSettingsStore.upsert(migrated);
    if (!persisted.ok) {
      console.warn(`Runtime settings migration failed: ${redactString(persisted.error)}`);
      return migrated;
    }
    return persisted.value;
  }
  return runtimeSettingsStore.get();
}

/**
 * Build the product model router from the persisted orchestration profile.
 *
 * Configured profiles use the assignment-aware Config_Bridge path. Unconfigured
 * profiles intentionally omit a product router (chat is gated in a later phase);
 * no {@link FakeLLMProvider} is injected as the default product router.
 */
async function buildStartupRouter(profile: RuntimeSettings["orchestrationProfile"]): Promise<ModelRouter | undefined> {
  if (profile !== "configured") {
    return undefined;
  }
  const baseRouter = await buildConfiguredRouter({
    store: providerConfigStore,
    secrets: secretStore,
    mode: "external",
    baseEnv: process.env,
    enableNetwork: true,
    fetchImpl: fetch,
  });
  return buildConfiguredAssignmentAwareRouter({
    baseRouter,
    assignmentStore: orchestrationAssignmentStore,
    providerConfigStore,
    secrets: secretStore,
    enableNetwork: true,
    fetchImpl: fetch,
  });
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
async function countStoreConfiguredProviders(): Promise<number> {
  try {
    const state = await providerConfigStore.getState();
    let count = 0;
    for (const record of state.providers) {
      if (await secretStore.hasSecret(record.secretRef)) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function buildStartupSandboxAdapter(
  profile: RuntimeSettings["orchestrationProfile"],
  kind: SandboxEnvironmentKind,
): Promise<SandboxAdapter> {
  if (kind === "stub") {
    return createE2BSandboxAdapterStub();
  }

  if (kind === "e2b" && profile === "configured") {
    const apiKey = await resolveE2BApiKey();
    if (apiKey) {
      const readiness = checkE2BSandboxReadiness({
        apiKey,
        networkMode: "external",
        defaultTimeoutMs: 60_000,
      });
      if (!readiness.ready) {
        console.warn(`E2B sandbox not ready: ${redactString(readiness.message)}`);
      } else {
        return createE2BSandboxAdapter({
          apiKey,
          networkMode: "external",
          workspaceRoot: SANDBOX_WORKSPACE_ROOT,
          defaultTimeoutMs: 60_000,
        });
      }
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
  // H2: Fix permissions on existing installations where .rector/ may have been
  // created with overly permissive defaults by earlier versions.
  fixExistingDirPermissions(RECTOR_DATA_DIR);

  // H3: Automated key rotation on boot when RECTOR_ROTATE_KEY_ON_BOOT is set.
  if (process.env.RECTOR_ROTATE_KEY_ON_BOOT?.trim() === "true") {
    try {
      const newKey = await performKeyRotation(secretEncryptionKey, secretStore);
      secretEncryptionKey = newKey;
      console.log("[SECURITY] Boot-time key rotation completed.");
    } catch (error) {
      console.warn(`[SECURITY] Boot-time key rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const runtimeSettings = await ensureRuntimeSettings();

  const storeProviderCount = await countStoreConfiguredProviders();

  // Req 1.4 / 1.5 / 1.7: configured profile with no configured provider warns and serves (rather
  // than crashing) so the operator can open the configuration panel. The warning names every
  // supported provider's required environment-variable keys and contains no secret value.
  if (
    runtimeSettings.orchestrationProfile === "configured" &&
    storeProviderCount === 0
  ) {
    console.warn(
      redactString(
        "Rector is starting with a configured orchestration profile but no configured providers. " +
          "Enter provider credentials in the configuration UI before issuing requests. " +
          `Supported providers and required environment variables: ${describeRequiredProviderEnvKeys()}.`,
      ),
    );
  }

  const orchestrationRouter = await buildStartupRouter(runtimeSettings.orchestrationProfile);
  const orchestrationMode =
    runtimeSettings.orchestrationProfile === "configured" ? "external" : "local";
  const orchestrationSandbox = await buildStartupSandboxAdapter(
    runtimeSettings.orchestrationProfile,
    runtimeSettings.sandboxEnvironment,
  );

  const persistenceDriver = deploymentConfig.persistence?.driver;
  const dbEncryptionKey = shouldEnableDbEncryption(secretEncryptionKey)
    ? deriveDbEncryptionKey(secretEncryptionKey)
    : undefined;
  const dbMacKey = derivePayloadMacKey(secretEncryptionKey);
  let bootstrappedStore: RectorStore | undefined;
  if (persistenceDriver === "sqlite" || persistenceDriver === "tidb") {
    bootstrappedStore = await runStartupMigration(deploymentConfig.persistence, {
      encryptionKey: dbEncryptionKey,
      macKey: dbMacKey,
    });
  }

  const authConfig = parseAuthConfig(process.env);
  const auditLog = createLocalAuditLogService({ filePath: AUDIT_LOG_FILE });
  const toolRegistry = createDefaultToolRegistry();

  const rateLimiter = createRateLimiterFromEnv(process.env);

  const app = createApp(manager, {
    orchestration: { mode: orchestrationMode, router: orchestrationRouter, sandbox: orchestrationSandbox },
    persistence: deploymentConfig.persistence,
    ...(bootstrappedStore !== undefined ? { store: bootstrappedStore } : {}),
    secretStore,
    providerConfigStore,
    memoryConfigStore,
    orchestrationAssignmentStore,
    memoryAssignmentStore,
    runtimeSettingsStore,
    auditLog,
    toolRegistry,
    auth: authConfig,
    secretEncryptionKey,
    dbEncryptionKey,
    dbMacKey,
    rateLimiter,
  });
  const server = http.createServer(app);
  const gracefulShutdown = createGracefulShutdownHandler({
    server,
    cleanup: () => {
      app.locals.neuroAliveState?.()?.backgroundHooks?.stop();
    },
  });

  server.listen({ port, host }, () => {
    console.log(
      `Rector MVP running on http://${host}:${port} ` +
        `(orchestration profile: ${runtimeSettings.orchestrationProfile})`,
    );
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

export {
  bootstrapPromise,
  deploymentConfig,
  manager,
  orchestrationConfig,
  runtimeSettingsStore,
  telemetry,
};
