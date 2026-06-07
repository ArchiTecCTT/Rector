import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createRectorStore,
  createSqliteDriver,
  type RectorStore,
  type SqlDriver,
  type Artifact,
  type Conversation,
  type CreateArtifactInput,
  type CreateConversationInput,
  type CreateMessageInput,
  type CreateRunInput,
  type Message,
  type Run,
  type RunEvent,
} from "../src/store";
import { RUN_EVENT_TYPES } from "../src/protocol/events";
import { RUN_PHASES } from "../src/protocol/phases";

/**
 * Task 8.2 — Store write-then-read-back round-trip property test.
 *
 * **Property 12: Store write-then-read-back round-trip**
 * **Validates: Requirements 8.1**
 *
 * For any record written through the SQL-backed store, reading the record back
 * yields a record equal to the written record field-for-field.
 *
 * The store is built through the production `createRectorStore` factory over an
 * injected in-memory driver — `createSqliteDriver({ path: ":memory:" })`. An
 * in-memory SQLite database exercises the real `SqlRectorStore` persistence path
 * (schema-validated serialize on write, re-parse on read) while touching no disk
 * file, no cloud account, no network, and no provider. This is exactly the
 * "injected in-memory driver, no network" surface Property 12 names.
 */

// A deterministic monotonic clock so generated timestamps are stable; the
// round-trip equality does not depend on it (the stored payload is canonical),
// but a fixed clock keeps fixtures reproducible.
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

const messageSpecArb = fc.record({
  role: neString(8),
  content: fc.string({ maxLength: 40 }),
  status: neString(8),
  redactionState: neString(8),
});

const runSpecArb = fc.record({
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

// One self-contained scenario: a conversation plus a record of every other
// entity kind bound to it, so a single round-trip exercises every table.
const scenarioArb = fc.record({
  conversation: conversationInputArb,
  message: messageSpecArb,
  run: runSpecArb,
  event: eventSpecArb,
  artifact: artifactInputArb,
});

describe("store write-then-read-back round-trip (Property 12)", () => {
  const openDrivers = new Set<SqlDriver>();

  function injectInMemoryDriver(): { store: RectorStore; driver: SqlDriver } {
    // ":memory:" keeps the round-trip entirely in process memory: no disk file,
    // no cloud account, no network. The driver is injected via the production
    // factory so the real SqlRectorStore persistence path is exercised.
    const driver = createSqliteDriver({ path: ":memory:" });
    openDrivers.add(driver);
    const store = createRectorStore(undefined, { driver, now: fixedClock() });
    return { store, driver };
  }

  afterEach(() => {
    for (const driver of openDrivers) {
      try {
        driver.close();
      } catch {
        /* already closed */
      }
    }
    openDrivers.clear();
  });

  // Feature: productization-alpha, Property 12: Store write-then-read-back round-trip
  it("reads every written record back field-for-field", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { store, driver } = injectInMemoryDriver();
        try {
          // --- Write each entity through the store. ---
          const conversation: Conversation = await store.createConversation(scenario.conversation);

          const messageInput: CreateMessageInput = {
            conversationId: conversation.id,
            role: scenario.message.role,
            content: scenario.message.content,
            status: scenario.message.status,
            redactionState: scenario.message.redactionState,
          };
          const message: Message = await store.createMessage(messageInput);

          const runInput: CreateRunInput = {
            conversationId: conversation.id,
            userMessageId: message.id,
            status: scenario.run.status,
            phase: scenario.run.phase,
            route: scenario.run.route,
            complexity: scenario.run.complexity,
            budget: scenario.run.budget,
            costEstimate: scenario.run.costEstimate,
            tokenEstimate: scenario.run.tokenEstimate,
            traceId: scenario.run.traceId,
            attempts: scenario.run.attempts,
            healingAttempts: scenario.run.healingAttempts,
            validationAttempts: scenario.run.validationAttempts,
          };
          const run: Run = await store.createRun(runInput);

          const event: RunEvent = await store.appendEvent({
            id: "evt-1",
            runId: run.id,
            type: scenario.event.type,
            phase: scenario.event.phase,
            payload: scenario.event.payload,
            traceId: scenario.event.traceId,
            createdAt: scenario.event.createdAt,
          } as RunEvent);

          const artifact: Artifact = await store.createArtifact(scenario.artifact);

          // --- Read each record back: it must equal the written record
          // field-for-field (deep equality over the canonical entity). ---
          expect(await store.getConversation(conversation.id)).toEqual(conversation);
          expect(await store.getMessage(message.id)).toEqual(message);
          expect(await store.getRun(run.id)).toEqual(run);
          expect(await store.getEvent(event.id)).toEqual(event);
          expect(await store.getArtifact(artifact.id)).toEqual(artifact);
        } finally {
          driver.close();
          openDrivers.delete(driver);
        }
      }),
      { numRuns: 100 }
    );
  });
});
