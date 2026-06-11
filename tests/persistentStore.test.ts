import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { SqlRectorStore, createSqliteDriver, type SqlDriver } from "../src/store/sqlRectorStore";
import type {
  Artifact,
  Conversation,
  CreateArtifactInput,
  CreateConversationInput,
  CreateMessageInput,
  CreateRunInput,
  Message,
  Run,
  RunEvent,
} from "../src/store/schemas";
import { RUN_EVENT_TYPES } from "../src/protocol/events";
import { RUN_PHASES } from "../src/protocol/phases";

/**
 * Property 2: Persisted-then-reloaded store returns identical entities (restart survival).
 * Validates: Requirements 1.3, 1.4
 *
 * A sequence of writes covering conversations, messages, runs, events, and artifacts is committed
 * through one `SqlRectorStore`. The underlying SQLite file is then re-opened by a SECOND store
 * instance (a faithful process-restart simulation). Every previously written entity must read back
 * deep-equal to the entity originally written, with ids/counters reconstructed solely from the
 * persisted data, and every list result must preserve the original insertion order.
 *
 * The test uses a local temp-file SQLite database — no API key, no cloud account, no network.
 */

// A monotonic clock so created timestamps are deterministic across the suite (equality of a
// reloaded entity does not actually depend on this — the stored payload is the canonical form —
// but a fixed clock keeps generated fixtures stable).
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

// --- Generators ------------------------------------------------------------

const neString = (maxLength: number) => fc.string({ minLength: 1, maxLength });
const WORKSPACES = ["ws-1", "ws-2", "ws-3"] as const;
const ARTIFACT_KINDS = ["patch", "log", "report"] as const;

const EVENT_BASE = Date.parse("2026-01-01T00:00:00.000Z");
const isoDateArb = fc
  .integer({ min: 0, max: 5_000_000 })
  .map((ms) => new Date(EVENT_BASE + ms).toISOString());

const payloadArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 12 })),
  { maxKeys: 3 }
);

const recordArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 6 }),
  fc.oneof(fc.integer({ min: 0, max: 10_000 }), fc.string({ maxLength: 12 })),
  { maxKeys: 3 }
);

const budgetArb = fc.record({
  maxUsd: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  maxInputTokens: fc.nat({ max: 100_000 }),
  maxOutputTokens: fc.nat({ max: 100_000 }),
  maxModelCalls: fc.nat({ max: 100 }),
  maxRuntimeMs: fc.nat({ max: 600_000 }),
  maxHealingAttempts: fc.nat({ max: 10 }),
  allowedProviders: fc.array(neString(8), { maxLength: 3 }),
  approvalRequiredAboveUsd: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
});

const conversationInputArb: fc.Arbitrary<CreateConversationInput> = fc.record({
  title: neString(20),
  workspaceId: fc.constantFrom(...WORKSPACES),
  retentionPolicy: neString(12),
});

// Message spec carries an index used to bind it to a created conversation in the test.
const messageSpecArb = fc.record({
  convIdx: fc.nat({ max: 1_000 }),
  role: neString(8),
  content: fc.string({ maxLength: 40 }),
  status: neString(8),
  redactionState: neString(8),
  withRunRef: fc.boolean(),
});

const runSpecArb = fc.record({
  convIdx: fc.nat({ max: 1_000 }),
  status: neString(8),
  phase: fc.constantFrom(...RUN_PHASES),
  route: neString(8),
  complexity: neString(8),
  budget: budgetArb,
  costEstimate: recordArb,
  tokenEstimate: recordArb,
  traceId: neString(12),
  attempts: fc.nat({ max: 5 }),
  healingAttempts: fc.nat({ max: 5 }),
  validationAttempts: fc.nat({ max: 5 }),
});

const eventSpecArb = fc.record({
  runIdx: fc.nat({ max: 1_000 }),
  type: fc.constantFrom(...RUN_EVENT_TYPES),
  phase: fc.constantFrom(...RUN_PHASES),
  payload: payloadArb,
  traceId: neString(12),
  createdAt: isoDateArb,
});

const artifactInputArb: fc.Arbitrary<CreateArtifactInput> = fc.record({
  kind: fc.constantFrom(...ARTIFACT_KINDS),
  uri: neString(24),
  summary: fc.string({ maxLength: 40 }),
  hash: neString(24),
  sizeBytes: fc.nat({ max: 1_000_000 }),
  piiState: neString(8),
  retentionPolicy: neString(12),
  metadata: recordArb,
});

