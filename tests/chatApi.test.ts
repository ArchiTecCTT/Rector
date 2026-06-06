import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";

import {
  runChat,
  runExternalChatRun,
  ProviderCallMetadataSchema,
  DEFAULT_EXTERNAL_BUDGET,
  type ChatRunArgs,
} from "../src/orchestration/chatRunner";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan } from "../src/orchestration/planner";
import { createInMemoryObservabilityTrace } from "../src/observability";
import {
  ProviderError,
  type LLMProvider,
  type ModelRouter,
  type ModelSelection,
} from "../src/providers/llm";
import {
  SpyLLMProvider,
  DEFAULT_SPY_USAGE,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";
import { PlannerOutputSchema } from "../src/orchestration/planner";
import type { Budget } from "../src/store/schemas";

function makeManager() {
  return new TaskManager();
}

describe("chat API vertical shell", () => {
  let app: express.Application;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    app = createApp(makeManager());
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

  async function api(path: string, opts?: RequestInit) {
    const res = await fetch(`${base}${path}`, {
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
      ...opts,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return { status: res.status, data };
  }

  it("creates and lists conversations", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Chunk 6 smoke", workspaceId: "test-workspace" }),
    });

    expect(created.status).toBe(201);
    expect((created.data as any).id).toMatch(/^conv-/);
    expect((created.data as any).title).toBe("Chunk 6 smoke");

    const listed = await api("/api/chat/conversations");
    expect(listed.status).toBe(200);
    expect((listed.data as any).conversations.some((c: any) => c.id === (created.data as any).id)).toBe(true);
  });

  it("gets a conversation with messages", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Message container" }),
    });

    const fetched = await api(`/api/chat/conversations/${(created.data as any).id}`);
    expect(fetched.status).toBe(200);
    expect((fetched.data as any).conversation.id).toBe((created.data as any).id);
    expect((fetched.data as any).messages).toEqual([]);
  });

  it("creates user and assistant messages plus a hidden run and events", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Run trace" }),
    });
    const conversationId = (created.data as any).id;

    const sent = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Explain the vertical slice" }),
    });

    expect(sent.status).toBe(201);
    expect((sent.data as any).userMessage.role).toBe("user");
    expect((sent.data as any).assistantMessage.role).toBe("assistant");
    expect((sent.data as any).assistantMessage.content).toContain("Status:");
    expect((sent.data as any).assistantMessage.content).toContain("Trace:");
    expect((sent.data as any).assistantMessage.content).toContain("provider calls: 0");
    expect((sent.data as any).run.id).toMatch(/^run-/);
    expect((sent.data as any).run.status).toBe("completed");
    const eventTypes = (sent.data as any).events.map((e: any) => e.type);
    expect(eventTypes[0]).toBe("RUN_CREATED");
    expect(eventTypes).toContain("PHASE_CHANGED");
    expect(eventTypes.at(-1)).toBe("RUN_COMPLETED");

    const fetched = await api(`/api/chat/conversations/${conversationId}`);
    expect((fetched.data as any).messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  });

  it("sets chat run route and context events from triage", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Triage route" }),
    });
    const conversationId = (created.data as any).id;

    const sent = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Fix the TypeScript bug in src/api/server.ts and update tests." }),
    });

    expect(sent.status).toBe(201);
    expect((sent.data as any).run.route).toBe("CODE_EDIT");
    expect((sent.data as any).run.complexity).toBe("medium");

    const triageEvent = (sent.data as any).events.find(
      (event: any) => event.phase === "TRIAGE" && event.payload?.triage?.route === "CODE_EDIT"
    );
    expect(triageEvent).toBeDefined();

    const contextEvent = (sent.data as any).events.find((event: any) => event.phase === "CONTEXT_BUILDING");
    expect(contextEvent?.payload?.contextPack?.conversationRef?.id).toBe(conversationId);
    expect(contextEvent?.payload?.contextPack?.messageRefs?.length).toBeGreaterThanOrEqual(1);

    const planningEvent = (sent.data as any).events.find((event: any) => event.phase === "PLANNING");
    expect(planningEvent?.payload?.plannerOutput?.goal).toContain("Fix the TypeScript bug");
    expect(planningEvent?.payload?.plannerOutput?.tasks.map((task: any) => task.id)).toEqual([
      "code.inspect",
      "code.edit",
      "code.validate",
    ]);

    const skepticEvent = (sent.data as any).events.find((event: any) => event.phase === "SKEPTIC_REVIEW");
    expect(skepticEvent?.payload?.skepticReview?.verdict).toBeDefined();
    expect(skepticEvent?.payload?.skepticReview?.findings).toEqual(expect.any(Array));

    const crucibleEvent = (sent.data as any).events.find((event: any) => event.phase === "CRUCIBLE");
    expect(crucibleEvent?.payload?.crucibleDecision?.verdict).toBeDefined();
    expect(crucibleEvent?.payload?.crucibleDecision?.round).toBe(1);
    expect(crucibleEvent?.payload?.crucibleDecision?.maxRounds).toBe(2);

    const dagEvent = (sent.data as any).events.find((event: any) => event.phase === "DAG_COMPILATION");
    const executingEvent = (sent.data as any).events.find((event: any) => event.phase === "EXECUTING");
    const validatingEvent = (sent.data as any).events.find((event: any) => event.phase === "VALIDATING");
    if (crucibleEvent?.payload?.crucibleDecision?.verdict === "ACCEPTED") {
      expect(dagEvent?.payload?.compiledDag?.nodes?.length).toBeGreaterThan(0);
      expect(dagEvent?.payload?.compiledDag?.metadata?.plannerTaskToDagNode).toBeDefined();
      expect(executingEvent?.payload?.executionResult?.status).toBe("SUCCESS");
      expect(executingEvent?.payload?.executionResult?.nodeResults?.length).toBe(
        dagEvent?.payload?.compiledDag?.nodes?.length
      );
      expect(validatingEvent?.payload?.validationHealingResult?.status).toBe("VALIDATED");
      expect(validatingEvent?.payload?.validationHealingResult?.actions).toEqual([]);
    } else {
      expect(dagEvent?.payload?.skippedReason).toContain("Crucible verdict");
      expect(executingEvent?.payload?.skippedReason).toContain("compiled DAG");
      expect(validatingEvent?.payload?.skippedReason).toContain("Execution skipped");
    }
  });

  it("returns run events", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Events" }),
    });
    const sent = await api(`/api/chat/conversations/${(created.data as any).id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Show trace" }),
    });

    const events = await api(`/api/runs/${(sent.data as any).run.id}/events`);
    expect(events.status).toBe(200);
    expect((events.data as any).run.id).toBe((sent.data as any).run.id);
    expect((events.data as any).events.length).toBeGreaterThanOrEqual(4);
    expect((events.data as any).events.at(-1).phase).toBe("DONE");
  });

  it("returns 404 when sending to a missing conversation", async () => {
    const sent = await api("/api/chat/conversations/no-such-conv/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sent.status).toBe(404);
    expect((sent.data as any).error).toBe("Conversation not found");
  });

  it("validates retentionPolicy type consistently in POST /api/chat/conversations", async () => {
    const res = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Valid title", retentionPolicy: 123 }),
    });
    expect(res.status).toBe(400);
    expect((res.data as any).error).toBe("retentionPolicy must be a string");
  });

  it("filters conversations by workspaceId on GET /api/chat/conversations", async () => {
    const wsA = `ws-${Math.random()}`;
    const wsB = `ws-${Math.random()}`;

    const convA = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Conv in WS A", workspaceId: wsA }),
    });
    const convB = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Conv in WS B", workspaceId: wsB }),
    });

    expect(convA.status).toBe(201);
    expect(convB.status).toBe(201);

    const listedA = await api(`/api/chat/conversations?workspaceId=${wsA}`);
    expect(listedA.status).toBe(200);
    expect((listedA.data as any).conversations.length).toBe(1);
    expect((listedA.data as any).conversations[0].id).toBe((convA.data as any).id);

    const listedB = await api(`/api/chat/conversations?workspaceId=${wsB}`);
    expect(listedB.status).toBe(200);
    expect((listedB.data as any).conversations.length).toBe(1);
    expect((listedB.data as any).conversations[0].id).toBe((convB.data as any).id);
  });

  it("returns 400 when message content is missing or invalid", async () => {
    const created = await api("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Validation Test" }),
    });
    const conversationId = (created.data as any).id;

    // Missing content entirely
    const resMissing = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(resMissing.status).toBe(400);
    expect((resMissing.data as any).error).toBe("content (string) is required");

    // Invalid content type (number)
    const resInvalidType = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: 12345 }),
    });
    expect(resInvalidType.status).toBe(400);
    expect((resInvalidType.data as any).error).toBe("content (string) is required");

    // Empty content string
    const resEmptyString = await api(`/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "" }),
    });
    expect(resEmptyString.status).toBe(400);
    expect((resEmptyString.data as any).error).toBe("content (string) is required");
  });

  it("serves chat shell markers", async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Rector");
    expect(html).toContain("Chat with Rector");
    expect(html).toContain("id=\"composer\"");
    expect(html).toContain("id=\"trace-drawer\"");
  });
});

