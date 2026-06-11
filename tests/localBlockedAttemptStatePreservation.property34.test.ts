/**
 * Feature: cloud-capable-transition, Property 34: A blocked local outbound
 * attempt leaves persisted state unchanged.
 *
 * **Validates: Requirements 9.6**
 *
 *   "IF a code path attempts an outbound provider network call or an external
 *    sandbox execution while Orchestrator_Mode is `local`, THEN THE
 *    Rector_Server SHALL block the attempt and SHALL leave persisted state
 *    unchanged."
 *
 * Local_Mode is the provider-free regression baseline: no provider is ever
 * constructed with network access enabled, so every outbound provider call a
 * collaborator might attempt is gated off behind a `NETWORK_DISABLED`
 * {@link ProviderError} thrown *before* any network egress. This property pins
 * the second half of Req 9.6 — that the block is *clean*: the persisted store
 * is byte-for-byte identical before and after the blocked attempt.
 *
 * The test models a realistic collaborator that mirrors the production write
 * pattern: it attempts the outbound provider call first and only persists the
 * provider's output (a message + an artifact) on success. With the Local_Mode
 * network posture (`enableNetwork: false`, which the Config_Bridge always uses
 * in local mode), the call is blocked and the persist step is never reached, so
 * a full snapshot of the {@link InMemoryRectorStore} taken before equals the
 * snapshot taken after.
 *
 * Non-vacuity is guaranteed two ways inside the property:
 *   1. The store is seeded with arbitrary non-empty state, so "unchanged" is a
 *      claim about real persisted entities rather than an empty store.
 *   2. A control run over an *identically seeded* store with a network-enabled
 *      provider and a canned `fetch` double drives the same collaborator down
 *      its success branch, proving the persist path genuinely mutates the store
 *      — therefore the blocked branch leaving it unchanged is meaningful.
 *
 * Everything is hermetic: an in-memory Provider_Config_Store, a fake
 * {@link SecretStore}, an in-memory RectorStore, and an injected counting
 * `fetch` double. ZERO real disk or network access occurs, and the counting
 * double directly observes that the blocked attempt produced zero egress.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { PROVIDER_KINDS, type ProviderConfigRecord, type ProviderKind } from "../src/providers/config";
import {
  createInMemoryProviderConfigStore,
  type ProviderConfigStore,
} from "../src/providers/configStore";
import { resolveTestProvider } from "../src/providers/configBridge";
import { ProviderError, type LLMProvider } from "../src/providers/llm";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type {
  Artifact,
  Conversation,
  Message,
  Run,
  RunEvent,
} from "../src/store/schemas";
import type { SecretStore, SecretStoreResult } from "../src/security/secretStore";

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/** Deterministic in-memory {@link SecretStore} double — no disk, no network. */
function createFakeSecretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map<string, string>(Object.entries(initial));
  return {
    async setSecret(providerId: string, value: string): Promise<SecretStoreResult<void>> {
      secrets.set(providerId, value);
      return { ok: true, value: undefined };
    },
    async getSecret(providerId: string): Promise<SecretStoreResult<string>> {
      const value = secrets.get(providerId);
      return value === undefined
        ? { ok: false, error: `No secret stored for provider "${providerId}".` }
        : { ok: true, value };
    },
    async hasSecret(providerId: string): Promise<boolean> {
      return secrets.has(providerId);
    },
  };
}

/** Seed an in-memory Provider_Config_Store with a single record. */
async function seedProviderStore(record: ProviderConfigRecord): Promise<ProviderConfigStore> {
  const store = createInMemoryProviderConfigStore();
  const result = await store.upsertProvider(record);
  expect(result.ok).toBe(true);
  return store;
}

/**
 * Build a schema-valid, *fully-configured* record for the given kind plus its
 * secret map, so the constructed provider passes `validateConfig()` and the
 * invoke path reaches the `enableNetwork` gate (the point where Local_Mode
 * blocks the attempt). Every kind supports the shared `fast` route.
 */