const scenarioArb = fc.record({
  conversations: fc.array(conversationInputArb, { minLength: 1, maxLength: 4 }),
  messages: fc.array(messageSpecArb, { maxLength: 8 }),
  runs: fc.array(runSpecArb, { maxLength: 5 }),
  events: fc.array(eventSpecArb, { maxLength: 10 }),
  artifacts: fc.array(artifactInputArb, { maxLength: 5 }),
});
// Explicit spec shapes (kept in sync with the generators above).
type MessageSpec = {
  convIdx: number;
  role: string;
  content: string;
  status: string;
  redactionState: string;
  withRunRef: boolean;
};
type RunSpec = {
  convIdx: number;
  status: string;
  phase: (typeof RUN_PHASES)[number];
  route: string;
  complexity: string;
  budget: CreateRunInput["budget"];
  costEstimate: Record<string, unknown>;
  tokenEstimate: Record<string, unknown>;
  traceId: string;
  attempts: number;
  healingAttempts: number;
  validationAttempts: number;
};
type EventSpec = {
  runIdx: number;
  type: (typeof RUN_EVENT_TYPES)[number];
  phase: (typeof RUN_PHASES)[number];
  payload: Record<string, unknown>;
  traceId: string;
  createdAt: string;
};
type GeneratedScenario = {
  conversations: CreateConversationInput[];
  messages: MessageSpec[];
  runs: RunSpec[];
  events: EventSpec[];
  artifacts: CreateArtifactInput[];
};

// The entities written through the first store instance — the expected reload results.
interface WrittenState {
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  events: RunEvent[];
  artifacts: Artifact[];
}

// Write the full scenario through a store and return the canonical created entities.
async function writeScenario(store: SqlRectorStore, scenario: GeneratedScenario): Promise<WrittenState> {
  const conversations: Conversation[] = [];
  for (const input of scenario.conversations) {
    conversations.push(await store.createConversation(input));
  }

  const messages: Message[] = [];
  const runs: Run[] = [];

  for (const spec of scenario.runs) {
    const conversation = conversations[spec.convIdx % conversations.length];
    const input: CreateRunInput = {
      conversationId: conversation.id,
      userMessageId: `umsg-${runs.length}`,
      status: spec.status,
      phase: spec.phase,
      route: spec.route,
      complexity: spec.complexity,
      budget: spec.budget,
      costEstimate: spec.costEstimate,
      tokenEstimate: spec.tokenEstimate,
      traceId: spec.traceId,
      attempts: spec.attempts,
      healingAttempts: spec.healingAttempts,
      validationAttempts: spec.validationAttempts,
    };
    runs.push(await store.createRun(input));
  }

  for (const spec of scenario.messages) {
    const conversation = conversations[spec.convIdx % conversations.length];
    const input: CreateMessageInput = {
      conversationId: conversation.id,
      role: spec.role,
      content: spec.content,
      status: spec.status,
      redactionState: spec.redactionState,
      ...(spec.withRunRef && runs.length > 0
        ? { runId: runs[spec.convIdx % runs.length].id }
        : {}),
    };
    messages.push(await store.createMessage(input));
  }

  const events: RunEvent[] = [];
  if (runs.length > 0) {
    scenario.events.forEach((spec, index) => {
      const run = runs[spec.runIdx % runs.length];
      events.push({
        id: `evt-${index}`,
        runId: run.id,
        type: spec.type,
        phase: spec.phase,
        payload: spec.payload,
        traceId: spec.traceId,
        createdAt: spec.createdAt,
      } as RunEvent);
    });
  }
  const appendedEvents: RunEvent[] = [];
  for (const event of events) {
    appendedEvents.push(await store.appendEvent(event));
  }

  const artifacts: Artifact[] = [];
  for (const input of scenario.artifacts) {
    artifacts.push(await store.createArtifact(input));
  }

  return { conversations, messages, runs, events: appendedEvents, artifacts };
}

