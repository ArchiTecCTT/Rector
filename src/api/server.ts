import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TaskManager } from "../thalamus/router";
import { getSetupChecklist } from "../setupChecklist";
import { STATES } from "../domain/states";
import { buildContextPack, createContextMaterial } from "../orchestration/contextBuilder";
import type { ExecutorSimulatorOptions } from "../orchestration/executorSimulator";
import { runChat } from "../orchestration/chatRunner";
import { triageUserMessage } from "../orchestration/triage";
import { createInMemoryObservabilityTrace } from "../observability";
import { redactSecrets, redactString } from "../security/redaction";
import {
  AzureOpenAIProvider,
  CloudflareWorkersAIProvider,
  PerplexityResearchProvider,
  ProviderError,
  TogetherAIProvider,
  type LLMProvider,
  type LLMRequest,
  type ModelRouter,
} from "../providers/llm";
import type { OrchestratorMode } from "../deployment";
import { InMemoryRectorStore } from "../store/inMemoryRectorStore";
import type { Artifact, Run, RunEvent } from "../store/schemas";

export interface ApiSecurityOptions {
  corsAllowedOrigins?: string[];
  rateLimit?: {
    windowMs?: number;
    maxRequests?: number;
  };
  /**
   * Orchestration wiring for the chat pipeline. `executorOptions`/`maxHealingAttempts` tune the
   * deterministic phases shared by both modes. `mode` and `router` are resolved once at startup
   * (`parseOrchestrationConfig` + `buildModelRouter`) and stored here so the chat runner can
   * dispatch by mode; `mode` defaults to `local` (provider-free) and `router` is optional because
   * local mode requires no provider. The chat endpoint is wired to consume `mode`/`router` in a
   * later task; this option is accepted and stored without rewiring the endpoint.
   */
  orchestration?: {
    executorOptions?: ExecutorSimulatorOptions;
    maxHealingAttempts?: number;
    mode?: OrchestratorMode;
    router?: ModelRouter;
  };
}

// --- Provider connection-test service (ORN-32) ---

/**
 * Supported provider identifiers the connection test can build and ping. Any value outside this
 * set is rejected as CONFIG_INVALID before any provider is constructed or any network call occurs.
 */
export const SUPPORTED_PROVIDER_IDS = ["together", "cloudflare", "azure-openai", "perplexity"] as const;

/** Type guard for the supported provider id set, used to reject unsupported ids with a 400. */
function isSupportedProviderId(providerId: string): boolean {
  return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export const TestConnectionRequestSchema = z.object({
  providerId: z.string().min(1), // "together" | "cloudflare" | "azure-openai" | "perplexity"
});
export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>;

export const TestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  providerId: z.string().min(1),
  model: z.string().optional(), // present only on success
  code: z.string().optional(), // ProviderErrorCode on failure
  error: z.string().optional(), // redacted message on failure
  networkAttempted: z.boolean(), // false when config invalid blocks before any call
});
export type TestConnectionResponse = z.infer<typeof TestConnectionResponseSchema>;

/**
 * Builds exactly one provider instance for the requested id, wired with the injected `fetchImpl`
 * and `enableNetwork`. Reads only the env key names the provider needs; never logs values. Returns
 * `undefined` for an unsupported/unknown provider id so the caller can short-circuit safely.
 */
