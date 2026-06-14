import express, { type Application, type Response } from "express";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOperatorRoutes } from "../src/api/routes/operator";
import { registerRunControlRoutes } from "../src/api/routes/runControl";
import { clearRunControl, getRunControlState } from "../src/orchestration/runControl";
import { InMemoryRectorStore, type Budget, type CreateRunInput } from "../src/store";

const budget: Budget = {
  maxUsd: 1,
  maxInputTokens: 10_000,
  maxOutputTokens: 5_000,
  maxModelCalls: 8,
  maxRuntimeMs: 60_000,
  maxHealingAttempts: 2,
  allowedProviders: [],
  approvalRequiredAboveUsd: 0,
};

const touchedRunIds = new Set<string>();

afterEach(() => {
  for (const runId of touchedRunIds) clearRunControl(runId);
  touchedRunIds.clear();
});

describe("run control API", () => {
  it("interrupts an active run and returns 202", async () => {
    const store = new InMemoryRectorStore();
    const run = await store.createRun(makeRunInput({ phase: "EXECUTING" }));
    touchedRunIds.add(run.id);
    const server = await startServer(registerRunControlApp(store));

    try {
      const response = await server.api(`/api/runs/${run.id}/interrupt`, {
        method: "POST",
        body: JSON.stringify({ reason: "stop now" }),
      });

      expect(response.status).toBe(202);
      expect(response.data).toMatchObject({ runId: run.id, status: "aborting", mutated: true });
      expect(getRunControlState(run.id)?.abortController.signal.aborted).toBe(true);
      expect((await store.listEvents(run.id)).map((event) => event.type)).toContain("RUN_INTERRUPT_REQUESTED");
    } finally {
      await server.close();
    }
  });

  it("returns 404 for an unknown run interrupt", async () => {
    const server = await startServer(registerRunControlApp(new InMemoryRectorStore()));

    try {
      const response = await server.api("/api/runs/missing-run/interrupt", { method: "POST" });

      expect(response.status).toBe(404);
      expect(response.data).toEqual({ error: "Run not found" });
    } finally {
      await server.close();
    }
  });

  it("rejects empty steer messages with 400", async () => {
    const server = await startServer(registerRunControlApp(new InMemoryRectorStore()));

    try {
      const response = await server.api("/api/runs/any-run/steer", {
        method: "POST",
        body: JSON.stringify({ message: "   " }),
      });

      expect(response.status).toBe(400);
      expect(response.data).toEqual({ error: "message (string) is required" });
    } finally {
      await server.close();
    }
  });

  it("steers an active run without aborting it", async () => {
    const store = new InMemoryRectorStore();
    const run = await store.createRun(makeRunInput({ phase: "EXECUTING" }));
    touchedRunIds.add(run.id);
    const server = await startServer(registerRunControlApp(store));

    try {
      const response = await server.api(`/api/runs/${run.id}/steer`, {
        method: "POST",
        body: JSON.stringify({ message: "prefer the shortest validation command" }),
      });

      expect(response.status).toBe(202);
      expect(response.data).toEqual({ runId: run.id, queued: true });
      const state = getRunControlState(run.id);
      expect(state?.interruptRequested).toBe(false);
      expect(state?.abortController.signal.aborted).toBe(false);
      expect((await store.listEvents(run.id)).map((event) => event.type)).toContain("RUN_STEER_ENQUEUED");
    } finally {
      await server.close();
    }
  });

  it("operator abort delegates to shared interruptRun for active runs", async () => {
    const store = new InMemoryRectorStore();
    const run = await store.createRun(makeRunInput({ phase: "EXECUTING" }));
    touchedRunIds.add(run.id);
    const authorize = vi.fn(async () => ({ workspaceId: "ws-run-control" }));
    const server = await startServer((app) => {
      app.use(express.json());
      registerOperatorRoutes(app, { store, authorize });
    });

    try {
      const response = await server.api(`/api/operator/runs/${run.id}/abort`, { method: "POST" });

      expect(response.status).toBe(202);
      expect(response.data).toMatchObject({ action: "abort", status: "aborting", mutated: true });
      expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.anything(), "operator.manage", {
        targetType: "operator",
      });
      expect((await store.listEvents(run.id)).map((event) => event.type)).toContain("RUN_INTERRUPT_REQUESTED");
    } finally {
      await server.close();
    }
  });

  it("operator abort requires operator.manage permission", async () => {
    const store = new InMemoryRectorStore();
    const authorize = vi.fn(async (_req, res: Response, permission: string) => {
      res.status(403).json({ permission });
      return false;
    });
    const server = await startServer((app) => {
      app.use(express.json());
      registerOperatorRoutes(app, { store, authorize: authorize as never });
    });

    try {
      const response = await server.api("/api/operator/runs/run-denied/abort", { method: "POST" });

      expect(response.status).toBe(403);
      expect(response.data).toEqual({ permission: "operator.manage" });
    } finally {
      await server.close();
    }
  });
});

function registerRunControlApp(store: InMemoryRectorStore): (app: Application) => void {
  return (app) => {
    app.use(express.json());
    registerRunControlRoutes(app, {
      store,
      workspaceIdForRun: async () => "ws-run-control",
      authorize: async (_req, _res, _permission, options) => ({
        workspaceId: options.workspaceId ?? "ws-run-control",
      }),
      sendRedacted: (res, status, payload) => {
        res.status(status).json(payload);
      },
    });
  };
}

async function startServer(register: (app: Application) => void): Promise<{
  api(path: string, opts?: RequestInit): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}> {
  const app = express();
  register(app);
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://localhost:${port}`;
  return {
    async api(path, opts) {
      const res = await fetch(`${base}${path}`, {
        headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
        ...opts,
      });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : {} };
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function makeRunInput(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId: "conv-run-control-api",
    userMessageId: "msg-run-control-api",
    status: "running",
    phase: "CHAT_RECEIVED",
    route: "CODE_EDIT",
    complexity: "medium",
    budget,
    costEstimate: { usd: 0, modelCalls: 0 },
    tokenEstimate: { input: 0, output: 0 },
    traceId: "trace-run-control-api",
    attempts: 0,
    healingAttempts: 0,
    validationAttempts: 0,
    ...overrides,
  };
}