function buildValidRecord(
  kind: ProviderKind,
  token: string,
  secret: string,
): { record: ProviderConfigRecord; secrets: Record<string, string> } {
  const secretRef = `secret:${kind}:${token}`;
  const base = {
    id: `${kind}:${token}`,
    kind,
    label: `Label ${token}`,
    secretRef,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  } as const;
  const secrets = { [secretRef]: secret };

  switch (kind) {
    case "together":
      return { record: { ...base, baseUrl: `https://${token}.together.example/v1` }, secrets };
    case "cloudflare":
      return {
        record: { ...base, baseUrl: `https://${token}.cloudflare.example/client/v4`, cloudflare: { accountId: token } },
        secrets,
      };
    case "azure-openai":
      return {
        record: {
          ...base,
          baseUrl: `https://${token}.azure.example`,
          model: `deployment-${token}`,
          azure: { endpoint: `https://${token}.azure.example`, deployment: `deployment-${token}` },
        },
        secrets,
      };
    case "openai-compatible":
      return {
        record: { ...base, baseUrl: `https://${token}.proxy.example/v1`, model: `model-${token}` },
        secrets,
      };
  }
}

/**
 * A canned response satisfying every provider's response parser, used only by
 * the network-enabled control run so the collaborator reaches its success
 * (persist) branch. Never reached on the blocked Local_Mode path.
 */
function cannedResponse(): Response {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        result: { response: "ok" },
        success: true,
        model: "canned-model",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  } as unknown as Response;
}

/** A full, comparable snapshot of every persisted entity in a RectorStore. */
interface StoreSnapshot {
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  events: RunEvent[];
  artifacts: Artifact[];
}

async function snapshotStore(store: InMemoryRectorStore): Promise<StoreSnapshot> {
  const [conversations, messages, runs, events, artifacts] = await Promise.all([
    store.listConversations(),
    store.listMessages(),
    store.listRuns(),
    store.listEvents(),
    store.listArtifacts(),
  ]);
  // Deep-clone via JSON so the snapshot is immune to later in-place mutation and
  // is directly structurally comparable with `toEqual`.
  return JSON.parse(JSON.stringify({ conversations, messages, runs, events, artifacts })) as StoreSnapshot;
}

/** Arbitrary, schema-valid seed contents for the RectorStore (non-empty). */
interface SeedSpec {
  conversations: { title: string; workspaceId: string; retentionPolicy: string }[];
  messagesPerConversation: { role: string; content: string; status: string; redactionState: string }[];
  artifacts: { kind: string; uri: string; summary: string; hash: string; sizeBytes: number; piiState: string; retentionPolicy: string }[];
}

const nonEmpty = (minLength = 1, maxLength = 24) =>
  fc.string({ minLength, maxLength }).filter((value) => value.trim().length >= minLength);

