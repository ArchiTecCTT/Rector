/**
 * Task 7.2 — External-mode end-to-end integration test.
 *
 * Drives a full external (BYOK) chat run through the real HTTP API created by
 * `createApp`, with an injected mocked `ModelRouter` whose `select()` returns a
 * scripted `SpyLLMProvider`. No API key and no real network are used: the spy
 * provider returns a deterministic, schema-valid plan (or a scripted provider
 * error) entirely in-memory.
 *
 * Coverage:
 *   1. A successful external run reaches DONE/completed, visits every brainstem
 *      phase, and records provider/model/route metadata (`providerCall`) on the
 *      PLANNING event (Req 3.5).
 *   2. The run's cost/token fields reflect the spy's reported usage (Req 3.6):
 *      costEstimate/actualCost usd + modelCalls, tokenEstimate/actualTokens.
 *   3. A provider-originated secret (an Authorization: Bearer token in a
 *      provider error) never appears anywhere in the HTTP response body — it is
 *      redacted by the chat runner's redaction boundary (Req 3.8).
 *   4. The deterministic post-planning phases (skeptic → crucible → DAG →
 *      executor → validation → synthesis) all appear in the run events, matching
 *      the local E2E expectations apart from plan source + provider metadata.
 *
 * Uses the same raw `http.Server` + `fetch` harness as `chatBrainstemE2E.test.ts`
 * (the repo's established, lowest-risk E2E pattern).
 */
import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";

import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";
import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan } from "../src/orchestration/planner";
import { ProviderError, type ModelRouter, type ModelSelection } from "../src/providers/llm";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  makeContextPack,
  planToJson,
} from "./support/byokArbitraries";

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
  return { status: res.status, data, rawBody: text };
}