describe("SqlRectorStore persisted-then-reloaded round-trip (Property 2 — restart survival)", () => {
  let dir: string;
  let counter = 0;
  const openDrivers = new Set<SqlDriver>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rector-persist-"));
  });

  afterEach(() => {
    // Defensive: ensure no driver handle is left open between iterations.
    for (const driver of openDrivers) {
      try {
        driver.close();
      } catch {
        /* already closed */
      }
    }
    openDrivers.clear();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Heavy SqlRectorStore property: allow extra time under Vitest 4 / slow WSL I/O (Chunk 37).
  it(
    "reloads every conversation, message, run, event, and artifact deep-equal with order preserved",
    async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (rawScenario) => {
        const scenario = rawScenario as GeneratedScenario;
        const dbPath = join(dir, `store-${counter++}.db`);

        // --- First store instance: write the scenario, then "shut down". ---
        const driver1 = createSqliteDriver({ path: dbPath });
        openDrivers.add(driver1);
        const store1 = new SqlRectorStore({ driver: driver1, now: fixedClock() });
        const written = await writeScenario(store1, scenario);
        driver1.close();
        openDrivers.delete(driver1);

        // --- Process restart: a brand-new store over the SAME database file. ---
        const driver2 = createSqliteDriver({ path: dbPath });
        openDrivers.add(driver2);
        const store2 = new SqlRectorStore({ driver: driver2, now: fixedClock() });

        try {
          // Point reads are deep-equal to the originally written entity (Req 1.3, 1.4).
          for (const conversation of written.conversations) {
            expect(await store2.getConversation(conversation.id)).toEqual(conversation);
          }
          for (const message of written.messages) {
            expect(await store2.getMessage(message.id)).toEqual(message);
          }
          for (const run of written.runs) {
            expect(await store2.getRun(run.id)).toEqual(run);
          }
          for (const event of written.events) {
            expect(await store2.getEvent(event.id)).toEqual(event);
          }
          for (const artifact of written.artifacts) {
            expect(await store2.getArtifact(artifact.id)).toEqual(artifact);
          }

          // Unfiltered list results preserve the original insertion order (Req 1.4).
          expect(await store2.listConversations()).toEqual(written.conversations);
          expect(await store2.listMessages()).toEqual(written.messages);
          expect(await store2.listRuns()).toEqual(written.runs);
          expect(await store2.listEvents()).toEqual(written.events);
          expect(await store2.listArtifacts()).toEqual(written.artifacts);

          // Filtered list results also preserve insertion order within each filter group.
          for (const workspaceId of WORKSPACES) {
            const expected = written.conversations.filter((c) => c.workspaceId === workspaceId);
            expect(await store2.listConversations(workspaceId)).toEqual(expected);
          }
          for (const conversation of written.conversations) {
            const expectedMessages = written.messages.filter(
              (m) => m.conversationId === conversation.id
            );
            expect(await store2.listMessages(conversation.id)).toEqual(expectedMessages);
            const expectedRuns = written.runs.filter(
              (r) => r.conversationId === conversation.id
            );
            expect(await store2.listRuns(conversation.id)).toEqual(expectedRuns);
          }
          for (const run of written.runs) {
            const expectedEvents = written.events.filter((e) => e.runId === run.id);
            expect(await store2.listEvents(run.id)).toEqual(expectedEvents);
          }
          for (const kind of ARTIFACT_KINDS) {
            const expected = written.artifacts.filter((a) => a.kind === kind);
            expect(await store2.listArtifacts(kind)).toEqual(expected);
          }
        } finally {
          driver2.close();
          openDrivers.delete(driver2);
        }
      }),
      { numRuns: 20 }
    );
  },
  120_000,
  );

  it("reloads a concrete cross-entity scenario after re-instantiation (deterministic example)", async () => {
    const dbPath = join(dir, `store-example-${counter++}.db`);

    const driver1 = createSqliteDriver({ path: dbPath });
    const store1 = new SqlRectorStore({ driver: driver1, now: fixedClock() });

    const conversation = await store1.createConversation({
      title: "Restart survival",
      workspaceId: "ws-1",
      retentionPolicy: "default",
    });
    const message = await store1.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: "persist me",
      status: "complete",
      redactionState: "none",
    });
    const run = await store1.createRun({
      conversationId: conversation.id,
      userMessageId: message.id,
      status: "running",
      phase: "TRIAGE",
      route: "local",
      complexity: "simple",
      budget: {
        maxUsd: 2,
        maxInputTokens: 10_000,
        maxOutputTokens: 5_000,
        maxModelCalls: 8,
        maxRuntimeMs: 60_000,
        maxHealingAttempts: 2,
        allowedProviders: ["local"],
        approvalRequiredAboveUsd: 1,
      },
      costEstimate: { usd: 0.5 },
      tokenEstimate: { input: 100, output: 200 },
      traceId: "trace-1",
      attempts: 0,
      healingAttempts: 0,
      validationAttempts: 0,
    });
    const event = await store1.appendEvent({
      id: "evt-1",
      runId: run.id,
      type: "RUN_CREATED",
      phase: "TRIAGE",
      payload: { step: 1 },
      traceId: "trace-1",
      createdAt: "2026-06-03T00:00:00.000Z",
    });
    const artifact = await store1.createArtifact({
      kind: "patch",
      uri: "file://changes.patch",
      summary: "Generated patch",
      hash: "sha256:abc",
      sizeBytes: 123,
      piiState: "none",
      retentionPolicy: "default",
      metadata: { labels: ["chunk-4"] },
    });
    driver1.close();

    const driver2 = createSqliteDriver({ path: dbPath });
    const store2 = new SqlRectorStore({ driver: driver2, now: fixedClock() });
    try {
      expect(await store2.getConversation(conversation.id)).toEqual(conversation);
      expect(await store2.getMessage(message.id)).toEqual(message);
      expect(await store2.getRun(run.id)).toEqual(run);
      expect(await store2.getEvent(event.id)).toEqual(event);
      expect(await store2.getArtifact(artifact.id)).toEqual(artifact);

      expect(await store2.listConversations()).toEqual([conversation]);
      expect(await store2.listMessages(conversation.id)).toEqual([message]);
      expect(await store2.listRuns(conversation.id)).toEqual([run]);
      expect(await store2.listEvents(run.id)).toEqual([event]);
      expect(await store2.listArtifacts("patch")).toEqual([artifact]);

      // Counters are reconstructed from persisted rows: the next created id continues the sequence.
      const nextConversation = await store2.createConversation({
        title: "second",
        workspaceId: "ws-1",
        retentionPolicy: "default",
      });
      expect(nextConversation.id).toBe("conv-2");
    } finally {
      driver2.close();
    }
  });
});
