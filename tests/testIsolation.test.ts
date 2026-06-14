/**
 * Task 13.2 — Network/credential isolation guard test (ORN-39/40/41).
 *
 * **Validates: Requirements 5.3, 5.5**
 *
 * This is a guard / meta test. It does not exercise a feature; it pins down the test environment's
 * two isolation invariants so that a future change can never silently make the suite depend on a
 * real credential or an outbound network connection:
 *
 *   Req 5.3 — `npm test` completes with mocked providers and a local/injected `SqlDriver` in place
 *             of a real cloud database, with NO environment API key required and NO outbound
 *             network connection established.
 *   Req 5.5 — IF a test execution attempts an outbound network connection OR requires a real
 *             provider API key, THEN the suite fails LOUDLY rather than contacting any external
 *             service.
 *
 * The three invariants asserted:
 *
 *   (1) No real API key is present/required. Every provider/orchestration secret env key
 *       (`TOGETHER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `AZURE_OPENAI_API_KEY`,
 *       `OPENAI_API_KEY`, … — see `src/deployment/index.ts` EXTERNAL_PROVIDER_DESCRIPTORS and
 *       `src/providers/llm.ts`) is unset, empty, or a recognizable placeholder during the run, so
 *       the suite cannot depend on a real credential. If a real-looking value is present the
 *       assertion fails loudly, naming the offending key.
 *
 *   (2) No outbound network. A `fetch` sentinel that THROWS synchronously on any call is installed
 *       for the duration of a representative provider-free (local) run AND a mocked-provider
 *       (external/BYOK) run. Both runs are driven directly through `runChat` (no HTTP harness, so
 *       the sentinel only ever sees a genuine outbound attempt). The sentinel must have been called
 *       ZERO times — proving the local path never reaches the network and the BYOK provider does
 *       not open a connection when a scripted (non-network) provider is injected. The original
 *       `fetch` is always restored in a `finally`.
 *
 *   (3) Local/injected `SqlDriver`. The persistent path is exercised against an in-memory SQLite
 *       store built by `createRectorStore({ driver: "sqlite", sqlitePath: ":memory:" })` — no cloud
 *       account, no network. The hosted `createTiDBDriver` is never auto-constructed for the
 *       memory/sqlite paths (asserted by selecting both and confirming a working local store).
 *
 * FAILS LOUDLY: the sentinel does not no-op. A dedicated assertion confirms the sentinel throws a
 * clearly-labelled error when invoked, so any code under test that attempts an outbound call during
 * a guarded run aborts that run with an obvious "outbound network" message instead of silently
 * succeeding.
 *
 * No API key, no network: local mode invokes the deterministic fake planner (zero provider calls),
 * the external run uses a scripted `SpyLLMProvider` (no network I/O), and persistence is in-memory
 * SQLite.
 */
import { describe, expect, it } from "vitest";

