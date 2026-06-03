import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";
import { TaskManager } from "../src/thalamus/router";

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
  return { status: res.status, data };
}

function eventForPhase(events: any[], phase: string): any {
  return events.find((event) => event.phase === phase);
}

const providerEnvKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "GOOGLE_API_KEY",
];
const savedProviderEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of providerEnvKeys) {
    savedProviderEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of providerEnvKeys) {
    const value = savedProviderEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedProviderEnv.clear();
});

describe("chat brainstem end-to-end", () => {
  it("runs chat through all local brainstem phases and synthesizes trace-backed final response without provider keys", async () => {
    await withServer(createApp(new TaskManager()), async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Chunk 15 brainstem" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "Explain the Rector vertical slice." }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;
      expect(body.run.status).toBe("completed");
      expect(body.run.phase).toBe("DONE");
      expect(body.run.budget.allowedProviders).toEqual([]);
      expect(body.run.budget.maxModelCalls).toBe(0);
      expect(body.run.actualCost.usd).toBe(0);
      expect(body.run.actualTokens).toEqual({ input: 0, output: 0 });

      const phases = [
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
      ];
      for (const phase of phases) {
        expect(eventForPhase(body.events, phase), `missing phase ${phase}`).toBeDefined();
      }

      expect(eventForPhase(body.events, "TRIAGE").payload.triage.route).toBe("DIRECT_ANSWER");
      expect(eventForPhase(body.events, "CONTEXT_BUILDING").payload.contextPack.id).toMatch(/^ctx-/);
      expect(eventForPhase(body.events, "PLANNING").payload.plannerOutput.tasks.length).toBe(1);
      expect(eventForPhase(body.events, "SKEPTIC_REVIEW").payload.skepticReview.verdict).toBeDefined();
      expect(eventForPhase(body.events, "CRUCIBLE").payload.crucibleDecision.verdict).toBe("ACCEPTED");
      expect(eventForPhase(body.events, "DAG_COMPILATION").payload.compiledDag.nodes.length).toBeGreaterThan(0);
      expect(eventForPhase(body.events, "EXECUTING").payload.executionResult.status).toBe("SUCCESS");
      expect(eventForPhase(body.events, "VALIDATING").payload.validationHealingResult.status).toBe("VALIDATED");
      expect(eventForPhase(body.events, "SYNTHESIZING").payload.synthesis.status).toBe("VALIDATED");

      const finalText = body.assistantMessage.content as string;
      expect(finalText).toContain("Status: VALIDATED");
      expect(finalText).toContain("Route: DIRECT_ANSWER");
      expect(finalText).toContain(`Trace: ${body.run.traceId}`);
      expect(finalText).toContain("triage DIRECT_ANSWER/low");
      expect(finalText).toContain("crucible ACCEPTED");
      expect(finalText).toContain("execution SUCCESS");
      expect(finalText).toContain("validation VALIDATED");
      expect(finalText).toContain("provider calls: 0");
      expect(finalText).not.toContain("Rector received");
    });
  });

  it("can deterministically exercise failure then healing through simulator options", async () => {
    await withServer(
      createApp(new TaskManager(), {
        orchestration: {
          executorOptions: {
            failAttemptsByNodeId: { "task:answer.synthesize": 2 },
          },
          maxHealingAttempts: 1,
        },
      }),
      async (base) => {
        const created = await api(base, "/api/chat/conversations", {
          method: "POST",
          body: JSON.stringify({ title: "Chunk 15 healing" }),
        });

        const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: "Explain the Rector vertical slice." }),
        });

        expect(sent.status).toBe(201);
        const body = sent.data as any;
        const execution = eventForPhase(body.events, "EXECUTING").payload.executionResult;
        const validation = eventForPhase(body.events, "VALIDATING").payload.validationHealingResult;
        const synthesis = eventForPhase(body.events, "SYNTHESIZING").payload.synthesis;

        expect(execution.status).toBe("PARTIAL");
        expect(validation.status).toBe("HEALED");
        expect(validation.attempts).toBe(1);
        expect(validation.actions).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "RETRY_NODE", nodeId: "task:answer.synthesize" })])
        );
        expect(synthesis.status).toBe("HEALED");
        expect(body.assistantMessage.content).toContain("Status: HEALED");
        expect(body.assistantMessage.content).toContain("healing HEALED after 1 attempt");
        expect(body.assistantMessage.content).toContain("provider calls: 0");
      }
    );
  });

  it("runs chat through full brainstem and synthesis for PLAN_ONLY routes", async () => {
    await withServer(createApp(new TaskManager()), async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Chunk 15 Plan Only E2E" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "Give me an architecture design proposal/plan without editing any code." }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;
      expect(body.run.status).toBe("completed");
      expect(body.run.phase).toBe("DONE");
      expect(body.run.route).toBe("PLAN_ONLY");

      const triageEvent = eventForPhase(body.events, "TRIAGE");
      expect(triageEvent).toBeDefined();
      expect(triageEvent.payload.triage.route).toBe("PLAN_ONLY");

      const skepticEvent = eventForPhase(body.events, "SKEPTIC_REVIEW");
      expect(skepticEvent).toBeDefined();
      expect(skepticEvent.payload.skepticReview.verdict).toBeDefined();

      const crucibleEvent = eventForPhase(body.events, "CRUCIBLE");
      expect(crucibleEvent).toBeDefined();
      expect(crucibleEvent.payload.crucibleDecision.verdict).toBeDefined();

      const synthesisEvent = eventForPhase(body.events, "SYNTHESIZING");
      expect(synthesisEvent).toBeDefined();
      expect(synthesisEvent.payload.synthesis.status).toBeDefined();
      expect(synthesisEvent.payload.synthesis.route).toBe("PLAN_ONLY");

      expect(body.assistantMessage.content).toContain("Route: PLAN_ONLY");
    });
  });

  it("runs chat through full brainstem and synthesis for CODE_EDIT routes", async () => {
    await withServer(createApp(new TaskManager()), async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Chunk 15 Code Edit E2E" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "Please implement a refactor to add changes to src/index.ts and write tests." }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;
      expect(body.run.status).toBe("completed");
      expect(body.run.phase).toBe("DONE");
      expect(body.run.route).toBe("CODE_EDIT");

      const triageEvent = eventForPhase(body.events, "TRIAGE");
      expect(triageEvent).toBeDefined();
      expect(triageEvent.payload.triage.route).toBe("CODE_EDIT");

      const skepticEvent = eventForPhase(body.events, "SKEPTIC_REVIEW");
      expect(skepticEvent).toBeDefined();
      expect(skepticEvent.payload.skepticReview.verdict).toBeDefined();

      const crucibleEvent = eventForPhase(body.events, "CRUCIBLE");
      expect(crucibleEvent).toBeDefined();
      expect(crucibleEvent.payload.crucibleDecision.verdict).toBeDefined();

      const synthesisEvent = eventForPhase(body.events, "SYNTHESIZING");
      expect(synthesisEvent).toBeDefined();
      expect(synthesisEvent.payload.synthesis.status).toBeDefined();
      expect(synthesisEvent.payload.synthesis.route).toBe("CODE_EDIT");

      expect(body.assistantMessage.content).toContain("Route: CODE_EDIT");
    });
  });
});
