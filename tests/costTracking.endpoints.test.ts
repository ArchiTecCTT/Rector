/**
 * Task 11.4 — Unit tests for the cost endpoints (ORN-41).
 *
 * **Validates: Requirements 3.6, 3.10**
 *
 * Exercises the two cost routes registered by `createApp` (task 11.1) over the repo's established
 * raw `http.Server` + `fetch` API harness (the same pattern `byokExternalE2E.test.ts` and
 * `chatStreaming.edge.test.ts` use):
 *
 *   1. `GET /api/runs/:id/cost` for a run that recorded provider-call events → returns the correct
 *      `RunCostAggregate` (Req 3.6). A run with provider-call events is produced by driving a real
 *      external (BYOK) chat run through the HTTP API with an injected mocked `ModelRouter` whose
 *      `select()` returns a scripted `SpyLLMProvider` — no API key and no network. The endpoint's
 *      output is asserted equal to the independently-computed `aggregateRunCost(runId, events)` fold
 *      over the same persisted (already-redacted) events the synchronous POST returns.
 *
 *   2. `GET /api/chat/conversations/:id/cost` → returns the correct `ConversationCostAggregate`
 *      summed across the conversation's runs (Req 3.6). Two messages in one conversation produce two
 *      runs; the endpoint's output is asserted equal to `aggregateConversationCost` over both runs'
 *      persisted events, with the per-run list in insertion order.
 *
 *   3. The empty-aggregate response for an UNKNOWN id on BOTH endpoints (Req 3.10) → a schema-valid,
 *      all-zero aggregate with empty provider/model lists, returned with status `200` (NOT a 404).
 *
 * Token-named usage fields (`inputTokens`/`outputTokens`) are redacted to `[REDACTED]` on persisted
 * provider-call events by the chat runner's redaction boundary, so the defensive aggregate folds
 * treat them as zero; the non-token usage fields (`estimatedUsd`, `modelCalls`) and the non-secret
 * `provider`/`model` ids survive and are summed/collected. The tests therefore assert the endpoint
 * matches the canonical fold rather than hard-coding token counts, while still pinning the
 * meaningful invariants (positive USD/model-call totals, the spy provider/model ids present).
 *
 * No API key, no real network: the provider is a `SpyLLMProvider` and the store is the default
 * in-memory store.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import {
  aggregateRunCost,
  aggregateConversationCost,
  RunCostAggregateSchema,
  ConversationCostAggregateSchema,
} from "../src/observability";
import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan } from "../src/orchestration/planner";
import type { ModelRouter, ModelSelection } from "../src/providers/llm";
import type { Run, RunEvent } from "../src/store/schemas";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

// --- Harness (mirrors byokExternalE2E.test.ts) -------------------------------------------------

async function withServer<T>(app: express.Application, fn: (base: string) => Promise<T>): Promise<T> {
  let server!: http.Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3000;
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function api(base: string, path: string, opts?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    ...opts,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { status: res.status, data: data as any, rawBody: text };
}

/** A single-provider router that always selects the supplied spy on the flagship route. */
function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "test router selects the scripted spy provider",
      };
    },
  };
}

/** A deterministic, schema-valid plan JSON for a prompt (reuses the fake planner). */
function fakePlanJsonFor(prompt: string): string {
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  return planToJson(createFakePlan({ triage, contextPack, messageContent: prompt }));
}

/**
 * The three scripted provider replies for one successful external run: a schema-valid plan, a SOUND
 * (empty-findings) skeptic draft so the crucible accepts, and a synthesizer draft with one evidence
 * citation so the citation-required live synthesis is accepted (reaching DONE). An explicit
 * `plannerUsage` keeps the planner's reported cost distinct and budget-permissive.
 */
function successResponsesFor(prompt: string, plannerUsage: Partial<typeof DEFAULT_SPY_USAGE>) {
  return [
    { content: fakePlanJsonFor(prompt), usage: plannerUsage },
    { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
    {
      content: synthesisDraftToJson({
        response: `Answer for: ${prompt}. The evidence is cited below.`,
        citations: [
          { kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" },
        ],
      }),
    },
  ];
}

function externalApp(provider: SpyLLMProvider): express.Application {
  return createApp(new TaskManager(), { orchestration: { mode: "external", router: spyRouter(provider) } });
}

// --- (1) GET /api/runs/:id/cost for a run with provider-call events (Req 3.6) ------------------

describe("GET /api/runs/:id/cost — run with provider-call events (Req 3.6)", () => {
  it("returns the correct RunCostAggregate derived from the run's persisted provider-call events", async () => {
    const prompt = "Create an implementation plan for adding login, but do not edit files.";
    const plannerUsage = { inputTokens: 321, outputTokens: 123, totalTokens: 444, estimatedUsd: 0.0456, modelCalls: 1 };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: successResponsesFor(prompt, plannerUsage),
    });

    await withServer(externalApp(provider), async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "run cost" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${created.data.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });
      expect(sent.status).toBe(201);
      // planner + live skeptic + live synthesizer — a real external run that recorded provider calls.
      expect(provider.invokeCount).toBe(3);
      expect(sent.data.run.phase).toBe("DONE");

      const runId: string = sent.data.run.id;
      const events: RunEvent[] = sent.data.events;

      const cost = await api(base, `/api/runs/${runId}/cost`);

      // Status 200 (a real run, never a 404) and a schema-valid RunCostAggregate.
      expect(cost.status).toBe(200);
      const aggregate = RunCostAggregateSchema.parse(cost.data);

      // The endpoint computes `aggregateRunCost(runId, await listEvents(runId))`; the synchronous POST
      // returns exactly those persisted events, so the canonical fold over them must match the
      // endpoint output byte-for-byte.
      const expected = aggregateRunCost(runId, events);
      expect(aggregate).toEqual(expected);

      // Meaningful invariants for a run that made provider calls.
      expect(aggregate.runId).toBe(runId);
      expect(aggregate.modelCalls).toBeGreaterThan(0);
      expect(aggregate.estimatedUsd).toBeGreaterThan(0);
      expect(aggregate.totalTokens).toBe(aggregate.inputTokens + aggregate.outputTokens);
      // Non-secret provider/model identifiers are collected from the provider-call events.
      expect(aggregate.providers).toContain(provider.metadata.id);
      expect(aggregate.models).toContain(provider.metadata.models.flagship);

      // No secret/auth material leaks into the cost body.
      expect(cost.rawBody).not.toMatch(/Bearer\s+\S/);
    });
  });
});