/**
 * Task 6.5 — Unit tests for the external chat runner (ORN-33).
 *
 * Validates Requirements 3.4, 3.5, 3.6, 3.7. These are example/unit tests that
 * exercise `runChat`/`runExternalChatRun` directly (not through HTTP) so the
 * blocker-to-transition assertions stay precise. Everything is in-memory and
 * mock-only via `SpyLLMProvider`: no API key and no network are used.
 *
 * Coverage:
 *   (1) planner swap vs local  — external records provider metadata on PLANNING
 *       and a non-zero cost; local records none and stays all-zero.
 *   (2) metadata shape          — the PLANNING event metadata validates against
 *       `ProviderCallMetadataSchema` and the run cost/token fields equal the
 *       spy's reported usage.
 *   (3) blocker mapping         — BUDGET_DENIED/PROVIDER_ERROR => NEEDS_DECISION,
 *       PLANNER_INVALID => FAILED, with NO exception escaping the handler.
 *   (4) secret redaction        — a secret in a provider error never appears in
 *       any persisted event.
 */

/** A `ModelRouter` whose `select` always returns the supplied provider. */
function makeRouter(provider: LLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship ?? provider.metadata.id,
        reason: "external chat runner test router selects the spy provider",
      };
    },
  };
}

/** Builds a fresh, schema-valid `ChatRunArgs` for the prompt, seeded into the store. */
async function buildChatArgs(store: InMemoryRectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "external chat runner",
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

/** Serializes the exact valid plan the live planner would accept for these args. */
function validPlanJsonFor(args: ChatRunArgs): string {
  return planToJson(
    createFakePlan({ triage: args.triage, contextPack: args.contextPack, messageContent: args.prompt })
  );
}

/**
 * A deterministic, schema-valid plan whose single task compiles to a
 * NON-FILE-OPERATION DAG node (an `LLM_EXECUTION` task plus its `VALIDATION`
 * node — both no-op successes in the safe executor). Used by the success-path
 * external tests so the full pipeline (planner -> live skeptic -> crucible ->
 * DAG -> safe executor -> bounded healing -> live synthesizer) executes cleanly
 * and reaches DONE without any real workspace I/O or approval gate.
 */
const NON_FILE_OPERATION_PLAN_JSON = planToJson(
  PlannerOutputSchema.parse({
    goal: "Answer the user question from available conversation context",
    assumptions: ["User expects a concise synthesis, not changes."],
    tasks: [
      {
        id: "answer.synthesize",
        title: "Synthesize direct answer",
        description: "Use available conversation context to produce a concise response.",
        dependencies: [],
        expectedArtifacts: ["Assistant answer"],
        validation: ["Answer addresses the stated question"],
        risk: "low",
        approvalRequired: false,
      },
    ],
    dependencies: [],
    validation: { summary: "Direct answer plan stays non-executing", checks: ["Confirm response is grounded in context"] },
    riskLevel: "low",
    approvalGates: [],
  })
);

/** A SOUND/empty skeptic draft so the crucible ACCEPTS the plan unchanged. */
const SOUND_SKEPTIC_JSON = skepticDraftToJson({ verdict: "SOUND", findings: [] });

/** A synthesizer draft with one evidence citation (the DAG carried execution evidence). */
const CITED_SYNTHESIS_JSON = synthesisDraftToJson({
  response: "Completed the task; see cited evidence for details.",
  citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" }],
});

/** Finds the persisted PLANNING-phase run event. */
function findPlanningEvent(events: Array<{ phase: string; payload?: any }>) {
  return events.find((event) => event.phase === "PLANNING");
}

describe("external chat runner (ORN-33)", () => {
  const EDIT_PROMPT = "Fix the TypeScript bug in src/api/server.ts and update tests.";

  it("records provider/cost metadata on the PLANNING event in external mode, but not in local mode", async () => {
    // External run with a spy scripted for the three live steps (planner -> skeptic -> synthesizer).
    const externalStore = new InMemoryRectorStore();
    const externalArgs = await buildChatArgs(externalStore, EDIT_PROMPT);
    const spy = new SpyLLMProvider({
      responses: [NON_FILE_OPERATION_PLAN_JSON, SOUND_SKEPTIC_JSON, CITED_SYNTHESIS_JSON],
    });

    const externalResult = await runChat(externalStore, externalArgs, {
      mode: "external",
      router: makeRouter(spy),
    });

    // The external run completes through the full pipeline (three provider calls).
    expect(externalResult.run.phase).toBe("DONE");
    expect(externalResult.run.status).toBe("completed");
    expect(spy.invokeCount).toBe(3);

    const externalEvents = await externalStore.listEvents(externalResult.run.id);
    const externalPlanning = findPlanningEvent(externalEvents);
    expect(externalPlanning).toBeDefined();
    // External PLANNING event carries provider-call metadata.
    expect(externalPlanning?.payload?.providerCall).toBeDefined();
    expect(externalPlanning?.payload?.plannerOutput).toBeDefined();

    // Local run for the same prompt records NO provider metadata and zero cost.
    const localStore = new InMemoryRectorStore();
    const localArgs = await buildChatArgs(localStore, EDIT_PROMPT);
    const localResult = await runChat(localStore, localArgs, { mode: "local" });

    const localEvents = await localStore.listEvents(localResult.run.id);
    const localPlanning = findPlanningEvent(localEvents);
    expect(localPlanning).toBeDefined();
    expect(localPlanning?.payload?.providerCall).toBeUndefined();

    // Local cost stays all-zero and no model call is recorded.
    expect(localResult.run.costEstimate.usd).toBe(0);
    expect(localResult.run.actualCost?.modelCalls ?? 0).toBe(0);
    expect(localResult.observabilitySummary.modelCallCount).toBe(0);
  });

  it("records PLANNING metadata that conforms to ProviderCallMetadataSchema with the spy's reported usage", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, EDIT_PROMPT);
    // Drive a successful external run with a known reported usage.
    const reportedUsage = {
      inputTokens: 321,
      outputTokens: 123,
      totalTokens: 444,
      estimatedUsd: 0.0042,
      modelCalls: 1,
    };
    const spy = new SpyLLMProvider({
      responses: [
        { content: NON_FILE_OPERATION_PLAN_JSON, usage: reportedUsage },
        SOUND_SKEPTIC_JSON,
        CITED_SYNTHESIS_JSON,
      ],
    });

    const result = await runExternalChatRun(store, args, { mode: "external", router: makeRouter(spy) });

    expect(result.run.phase).toBe("DONE");

    const events = await store.listEvents(result.run.id);
    const planning = findPlanningEvent(events);
    expect(planning).toBeDefined();

    // The recorded metadata passed `ProviderCallMetadataSchema.parse` inside the runner before
    // persistence. On the persisted event, however, the security redaction boundary
    // (`redactSecrets`, applied by the run state machine) replaces any token-named numeric field
    // with "[REDACTED]" — so `usage.{inputTokens,outputTokens,totalTokens}` are strings on the
    // event, while `estimatedUsd`/`modelCalls` and the identifier fields survive.
    const providerCall = planning?.payload?.providerCall as {
      mode: string;
      provider: string;
      model: string;
      modelRoute: string;
      usage: Record<string, unknown>;
      attempts: number;
      repaired: boolean;
    };
    expect(providerCall).toBeDefined();
    expect(providerCall.mode).toBe("external");
    expect(providerCall.provider).toBe("spy");
    expect(providerCall.model).toBe("spy-model-v1");
    expect(providerCall.modelRoute).toBe("flagship");
    expect(providerCall.attempts).toBe(1);
    expect(providerCall.repaired).toBe(false);

    // Surviving (non-token-named) usage fields equal the spy's reported usage.
    expect(providerCall.usage.estimatedUsd).toBe(reportedUsage.estimatedUsd);
    expect(providerCall.usage.modelCalls).toBe(reportedUsage.modelCalls);

    // Positive evidence the redaction boundary ran over the recorded metadata.
    expect(providerCall.usage.inputTokens).toBe("[REDACTED]");
    expect(providerCall.usage.outputTokens).toBe("[REDACTED]");

    // Schema conformance: reunite the surviving identifiers with the authoritative (un-redacted)
    // token counts the run preserved, and confirm the pair validates — i.e. exactly the metadata
    // the runner built before persistence.
    const metadata = ProviderCallMetadataSchema.parse({
      ...providerCall,
      usage: {
        inputTokens: reportedUsage.inputTokens,
        outputTokens: reportedUsage.outputTokens,
        totalTokens: reportedUsage.totalTokens,
        estimatedUsd: providerCall.usage.estimatedUsd,
        modelCalls: providerCall.usage.modelCalls,
      },
    });
    expect(metadata.usage.inputTokens).toBe(reportedUsage.inputTokens);
    expect(metadata.usage.outputTokens).toBe(reportedUsage.outputTokens);
    expect(metadata.usage.estimatedUsd).toBe(reportedUsage.estimatedUsd);
    expect(metadata.usage.modelCalls).toBe(reportedUsage.modelCalls);

    // Run cost/token fields are cumulative across planner + skeptic + synthesizer (Req 3.6).
    const expectedUsd = reportedUsage.estimatedUsd + DEFAULT_SPY_USAGE.estimatedUsd * 2;
    const expectedInputTokens = reportedUsage.inputTokens + DEFAULT_SPY_USAGE.inputTokens * 2;
    const expectedOutputTokens = reportedUsage.outputTokens + DEFAULT_SPY_USAGE.outputTokens * 2;
    const expectedModelCalls = reportedUsage.modelCalls + DEFAULT_SPY_USAGE.modelCalls * 2;
    expect(result.run.costEstimate.usd).toBeCloseTo(expectedUsd, 12);
    expect((result.run.tokenEstimate as any).input).toBe(expectedInputTokens);
    expect((result.run.tokenEstimate as any).output).toBe(expectedOutputTokens);
    expect(result.run.actualCost?.usd).toBeCloseTo(expectedUsd, 12);
    expect((result.run.actualCost as any)?.modelCalls).toBe(expectedModelCalls);
    expect((result.run.actualTokens as any)?.input).toBe(expectedInputTokens);
    expect((result.run.actualTokens as any)?.output).toBe(expectedOutputTokens);
  });

  it("maps a BUDGET_DENIED blocker to NEEDS_DECISION without invoking the provider or throwing", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, EDIT_PROMPT);
    const spy = new SpyLLMProvider({ responses: [validPlanJsonFor(args)] });

    // Sub-threshold budget: a positive estimate (0.01 USD) exceeds maxUsd 0, so
    // the preflight denies the call before any provider invocation.
    const subThresholdBudget: Budget = { ...DEFAULT_EXTERNAL_BUDGET, maxUsd: 0 };

    const result = await runChat(store, args, {
      mode: "external",
      router: makeRouter(spy),
      budget: subThresholdBudget,
    });

    // Resolves to a structured ChatRunResult (no exception escaped the handler).
    expect(result).toBeDefined();
    expect(result.run.phase).toBe("NEEDS_DECISION");
    expect(result.run.status).toBe("needs_decision");
    expect(result.synthesis.status).toBe("NEEDS_DECISION");
    // Budget denial precedes the network call.
    expect(spy.invokeCount).toBe(0);
  });

  it("maps a PROVIDER_ERROR blocker to NEEDS_DECISION without throwing", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, EDIT_PROMPT);
    const spy = new SpyLLMProvider({
      responses: [
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            message: "Spy provider HTTP 503 (simulated)",
          }),
        },
      ],
    });

    const result = await runExternalChatRun(store, args, { mode: "external", router: makeRouter(spy) });

    expect(result).toBeDefined();
    expect(result.run.phase).toBe("NEEDS_DECISION");
    expect(result.run.status).toBe("needs_decision");
    expect(result.synthesis.status).toBe("NEEDS_DECISION");
    // The provider was invoked exactly once before failing.
    expect(spy.invokeCount).toBe(1);

    // The decision request surfaces the PROVIDER_ERROR blocker.
    const events = await store.listEvents(result.run.id);
    const decisionEvent = events.find((event) => event.phase === "NEEDS_DECISION");
    expect((decisionEvent?.payload as any)?.blocker?.code).toBe("PROVIDER_ERROR");
  });

  it("maps a PLANNER_INVALID blocker to FAILED after one repair without throwing", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, EDIT_PROMPT);
    // Malformed JSON on BOTH the initial call and the single repair retry.
    const spy = new SpyLLMProvider({
      responses: ["<<<NOT_JSON first attempt", "<<<NOT_JSON repair attempt"],
    });

    const result = await runExternalChatRun(store, args, { mode: "external", router: makeRouter(spy) });

    expect(result).toBeDefined();
    expect(result.run.phase).toBe("FAILED");
    expect(result.run.status).toBe("failed");
    expect(result.synthesis.status).toBe("FAILED");
    // Exactly two provider calls: one initial + one repair.
    expect(spy.invokeCount).toBe(2);

    const events = await store.listEvents(result.run.id);
    const failedEvent = events.find((event) => event.phase === "FAILED");
    expect((failedEvent?.payload as any)?.blocker?.code).toBe("PLANNER_INVALID");
  });

  it("never leaks a provider-error secret into any persisted event", async () => {
    const secret = "sk-leak-DEADBEEFCAFE1234567890";
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, EDIT_PROMPT);
    const spy = new SpyLLMProvider({
      responses: [
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            // The secret is embedded in an Authorization-style fragment so the
            // redaction layer must scrub it before it reaches any event.
            message: `Upstream auth rejected: Bearer ${secret}`,
          }),
        },
      ],
    });

    const result = await runExternalChatRun(store, args, { mode: "external", router: makeRouter(spy) });

    expect(result.run.phase).toBe("NEEDS_DECISION");

    const events = await store.listEvents(result.run.id);
    expect(JSON.stringify(events)).not.toContain(secret);
    // The synthesis surfaced to the user is also secret-free.
    expect(JSON.stringify(result.synthesis)).not.toContain(secret);
  });

  it("requires a configured router when dispatching in external mode", async () => {
    const store = new InMemoryRectorStore();
    const args = await buildChatArgs(store, EDIT_PROMPT);

    await expect(runChat(store, args, { mode: "external" })).rejects.toThrow(/ModelRouter/);
  });
});
