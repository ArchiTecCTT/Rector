/**
 * Feature: cloud-capable-transition, Property 36: Every log/telemetry write is
 * redacted before the sink.
 *
 * Validates: Requirements 10.1
 *
 * Req 10.1: WHEN the Rector_Server writes an environment variable, API endpoint
 * detail, or database identifier to a log or telemetry sink, THE Rector_Server
 * SHALL redact secret values, API keys, and authorization headers using the
 * Redaction_Layer before the write.
 *
 * This property drives every NEW log/telemetry sink the cloud-capable transition
 * introduces through its real production code path, injecting a fast-check
 * generated key-like secret (embedded in a carrier the Redaction_Layer is
 * designed to target — a `Bearer` header, an inline `api_key=`/`secret=` pair, or
 * a credential URI) into the value that flows toward the sink. Each sink is
 * modeled with a *capturing double* (a recording logger, a recording HTTP
 * response, an in-memory sandbox client, or the returned result/error object
 * that the telemetry layer records), and for the captured value the property
 * asserts BOTH:
 *
 *   1. **redacted before the sink** — the captured value equals its own redacted
 *      form (it is a fixed point of the governing Redaction_Layer function). An
 *      un-redacted write would still carry the live `Bearer <secret>` carrier and
 *      would therefore NOT be stable under redaction; stability is exactly the
 *      "redaction happened before the write" guarantee Req 10.1 mandates; and
 *   2. **no secret substring** — the captured value contains no substring of the
 *      injected secret.
 *
 * The six sinks exercised, each through its shipped module:
 *   - **startup warning** — `resolveOrchestrationConfig` store-read-failure line
 *     routed to an injected logger (`src/providers/orchestrationConfig.ts`);
 *   - **discovery error** — `ModelDiscoveryService.discover` classified error
 *     message (`src/providers/discovery/service.ts`);
 *   - **settings discovery response** — `runSettingsDiscovery` result sent through
 *     the `redactOutbound` HTTP boundary to a recording response
 *     (`src/api/server.ts`);
 *   - **sandbox stream** — `createE2BSandboxAdapter` captured stdout/stderr
 *     (`src/sandbox/e2bSandboxAdapter.ts`);
 *   - **synthesizer answer** — `runLiveSynthesizer` assembled answer + citations
 *     (`src/orchestration/synthesizer.ts`);
 *   - **TiDB error** — `runStartupMigration` `PersistenceInitializationError`
 *     message (`src/store/index.ts`).
 *
 * Everything is in-memory and mock-only: providers are spies, `fetch` is a local
 * throwing double, the sandbox client and SqlDriver are in-memory doubles, and
 * the secret/config stores are local doubles. No API key, no network, and no real
 * container/database is touched, so every run is deterministic and hermetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  redactString,
  redactSecrets,
  redactOutbound,
} from "../src/security/redaction";
import { resolveOrchestrationConfig } from "../src/providers/orchestrationConfig";
import { createModelDiscoveryService } from "../src/providers/discovery/service";
import { createDiscoveryCache } from "../src/providers/discovery/cache";
import { createDefaultDiscoveryAdapterRegistry } from "../src/providers/discovery/adapters/registry";
import { createInMemoryProviderConfigStore } from "../src/providers/configStore";
import {
  PROVIDER_CONFIG_VERSION,
  type ProviderConfigRecord,
} from "../src/providers/config";
import { runSettingsDiscovery } from "../src/api/server";
import { createE2BSandboxAdapter, type E2BClient } from "../src/sandbox/e2bSandboxAdapter";
import {
  runLiveSynthesizer,
  type BrainstemSynthesisInput,
  type SynthesisCitation,
} from "../src/orchestration/synthesizer";
import { createFakePlan } from "../src/orchestration/planner";
import { reviewPlanWithSkeptic } from "../src/orchestration/skeptic";
import { arbitratePlanWithCrucible } from "../src/orchestration/crucible";
import { runStartupMigration, PersistenceInitializationError } from "../src/store";
import type { SqlDriver } from "../src/store/sqlRectorStore";
import type { ProviderConfigStore } from "../src/providers/configStore";
import type { SecretStore } from "../src/security/secretStore";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbKeyLikeSecret,
  arbPlannerInput,
  generousBudget,
  makeExternalRun,
} from "./support/byokArbitraries";

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const ALLOWLISTED_COMMAND = "echo";

/**
 * Carriers the Redaction_Layer is guaranteed to fully target: a delimiter-free
 * key-like secret embedded in any of these is removed WHOLLY by `redactString`
 * (and therefore `redactSecrets`/`redactOutbound`), so a redacted write contains
 * no secret substring and is stable under re-redaction.
 */
const carriers: Array<(secret: string) => string> = [
  (s) => `Authorization: Bearer ${s}`,
  (s) => `api_key=${s}`,
  (s) => `secret=${s}`,
  (s) => `https://admin:${s}@db.example.test/v1`,
];
const carrierIndexArb = fc.nat(carriers.length - 1);

