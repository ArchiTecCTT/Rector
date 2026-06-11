import { describe, expect, it } from "vitest";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { createRectorStore, type PersistenceConfig, type RectorStore } from "../src/store";
import type {
  Artifact,
  Conversation,
  Message,
  Run,
  RunEvent,
} from "../src/store/schemas";

/**
 * In-memory baseline regression test.
 * Validates: Requirements 5.2, 5.4
 *
 * Phase 3 introduced a `RectorStore` interface, the `createRectorStore` selection factory, the SSE
 * broadcast decorator, and the cost aggregates — but it must NOT change the default, provider-free
 * path. Requirement 5.2 makes the in-memory store the default backing the provider-free baseline;
 * Requirement 5.4 requires that the persisted conversations, messages, runs, events, and artifacts
 * produced by that default path remain BYTE-FOR-BYTE identical to the pre-Phase-3 baseline (the
 * unchanged `InMemoryRectorStore`).
 *
 * This suite anchors that guarantee three ways:
 *   1. The default/provider-free selection (`createRectorStore()` with no config, and the explicit
 *      `memory` driver) resolves to an `InMemoryRectorStore` — no driver, no file handle, no
 *      cloud account, and no network (Req 5.2).
 *   2. Running one identical, fully deterministic cross-entity scenario through the default-path
 *      store and through a directly-constructed `InMemoryRectorStore` (the pre-Phase-3 baseline)
 *      yields byte-for-byte identical serialized entities and list results (Req 5.4).
 *   3. The serialized baseline dump is locked against an explicit golden snapshot so any future
 *      drift in the in-memory store's entity shape, id scheme, or key order is caught (Req 5.4).
 *
 * No API key is read and no outbound network connection is made — the store is entirely in-process.
 */

// A deterministic, monotonic clock so every timestamp is fixed and reproducible. Two independent
// instances produce the identical sequence, which is what lets the default-path dump and the
// baseline dump be compared byte-for-byte.
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

const BUDGET = {
  maxUsd: 2,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxModelCalls: 8,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: ["local"],
  approvalRequiredAboveUsd: 1,
} as const;

// The canonical dump captured after the scenario runs: every created/updated entity plus the
// unfiltered and filtered list results, in insertion order.
interface StoreDump {
  conversations: (Conversation | undefined)[];
  messages: (Message | undefined)[];
  runs: (Run | undefined)[];
  events: (RunEvent | undefined)[];
  artifacts: (Artifact | undefined)[];
  listConversations: Conversation[];
  listConversationsByWorkspace: Conversation[];
  listMessages: Message[];
  listMessagesByConversation: Message[];
  listRuns: Run[];
  listRunsByConversation: Run[];
  listEvents: RunEvent[];
  listEventsByRun: RunEvent[];
  listArtifacts: Artifact[];
  listArtifactsByKind: Artifact[];
}

/**
 * A fully deterministic scenario that exercises every write path the in-memory store exposes:
 * create/update for conversations, messages, runs, and artifacts; `appendEvent`; and an atomic
 * `commitRunTransition`. It contains no randomness, no `Date.now`, and no environment access, so
 * two stores fed the same fixed clock must produce identical output.
 */
