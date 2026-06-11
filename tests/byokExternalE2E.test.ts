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
import { createFakePlan, PlannerOutputSchema } from "../src/orchestration/planner";
import { ProviderError, type ModelRouter, type ModelSelection } from "../src/providers/llm";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
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
    const prompt = "Create an implementation plan for adding login, but do not edit files.";

    // The spy scripts the three live steps in order: (a) the planner plan with a known reported
    // usage, (b) a SOUND/empty skeptic draft (so the crucible ACCEPTS), and (c) a synthesizer draft
    // with one evidence citation. A small fixed estimate keeps every budget preflight permissive.
    // No network, no API key.
    const reportedUsage = { inputTokens: 321, outputTokens: 123, totalTokens: 444, estimatedUsd: 0.0456, modelCalls: 1 };
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: prompt,
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: fakePlanJsonFor(prompt), usage: reportedUsage },
        { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
        {
          content: synthesisDraftToJson({
            response: "The Rector vertical slice runs a deterministic brainstem loop; see cited evidence.",
            citations: [{ kind: "artifact", ref: "task:answer.synthesize", detail: "no-op execution node succeeded" }],
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
        body: JSON.stringify({ title: "BYOK external E2E" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;

      // Four provider calls were made: preprocessor + planner + live skeptic + live synthesizer.
      expect(provider.invokeCount).toBe(4);

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

      // --- (2) Run cost/token fields accumulate preprocessor + planner + skeptic + synthesizer usage (Req 3.6). ---
      const expectedUsd = reportedUsage.estimatedUsd + DEFAULT_SPY_USAGE.estimatedUsd * 3;
      const expectedModelCalls = reportedUsage.modelCalls + DEFAULT_SPY_USAGE.modelCalls * 3;
      const expectedInputTokens = reportedUsage.inputTokens + DEFAULT_SPY_USAGE.inputTokens * 3;
      const expectedOutputTokens = reportedUsage.outputTokens + DEFAULT_SPY_USAGE.outputTokens * 3;
      expect(body.run.costEstimate.usd).toBeCloseTo(expectedUsd, 12);
      expect(body.run.costEstimate.modelCalls).toBe(expectedModelCalls);
      expect(body.run.actualCost.usd).toBeCloseTo(expectedUsd, 12);
      expect(body.run.actualCost.modelCalls).toBe(expectedModelCalls);
      expect(body.run.tokenEstimate).toEqual({ input: expectedInputTokens, output: expectedOutputTokens });
      expect(body.run.actualTokens).toEqual({ input: expectedInputTokens, output: expectedOutputTokens });

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
          content: JSON.stringify({
            distilledContext: prompt,
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
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
      expect(provider.invokeCount).toBe(2);
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

// ---------------------------------------------------------------------------
// Task 10.3 — additional external-mode end-to-end coverage.
//
// The describe block above already covers (1) a successful external run with
// provider/cost metadata on the PLANNING event and (2) a provider-error secret
// redaction case. This block ADDS the coverage that file lacked:
//
//   (a) The live synthesizer's evidence-cited answer surfaces through the
//       SYNTHESIZING event and the assistant response. The synthesizer REQUIRES
//       a non-empty citation set whenever the run carried execution/validation
//       evidence (Req 2.2/2.3): a citation-free answer is rejected and routed to
//       repair-then-fallback. So a non-fallback live synthesis — observable as
//       `synthesis.providerCalls >= 1` on the SYNTHESIZING event, versus the
//       deterministic fallback's `providerCalls === 0` — is end-to-end proof
//       that a schema-valid, non-empty citation set was accepted. The cited
//       answer text is asserted to surface in the assistant response, and a
//       secret embedded in the model's answer + plan content is asserted absent
//       from the HTTP body (Req 7.5 redaction at the synthesizer + event
//       boundary).
//
//   (b) The safe workspace executor and the bounded healing loop are exercised
//       by a FILE_OPERATION plan whose compiled PROPOSE_PATCH node lacks a
//       matching FILE_WRITE approval. The safe executor returns a structured
//       NEEDS_APPROVAL result (never touching disk), execution fails, the
//       bounded healing loop classifies the failure as PERMISSION and returns
//       NEEDS_DECISION (Req 5.8), and the run terminates in NEEDS_DECISION with
//       all execution artifacts preserved (Req 9.7) and no secret leakage.
//
// `createApp` does not forward sandbox wiring (workspaceRoot / fsImpl /
// commandRunner / approvals) into the chat runner, so these additions stay at
// the level the HTTP API supports: the safe executor runs with its safe
// defaults, an unapproved PROPOSE_PATCH performs no write, and no real process
// or network is used.
// ---------------------------------------------------------------------------

/** Wraps a secret in an `Authorization: Bearer` string — a form `redactString` redacts. */
function bearerLeak(secret: string): string {
  return `Authorization: Bearer ${secret}`;
}

/**
 * Builds a deterministic, schema-valid plan for `prompt` (no file operations →
 * all no-op execution nodes) with a secret embedded in the goal in a redactable
 * Bearer form, so the success path's planner-output redaction is exercised too.
 */
function leakyNoOpPlanJsonFor(prompt: string, secret: string): string {
  const triage = triageUserMessage(prompt);
  const contextPack = makeContextPack(triage, prompt);
  const plan = createFakePlan({ triage, contextPack, messageContent: prompt });
  return planToJson({ ...plan, goal: `${plan.goal} (${bearerLeak(secret)})` });
}

/**
 * Builds a schema-valid, low-risk plan with a single FILE_OPERATION task whose
 * expected artifact is a safe relative path. The DAG compiler classifies a task
 * whose text contains "edit"/"file" as a FILE_OPERATION node, which the
 * sandbox bridge maps to a PROPOSE_PATCH on that path. With no FILE_WRITE
 * approval the safe executor returns NEEDS_APPROVAL (no write), so execution
 * fails and the bounded healing loop routes the PERMISSION failure to
 * NEEDS_DECISION. A secret is embedded (Bearer form) in the goal to exercise
 * redaction on the terminal path. The plan is parsed through
 * `PlannerOutputSchema` so a construction error fails fast in the test rather
 * than surfacing as a planner blocker.
 */
function fileOperationPlanJson(artifactPath: string, secret: string): string {
  const plan = PlannerOutputSchema.parse({
    goal: `Edit a source file to add the requested feature (${bearerLeak(secret)})`,
    assumptions: ["The target file is within the workspace."],
    tasks: [
      {
        id: "edit-feature",
        title: "Edit source file to add the feature",
        description: `Apply the requested code change to the file ${artifactPath}`,
        dependencies: [],
        expectedArtifacts: [artifactPath],
        validation: ["the edited file compiles"],
        risk: "low",
        approvalRequired: false,
      },
    ],
    dependencies: [],
    validation: { summary: "Validate the edited file", checks: ["the file compiles"] },
    riskLevel: "low",
    approvalGates: [],
  });
  return planToJson(plan);
}

describe("BYOK external-mode end-to-end — citations, safe executor, and healing (task 10.3)", () => {
  it("surfaces the live synthesizer's evidence-cited answer in the SYNTHESIZING event and redacts an answer-embedded secret from the HTTP body", async () => {
    const prompt = "Create an implementation plan for adding login, but do not edit files.";
    // The secret is embedded (Bearer form) in BOTH the plan goal and the model's
    // synthesis answer + a citation detail; production redaction must strip every
    // occurrence before it crosses the HTTP boundary.
    const SECRET = "sk-CITATIONLEAKSECRET0123456789abcdEFGH";

    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: prompt,
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: leakyNoOpPlanJsonFor(prompt, SECRET) },
        { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
        {
          content: synthesisDraftToJson({
            response: `The Rector vertical slice ran end-to-end; the evidence is cited below. (${bearerLeak(SECRET)})`,
            citations: [
              { kind: "artifact", ref: "task:answer.synthesize", detail: `no-op execution node succeeded (${bearerLeak(SECRET)})` },
              { kind: "test", ref: "validate:answer.synthesize", detail: "task validation passed" },
            ],
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
        body: JSON.stringify({ title: "BYOK external citations" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;

      // preprocessor + planner + live skeptic + live synthesizer.
      expect(provider.invokeCount).toBe(4);
      expect(body.run.status).toBe("completed");
      expect(body.run.phase).toBe("DONE");

      const synthEvent = eventForPhase(body.events, "SYNTHESIZING");
      expect(synthEvent).toBeDefined();
      // The run carried execution evidence (the DAG executed nodes through the
      // safe executor), so the synthesizer required a non-empty citation set. A
      // live (non-fallback) synthesis is observable as providerCalls >= 1; the
      // deterministic fallback reports providerCalls === 0. providerCalls === 1
      // is therefore end-to-end proof a schema-valid, non-empty citation set was
      // accepted (a citation-free answer would have forced a fallback).
      expect(synthEvent.payload.synthesis.providerCalls).toBe(1);
      expect(synthEvent.payload.synthesis.status).toBe("VALIDATED");

      // The live, citation-referencing answer surfaces in the SYNTHESIZING event
      // and the assistant message (not the deterministic "Status: ..." fallback).
      const answer: string = synthEvent.payload.synthesis.response;
      expect(answer).toMatch(/evidence is cited/i);
      expect(answer.startsWith("Status:")).toBe(false);
      expect(body.assistantMessage.content).toBe(answer);

      // The secret embedded in the answer, the citation, and the plan goal must
      // not appear ANYWHERE in the HTTP response body.
      expect(sent.rawBody).not.toContain(SECRET);
      expect(sent.rawBody).not.toContain("sk-CITATIONLEAKSECRET");
      expect(sent.rawBody).not.toMatch(/Bearer\s+sk-/);
    });
  });

  it("drives a FILE_OPERATION plan through the safe executor and bounded healing loop to NEEDS_DECISION with artifacts preserved and no secret leakage", async () => {
    const prompt = "Add the requested feature to the codebase.";
    const SECRET = "sk-HEALINGLEAKSECRET0123456789abcdefIJKL";
    const artifactPath = "src/generated/byok-e2e-feature.ts";

    // Only the planner and live skeptic are scripted: the run terminates at
    // NEEDS_DECISION before the synthesizer is reached, so no synthesis response
    // is scripted.
    const provider = new SpyLLMProvider({
      estimate: DEFAULT_SPY_USAGE,
      responses: [
        {
          content: JSON.stringify({
            distilledContext: prompt,
            proposedToolCalls: [],
            entities: [],
            intent: "Explain",
            constraints: [],
          }),
        },
        { content: fileOperationPlanJson(artifactPath, SECRET) },
        { content: skepticDraftToJson({ verdict: "SOUND", findings: [] }) },
      ],
      // The provider-backed repair agent is selected but never invoked for a
      // PERMISSION failure; allow a repeat so an unexpected extra call does not
      // throw an opaque overflow error (it would instead fail a clear assertion).
      onOverflow: "repeat-last",
    });

    const app = createApp(new TaskManager(), {
      orchestration: { mode: "external", router: spyRouter(provider) },
    });

    await withServer(app, async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "BYOK external healing" }),
      });
      expect(created.status).toBe(201);

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });

      expect(sent.status).toBe(201);
      const body = sent.data as any;

      // preprocessor + planner + live skeptic only; the run stops before the live synthesizer
      // (a PERMISSION failure never consults the repair agent — Req 5.8).
      expect(provider.invokeCount).toBe(3);

      // Req 9.7: a healing NEEDS_DECISION terminates the run in NEEDS_DECISION.
      expect(body.run.phase).toBe("NEEDS_DECISION");
      expect(body.run.status).toBe("needs_decision");

      // The safe executor returned a structured failure (unapproved PROPOSE_PATCH
      // → NEEDS_APPROVAL → node FAILED), and the bounded healing loop classified
      // it as requiring an operator decision.
      const executing = eventForPhase(body.events, "EXECUTING");
      expect(executing.payload.executionResult.status).toBe("FAILED");
      const validating = eventForPhase(body.events, "VALIDATING");
      expect(validating.payload.validationHealingResult.status).toBe("NEEDS_DECISION");

      // Req 9.7: execution artifacts (the unapproved patch) are preserved. The
      // safe-executor bridge records a PROPOSE_PATCH artifact for the node. Read
      // them from `executionResult.artifacts` (the persisted top-level
      // `executionArtifacts` is the same array reference, which the redaction
      // boundary collapses to a shared-reference marker).
      const artifacts = executing.payload.executionResult.artifacts as Array<{ operationKind?: string }>;
      expect(Array.isArray(artifacts)).toBe(true);
      expect(artifacts.length).toBeGreaterThan(0);
      expect(artifacts.some((artifact) => artifact.operationKind === "PROPOSE_PATCH")).toBe(true);

      // No secret leaks anywhere in the HTTP response body on the terminal path.
      expect(sent.rawBody).not.toContain(SECRET);
      expect(sent.rawBody).not.toContain("sk-HEALINGLEAKSECRET");
      expect(sent.rawBody).not.toMatch(/Bearer\s+sk-/);
    });
  });
});
