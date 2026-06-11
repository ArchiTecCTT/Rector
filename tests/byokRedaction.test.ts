/**
 * Task 7.1 — Property 2: No API key appears in any event, trace, error,
 * response, or snapshot.
 *
 * Validates Requirements 1.3, 2.3, and 4.4 (redaction across the ORN-31/32/34
 * boundaries). For arbitrary key-like secrets injected at the provider/env
 * boundary, the secret substring must never survive into any persisted artifact:
 * run events, the run record, the synthesis, the observability summary, the
 * connection-test response, or a thrown error message.
 *
 * REDACTION MODEL (from `src/security/redaction.ts`, confirmed by reading it):
 *  - `redactString` redacts by PATTERN: `Bearer <token>`, `Basic <token>`,
 *    credential URIs (`scheme://user@`), and inline `api_key=`/`token=`/
 *    `secret=`/`password=` pairs.
 *  - `redactSecrets` additionally redacts any object VALUE whose KEY name
 *    contains apikey/token/secret/password/authorization/cookie/connectionstring.
 *  A BARE key-like token (e.g. `sk-...` on its own, with no surrounding
 *    Bearer/`key=` context and not under a secret-named key) is NOT something
 *    the production code claims to redact. Property 2 therefore injects each
 *    secret in a form the redaction boundary IS responsible for catching:
 *    embedded in an `Authorization: Bearer <secret>` string (chat provider
 *    errors / plan content) and under secret-named env keys (connection test).
 *
 * Everything is in-memory and mock-only: a scripted `SpyLLMProvider` and a
 * mocked `fetch` are used, so no API key and no real network are involved.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { runChat, type ChatRunArgs } from "../src/orchestration/chatRunner";
import { runConnectionTest } from "../src/api/server";
import { InMemoryRectorStore } from "../src/store/inMemoryRectorStore";
import { triageUserMessage } from "../src/orchestration/triage";
import { createFakePlan, type PlannerOutput } from "../src/orchestration/planner";
import { createInMemoryObservabilityTrace } from "../src/observability";
import {
  ProviderError,
  type ModelRouter,
  type ModelRouterInput,
  type ModelSelection,
} from "../src/providers/llm";
import type { CommandRunner } from "../src/sandbox";
import {
  DEFAULT_SPY_USAGE,
  SpyLLMProvider,
  arbKeyLikeSecret,
  arbPrompt,
  arbValidPlan,
  createFetchDouble,
  createWorkspaceFs,
  embedSecret,
  generousBudget,
  makeContextPack,
  planToJson,
  skepticDraftToJson,
  synthesisDraftToJson,
} from "./support/byokArbitraries";

/** A single-provider router that always selects the supplied spy on the flagship route. */
function spyRouter(provider: SpyLLMProvider): ModelRouter {
  return {
    select(): ModelSelection {
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: "redaction test router selects the scripted spy provider",
      };
    },
  };
}

/** Builds schema-valid `ChatRunArgs` for a prompt, mirroring the chat endpoint's local wiring. */
async function buildArgs(store: InMemoryRectorStore, prompt: string): Promise<ChatRunArgs> {
  const conversation = await store.createConversation({
    title: "redaction test",
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
  const observability = createInMemoryObservabilityTrace({ provider: "local" });
  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    prompt,
    triage,
    contextPack,
    observability,
  };
}

/** Wraps a secret in an Authorization: Bearer header string — a form `redactString` redacts. */
function bearerLeak(secret: string): string {
  return `Upstream rejected request (Authorization: Bearer ${secret})`;
}

/** Asserts the secret substring appears nowhere in the serialized run artifacts. */
async function assertNoSecretInRunArtifacts(
  store: InMemoryRectorStore,
  result: { run: unknown; synthesis: unknown; observabilitySummary: unknown },
  runId: string,
  secret: string,
): Promise<void> {
  const events = await store.listEvents(runId);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(result.run)).not.toContain(secret);
  expect(JSON.stringify(result.synthesis)).not.toContain(secret);
  expect(JSON.stringify(result.observabilitySummary)).not.toContain(secret);
}