function resolveConnectionTestProvider(
  providerId: string,
  env: Record<string, string | undefined>,
  options: { enableNetwork: boolean; fetchImpl: typeof fetch }
): LLMProvider | undefined {
  const { enableNetwork, fetchImpl } = options;
  switch (providerId) {
    case "together":
      return new TogetherAIProvider({
        apiKey: env.TOGETHER_API_KEY,
        baseUrl: env.TOGETHER_BASE_URL,
        enableNetwork,
        fetchImpl,
      });
    case "cloudflare":
      return new CloudflareWorkersAIProvider({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        baseUrl: env.CLOUDFLARE_BASE_URL,
        enableNetwork,
        fetchImpl,
      });
    case "azure-openai":
      return new AzureOpenAIProvider({
        apiKey: env.AZURE_OPENAI_API_KEY,
        endpoint: env.AZURE_OPENAI_ENDPOINT,
        apiVersion: env.AZURE_OPENAI_API_VERSION,
        deployments: {
          cheap: env.AZURE_OPENAI_CHEAP_DEPLOYMENT,
          fast: env.AZURE_OPENAI_FAST_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          flagship: env.AZURE_OPENAI_FLAGSHIP_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
          research: env.AZURE_OPENAI_RESEARCH_DEPLOYMENT,
        },
        enableNetwork,
        fetchImpl,
      });
    case "perplexity":
      return new PerplexityResearchProvider({
        apiKey: env.PERPLEXITY_API_KEY,
        baseUrl: env.PERPLEXITY_BASE_URL,
        enableNetwork,
        fetchImpl,
      });
    default:
      return undefined;
  }
}

/**
 * Verifies a single provider's credentials with at most one minimal network ping.
 *
 * Pure and unit-testable via an injected `fetchImpl`. Guarantees:
 * - Unknown/unsupported `providerId` => `CONFIG_INVALID`, `networkAttempted: false`, zero calls.
 * - `validateConfig()` runs first; on failure => `CONFIG_INVALID`, `networkAttempted: false`.
 * - Otherwise a single `invoke()` ping (small `maxOutputTokens`) is attempted.
 * - Every outbound error message is passed through `redactString`; the response never includes the
 *   API key, Authorization header, or the raw provider body.
 */
export async function runConnectionTest(input: {
  providerId: string;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}): Promise<TestConnectionResponse> {
  const { providerId, env, fetchImpl } = input;

  const provider = resolveConnectionTestProvider(providerId, env, { enableNetwork: true, fetchImpl });
  if (!provider) {
    return TestConnectionResponseSchema.parse({
      ok: false,
      providerId,
      code: "CONFIG_INVALID",
      error: redactString(`Unsupported providerId: ${providerId}`),
      networkAttempted: false,
    });
  }

  // Config validation short-circuits BEFORE any network call is attempted.
  try {
    provider.validateConfig();
  } catch (error) {
    return TestConnectionResponseSchema.parse({
      ok: false,
      providerId,
      code: error instanceof ProviderError ? error.code : "CONFIG_INVALID",
      error: redactString(connectionTestErrorMessage(error)),
      networkAttempted: false,
    });
  }

  const pingRequest: LLMRequest = {
    messages: [
      { role: "system", content: "ping" },
      { role: "user", content: "reply with: pong" },
    ],
    maxOutputTokens: 8,
    task: "connection-test",
  };

  try {
    const response = await provider.invoke(pingRequest);
    return TestConnectionResponseSchema.parse({
      ok: true,
      providerId,
      model: response.model,
      networkAttempted: true,
    });
  } catch (error) {
    return TestConnectionResponseSchema.parse({
      ok: false,
      providerId,
      code: error instanceof ProviderError ? error.code : "PROVIDER_ERROR",
      error: redactString(connectionTestErrorMessage(error)),
      networkAttempted: true,
    });
  }
}

function connectionTestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Builds a concise, redaction-ready message from a Zod (or other) request-body parse failure. */
function requestValidationMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const summary = error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return `Invalid request body: ${summary}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createApp(manager: TaskManager, securityOptions: ApiSecurityOptions = {}): express.Application {
  const app = express();
  const rectorStore = new InMemoryRectorStore();
  app.use(securityHeadersMiddleware);
  app.use(corsMiddleware(securityOptions));
  app.use(chatRateLimitMiddleware(securityOptions));
  app.use(express.json());
  const publicDir = resolvePublicDir();
  app.use(express.static(publicDir));

  // --- Chat routes ---

  app.post("/api/chat/conversations", async (req, res) => {
    try {
      const { title, workspaceId, retentionPolicy } = req.body ?? {};
      if (title !== undefined && typeof title !== "string") {
        return res.status(400).json({ error: "title must be a string" });
      }
      if (workspaceId !== undefined && typeof workspaceId !== "string") {
        return res.status(400).json({ error: "workspaceId must be a string" });
      }
      if (retentionPolicy !== undefined && typeof retentionPolicy !== "string") {
        return res.status(400).json({ error: "retentionPolicy must be a string" });
      }

      const conversation = await rectorStore.createConversation({
        title: nonEmptyOrDefault(title, "New conversation"),
        workspaceId: nonEmptyOrDefault(workspaceId, "local"),
        retentionPolicy: nonEmptyOrDefault(retentionPolicy, "session"),
      });
      res.status(201).json(conversation);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/chat/conversations", async (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
      const conversations = await rectorStore.listConversations(workspaceId);
      res.json({ conversations });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chat/conversations/:id", async (req, res) => {
    try {
      const conversation = await rectorStore.getConversation(req.params.id);
      if (!conversation) return res.status(404).json({ error: "Conversation not found" });
      const messages = await rectorStore.listMessages(conversation.id);
      res.json({ conversation, messages });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/chat/conversations/:id/messages", async (req, res) => {
    try {
      const conversation = await rectorStore.getConversation(req.params.id);
      if (!conversation) return res.status(404).json({ error: "Conversation not found" });

      const { content } = req.body ?? {};
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content (string) is required" });
      }

      const redactedContent = redactString(content);
      const redactionState = redactedContent === content ? "none" : "redacted";
      const userMessage = await rectorStore.createMessage({
        conversationId: conversation.id,
        role: "user",
        content: redactedContent,
        status: "created",
        redactionState,
      });
      const observability = createInMemoryObservabilityTrace({ provider: "local" });
      const triage = await observability.recordSpan("TRIAGE", () => triageUserMessage(redactedContent));
      const contextPack = await observability.recordSpan("CONTEXT_BUILDING", async () => {
        const contextMaterial = await createContextMaterial(rectorStore, {
          kind: "chat-user-message",
          content: redactedContent,
          summary: "Latest user message content",
          retentionPolicy: conversation.retentionPolicy,
          piiState: redactionState,
        });
        return buildContextPack(rectorStore, {
          conversation,
          messages: await rectorStore.listMessages(conversation.id),
          userMessage,
          triage,
          materials: [contextMaterial],
        });
      });
      const orchestration = securityOptions.orchestration;
      const { run, synthesis, observabilitySummary } = await runChat(
        rectorStore,
        {
          conversationId: conversation.id,
          userMessageId: userMessage.id,
          prompt: redactedContent,
          triage,
          contextPack,
          observability,
          options: orchestration,
        },
        {
          // Default to local (provider-free) when no orchestration option is configured so existing
          // behavior and tests are unchanged. enableNetwork is only meaningful in external mode.
          mode: orchestration?.mode ?? "local",
          router: orchestration?.router,
          enableNetwork: orchestration?.mode === "external",
        }
      );
      const assistantMessage = await rectorStore.createMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: synthesis.response,
        status: "completed",
        runId: run.id,
        redactionState,
      });
      await rectorStore.updateMessage(userMessage.id, { status: "completed", runId: run.id });
      const events = await rectorStore.listEvents(run.id);
      const completedRun = await rectorStore.getRun(run.id);

      res.status(201).json({
        userMessage: { ...userMessage, status: "completed", runId: run.id },
        assistantMessage,
        run: completedRun ?? run,
        events,
        observability: observabilitySummary,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/runs/:id/events", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      const events = await rectorStore.listEvents(run.id);
      res.json({ run, events });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Local-only operator routes for optional Retool console ---

  app.get("/api/operator/runs", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      res.json(operatorEnvelope({ runs: runs.map(summarizeOperatorRun) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/runs/:id", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });

      const conversation = await rectorStore.getConversation(run.conversationId);
      const messages = await rectorStore.listMessages(run.conversationId);
      const events = await rectorStore.listEvents(run.id);
      const artifactHandles = collectArtifactHandles(events);

      res.json(
        operatorEnvelope({
          run,
          conversation,
          userMessage: messages.find((message) => message.id === run.userMessageId),
          assistantMessages: messages.filter((message) => message.role === "assistant" && message.runId === run.id),
          events,
          artifactHandles,
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/failures", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      const events = await rectorStore.listEvents();
      const failures = runs
        .filter(isOperatorFailureRun)
        .map((run) => ({
          ...summarizeOperatorRun(run),
          lastError: run.lastError,
          failureEvents: events.filter((event) => event.runId === run.id && isFailureEvent(event)),
        }));

      res.json(operatorEnvelope({ failures }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/operator/approvals", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      const approvals = runs
        .filter((run) => run.phase === "NEEDS_DECISION" || run.decisionRequest !== undefined)
        .map((run) => ({
          ...summarizeOperatorRun(run),
          decisionRequest: run.decisionRequest ?? {},
        }));

      res.json(operatorEnvelope({ approvals }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/approvals/:runId/decision", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: "Run not found" });
      const { decision, note } = req.body ?? {};
      if (decision === undefined) {
        return res.status(400).json({ error: "decision is required" });
      }

      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          mutated: false,
          run: summarizeOperatorRun(run),
          decision: redactSecrets({ decision, note }),
          message: "Decision captured as a local-only placeholder; approval resume is not implemented in Chunk 21.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/operator/costs", async (_req, res) => {
    try {
      const runs = await rectorStore.listRuns();
      res.json(operatorEnvelope({ summary: summarizeOperatorCosts(runs), runs: runs.map(summarizeOperatorRun) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/runs/:id/retry", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          action: "retry",
          mutated: false,
          run: summarizeOperatorRun(run),
          message: "Retry control is a local-only placeholder until real executor resume semantics exist.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/operator/runs/:id/abort", async (req, res) => {
    try {
      const run = await rectorStore.getRun(req.params.id);
      if (!run) return res.status(404).json({ error: "Run not found" });
      res.status(202).json(
        operatorEnvelope({
          status: "placeholder",
          action: "abort",
          mutated: false,
          run: summarizeOperatorRun(run),
          message: "Abort control is a local-only placeholder until cancellable execution exists.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/operator/artifacts/:id", async (req, res) => {
    try {
      const artifact = await rectorStore.getArtifact(req.params.id);
      if (!artifact) return res.status(404).json({ error: "Artifact not found" });
      res.json(operatorEnvelope({ artifact: artifactMetadataOnly(artifact) }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/operator/linear/issues", async (req, res) => {
    try {
      const { runId, title, description } = req.body ?? {};
      if (runId !== undefined && typeof runId !== "string") {
        return res.status(400).json({ error: "runId must be a string when provided" });
      }
      if (!title || typeof title !== "string") {
        return res.status(400).json({ error: "title (string) is required" });
      }
      if (description !== undefined && typeof description !== "string") {
        return res.status(400).json({ error: "description must be a string when provided" });
      }
      if (runId) {
        const run = await rectorStore.getRun(runId);
        if (!run) return res.status(404).json({ error: "Run not found" });
      }

      res.status(202).json(
        operatorEnvelope({
          status: "stubbed",
          networkCalls: 0,
          issue: {
            key: `LOCAL-LINEAR-${stableStubIssueNumber(runId ?? title)}`,
            title: title.trim(),
            description: description?.trim() ?? "",
            runId,
            url: null,
          },
          message: "Linear issue creation is stubbed locally; no network request was made.",
        })
      );
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Task routes ---

  app.post("/api/tasks", (req, res) => {
    try {
      const { description } = req.body ?? {};
      if (!description || typeof description !== "string") {
        return res.status(400).json({ error: "description (string) is required" });
      }
      const task = manager.createTask(description);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/tasks", async (_req, res) => {
    try {
      const tasks = await manager.listTasks();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/tasks/:id", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Control routes ---

  app.post("/api/tasks/:id/retry", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      if (task.state !== STATES.PAUSED) {
        return res.status(400).json({ error: `Cannot retry from ${task.state}` });
      }
      const updated = await manager.transition(req.params.id, STATES.INTAKE);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/pause", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      const updated = await manager.transition(req.params.id, STATES.PAUSED);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/approve", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      if (task.state !== STATES.HUMAN_HANDOFF) {
        return res.status(400).json({ error: `Cannot approve from ${task.state}` });
      }
      const approved = await manager.approve(req.params.id);
      res.json(approved);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/tasks/:id/abort", async (req, res) => {
    try {
      const task = await manager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Not found" });
      const updated = await manager.transition(req.params.id, STATES.ABORTED);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Advance pipeline one step ---

  app.post("/api/tasks/:id/advance", async (req, res) => {
    try {
      const task = await manager.advance(req.params.id);
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Telemetry ---

  app.get("/api/telemetry", (_req, res) => {
    res.json(manager.telemetry.getMetrics());
  });

  // --- Setup checklist ---

  app.get("/api/setup", (_req, res) => {
    res.json(getSetupChecklist());
  });

  // --- Provider connection test (ORN-32) ---

  app.post("/api/setup/test-connection", async (req, res) => {
    let request: TestConnectionRequest;
    try {
      request = TestConnectionRequestSchema.parse(req.body ?? {});
    } catch (err: unknown) {
      return res.status(400).json({ error: redactString(requestValidationMessage(err)) });
    }

    // An unsupported providerId is rejected with a 400 before any provider is built or any network
    // call is attempted (Requirement 2.4). The body keeps the safe TestConnectionResponse shape.
    if (!isSupportedProviderId(request.providerId)) {
      return res.status(400).json(
        TestConnectionResponseSchema.parse({
          ok: false,
          providerId: request.providerId,
          code: "CONFIG_INVALID",
          error: redactString(`Unsupported providerId: ${request.providerId}`),
          networkAttempted: false,
        })
      );
    }

    try {
      const result = await runConnectionTest({
        providerId: request.providerId,
        env: process.env,
        fetchImpl: fetch,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: redactString(err?.message ?? String(err)) });
    }
  });

  // --- Scenario seeding ---

  app.post("/api/dev/scenario", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const { type } = req.body ?? {};
      if (type === "happy") {
        const t = manager.createTask("Build a REST API for task management");
        res.status(201).json(t);
      } else if (type === "healing") {
        const t = manager.createTask("Refactor the broken retry logic to work correctly");
        res.status(201).json(t);
      } else {
        return res.status(400).json({ error: "type must be 'happy' or 'healing'" });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- SPA fallback ---
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}

function resolvePublicDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../public"),
    path.resolve(moduleDir, "../../src/public"),
    path.resolve(process.cwd(), "src/public"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? candidates[0];
}

function securityHeadersMiddleware(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

function corsMiddleware(options: ApiSecurityOptions): express.RequestHandler {
  const configuredOrigins = new Set([
    ...(options.corsAllowedOrigins ?? []),
    ...parseCsvEnv(process.env.CORS_ALLOWED_ORIGINS),
  ]);

  return (req, res, next) => {
    const origin = req.header("Origin");
    if (origin && (configuredOrigins.has(origin) || isDevLocalhostOrigin(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Max-Age", "600");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function chatRateLimitMiddleware(options: ApiSecurityOptions): express.RequestHandler {
  const windowMs = options.rateLimit?.windowMs ?? numberFromEnv("CHAT_RATE_LIMIT_WINDOW_MS", 60_000);
  const maxRequests = options.rateLimit?.maxRequests ?? numberFromEnv("CHAT_RATE_LIMIT_MAX", 60);
  const buckets = new Map<string, { resetAt: number; count: number }>();

  return (req, res, next) => {
    if (req.method !== "POST" || !req.path.startsWith("/api/chat/")) {
      next();
      return;
    }
    if (maxRequests <= 0) {
      next();
      return;
    }

    const now = Date.now();

    // Clean up expired buckets opportunistically to prevent memory growth
    for (const [k, b] of buckets.entries()) {
      if (b.resetAt <= now) {
        buckets.delete(k);
      }
    }

    const key = req.ip || req.socket.remoteAddress || "unknown";
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { resetAt: now + windowMs, count: 1 });
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - 1)));
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: "Too many chat requests" });
      return;
    }

    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - bucket.count)));
    next();
  };
}

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isDevLocalhostOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function numberFromEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function nonEmptyOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

type OperatorEnvelopePayload = Record<string, unknown>;

type OperatorArtifactHandle = {
  artifactId: string;
  kind?: string;
  uri?: string;
  summary?: string;
  hash?: string;
  sizeBytes?: number;
  piiState?: string;
  retentionPolicy?: string;
};

function operatorEnvelope(payload: OperatorEnvelopePayload): OperatorEnvelopePayload {
  return {
    localOnly: true,
    auth: "local-only-no-auth",
    surface: "retool-operator-console-api",
    ...payload,
  };
}

function summarizeOperatorRun(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    conversationId: run.conversationId,
    userMessageId: run.userMessageId,
    status: run.status,
    phase: run.phase,
    route: run.route,
    complexity: run.complexity,
    traceId: run.traceId,
    attempts: run.attempts,
    healingAttempts: run.healingAttempts,
    validationAttempts: run.validationAttempts,
    lastError: run.lastError,
    dagId: run.dagId,
    estimatedUsd: numericField(run.costEstimate, "usd"),
    actualUsd: numericField(run.actualCost, "usd"),
    estimatedInputTokens: numericField(run.tokenEstimate, "input"),
    estimatedOutputTokens: numericField(run.tokenEstimate, "output"),
    actualInputTokens: numericField(run.actualTokens, "input"),
    actualOutputTokens: numericField(run.actualTokens, "output"),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function summarizeOperatorCosts(runs: Run[]): Record<string, unknown> {
  return runs.reduce(
    (summary, run) => ({
      runCount: summary.runCount + 1,
      estimatedUsd: summary.estimatedUsd + numericField(run.costEstimate, "usd"),
      actualUsd: summary.actualUsd + numericField(run.actualCost, "usd"),
      estimatedInputTokens: summary.estimatedInputTokens + numericField(run.tokenEstimate, "input"),
      estimatedOutputTokens: summary.estimatedOutputTokens + numericField(run.tokenEstimate, "output"),
      actualInputTokens: summary.actualInputTokens + numericField(run.actualTokens, "input"),
      actualOutputTokens: summary.actualOutputTokens + numericField(run.actualTokens, "output"),
      modelCalls: summary.modelCalls + numericField(run.actualCost, "modelCalls"),
    }),
    {
      runCount: 0,
      estimatedUsd: 0,
      actualUsd: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      modelCalls: 0,
    }
  );
}

function isOperatorFailureRun(run: Run): boolean {
  return run.status === "failed" || run.status === "aborted" || run.status === "needs_decision" || run.lastError !== undefined;
}

function isFailureEvent(event: RunEvent): boolean {
  return event.type === "RUN_FAILED" || event.type === "RUN_ABORTED" || event.type === "DECISION_REQUESTED";
}

function collectArtifactHandles(events: RunEvent[]): OperatorArtifactHandle[] {
  const handles = new Map<string, OperatorArtifactHandle>();
  for (const event of events) {
    collectArtifactHandlesFromValue(event.payload, handles);
  }
  return Array.from(handles.values());
}

function collectArtifactHandlesFromValue(value: unknown, handles: Map<string, OperatorArtifactHandle>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactHandlesFromValue(item, handles);
    return;
  }

  if (!isRecord(value)) return;

  if (typeof value.artifactId === "string") {
    handles.set(value.artifactId, {
      artifactId: value.artifactId,
      kind: stringField(value, "kind"),
      uri: stringField(value, "uri"),
      summary: stringField(value, "summary"),
      hash: stringField(value, "hash"),
      sizeBytes: numberField(value, "sizeBytes"),
      piiState: stringField(value, "piiState"),
      retentionPolicy: stringField(value, "retentionPolicy"),
    });
  }

  for (const nested of Object.values(value)) {
    collectArtifactHandlesFromValue(nested, handles);
  }
}

function artifactMetadataOnly(artifact: Artifact): Artifact {
  const { content: _content, ...metadata } = artifact.metadata;
  return {
    ...artifact,
    metadata,
  };
}

function stableStubIssueNumber(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return String(Number.parseInt(hash.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

function numericField(value: Record<string, unknown> | undefined, key: string): number {
  if (value === undefined) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
