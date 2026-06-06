import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import type { RectorStore } from "../src/store";
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
 * Property 1: In-memory store behavior and existing tests are unchanged (regression baseline).
 * Validates: Requirements 1.1, 1.2
 *
 * The Phase 3 interface extraction declared `InMemoryRectorStore implements RectorStore` without
 * touching any method signature. This suite reuses the same create/update/list/delete generator
 * approach as the SqlRectorStore round-trip test (`tests/persistentStore.test.ts`) and asserts the
 * in-memory store — the DEFAULT and the regression baseline — still satisfies its current invariants
 * and signatures:
 *   - a created entity is retrievable and deep-equal to what was created;
 *   - an update mutates the patched fields, preserves `createdAt`, and bumps `updatedAt`;
 *   - list results preserve insertion order and respect their filters;
 *   - delete removes the entity and returns a boolean;
 *   - duplicate event ids are rejected by `appendEvent`/`commitRunTransition`;
 *   - `commitRunTransition` applies the run update and the event append atomically.
 *
 * No API key, no cloud account, and no network are involved — the store is fully in-process.
 */

// A monotonic clock so each store mutation gets a strictly-increasing timestamp; this lets the
// "update bumps updatedAt" invariant be asserted deterministically.
function fixedClock(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

// Compile-time + runtime conformance: the in-memory store is assignable to the RectorStore
// interface with no signature change (Req 1.2). If a signature drifted, this would not type-check.
const _conformsToInterface: RectorStore = new InMemoryRectorStore();
void _conformsToInterface;

// --- Generators (mirrored from tests/persistentStore.test.ts) --------------

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

// The entities written through the store — the expected read/list results.
interface WrittenState {
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  events: RunEvent[];
  artifacts: Artifact[];
}

// Write the full scenario through a store and return the created entities, in insertion order.
async function writeScenario(
  store: InMemoryRectorStore,
  scenario: GeneratedScenario
): Promise<WrittenState> {
  const conversations: Conversation[] = [];
  for (const input of scenario.conversations) {
    conversations.push(await store.createConversation(input));
  }

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

  const messages: Message[] = [];
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

  const appendedEvents: RunEvent[] = [];
  if (runs.length > 0) {
    let index = 0;
    for (const spec of scenario.events) {
      const run = runs[spec.runIdx % runs.length];
      appendedEvents.push(
        await store.appendEvent({
          id: `evt-${index++}`,
          runId: run.id,
          type: spec.type,
          phase: spec.phase,
          payload: spec.payload,
          traceId: spec.traceId,
          createdAt: spec.createdAt,
        } as RunEvent)
      );
    }
  }

  const artifacts: Artifact[] = [];
  for (const input of scenario.artifacts) {
    artifacts.push(await store.createArtifact(input));
  }

  return { conversations, messages, runs, events: appendedEvents, artifacts };
}

describe("InMemoryRectorStore parity (Property 1 — regression baseline)", () => {
  it("retrieves every created entity deep-equal and preserves insertion order in list results", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (rawScenario) => {
        const scenario = rawScenario as GeneratedScenario;
        const store = new InMemoryRectorStore({ now: fixedClock() });
        const written = await writeScenario(store, scenario);

        // Point reads are deep-equal to the originally created entity (Req 1.1, 1.2).
        for (const conversation of written.conversations) {
          expect(await store.getConversation(conversation.id)).toEqual(conversation);
        }
        for (const message of written.messages) {
          expect(await store.getMessage(message.id)).toEqual(message);
        }
        for (const run of written.runs) {
          expect(await store.getRun(run.id)).toEqual(run);
        }
        for (const event of written.events) {
          expect(await store.getEvent(event.id)).toEqual(event);
        }
        for (const artifact of written.artifacts) {
          expect(await store.getArtifact(artifact.id)).toEqual(artifact);
        }

        // Unfiltered list results preserve the original insertion order.
        expect(await store.listConversations()).toEqual(written.conversations);
        expect(await store.listMessages()).toEqual(written.messages);
        expect(await store.listRuns()).toEqual(written.runs);
        expect(await store.listEvents()).toEqual(written.events);
        expect(await store.listArtifacts()).toEqual(written.artifacts);

        // Filtered list results preserve insertion order within each filter group.
        for (const workspaceId of WORKSPACES) {
          const expected = written.conversations.filter((c) => c.workspaceId === workspaceId);
          expect(await store.listConversations(workspaceId)).toEqual(expected);
        }
        for (const conversation of written.conversations) {
          const expectedMessages = written.messages.filter(
            (m) => m.conversationId === conversation.id
          );
          expect(await store.listMessages(conversation.id)).toEqual(expectedMessages);
          const expectedRuns = written.runs.filter((r) => r.conversationId === conversation.id);
          expect(await store.listRuns(conversation.id)).toEqual(expectedRuns);
        }
        for (const run of written.runs) {
          const expectedEvents = written.events.filter((e) => e.runId === run.id);
          expect(await store.listEvents(run.id)).toEqual(expectedEvents);
        }
        for (const kind of ARTIFACT_KINDS) {
          const expected = written.artifacts.filter((a) => a.kind === kind);
          expect(await store.listArtifacts(kind)).toEqual(expected);
        }

        // Reads/lists must return clones, never the internal instance (mutation isolation).
        const [firstConversation] = written.conversations;
        const fetched = await store.getConversation(firstConversation.id);
        expect(fetched).not.toBe(firstConversation);
      }),
      { numRuns: 30 }
    );
  });

  it("update applies the patch, preserves createdAt, and bumps updatedAt", async () => {
    await fc.assert(
      fc.asyncProperty(
        conversationInputArb,
        neString(20),
        fc.constantFrom(...WORKSPACES),
        async (input, newTitle, newWorkspaceId) => {
          const store = new InMemoryRectorStore({ now: fixedClock() });
          const created = await store.createConversation(input);
          // A freshly created entity has createdAt === updatedAt (one clock read).
          expect(created.updatedAt).toBe(created.createdAt);

          const updated = await store.updateConversation(created.id, {
            title: newTitle,
            workspaceId: newWorkspaceId,
          });

          expect(updated).toBeDefined();
          expect(updated!.id).toBe(created.id);
          expect(updated!.title).toBe(newTitle);
          expect(updated!.workspaceId).toBe(newWorkspaceId);
          // createdAt is preserved, updatedAt is bumped forward.
          expect(updated!.createdAt).toBe(created.createdAt);
          expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
          // The mutation is observable through a subsequent read.
          expect(await store.getConversation(created.id)).toEqual(updated);

          // Updating an unknown id returns undefined.
          expect(await store.updateConversation("conv-missing", { title: newTitle })).toBeUndefined();
        }
      ),
      { numRuns: 30 }
    );
  });

  it("delete removes the entity and returns a boolean reflecting prior existence", async () => {
    await fc.assert(
      fc.asyncProperty(conversationInputArb, async (input) => {
        const store = new InMemoryRectorStore({ now: fixedClock() });
        const created = await store.createConversation(input);

        expect(await store.deleteConversation(created.id)).toBe(true);
        expect(await store.getConversation(created.id)).toBeUndefined();
        // A second delete of the now-absent entity returns false.
        expect(await store.deleteConversation(created.id)).toBe(false);
        // Deleting a never-existing id returns false.
        expect(await store.deleteConversation("conv-never")).toBe(false);
      }),
      { numRuns: 30 }
    );
  });

  it("appendEvent rejects a duplicate event id and leaves the event log unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(runSpecArb, eventSpecArb, async (runSpec, eventSpec) => {
        const store = new InMemoryRectorStore({ now: fixedClock() });
        const conversation = await store.createConversation({
          title: "dup-events",
          workspaceId: "ws-1",
          retentionPolicy: "default",
        });
        const run = await store.createRun({
          conversationId: conversation.id,
          userMessageId: "umsg-0",
          status: runSpec.status,
          phase: runSpec.phase,
          route: runSpec.route,
          complexity: runSpec.complexity,
          budget: runSpec.budget,
          costEstimate: runSpec.costEstimate,
          tokenEstimate: runSpec.tokenEstimate,
          traceId: runSpec.traceId,
          attempts: runSpec.attempts,
          healingAttempts: runSpec.healingAttempts,
          validationAttempts: runSpec.validationAttempts,
        });

        const event = {
          id: "evt-dup",
          runId: run.id,
          type: eventSpec.type,
          phase: eventSpec.phase,
          payload: eventSpec.payload,
          traceId: eventSpec.traceId,
          createdAt: eventSpec.createdAt,
        } as RunEvent;

        await store.appendEvent(event);
        await expect(store.appendEvent(event)).rejects.toThrow();
        // The duplicate is not appended a second time.
        expect(await store.listEvents(run.id)).toHaveLength(1);
      }),
      { numRuns: 30 }
    );
  });

  it("commitRunTransition applies the run patch and appends the event atomically", async () => {
    await fc.assert(
      fc.asyncProperty(
        runSpecArb,
        eventSpecArb,
        fc.constantFrom(...RUN_PHASES),
        neString(8),
        async (runSpec, eventSpec, nextPhase, nextStatus) => {
          const store = new InMemoryRectorStore({ now: fixedClock() });
          const conversation = await store.createConversation({
            title: "transition",
            workspaceId: "ws-1",
            retentionPolicy: "default",
          });
          const run = await store.createRun({
            conversationId: conversation.id,
            userMessageId: "umsg-0",
            status: runSpec.status,
            phase: runSpec.phase,
            route: runSpec.route,
            complexity: runSpec.complexity,
            budget: runSpec.budget,
            costEstimate: runSpec.costEstimate,
            tokenEstimate: runSpec.tokenEstimate,
            traceId: runSpec.traceId,
            attempts: runSpec.attempts,
            healingAttempts: runSpec.healingAttempts,
            validationAttempts: runSpec.validationAttempts,
          });

          const event = {
            id: "evt-commit",
            runId: run.id,
            type: eventSpec.type,
            phase: nextPhase,
            payload: eventSpec.payload,
            traceId: eventSpec.traceId,
            createdAt: eventSpec.createdAt,
          } as RunEvent;

          const result = await store.commitRunTransition(
            run.id,
            { phase: nextPhase, status: nextStatus },
            event
          );

          // The run update and the event append are both observable.
          expect(result.run.phase).toBe(nextPhase);
          expect(result.run.status).toBe(nextStatus);
          expect(result.run.createdAt).toBe(run.createdAt);
          expect(Date.parse(result.run.updatedAt)).toBeGreaterThan(Date.parse(run.updatedAt));
          expect(await store.getRun(run.id)).toEqual(result.run);
          expect(await store.getEvent(event.id)).toEqual(result.event);

          // A duplicate-id transition is rejected and leaves run + event log unchanged.
          const runBefore = await store.getRun(run.id);
          await expect(
            store.commitRunTransition(run.id, { status: "rolled-back" }, event)
          ).rejects.toThrow();
          expect(await store.getRun(run.id)).toEqual(runBefore);
          expect(await store.listEvents(run.id)).toHaveLength(1);
        }
      ),
      { numRuns: 30 }
    );
  });
});
