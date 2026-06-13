/**
 * Task 13.1 — End-to-end redaction property test (ORN-39/40/41).
 *
 * **Property 3: No secret appears in any persisted row, event, artifact, SSE frame, or cost
 * aggregate.**
 * **Validates: Requirements 1.5, 2.5, 3.5**
 *
 * This is the broad, cross-cutting sibling of the streaming-only redaction test
 * (`tests/chatStreaming.redaction.test.ts`, task 7.5). Where that test drives the SSE boundary in
 * isolation, this one injects a distinctive key-like secret into BOTH the provider's scripted
 * outputs AND the user message content, drives a FULL external (BYOK) chat run through the real
 * HTTP API created by `createApp`, and then asserts the secret substring is ABSENT from every
 * externally observable surface:
 *
 *   1. every stored payload — `GET /api/chat/conversations/:id` (conversation + messages),
 *      `GET /api/runs/:id/events` (run + events), `GET /api/operator/runs/:id` (artifact handles),
 *   2. every replayed/live SSE frame — `GET /api/runs/:id/stream` (the run is terminal by the time
 *      the stream is opened, so the handler replays every persisted event then closes cleanly),
 *   3. the cost aggregates — `GET /api/runs/:id/cost` and `GET /api/chat/conversations/:id/cost`,
 *   4. the connection-test response — `runConnectionTest` (the injectable core of
 *      `POST /api/setup/test-connection`) with the secret in env AND in a thrown network error.
 *
 * WHY THIS HOLDS (confirmed by reading the code):
 *  - The chat route redacts the user message content with `redactString` BEFORE persisting it
 *    (`src/api/server.ts`, `POST .../messages`).
 *  - Run events are redacted at persistence time: `transitionRun`/`runEvent`
 *    (`src/orchestration/runStateMachine.ts`) run every payload through `redactSecrets` before
 *    `appendEvent`/`commitRunTransition` persist it.
 *  - The SQLite store re-validates and stores only that already-redacted, schema-valid data, so no
 *    secret reaches a row (Req 1.5).
 *  - SSE frames replay/stream only persisted (redacted) events (Req 2.5).
 *  - Cost aggregates are numeric totals + distinct non-secret provider/model ids derived from those
 *    same persisted events (Req 3.5).
 *
 * PERSISTENT STORE: the app is configured with `persistence: { driver: "sqlite", sqlitePath:
 * ":memory:" }`, so the run executes against a real `SqlRectorStore` (the persistent path) — the
 * "stored row" redaction guarantee is therefore actually exercised, not just the in-memory path.
 * The in-memory SQLite DB needs no file, no cloud account, and no network.
 *
 * SECRET SHAPES: fast-check generates a delimiter-free (hex/alnum) key-like secret and selects a
 * carrier the project's redactor (`src/security/redaction.ts`) actually targets — a `Bearer`
 * header, an inline `api_key=`/`token=`/`secret=` pair, or a credential URI. A delimiter-free
 * secret guarantees the redaction pattern removes it WHOLLY (never leaving a partial substring).
 *
 * No API key, no network: the provider is a scripted `SpyLLMProvider`, the connection test uses a
 * mocked `fetch`, and persistence is in-memory SQLite.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import express from "express";
import http from "node:http";

import { createApp, runConnectionTest } from "../src/api/server";
import { configuredAppOptions } from "./support/configuredApp";
import { TaskManager } from "../src/thalamus/router";
import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan, type PlannerOutput } from "../src/orchestration/planner";
import type { ModelRouter, ModelSelection } from "../src/providers/llm";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbKeyLikeSecret,
  createFetchDouble,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

// --- Harness (mirrors byokExternalE2E.test.ts / costTracking.endpoints.test.ts) ----------------

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

/** Reads the full SSE body of a stream that closes itself (a terminal run replays then ends). */
async function readStream(base: string, runId: string): Promise<string> {
  const res = await fetch(`${base}/api/runs/${runId}/stream`);
  return res.text();
}

/** A single-provider router that always selects the supplied spy on the flagship route. */
function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "redaction e2e router selects the scripted spy provider",
      };
    },
  };
}

/** A deterministic, schema-valid plan for `prompt`, reusing the fake planner. */
function fakePlanFor(prompt: string): PlannerOutput {
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  return createFakePlan({ triage, contextPack, messageContent: prompt });
}

// --- Secret carriers --------------------------------------------------------

/**
 * Carriers the project's `redactString`/`redactSecrets` are guaranteed to target. A
 * delimiter-free (alnum/hex) secret embedded in any of these is removed WHOLLY by redaction:
 *  - `Bearer <token>`     => BEARER_PATTERN,
 *  - `api_key=`/`token=`/`secret=` pair => INLINE_SECRET_PATTERN,
 *  - credential URI (`scheme://user:pass@`) => CREDENTIAL_URI_PATTERN strips the userinfo.
 */
const carriers: Array<(secret: string) => string> = [
  (s) => `Authorization: Bearer ${s}`,
  (s) => `api_key=${s}`,
  (s) => `token=${s}`,
  (s) => `secret=${s}`,
  (s) => `https://admin:${s}@db.example.com/v1`,
];

const carrierIndexArb = fc.nat(carriers.length - 1);

/** The three scripted provider replies for one successful external run, with the secret embedded. */
function leakyResponses(prompt: string, leak: string) {
  const plan = fakePlanFor(prompt);
  const leakyPlan: PlannerOutput = { ...plan, goal: `${plan.goal} (${leak})` };
  return [
    {
      content: JSON.stringify({
        distilledContext: `${prompt} (${leak})`,
        proposedToolCalls: [],
        entities: [],
        intent: "Explain",
        constraints: [],
      }),
    },
    { content: planToJson(leakyPlan) },
    { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
    {
      content: synthesisDraftToJson({
        response: `The Rector vertical slice ran end-to-end; evidence cited below. (${leak})`,
        citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: `no-op execution node succeeded (${leak})` }],
      }),
    },
  ];
}