// --- (2) GET /api/chat/conversations/:id/cost summed across the conversation's runs (Req 3.6) --

describe("GET /api/chat/conversations/:id/cost — summed across the conversation's runs (Req 3.6)", () => {
  it("returns the correct ConversationCostAggregate summed over two runs in insertion order", async () => {
    const prompt1 = "Create an implementation plan for adding login, but do not edit files.";
    const prompt2 = "Outline a design proposal for the billing module.";
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        ...successResponsesFor(prompt1, { inputTokens: 321, outputTokens: 123, totalTokens: 444, estimatedUsd: 0.0456, modelCalls: 1 }),
        ...successResponsesFor(prompt2, { inputTokens: 210, outputTokens: 90, totalTokens: 300, estimatedUsd: 0.0222, modelCalls: 1 }),
      ],
    });

    await withServer(externalApp(provider), async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "conversation cost" }),
      });
      expect(created.status).toBe(201);
      const conversationId: string = created.data.id;

      const sent1 = await api(base, `/api/chat/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt1 }),
      });
      expect(sent1.status).toBe(201);
      expect(sent1.data.run.phase).toBe("DONE");

      const sent2 = await api(base, `/api/chat/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt2 }),
      });
      expect(sent2.status).toBe(201);
      expect(sent2.data.run.phase).toBe("DONE");

      const run1: Run = sent1.data.run;
      const run2: Run = sent2.data.run;
      const events1: RunEvent[] = sent1.data.events;
      const events2: RunEvent[] = sent2.data.events;

      const conv = await api(base, `/api/chat/conversations/${conversationId}/cost`);

      // Status 200 and a schema-valid ConversationCostAggregate.
      expect(conv.status).toBe(200);
      const aggregate = ConversationCostAggregateSchema.parse(conv.data);

      // The endpoint folds `listRuns(conversationId)` (insertion order) through `aggregateRunCost`;
      // recomputing over the same runs/events must match the endpoint output exactly.
      const eventsByRun = new Map<string, RunEvent[]>([
        [run1.id, events1],
        [run2.id, events2],
      ]);
      const expected = aggregateConversationCost(conversationId, [run1, run2], eventsByRun);
      expect(aggregate).toEqual(expected);

      // Two runs were summed, the per-run list is in insertion order, and totals equal the sum of
      // the per-run aggregates (Req 3.3 summation surfaced through the endpoint).
      expect(aggregate.conversationId).toBe(conversationId);
      expect(aggregate.runCount).toBe(2);
      expect(aggregate.runs.map((r) => r.runId)).toEqual([run1.id, run2.id]);

      const perRun1 = aggregateRunCost(run1.id, events1);
      const perRun2 = aggregateRunCost(run2.id, events2);
      expect(aggregate.estimatedUsd).toBeCloseTo(perRun1.estimatedUsd + perRun2.estimatedUsd, 10);
      expect(aggregate.modelCalls).toBe(perRun1.modelCalls + perRun2.modelCalls);
      expect(aggregate.totalTokens).toBe(perRun1.totalTokens + perRun2.totalTokens);
      expect(aggregate.modelCalls).toBeGreaterThan(0);
      expect(aggregate.estimatedUsd).toBeGreaterThan(0);

      expect(conv.rawBody).not.toMatch(/Bearer\s+\S/);
    });
  });
});

// --- (3) Unknown id → schema-valid all-zero aggregate, NOT a 404 (Req 3.10) --------------------

describe("cost endpoints — unknown id returns an all-zero aggregate, not a 404 (Req 3.10)", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    // Default (local, in-memory) app: no run or conversation has ever been created, so any id is
    // unknown. No external mode, no provider, no network needed for the empty-aggregate path.
    app = createApp(new TaskManager());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /api/runs/:id/cost for an unknown run returns 200 with an all-zero RunCostAggregate", async () => {
    const runId = "run-unknown-abc123";
    const cost = await api(base, `/api/runs/${runId}/cost`);

    // NOT a 404 — an unknown run yields a schema-valid all-zero aggregate (Req 3.10).
    expect(cost.status).toBe(200);
    const aggregate = RunCostAggregateSchema.parse(cost.data);
    expect(aggregate).toEqual({
      runId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
      modelCalls: 0,
      providers: [],
      models: [],
    });
  });

  it("GET /api/chat/conversations/:id/cost for an unknown conversation returns 200 with an all-zero ConversationCostAggregate", async () => {
    const conversationId = "conv-unknown-xyz789";
    const conv = await api(base, `/api/chat/conversations/${conversationId}/cost`);

    // NOT a 404 — an unknown conversation yields a schema-valid all-zero aggregate with no runs.
    expect(conv.status).toBe(200);
    const aggregate = ConversationCostAggregateSchema.parse(conv.data);
    expect(aggregate).toEqual({
      conversationId,
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: 0,
      modelCalls: 0,
      runs: [],
    });
  });
});