describe("Property 2: no API key appears in any event, trace, error, response, or snapshot", () => {
  // Validates: Requirements 1.3, 4.4 (external chat path).
  it("redacts a provider-error secret from every artifact of a blocked external run", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbKeyLikeSecret(), async (prompt, secret) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, prompt);

        // The spy throws a provider error whose message embeds the secret in a
        // Bearer form on both attempts, so the planner ends in a PROVIDER_ERROR
        // blocker and the run transitions to NEEDS_DECISION.
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [
            { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "spy", status: 401, message: bearerLeak(secret) }) },
            { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "spy", status: 401, message: bearerLeak(secret) }) },
          ],
        });

        // Must never throw past the runner, even though the provider errored.
        const result = await runChat(store, args, {
          mode: "external",
          router: spyRouter(provider),
          budget: generousBudget(),
        });

        await assertNoSecretInRunArtifacts(store, result, result.run.id, secret);
      }),
      { numRuns: 60 },
    );
  });

  // Validates: Requirements 1.3, 4.4 (external chat path, success case).
  it("redacts a secret embedded in plan content from every artifact of a successful external run", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbValidPlan(), arbKeyLikeSecret(), async (prompt, plan, secret) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, prompt);

        // Embed the secret (Bearer form) into the plan goal so it travels through
        // the planner output, synthesis, and persisted events — all of which run
        // through the redaction boundary.
        const leakyPlan = { ...plan, goal: `${plan.goal} ${bearerLeak(secret)}` };
        const provider = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [{ content: planToJson(leakyPlan) }, { content: planToJson(leakyPlan) }],
        });

        const result = await runChat(store, args, {
          mode: "external",
          router: spyRouter(provider),
          budget: generousBudget(),
        });

        await assertNoSecretInRunArtifacts(store, result, result.run.id, secret);
      }),
      { numRuns: 40 },
    );
  });

  // Validates: Requirement 2.3 (connection test response redaction).
  it("redacts a secret from the connection-test response even when env and the network error carry it", async () => {
    await fc.assert(
      fc.asyncProperty(arbKeyLikeSecret(), async (secret) => {
        // The secret is placed under a secret-named env key (redactSecrets territory)
        // AND embedded in a thrown network error message in Bearer form
        // (redactString territory). Together they cover both redaction mechanisms.
        const env: Record<string, string | undefined> = {
          TOGETHER_API_KEY: secret,
          TOGETHER_BASE_URL: "https://api.together.test/v1",
        };
        const fetchDouble = createFetchDouble({ throwError: new Error(bearerLeak(secret)) });

        const response = await runConnectionTest({
          providerId: "together",
          env,
          fetchImpl: fetchDouble.fetchImpl,
        });

        // A network failure is reported as a safe, redacted response (never throws).
        expect(response.ok).toBe(false);
        expect(response.networkAttempted).toBe(true);
        expect(JSON.stringify(response)).not.toContain(secret);
        expect(response.error).toBeDefined();
        expect(response.error).not.toContain(secret);
      }),
      { numRuns: 60 },
    );
  });

  // Validates: Requirement 2.3 (connection test never leaks a config-invalid secret).
  it("never leaks the env secret when the connection test short-circuits on invalid config", async () => {
    await fc.assert(
      fc.asyncProperty(arbKeyLikeSecret(), async (secret) => {
        // Missing TOGETHER_BASE_URL is fine (it has a default); to force a
        // config-invalid short-circuit we use an unsupported providerId while the
        // secret sits in env. No network call is attempted.
        const env: Record<string, string | undefined> = { TOGETHER_API_KEY: secret };
        const fetchDouble = createFetchDouble();

        const response = await runConnectionTest({
          providerId: "unsupported-provider",
          env,
          fetchImpl: fetchDouble.fetchImpl,
        });

        expect(response.ok).toBe(false);
        expect(response.networkAttempted).toBe(false);
        expect(fetchDouble.calls).toBe(0);
        expect(JSON.stringify(response)).not.toContain(secret);
      }),
      { numRuns: 40 },
    );
  });
});