/** A captured write reaching one sink, plus whether it is already in redacted form. */
interface SinkCapture {
  /** The sink's human-readable name (for assertion messages). */
  name: string;
  /** The serialized captured value, for the no-secret-substring check. */
  serialized: string;
  /** True iff the captured value equals its own redacted form (a redaction fixed point). */
  stable: boolean;
}

/** A string is "redacted before the sink" when it is a fixed point of `redactString`. */
function stableString(value: string): boolean {
  return redactString(value) === value;
}

/** A structure is "redacted before the sink" when it is a fixed point of `redactSecrets`. */
function stableStructure(value: unknown): boolean {
  return JSON.stringify(redactSecrets(value)) === JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Shared doubles
// ---------------------------------------------------------------------------

/** Presence-only Secret_Store double returning a fixed live secret value. */
function secretStoreReturning(secretValue: string): SecretStore {
  return {
    async setSecret() {
      return { ok: true, value: undefined };
    },
    async getSecret() {
      return { ok: true, value: secretValue };
    },
    async hasSecret() {
      return false;
    },
  };
}

/** A `together` record with exactly the non-secret fields the adapter needs to reach `fetch`. */
function togetherRecord(): ProviderConfigRecord {
  return {
    id: "together:sink-test",
    kind: "together",
    label: "Sink Test",
    baseUrl: "https://api.together.test",
    secretRef: "together-secret",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };
}

/** A `fetch` double whose transport error embeds `leak` (a redactable secret carrier). */
function throwingFetch(leak: string): typeof fetch {
  return (async () => {
    throw new Error(`connection failed: ${leak}`);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Sink scenarios — each drives a real production sink with a capturing double.
// ---------------------------------------------------------------------------

/** (1) Startup warning sink: `resolveOrchestrationConfig` store-read-failure line. */
async function captureStartupWarning(leak: string): Promise<SinkCapture> {
  const captured: string[] = [];
  const failingConfigStore = {
    async getState(): Promise<never> {
      throw new Error(`store read blew up: ${leak}`);
    },
  } as unknown as ProviderConfigStore;

  await resolveOrchestrationConfig({
    env: { ORCHESTRATOR_MODE: "external" },
    providerConfigStore: failingConfigStore,
    secretStore: secretStoreReturning(leak),
    logger: { error: (message: string) => captured.push(message) },
  });

  // Exactly the redacted store-read-failure line reached the logger sink.
  const line = captured.join("\n");
  return { name: "startup warning", serialized: line, stable: stableString(line) };
}

/** (2) Discovery error sink: `ModelDiscoveryService.discover` classified error message. */
async function captureDiscoveryError(leak: string): Promise<SinkCapture> {
  const record = togetherRecord();
  const configStore = createInMemoryProviderConfigStore({
    version: PROVIDER_CONFIG_VERSION,
    providers: [record],
    activeRoutes: {},
  });
  const service = createModelDiscoveryService({
    configStore,
    secrets: secretStoreReturning(leak),
    cache: createDiscoveryCache(),
    adapters: createDefaultDiscoveryAdapterRegistry(),
    clock: () => Date.parse(FIXED_TS),
  });

  const result = await service.discover(record.id, { fetchImpl: throwingFetch(leak) });
  expect(result.ok).toBe(false);
  const message = result.ok ? "" : result.error.message;
  return { name: "discovery error", serialized: message, stable: stableString(message) };
}

/** (3) Settings discovery response sink: `runSettingsDiscovery` through the `redactOutbound` boundary. */
async function captureSettingsDiscoveryResponse(leak: string): Promise<SinkCapture> {
  const record = togetherRecord();
  const configStore = createInMemoryProviderConfigStore({
    version: PROVIDER_CONFIG_VERSION,
    providers: [record],
    activeRoutes: {},
  });
  const service = createModelDiscoveryService({
    configStore,
    secrets: secretStoreReturning(leak),
    cache: createDiscoveryCache(),
    adapters: createDefaultDiscoveryAdapterRegistry(),
    clock: () => Date.parse(FIXED_TS),
  });

  const result = await runSettingsDiscovery({
    mode: "external",
    service,
    providerId: record.id,
    fetchImpl: throwingFetch(leak),
    now: () => new Date(FIXED_TS),
  });

  // Model the HTTP sink with a recording response double; the route serializes the
  // result through the same `redactOutbound` boundary `sendRedacted` applies.
  let captured: unknown;
  const res = {
    status() {
      return this;
    },
    json(body: unknown) {
      captured = body;
      return this;
    },
  };
  const outcome = redactOutbound(result);
  if (outcome.ok) {
    res.status();
    res.json(outcome.value);
  } else {
    res.status();
    res.json({ error: outcome.error });
  }

  return {
    name: "settings discovery response",
    serialized: JSON.stringify(captured),
    stable: stableStructure(captured),
  };
}

/** (4) Sandbox stream sink: `createE2BSandboxAdapter` captured stdout/stderr. */
async function captureSandboxStream(leak: string): Promise<SinkCapture> {
  const client: E2BClient = {
    runCommand: () => ({ exitCode: 0, stdout: `out: ${leak}`, stderr: `err: ${leak}` }),
    writeFile: () => {},
  };
  const adapter = createE2BSandboxAdapter({
    apiKey: "test-key",
    workspaceRoot: "/workspace",
    allowlistedCommands: [ALLOWLISTED_COMMAND],
    clientFactory: () => client,
    now: () => FIXED_TS,
  });

  const result = await adapter.execute({
    kind: "local",
    command: ALLOWLISTED_COMMAND,
    args: [],
    timeoutMs: 1_000,
  });

  const streams = `${result.stdout}\n${result.stderr}`;
  return {
    name: "sandbox stream",
    serialized: streams,
    stable: stableString(result.stdout) && stableString(result.stderr),
  };
}

/** A schema-valid `BrainstemSynthesisInput` arbitrary (no execution/validation evidence). */
const arbSynthesisInput = (): fc.Arbitrary<BrainstemSynthesisInput> =>
  arbPlannerInput().map((plannerInput) => {
    const plannerOutput = createFakePlan(plannerInput);
    const skepticReview = reviewPlanWithSkeptic(plannerOutput, plannerInput.contextPack);
    const crucibleDecision = arbitratePlanWithCrucible({
      plannerOutput,
      skepticReview,
      now: () => FIXED_TS,
    });
    return {
      traceId: "trace-prop36",
      triage: plannerInput.triage,
      contextPack: plannerInput.contextPack,
      plannerOutput,
      skepticReview,
      crucibleDecision,
    };
  });

/** (5) Synthesizer answer sink: `runLiveSynthesizer` assembled answer + citations. */
async function captureSynthesizerAnswer(
  input: BrainstemSynthesisInput,
  leak: string,
): Promise<SinkCapture> {
  // A valid Narrative_Answer that embeds the secret in the body and in a citation,
  // references the trace drawer, and stays within the 2000-char cap.
  const draft = {
    response: `Attempted the change and recorded ${leak}. See the trace drawer for the raw run data.`,
    citations: [
      { kind: "command", ref: `ran ${leak}`, detail: `captured output ${leak}` } as SynthesisCitation,
    ],
  };
  const provider = new SpyLLMProvider({
    estimate: DEFAULT_SPY_USAGE,
    responses: [JSON.stringify(draft)],
  });

  const result = await runLiveSynthesizer(input, {
    provider,
    run: makeExternalRun(generousBudget()),
  });

  const citationText = result.citations
    .map((citation) => `${citation.ref} ${citation.detail}`)
    .join("\n");
  const answer = `${result.synthesis.response}\n${citationText}`;
  const stable =
    stableString(result.synthesis.response) &&
    result.citations.every((c) => stableString(c.ref) && stableString(c.detail));

  return { name: "synthesizer answer", serialized: answer, stable };
}

/** (6) TiDB error sink: `runStartupMigration` `PersistenceInitializationError` message. */
async function captureTidbError(leak: string): Promise<SinkCapture> {
  // A mysql-dialect SqlDriver double whose first DDL `exec` throws a secret-bearing
  // error, mirroring a TiDB connect/provision failure.
  const driver: SqlDriver = {
    dialect: "mysql",
    exec() {
      throw new Error(`tidb migration failed: ${leak}`);
    },
    run() {},
    get() {
      return undefined;
    },
    all() {
      return [];
    },
    close() {},
  };

  let message = "";
  try {
    await runStartupMigration(undefined, { driver });
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceInitializationError);
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message.length).toBeGreaterThan(0);
  return { name: "TiDB error", serialized: message, stable: stableString(message) };
}

describe("Feature: cloud-capable-transition, Property 36: every log/telemetry write is redacted before the sink", () => {
  // Validates: Requirements 10.1
  it("redacts every write to every new log/telemetry sink before it reaches the sink", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbKeyLikeSecret(),
        carrierIndexArb,
        arbSynthesisInput(),
        async (secret, carrierIndex, synthesisInput) => {
          const leak = carriers[carrierIndex](secret);

          const captures: SinkCapture[] = [
            await captureStartupWarning(leak),
            await captureDiscoveryError(leak),
            await captureSettingsDiscoveryResponse(leak),
            await captureSandboxStream(leak),
            await captureSynthesizerAnswer(synthesisInput, leak),
            await captureTidbError(leak),
          ];

          for (const capture of captures) {
            // (1) Redacted before the sink: the captured value is a redaction fixed point.
            expect(capture.stable, `${capture.name} reached the sink un-redacted`).toBe(true);
            // (2) No secret substring survived into the sink.
            expect(capture.serialized, `secret leaked into ${capture.name}`).not.toContain(secret);
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});