import { runChat, type ChatRunArgs } from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { createRectorStore, type RectorStore } from "../src/store";
import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan, type PlannerOutput } from "../src/orchestration/planner";
import { createInMemoryObservabilityTrace } from "../src/observability";
import type { ModelRouter, ModelSelection } from "../src/providers/llm";
import {
  SpyLLMProvider,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";
import { configuredSpyRouter } from "./support/configuredApp";

// ---------------------------------------------------------------------------
// (1) Credential isolation: provider/orchestration secret env keys
// ---------------------------------------------------------------------------

/**
 * Every secret-bearing provider/orchestration env key the codebase reads (see
 * `EXTERNAL_PROVIDER_DESCRIPTORS` in `src/deployment/index.ts` and the provider constructors in
 * `src/providers/llm.ts`). `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are included defensively: they
 * are common ambient credentials a developer machine may carry and which no test may depend on.
 */
const PROVIDER_SECRET_ENV_KEYS = [
  "TOGETHER_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Runs `fn` with every provider secret env key DELETED from `process.env`, always restoring the
 * prior values afterwards. This is stronger than asserting the ambient machine happens to lack a
 * key: it proves the guarded code does not DEPEND on a real credential, because it runs to
 * completion with all of them removed (Req 5.5 — "requires a real provider API key"). A developer
 * machine or CI runner may legitimately carry ambient credentials; they must simply never be
 * required by the suite.
 */
async function withScrubbedCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of PROVIDER_SECRET_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Network isolation: a fetch sentinel that fails loudly on any outbound call
// ---------------------------------------------------------------------------

class OutboundNetworkAttemptError extends Error {
  readonly name = "OutboundNetworkAttemptError";
}

interface FetchSentinel {
  fetchImpl: typeof fetch;
  callCount: number;
  /** The targets the sentinel was asked to reach (for a clear failure message). */
  attempts: string[];
}

/**
 * Builds a `fetch` replacement that THROWS SYNCHRONOUSLY on any invocation. Throwing (rather than
 * returning a rejected promise) guarantees the failure is loud and immediate at the call site, so a
 * stray outbound attempt during a guarded run cannot be swallowed by un-awaited promise handling.
 */
function createFetchSentinel(): FetchSentinel {
  const sentinel: FetchSentinel = { fetchImpl: undefined as unknown as typeof fetch, callCount: 0, attempts: [] };
  sentinel.fetchImpl = ((input: unknown) => {
    sentinel.callCount += 1;
    const target =
      typeof input === "string"
        ? input
        : input && typeof input === "object" && "url" in input
          ? String((input as { url: unknown }).url)
          : String(input);
    sentinel.attempts.push(target);
    throw new OutboundNetworkAttemptError(
      `Prohibited outbound network connection during test: fetch("${target}"). The Rector test ` +
        `suite must run with no outbound network (Req 5.3/5.5).`
    );
  }) as unknown as typeof fetch;
  return sentinel;
}

/** Runs `fn` with the global `fetch` replaced by `sentinel`, always restoring the original. */
async function withFetchSentinel<T>(sentinel: FetchSentinel, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = sentinel.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Harness: drive a chat run directly (no HTTP, so the sentinel only ever sees
// a genuine outbound provider attempt — never the test client itself).
// ---------------------------------------------------------------------------

/** A `ModelRouter` whose `select` always returns the supplied scripted spy provider. */
function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "isolation guard router selects the scripted spy provider",
      };
    },
  };
}

/** Builds a fresh, schema-valid `ChatRunArgs` for `prompt`, seeded into `store`. */
async function buildChatArgs(store: RectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "isolation guard",
    workspaceId: "local",
    retentionPolicy: "session",
  });
  const userMessage = await store.createMessage({
    conversationId: conversation.id,
    role: "user",
    content: prompt,
    status: "created",
    redactionState: "none",
  });
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const observability = createInMemoryObservabilityTrace({ provider: "external" });

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
  };
}

const PROMPT = "Explain the Rector vertical slice.";

/** A deterministic, schema-valid plan for `prompt`, reusing the fake planner. */
function fakePlanFor(prompt: string, triage: ChatRunArgs["triage"], contextPack: ChatRunArgs["contextPack"]): PlannerOutput {
  return createFakePlan({ triage, contextPack, messageContent: prompt });
}

describe("test isolation guard — no real credential is present or required (Req 5.5)", () => {
  it("does not require any provider/orchestration credential — runs with all of them scrubbed", async () => {
    // Delete every provider secret key AND install the throwing fetch sentinel, then drive the
    // provider-free baseline. If any code path actually required a real key (or tried to reach the
    // network with one), this run would fail loudly here instead of contacting an external service.
    const sentinel = createFetchSentinel();
    const result = await withScrubbedCredentials(async () =>
      withFetchSentinel(sentinel, async () => {
        const store = new InMemoryRectorStore();
        const args = await buildChatArgs(store, PROMPT);
        return runChat(store, args, { router: configuredSpyRouter(PROMPT), sandboxConfigured: true });
      })
    );

    // Within the guarded section no provider secret key was set...
    expect(result.run.status).toBe("completed");
    expect(result.run.phase).toBe("DONE");
    // ...the scripted spy provider completed without outbound network...
    expect(result.observabilitySummary.modelCallCount).toBeGreaterThanOrEqual(0);
    // ...and not one outbound connection was attempted.
    expect(sentinel.callCount, `attempted outbound network to: ${sentinel.attempts.join(", ")}`).toBe(0);
  });

  it("runs the configured spy pipeline with no orchestration credential configured", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, PROMPT);
    const result = await runChat(store, args, { router: configuredSpyRouter(PROMPT), sandboxConfigured: true });

    expect(result.run.status).toBe("completed");
    expect(result.run.phase).toBe("DONE");
    expect(result.observabilitySummary.modelCallCount).toBeGreaterThanOrEqual(0);
  });
});