// ===========================================================================
// Task 10.1 — Property 6: No secret appears in any artifact, event, trace,
// response, or error (across the full external loop).
//
// Validates Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6 (ORN-35/36/37/38). Phase 1
// (Property 2 above) proved the planner boundary. Property 6 extends the
// guarantee to the WHOLE external neuro-symbolic loop: a key-like secret is
// injected — in a redactable form — into the prompt, the provider outputs
// (planner / live skeptic / live synthesizer), the injected workspace
// filesystem and command runner, and a provider failure message; the run is
// then driven through `runChat` in external mode with a mocked `ModelRouter`
// and an injected `fsImpl`/`commandRunner`. The secret substring must never
// survive into any persisted event, execution artifact, sandbox result,
// skeptic review, synthesis response/citation, blocker, or thrown error.
//
// As in Property 2, the secret is always embedded in a context the redaction
// boundary is responsible for (`Authorization: Bearer <secret>`), since a bare
// token is not something the production code claims to redact. Everything is
// in-memory and mock-only (`SpyLLMProvider` + `InMemoryWorkspaceFs` + a stub
// `CommandRunner`): no API key, no real disk, and no real network are involved.
// ===========================================================================

/**
 * A task-aware single-app router: returns a dedicated scripted spy for each live
 * step (planner / skeptic / synthesizer / repair) so response scripting is
 * unambiguous regardless of the order the external runner selects providers in.
 */
function taskSpyRouter(spies: {
  planner: SpyLLMProvider;
  skeptic: SpyLLMProvider;
  synthesizer: SpyLLMProvider;
  repair: SpyLLMProvider;
}): ModelRouter {
  return {
    select(input?: ModelRouterInput): ModelSelection {
      const task = input?.task ?? "planner";
      const provider =
        task === "skeptic"
          ? spies.skeptic
          : task === "synthesizer"
            ? spies.synthesizer
            : task === "repair"
              ? spies.repair
              : spies.planner;
      return {
        provider,
        modelRoute: "flagship",
        model: provider.metadata.models.flagship,
        reason: `Property 6 router selects the scripted spy for task=${task}`,
      };
    },
  };
}

/** A scripted spy that always returns `content` (repeats it on overflow). */
function scriptedSpy(content: string): SpyLLMProvider {
  return new SpyLLMProvider({ estimate: DEFAULT_SPY_USAGE, responses: [content], onOverflow: "repeat-last" });
}

/** Injects a redactable secret into a plan's goal so it travels the whole loop. */
function leakPlanGoal(plan: PlannerOutput, secret: string): PlannerOutput {
  return { ...plan, goal: `${plan.goal} ${embedSecret(secret, "prompt")}` };
}

/**
 * Rewrites a plan's first task into a file-editing task targeting a safe
 * relative path, so DAG compilation emits a `FILE_OPERATION` node that maps to a
 * real `PROPOSE_PATCH` sandbox operation (exercising the safe-executor /
 * execution-artifact / healing channels through the full loop). The plan stays
 * low-risk and gate-free so the crucible accepts it.
 */
function injectFileEditTask(plan: PlannerOutput, secret: string): PlannerOutput {
  const tasks = plan.tasks.map((task, index) =>
    index === 0
      ? {
          ...task,
          description: `${task.description} edit file ${embedSecret(secret, "file-content")}`,
          expectedArtifacts: ["src/app.ts"],
          risk: "low" as const,
          approvalRequired: false,
        }
      : task
  );
  return leakPlanGoal({ ...plan, tasks, riskLevel: "low", approvalGates: [] }, secret);
}