const arbSeedSpec = (): fc.Arbitrary<SeedSpec> =>
  fc.record({
    conversations: fc.array(
      fc.record({ title: nonEmpty(), workspaceId: nonEmpty(), retentionPolicy: nonEmpty() }),
      { minLength: 1, maxLength: 3 },
    ),
    messagesPerConversation: fc.array(
      fc.record({
        role: fc.constantFrom("user", "assistant", "system"),
        content: fc.string({ maxLength: 48 }),
        status: fc.constantFrom("created", "completed", "streaming"),
        redactionState: fc.constantFrom("none", "redacted"),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    artifacts: fc.array(
      fc.record({
        kind: nonEmpty(),
        uri: nonEmpty(),
        summary: fc.string({ maxLength: 48 }),
        hash: nonEmpty(),
        sizeBytes: fc.nat({ max: 4096 }),
        piiState: fc.constantFrom("none", "scrubbed"),
        retentionPolicy: nonEmpty(),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  });

/** Build and seed a fresh in-memory RectorStore from a {@link SeedSpec}. */
async function seedRectorStore(spec: SeedSpec): Promise<InMemoryRectorStore> {
  const store = new InMemoryRectorStore({ now: () => FIXED_TS });
  for (const conv of spec.conversations) {
    const conversation = await store.createConversation(conv);
    for (const msg of spec.messagesPerConversation) {
      await store.createMessage({ ...msg, conversationId: conversation.id });
    }
  }
  for (const art of spec.artifacts) {
    await store.createArtifact({ ...art, metadata: {} });
  }
  return store;
}

/**
 * The modeled collaborator: attempt an outbound provider call, and ONLY on
 * success persist the provider's output (a message + an artifact). Mirrors the
 * production pattern where persistence follows a successful provider result.
 *
 * Returns whether the attempt was blocked by the Local_Mode network gate.
 */
async function attemptOutboundThenPersist(
  store: InMemoryRectorStore,
  provider: LLMProvider,
): Promise<{ blocked: boolean }> {
  let content: string;
  try {
    const response = await provider.invoke({
      messages: [{ role: "user", content: "ping" }],
      modelRoute: "fast",
    });
    content = response.content;
  } catch (error) {
    if (error instanceof ProviderError && error.code === "NETWORK_DISABLED") {
      // Blocked: the outbound attempt never reached the network and we persist
      // nothing, so the store is left exactly as it was.
      return { blocked: true };
    }
    throw error;
  }

  // Success branch (only reached when network is enabled): persist the result.
  const [conversation] = await store.listConversations();
  if (conversation) {
    await store.createMessage({
      conversationId: conversation.id,
      role: "assistant",
      content,
      status: "completed",
      redactionState: "none",
    });
  }
  await store.createArtifact({
    kind: "provider-output",
    uri: "mem://provider-output",
    summary: content,
    hash: "hash-provider-output",
    sizeBytes: content.length,
    piiState: "none",
    retentionPolicy: "session",
    metadata: {},
  });
  return { blocked: false };
}

const tokenArb = fc.integer({ min: 1, max: 1_000_000 }).map((n) => `t${n}`);
const secretArb = fc.string({ minLength: 8, maxLength: 64 }).filter((value) => value.trim().length >= 8);

describe("Local_Mode — Property 34: a blocked outbound attempt leaves persisted state unchanged (Req 9.6)", () => {
  // Feature: cloud-capable-transition, Property 34: A blocked local outbound attempt leaves persisted state unchanged
  it("blocks the local outbound attempt with zero egress and leaves the store byte-identical", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDER_KINDS),
        tokenArb,
        secretArb,
        arbSeedSpec(),
        async (kind, token, secret, seed) => {
          const { record, secrets: secretMap } = buildValidRecord(kind, token, secret);
          const providerStore = await seedProviderStore(record);
          const secrets = createFakeSecretStore(secretMap);

          // --- Local_Mode path: the provider is constructed with the Local_Mode
          // network posture (enableNetwork: false — the Config_Bridge always uses
          // this in local mode) and a counting fetch double standing in for the
          // network boundary.
          let blockedFetchCount = 0;
          const blockedFetch = (async () => {
            blockedFetchCount += 1;
            return cannedResponse();
          }) as unknown as typeof fetch;

          const localProvider = await resolveTestProvider(record.id, providerStore, secrets, {
            enableNetwork: false,
            fetchImpl: blockedFetch,
          });
          expect(localProvider).toBeDefined();

          const store = await seedRectorStore(seed);
          const before = await snapshotStore(store);
          // Sanity: the seeded state is genuinely non-empty, so "unchanged" is a
          // meaningful claim rather than a vacuous statement about an empty store.
          expect(before.conversations.length).toBeGreaterThanOrEqual(1);
          expect(before.messages.length).toBeGreaterThanOrEqual(1);
          expect(before.artifacts.length).toBeGreaterThanOrEqual(1);

          const blockedResult = await attemptOutboundThenPersist(store, localProvider!);

          // Req 9.6: the outbound attempt is blocked ...
          expect(blockedResult.blocked).toBe(true);
          // ... before any network egress (the counting double never fired) ...
          expect(blockedFetchCount).toBe(0);
          // ... and the persisted state is unchanged (snapshot before == after).
          const after = await snapshotStore(store);
          expect(after).toEqual(before);

          // --- Non-vacuity control: the SAME collaborator over an identically
          // seeded store, but with a network-enabled provider + canned fetch,
          // takes the success branch and genuinely mutates the store. This proves
          // the persist path is real, so the blocked branch above truly preserves
          // state rather than simply never writing under any condition.
          let controlFetchCount = 0;
          const controlFetch = (async () => {
            controlFetchCount += 1;
            return cannedResponse();
          }) as unknown as typeof fetch;
          const controlProvider = await resolveTestProvider(record.id, providerStore, secrets, {
            enableNetwork: true,
            fetchImpl: controlFetch,
          });
          const controlStore = await seedRectorStore(seed);
          const controlBefore = await snapshotStore(controlStore);
          const controlResult = await attemptOutboundThenPersist(controlStore, controlProvider!);
          const controlAfter = await snapshotStore(controlStore);

          expect(controlResult.blocked).toBe(false);
          expect(controlFetchCount).toBeGreaterThanOrEqual(1);
          // The success path persisted at least one new entity (message+artifact).
          expect(controlAfter).not.toEqual(controlBefore);
        },
      ),
      { numRuns: 100 },
    );
  });
});