async function runScenario(store: RectorStore): Promise<StoreDump> {
  // --- Conversations (two workspaces, plus an update) ---
  const conversationA = await store.createConversation({
    title: "Build Rector",
    workspaceId: "ws-1",
    retentionPolicy: "default",
  });
  const conversationB = await store.createConversation({
    title: "Second thread",
    workspaceId: "ws-2",
    retentionPolicy: "short",
  });
  const conversationAUpdated = await store.updateConversation(conversationA.id, {
    title: "Build Rector (renamed)",
  });

  // --- A run, then an update that fills the optional actual cost/token fields ---
  const userMessage = await store.createMessage({
    conversationId: conversationA.id,
    role: "user",
    content: "Implement persistence",
    status: "complete",
    redactionState: "none",
  });
  const run = await store.createRun({
    conversationId: conversationA.id,
    userMessageId: userMessage.id,
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget: { ...BUDGET, allowedProviders: [...BUDGET.allowedProviders] },
    costEstimate: { usd: 0.5 },
    tokenEstimate: { input: 100, output: 200 },
    traceId: "trace-1",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
  });
  const runUpdated = await store.updateRun(run.id, {
    status: "completed",
    actualCost: { usd: 0.42 },
    actualTokens: { input: 90, output: 180 },
  });

  // --- A reply message that references the run ---
  const assistantMessage = await store.createMessage({
    conversationId: conversationA.id,
    role: "assistant",
    content: "Persistence implemented.",
    status: "complete",
    runId: run.id,
    redactionState: "none",
  });

  // --- Events: one appended directly, one applied via an atomic run transition ---
  const createdEvent = await store.appendEvent({
    id: "evt-1",
    runId: run.id,
    type: "RUN_CREATED",
    phase: "TRIAGE",
    payload: { step: 1 },
    traceId: "trace-1",
    createdAt: "2026-06-03T00:00:00.000Z",
  });
  const transition = await store.commitRunTransition(
    run.id,
    { phase: "DONE", status: "completed" },
    {
      id: "evt-2",
      runId: run.id,
      type: "RUN_COMPLETED",
      phase: "DONE",
      payload: { step: 2 },
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:01.000Z",
    }
  );

  // --- Artifacts (create, then update the summary) ---
  const artifact = await store.createArtifact({
    kind: "patch",
    uri: "file://changes.patch",
    summary: "Generated patch",
    hash: "sha256:abc",
    sizeBytes: 123,
    piiState: "none",
    retentionPolicy: "default",
    metadata: { labels: ["chunk-4"] },
  });
  const artifactUpdated = await store.updateArtifact(artifact.id, {
    summary: "Generated patch (reviewed)",
  });

  return {
    conversations: [conversationA, conversationB, conversationAUpdated],
    messages: [userMessage, assistantMessage],
    runs: [run, runUpdated, transition.run],
    events: [createdEvent, transition.event],
    artifacts: [artifact, artifactUpdated],
    listConversations: await store.listConversations(),
    listConversationsByWorkspace: await store.listConversations("ws-1"),
    listMessages: await store.listMessages(),
    listMessagesByConversation: await store.listMessages(conversationA.id),
    listRuns: await store.listRuns(),
    listRunsByConversation: await store.listRuns(conversationA.id),
    listEvents: await store.listEvents(),
    listEventsByRun: await store.listEvents(run.id),
    listArtifacts: await store.listArtifacts(),
    listArtifactsByKind: await store.listArtifacts("patch"),
  };
}

describe("In-memory baseline regression (Requirements 5.2, 5.4)", () => {
  it("resolves the default and provider-free path to the in-memory store with no driver or network", () => {
    // Req 5.2: no config at all -> the in-memory default (the provider-free baseline).
    const defaulted = createRectorStore();
    expect(defaulted).toBeInstanceOf(InMemoryRectorStore);

    // Req 5.2: an explicit `memory` driver resolves to the same in-memory store; the Mongo/Redis
    // fields are present but ignored for selection (no Mongo dependency, no network).
    const memoryConfig: PersistenceConfig = {
      driver: "memory",
      mongoUri: "mongodb://example.invalid/db",
      mongoDb: "ignored",
      redisUrl: "redis://example.invalid:6379",
    };
    const explicit = createRectorStore(memoryConfig);
    expect(explicit).toBeInstanceOf(InMemoryRectorStore);

    // An absent persistence block also defaults to in-memory.
    const undefinedDriver = createRectorStore({} as PersistenceConfig);
    expect(undefinedDriver).toBeInstanceOf(InMemoryRectorStore);
  });

  it("produces conversations, messages, runs, events, and artifacts byte-for-byte identical to the pre-Phase-3 baseline", async () => {
    // Pre-Phase-3 baseline: the unchanged InMemoryRectorStore, constructed directly.
    const baseline = new InMemoryRectorStore({ now: fixedClock() });
    const baselineDump = await runScenario(baseline);

    // Default path: the Phase 3 factory with no persistence configured resolves to the in-memory
    // store and must reproduce the baseline exactly.
    const defaultPath = createRectorStore(undefined, { now: fixedClock() });
    const defaultPathDump = await runScenario(defaultPath);

    // Explicit `memory` driver path: same guarantee.
    const memoryPath = createRectorStore({ driver: "memory" }, { now: fixedClock() });
    const memoryPathDump = await runScenario(memoryPath);

    // Byte-for-byte identity: serialize both dumps and compare the exact strings (Req 5.4).
    const baselineBytes = JSON.stringify(baselineDump);
    expect(JSON.stringify(defaultPathDump)).toBe(baselineBytes);
    expect(JSON.stringify(memoryPathDump)).toBe(baselineBytes);

    // Deep structural equality as a readable companion assertion.
    expect(defaultPathDump).toEqual(baselineDump);
    expect(memoryPathDump).toEqual(baselineDump);
  });

  it("locks the exact serialized shape of the in-memory baseline dump against drift", async () => {
    const baseline = new InMemoryRectorStore({ now: fixedClock() });
    const dump = await runScenario(baseline);

    // A golden snapshot of the canonical byte representation. If a future change alters a field,
    // the id scheme, key order, or timestamp handling on the default path, this assertion fails
    // and flags the pre-Phase-3 regression.
    expect(JSON.stringify(dump, null, 2)).toMatchSnapshot();
  });
});