/** A command runner whose captured streams both carry the secret (redactable). */
function secretCommandRunner(secret: string): CommandRunner {
  return async () => ({
    exitCode: 0,
    stdout: `stdout ${embedSecret(secret, "command-output")}`,
    stderr: `stderr ${embedSecret(secret, "command-output")}`,
  });
}

/** Asserts the secret substring appears in NONE of a run's persisted artifacts. */
async function assertExternalRunIsSecretFree(
  store: InMemoryRectorStore,
  result: { run: unknown; synthesis: unknown; observabilitySummary: unknown },
  runId: string,
  secret: string,
): Promise<void> {
  const events = await store.listEvents(runId);
  // Persisted events cover the EXECUTING/VALIDATING/HEALING payloads (execution
  // artifacts, sandbox results, healing rounds), the SKEPTIC_REVIEW payload
  // (skeptic review), the SYNTHESIZING payload (synthesis + citations), and any
  // blocker recorded on a terminal transition.
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(result.run)).not.toContain(secret);
  expect(JSON.stringify(result.synthesis)).not.toContain(secret);
  expect(JSON.stringify(result.observabilitySummary)).not.toContain(secret);
}

describe("Property 6: no secret appears in any artifact, event, trace, response, or error", () => {
  // Validates: Requirements 7.1, 7.2, 7.4, 7.5 (full live loop: skeptic + synthesizer + sandbox).
  it("redacts a secret injected across the entire external loop of a successful run", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbValidPlan(), arbKeyLikeSecret(), async (prompt, plan, secret) => {
        const store = new InMemoryRectorStore();
        // The user prompt itself carries the secret (Bearer form).
        const args = await buildArgs(store, `${prompt} ${embedSecret(secret, "prompt")}`);

        // Planner echoes the secret in the plan goal; the live skeptic returns a
        // clean SOUND draft (empty findings) so the crucible accepts and the DAG
        // executes; the synthesizer echoes the secret in BOTH the response and a
        // citation detail. Every default plan's expected artifacts are human
        // strings (never safe relative paths), so all DAG nodes are no-op
        // successes and the run reaches synthesis.
        const leakyPlan = leakPlanGoal(plan, secret);
        const skepticDraft = skepticDraftToJson({ verdict: "SOUND", findings: [] });
        const synthDraft = synthesisDraftToJson({
          response: `Completed the task. ${embedSecret(secret, "prompt")}`,
          citations: [{ kind: "file", ref: "src/app.ts", detail: embedSecret(secret, "file-content") }],
        });

        const router = taskSpyRouter({
          planner: scriptedSpy(planToJson(leakyPlan)),
          skeptic: scriptedSpy(skepticDraft),
          synthesizer: scriptedSpy(synthDraft),
          repair: scriptedSpy(planToJson(leakyPlan)),
        });

        // The injected filesystem and command runner both carry the secret, so
        // any real workspace I/O the loop performs flows through the sandbox
        // redaction boundary.
        const workspaceRoot = process.cwd();
        const fsImpl = createWorkspaceFs({
          root: workspaceRoot,
          files: { "src/secret.ts": embedSecret(secret, "file-content") },
          dirs: { src: ["secret.ts"] },
        });

        const result = await runChat(store, args, {
          mode: "external",
          router,
          budget: generousBudget(),
          workspaceRoot,
          fsImpl,
          commandRunner: secretCommandRunner(secret),
          allowlistedCommands: ["npm:test"],
        });

        await assertExternalRunIsSecretFree(store, result, result.run.id, secret);
      }),
      { numRuns: 20 },
    );
  });

  // Validates: Requirements 7.2, 7.3, 7.5 (safe-executor patch artifact + healing payloads).
  it("redacts a secret across execution artifacts and healing payloads when the loop runs the safe executor", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbValidPlan(), arbKeyLikeSecret(), async (prompt, plan, secret) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, `${prompt} ${embedSecret(secret, "prompt")}`);

        // A file-edit task targeting a safe relative path makes DAG compilation
        // emit a FILE_OPERATION node that maps to a real PROPOSE_PATCH sandbox
        // operation. With no FILE_WRITE approval it surfaces as NEEDS_APPROVAL
        // (a PERMISSION failure), routing the bounded healing loop to
        // NEEDS_DECISION with the patch artifact and healing payloads preserved.
        const leakyPlan = injectFileEditTask(plan, secret);
        const router = taskSpyRouter({
          planner: scriptedSpy(planToJson(leakyPlan)),
          skeptic: scriptedSpy(skepticDraftToJson({ verdict: "SOUND", findings: [] })),
          synthesizer: scriptedSpy(
            synthesisDraftToJson({
              response: `Summary. ${embedSecret(secret, "prompt")}`,
              citations: [{ kind: "artifact", ref: "patch:src-app.ts", detail: embedSecret(secret, "file-content") }],
            }),
          ),
          repair: scriptedSpy(planToJson(leakyPlan)),
        });

        const workspaceRoot = process.cwd();
        const fsImpl = createWorkspaceFs({ root: workspaceRoot, files: {}, dirs: { src: [] } });

        const result = await runChat(store, args, {
          mode: "external",
          router,
          budget: generousBudget(),
          workspaceRoot,
          fsImpl,
          commandRunner: secretCommandRunner(secret),
          allowlistedCommands: ["npm:test"],
          approvals: [],
        });

        await assertExternalRunIsSecretFree(store, result, result.run.id, secret);
      }),
      { numRuns: 20 },
    );
  });

  // Validates: Requirements 7.1, 7.5, 7.6 (skeptic blocker message + no secret in any thrown error).
  it("redacts a secret carried in a live-skeptic provider failure and never throws it past the runner", async () => {
    await fc.assert(
      fc.asyncProperty(arbPrompt(), arbValidPlan(), arbKeyLikeSecret(), async (prompt, plan, secret) => {
        const store = new InMemoryRectorStore();
        const args = await buildArgs(store, `${prompt} ${embedSecret(secret, "prompt")}`);

        // The planner succeeds, then the live skeptic's provider throws a
        // transport error whose message embeds the secret (Bearer form) on every
        // attempt. The runner must resolve to a redacted PROVIDER_ERROR blocker
        // and terminate FAILED without leaking the secret — and without throwing.
        const skepticError = new SpyLLMProvider({
          estimate: DEFAULT_SPY_USAGE,
          responses: [
            { error: new ProviderError({ code: "PROVIDER_HTTP_ERROR", provider: "spy", status: 500, message: embedSecret(secret, "failure-message") }) },
          ],
          onOverflow: "repeat-last",
        });

        const router = taskSpyRouter({
          planner: scriptedSpy(planToJson(leakPlanGoal(plan, secret))),
          skeptic: skepticError,
          synthesizer: scriptedSpy(synthesisDraftToJson({ response: "fallback", citations: [] })),
          repair: scriptedSpy(planToJson(plan)),
        });

        let result: Awaited<ReturnType<typeof runChat>> | undefined;
        try {
          result = await runChat(store, args, {
            mode: "external",
            router,
            budget: generousBudget(),
            workspaceRoot: process.cwd(),
            fsImpl: createWorkspaceFs({ root: process.cwd(), files: {}, dirs: {} }),
          });
        } catch (error) {
          // The runner is contracted never to throw on a live-step failure; if it
          // ever does, the thrown message must still be secret-free (Req 7.6).
          expect(String((error as Error)?.message ?? error)).not.toContain(secret);
          throw error;
        }

        await assertExternalRunIsSecretFree(store, result, result.run.id, secret);
      }),
      { numRuns: 25 },
    );
  });
});