function eventForPhase(events: any[], phase: string): any {
  return events.find((event) => event.phase === phase);
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

/**
 * Builds a deterministic, schema-valid plan JSON for a prompt by reusing
 * `createFakePlan`. The plan is held to the exact same safety bar a live plan
 * must pass, so it flows cleanly through skeptic → crucible → DAG → executor →
 * validation → synthesis to DONE.
 */
function fakePlanJsonFor(prompt: string): string {
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  return planToJson(createFakePlan({ triage, contextPack, messageContent: prompt }));
}

const ALL_PHASES = [
  "TRIAGE",
  "CONTEXT_BUILDING",
  "PLANNING",
  "SKEPTIC_REVIEW",
  "CRUCIBLE",
  "DAG_COMPILATION",
  "EXECUTING",
  "VALIDATING",
  "SYNTHESIZING",
  "DONE",
] as const;

describe("BYOK external-mode end-to-end", () => {
  it("runs a full external brainstem run through createApp, records provider/cost metadata, and reaches DONE", async () => {
    const prompt = "Explain the Rector vertical slice.";

    // Spy returns a valid plan with a known reported usage; a small fixed
    // estimate keeps the budget preflight permissive. No network, no API key.
    const reportedUsage = { inputTokens: 321, outputTokens: 123, totalTokens: 444, estimatedUsd: 0.0456, modelCalls: 1 };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [{ content: fakePlanJsonFor(prompt), usage: reportedUsage }],
    });

    const app = createApp(new TaskManager(), {
      orchestration: { mode: "external", router: spyRouter(provider) },
    });

    await withServer(app, async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "BYOK external E2E" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;

      // Exactly one provider call was made (single committed planner call).
      expect(provider.invokeCount).toBe(1);

      // --- (1) Run reaches DONE/completed via the external path. ---
      expect(body.run.status).toBe("completed");
      expect(body.run.phase).toBe("DONE");

      // --- (4) Every brainstem phase appears in the recorded events. ---
      for (const phase of ALL_PHASES) {
        expect(eventForPhase(body.events, phase), `missing phase ${phase}`).toBeDefined();
      }
      expect(eventForPhase(body.events, "CRUCIBLE").payload.crucibleDecision.verdict).toBe("ACCEPTED");
      expect(eventForPhase(body.events, "EXECUTING").payload.executionResult.status).toBe("SUCCESS");
      expect(eventForPhase(body.events, "VALIDATING").payload.validationHealingResult.status).toBe("VALIDATED");
      expect(eventForPhase(body.events, "SYNTHESIZING").payload.synthesis.status).toBe("VALIDATED");

      // --- (1) PLANNING event carries provider/model/route metadata (Req 3.5). ---
      const planningEvent = eventForPhase(body.events, "PLANNING");
      expect(planningEvent).toBeDefined();
      const providerCall = planningEvent.payload.providerCall;
      expect(providerCall).toBeDefined();
      expect(providerCall.mode).toBe("external");
      expect(providerCall.provider).toBe(provider.metadata.id);
      expect(providerCall.model).toBe(provider.metadata.models.flagship);
      expect(providerCall.modelRoute).toBe("flagship");
      expect(providerCall.attempts).toBe(1);
      expect(providerCall.repaired).toBe(false);
      // Non-token-named usage fields survive redaction and equal the reported usage.
      expect(providerCall.usage.estimatedUsd).toBe(reportedUsage.estimatedUsd);
      expect(providerCall.usage.modelCalls).toBe(reportedUsage.modelCalls);
      // Token-named fields are redacted by the runner's redaction boundary.
      expect(providerCall.usage.inputTokens).toBe("[REDACTED]");
      expect(providerCall.usage.outputTokens).toBe("[REDACTED]");

      // --- (2) Run cost/token fields reflect the spy's reported usage (Req 3.6). ---
      expect(body.run.costEstimate.usd).toBe(reportedUsage.estimatedUsd);
      expect(body.run.costEstimate.modelCalls).toBe(reportedUsage.modelCalls);
      expect(body.run.actualCost.usd).toBe(reportedUsage.estimatedUsd);
      expect(body.run.actualCost.modelCalls).toBe(reportedUsage.modelCalls);
      expect(body.run.tokenEstimate).toEqual({ input: reportedUsage.inputTokens, output: reportedUsage.outputTokens });
      expect(body.run.actualTokens).toEqual({ input: reportedUsage.inputTokens, output: reportedUsage.outputTokens });

      // No stray auth material anywhere in the success response body.
      expect(sent.rawBody).not.toMatch(/Bearer\s+\S/);
    });
  });

  it("redacts a provider-originated secret so it never appears in the HTTP response body (Req 3.8)", async () => {
    const prompt = "Add pagination to the /users endpoint and update the tests.";

    // A distinctive key-like secret embedded in an Authorization: Bearer header
    // string inside a provider error message. Production redaction (redactString)
    // is designed to catch the `Bearer <token>` form.
    const SECRET = "sk-LEAKEDSECRETKEY0123456789abcdefGHIJ";
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          error: new ProviderError({
            code: "PROVIDER_HTTP_ERROR",
            provider: "spy",
            status: 401,
            message: `Upstream provider rejected request (Authorization: Bearer ${SECRET})`,
          }),
        },
      ],
    });

    const app = createApp(new TaskManager(), {
      orchestration: { mode: "external", router: spyRouter(provider) },
    });

    await withServer(app, async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "BYOK external secret redaction" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });

      // The endpoint never throws on a provider failure: a structured result is
      // returned and the run transitions to NEEDS_DECISION.
      expect(sent.status).toBe(201);
      const body = sent.data as any;
      expect(provider.invokeCount).toBe(1);
      expect(body.run.phase).toBe("NEEDS_DECISION");
      expect(body.run.status).toBe("needs_decision");

      // The provider error was surfaced as a redacted PROVIDER_ERROR blocker.
      expect(JSON.stringify(body.run.decisionRequest)).toContain("PROVIDER_ERROR");
      expect(JSON.stringify(body.run.decisionRequest)).toContain("[REDACTED]");

      // --- (3) The secret must not appear ANYWHERE in the HTTP response body. ---
      expect(sent.rawBody).not.toContain(SECRET);
      expect(sent.rawBody).not.toContain("sk-LEAKEDSECRETKEY");
      expect(sent.rawBody).not.toMatch(/Bearer\s+sk-/);
    });
  });
});