const PROMPT = "Explain the Rector vertical slice.";

// --- (1)-(3) stored rows + SSE frames + cost aggregates --------------------

describe("no secret in any persisted row, SSE frame, or cost aggregate (Property 3, Req 1.5/2.5/3.5)", () => {
  it("drives a full external run against a persistent (sqlite :memory:) store and leaks the secret nowhere", async () => {
    await fc.assert(
      fc.asyncProperty(arbKeyLikeSecret(), carrierIndexArb, async (secret, carrierIndex) => {
        const leak = carriers[carrierIndex](secret);

        // Scripted provider: plan + SOUND skeptic + cited synthesis, each carrying the secret in a
        // redactable form. No network, no API key.
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: leakyResponses(PROMPT, leak),
        });

        // Persistent store: a real SqlRectorStore over in-memory SQLite (the persistent path), so
        // the "no secret in a stored row" guarantee is genuinely exercised.
        const app = createApp(
          new TaskManager(),
          await configuredAppOptions({
            orchestration: { router: spyRouter(provider) },
            persistence: { driver: "sqlite", sqlitePath: ":memory:" },
          }),
        );

        await withServer(app, async (base) => {
          const created = await api(base, "/api/chat/conversations", {
            method: "POST",
            body: JSON.stringify({ title: "redaction e2e" }),
          });
          expect(created.status).toBe(201);
          const conversationId: string = created.data.id;

          // The user message content ALSO carries the secret (redacted at the chat route).
          const sent = await api(base, `/api/chat/conversations/${conversationId}/messages`, {
            method: "POST",
            body: JSON.stringify({ content: `${PROMPT} ${leak}` }),
          });
          if (sent.status !== 201) {
            console.error("FAILED RESPONSE:", sent.data);
          }
          expect(sent.status).toBe(201);
          // A real external run: preprocessor + planner + live skeptic + live synthesizer reached DONE.
          expect(provider.invokeCount).toBe(4);
          expect(sent.data.run.phase).toBe("DONE");
          const runId: string = sent.data.run.id;

          // Collect every externally observable surface, then assert the secret is absent from all.
          const conversation = await api(base, `/api/chat/conversations/${conversationId}`);
          const runEvents = await api(base, `/api/runs/${runId}/events`);
          const operatorRun = await api(base, `/api/operator/runs/${runId}`);
          const runCost = await api(base, `/api/runs/${runId}/cost`);
          const conversationCost = await api(base, `/api/chat/conversations/${conversationId}/cost`);
          const streamBody = await readStream(base, runId);

          expect(conversation.status).toBe(200);
          expect(runEvents.status).toBe(200);
          expect(operatorRun.status).toBe(200);
          expect(runCost.status).toBe(200);
          expect(conversationCost.status).toBe(200);

          // Sanity: the stream actually replayed events and closed with a terminal `done` frame, so
          // the absence assertion below covers real frames (not an empty stream).
          expect(streamBody).toContain("event: run-event");
          expect(streamBody).toContain("event: done");

          const surfaces: Record<string, string> = {
            "POST messages response": sent.rawBody,
            "GET conversation+messages": conversation.rawBody,
            "GET run events": runEvents.rawBody,
            "GET operator run (artifacts/handles)": operatorRun.rawBody,
            "GET run cost": runCost.rawBody,
            "GET conversation cost": conversationCost.rawBody,
            "GET run stream (replayed SSE frames)": streamBody,
          };

          for (const [name, body] of Object.entries(surfaces)) {
            // The whole injected secret must be absent...
            expect(body, `secret leaked into ${name}`).not.toContain(secret);
            // ...and so must any residual `Bearer <secret>` / credential-userinfo form.
            expect(body, `unredacted bearer/credential in ${name}`).not.toMatch(/Bearer\s+sk-/);
          }
        });
      }),
      { numRuns: 6 }
    );
  }, 30_000);
});

// --- (4) connection-test response -----------------------------------------

describe("no secret in the connection-test response (Property 3, Req 2.5)", () => {
  it("redacts the secret from the connection-test response even when env and the network error carry it", async () => {
    await fc.assert(
      fc.asyncProperty(arbKeyLikeSecret(), carrierIndexArb, async (secret, carrierIndex) => {
        const leak = carriers[carrierIndex](secret);

        // The secret sits under a secret-named env key (redactSecrets territory) AND inside a thrown
        // network error message (redactString territory). The mocked fetch guarantees no real
        // network call — `POST /api/setup/test-connection` delegates to exactly this core with the
        // process env and the global fetch, so this is the route's injectable, network-safe heart.
        const env: Record<string, string | undefined> = {
          TOGETHER_API_KEY: secret,
          TOGETHER_BASE_URL: "https://api.together.test/v1",
        };
        const fetchDouble = createFetchDouble({ throwError: new Error(`connect failed (${leak})`) });

        const response = await runConnectionTest({
          providerId: "together",
          env,
          fetchImpl: fetchDouble.fetchImpl,
        });

        // A network failure is reported as a safe, redacted response (never throws).
        expect(response.ok).toBe(false);
        expect(response.networkAttempted).toBe(true);
        expect(JSON.stringify(response)).not.toContain(secret);
        expect(JSON.stringify(response)).not.toMatch(/Bearer\s+sk-/);
      }),
      { numRuns: 20 }
    );
  });
});