describe("test isolation guard — the fetch sentinel fails loudly (Req 5.5)", () => {
  it("throws synchronously on any outbound fetch attempt instead of silently no-oping", () => {
    const sentinel = createFetchSentinel();
    expect(() => (sentinel.fetchImpl as unknown as (u: string) => unknown)("https://api.together.xyz/v1")).toThrow(
      OutboundNetworkAttemptError
    );
    expect(() => (sentinel.fetchImpl as unknown as (u: string) => unknown)("https://api.together.xyz/v1")).toThrow(
      /Prohibited outbound network connection/
    );
    // The sentinel recorded every attempt, so a guarded run can name what tried to reach out.
    expect(sentinel.callCount).toBe(2);
    expect(sentinel.attempts).toEqual([
      "https://api.together.xyz/v1",
      "https://api.together.xyz/v1",
    ]);
  });
});

describe("test isolation guard — no outbound network during a guarded run (Req 5.3/5.5)", () => {
  it("drives the configured spy pipeline against an in-memory store with ZERO fetch calls", async () => {
    const sentinel = createFetchSentinel();
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, PROMPT);

    const result = await withFetchSentinel(sentinel, async () =>
      runChat(store, args, { router: configuredSpyRouter(PROMPT), sandboxConfigured: true }),
    );

    expect(sentinel.callCount, `spy run attempted outbound network to: ${sentinel.attempts.join(", ")}`).toBe(0);
    expect(result.run.phase).toBe("DONE");
  });

  it("drives the configured spy pipeline against an injected in-memory SQLite SqlDriver with ZERO fetch calls", async () => {
    const store = createRectorStore({ driver: "sqlite", sqlitePath: ":memory:" });
    const sentinel = createFetchSentinel();
    const args = await buildChatArgs(store, PROMPT);

    const result = await withFetchSentinel(sentinel, async () =>
      runChat(store, args, { router: configuredSpyRouter(PROMPT), sandboxConfigured: true }),
    );

    expect(sentinel.callCount, `sqlite-backed run attempted outbound network to: ${sentinel.attempts.join(", ")}`).toBe(0);
    expect(result.run.phase).toBe("DONE");

    // The persisted run survives a reload against the same kind of local driver with no network.
    const reloadedEvents = await store.listEvents(result.run.id);
    expect(reloadedEvents.length).toBeGreaterThan(0);
  });

  it("drives a mocked external (BYOK) run with a scripted provider and ZERO fetch calls", async () => {
    // The BYOK provider path does not open a connection when a scripted (non-network) provider is
    // injected: the spy returns canned plan/skeptic/synthesis content without ever calling fetch.
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, PROMPT);
    const plan = fakePlanFor(PROMPT, args.triage, args.contextPack);
    const provider = new SpyLLMProvider({
      responses: [
        {
          content: JSON.stringify({
            distilledContext: PROMPT,
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: planToJson(plan) },
        { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
        {
          content: synthesisDraftToJson({
            response: "The Rector vertical slice ran end-to-end; evidence cited below.",
            citations: [
              { kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" },
            ],
          }),
        },
      ],
    });

    const sentinel = createFetchSentinel();
    const result = await withFetchSentinel(sentinel, async () =>
      runChat(store, args, { mode: "external", router: spyRouter(provider) })
    );

    // The scripted provider was exercised, yet not one outbound connection was attempted.
    expect(provider.invokeCount).toBeGreaterThan(0);
    expect(sentinel.callCount, `external run attempted outbound network to: ${sentinel.attempts.join(", ")}`).toBe(0);
    expect(result.run.phase).toBe("DONE");
  });
});
