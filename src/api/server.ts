import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { TaskManager } from "../thalamus/router";
import { getSetupChecklist } from "../setupChecklist";
import { STATES } from "../domain/states";
import { transitionRun } from "../orchestration/runStateMachine";
import { InMemoryRectorStore } from "../store/inMemoryRectorStore";
import type { Run, RunEvent } from "../store/schemas";

export function createApp(manager: TaskManager): express.Application {
  const app = express();
  const rectorStore = new InMemoryRectorStore();
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json());
  const publicDir = path.resolve(process.cwd(), "src/public");
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

      const userMessage = await rectorStore.createMessage({
        conversationId: conversation.id,
        role: "user",
        content,
        status: "created",
        redactionState: "none",
      });
      const run = await createFakeChatRun(rectorStore, conversation.id, userMessage.id, content);
      const assistantMessage = await rectorStore.createMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: `Rector received: ${content}. This shell created a local run trace without provider calls.`,
        status: "completed",
        runId: run.id,
        redactionState: "none",
      });
      await rectorStore.updateMessage(userMessage.id, { status: "completed", runId: run.id });
      const events = await rectorStore.listEvents(run.id);
      const completedRun = await rectorStore.getRun(run.id);

      res.status(201).json({
        userMessage: { ...userMessage, status: "completed", runId: run.id },
        assistantMessage,
        run: completedRun ?? run,
        events,
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

function nonEmptyOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

async function createFakeChatRun(
  store: InMemoryRectorStore,
  conversationId: string,
  userMessageId: string,
  prompt: string
): Promise<Run> {
  const traceId = `trace-${crypto.randomUUID()}`;
  const run = await store.createRun({
    conversationId,
    userMessageId,
    status: "running",
    phase: "CHAT_RECEIVED",
    route: "fake-orchestrator",
    complexity: "shell",
    budget: {
      maxUsd: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxModelCalls: 0,
      maxRuntimeMs: 1000,
      maxHealingAttempts: 0,
      allowedProviders: [],
      approvalRequiredAboveUsd: 0,
    },
    costEstimate: { usd: 0 },
    actualCost: { usd: 0 },
    tokenEstimate: { input: 0, output: 0 },
    actualTokens: { input: 0, output: 0 },
    traceId,
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
  });

  await store.appendEvent(runEvent(run, "RUN_CREATED", "CHAT_RECEIVED", {
    source: "chat-api",
    promptPreview: prompt.slice(0, 120),
  }));

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
  ] as const;

  let current = run;
  for (const phase of phases) {
    const result = await transitionRun(store, current.id, phase, {
      traceId,
      payload: {
        source: "fake-orchestrator",
        note: phase === "DONE" ? "Shell run completed" : "Shell run advanced",
      },
    });
    current = result.run;
  }

  return current;
}

function runEvent(
  run: Run,
  type: RunEvent["type"],
  phase: RunEvent["phase"],
  payload: Record<string, unknown>
): RunEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    runId: run.id,
    type,
    phase,
    payload,
    traceId: run.traceId,
    createdAt: new Date().toISOString(),
  };
}
