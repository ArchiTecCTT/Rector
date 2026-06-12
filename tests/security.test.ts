import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createApp } from "../src/api/server";
import { enforceMaxPerRunBudget, evaluateBudget, evaluateSandboxRuntimeSafety } from "../src/security/budget";
import { redactSecrets, redactString } from "../src/security/redaction";
import { TaskManager } from "../src/thalamus/router";
import type { Budget, Run } from "../src/store";

const budget: Budget = {
  maxUsd: 1,
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  maxModelCalls: 2,
  maxRuntimeMs: 10_000,
  maxHealingAttempts: 1,
  allowedProviders: ["local"],
  approvalRequiredAboveUsd: 0.5,
};

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    conversationId: "conv-1",
    userMessageId: "msg-1",
    status: "running",
    phase: "TRIAGE",
    route: "local",
    complexity: "simple",
    budget,
    costEstimate: { usd: 0.1 },
    tokenEstimate: { input: 100, output: 100 },
    traceId: "trace-1",
    attempts: 1,
    healingAttempts: 0,
    validationAttempts: 0,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

async function withServer(app = createApp(new TaskManager()), fn: (base: string) => Promise<void>) {
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3000;
    await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("budget enforcement", () => {
  it("allows provider-free local behavior within zero spend", () => {
    const decision = evaluateBudget(
      run({
        budget: { ...budget, maxUsd: 0, maxInputTokens: 0, maxOutputTokens: 0, maxModelCalls: 0, allowedProviders: [] },
        costEstimate: { usd: 0 },
        tokenEstimate: { input: 0, output: 0 },
      }),
      { provider: undefined, modelCalls: 0, runtimeMs: 50, healingAttempts: 0 }
    );

    expect(decision.status).toBe("allowed");
    expect(decision.reasons).toEqual([]);
  });

  it("denies hard budget limit violations", () => {
    const decision = evaluateBudget(run(), {
      provider: "openai",
      estimatedUsd: 2,
      inputTokens: 1_001,
      outputTokens: 100,
      modelCalls: 3,
      runtimeMs: 20_000,
      healingAttempts: 2,
    });

    expect(decision.status).toBe("denied");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "estimated cost 2 exceeds maxUsd 1",
        "input tokens 1001 exceed maxInputTokens 1000",
        "model calls 3 exceed maxModelCalls 2",
        "runtime 20000ms exceeds maxRuntimeMs 10000ms",
        "healing attempts 2 exceed maxHealingAttempts 1",
        "provider openai is not allowed",
      ])
    );
  });

  it("requests a decision above the approval threshold but below max spend", () => {
    const decision = evaluateBudget(run({ costEstimate: { usd: 0.75 } }), { provider: "local" });

    expect(decision.status).toBe("NEEDS_DECISION");
    expect(decision.reasons).toEqual(["estimated cost 0.75 requires approval above 0.5"]);
  });

  it("denies maxOutputTokens violation in isolation", () => {
    const decision = evaluateBudget(run(), {
      outputTokens: 501, // budget.maxOutputTokens is 500
    });

    expect(decision.status).toBe("denied");
    expect(decision.reasons).toEqual([
      "output tokens 501 exceed maxOutputTokens 500",
    ]);
  });

  it("clamps negative cost/token counters so they cannot reduce accumulated budget usage", () => {
    const decision = evaluateBudget(
      run({ costEstimate: { usd: 0.4, modelCalls: 1, runtimeMs: 500 }, tokenEstimate: { input: 50, output: 60 } }),
      {
        estimatedUsd: -100,
        actualUsd: -100,
        inputTokens: -500,
        outputTokens: -500,
        modelCalls: -3,
        runtimeMs: -30_000,
        healingAttempts: -1,
      },
    );

    expect(decision.status).toBe("allowed");
    expect(decision.usage).toMatchObject({
      estimatedUsd: 0.4,
      actualUsd: 0,
      inputTokens: 50,
      outputTokens: 60,
      modelCalls: 1,
      runtimeMs: 500,
      healingAttempts: 0,
    });
  });

  it("ignores negative projected deltas in per-run budget enforcement and rejects negative sandbox runtime", () => {
    const perRun = enforceMaxPerRunBudget(
      run({ budget: { ...budget, maxUsd: 1, maxModelCalls: 2 } }),
      { estimatedUsd: 0.75, modelCalls: 1 },
      { estimatedUsd: -0.9, modelCalls: -1 },
    );
    expect(perRun.status).toBe("allowed");
    expect(perRun.usage.estimatedUsd).toBe(0.75);
    expect(perRun.usage.modelCalls).toBe(1);

    const sandbox = evaluateSandboxRuntimeSafety({ runtimeMs: -1, maxRuntimeMs: 1_000 });
    expect(sandbox.status).toBe("denied");
    expect(sandbox.reasons[0]).toContain("non-negative");
  });
});

describe("redaction", () => {
  it("redacts secret-looking object keys and credentialed URIs deterministically", () => {
    const redacted = redactSecrets({
      apiKey: "abc123",
      nested: { password: "p@ss", normal: "keep" },
      uri: "postgres://user:secret@localhost:5432/db",
      callbackUri: "https://example.test/path",
      list: [{ authorization: "Bearer secret-token" }],
    });

    expect(redacted).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", normal: "keep" },
      uri: "postgres://[REDACTED]@localhost:5432/db",
      callbackUri: "https://example.test/path",
      list: [{ authorization: "[REDACTED]" }],
    });
  });

  it("redacts credentialed URIs and authorization-like strings", () => {
    expect(redactString("connect mongodb://admin:s3cret@host/db using Bearer abc.def.ghi")).toBe(
      "connect mongodb://[REDACTED]@host/db using Bearer [REDACTED]"
    );
    expect(redactString("connect mongodb://admin@host/db")).toBe("connect mongodb://[REDACTED]@host/db");
  });

  it("redacts camelCase secret-looking keys", () => {
    const redacted = redactSecrets({
      githubToken: "ghp_abc123",
      dbPassword: "my_password",
      awsSecretAccessKey: "aws_key_123",
      sessionCookie: "cookie_val",
      regularValue: "keep",
    });

    expect(redacted).toEqual({
      githubToken: "[REDACTED]",
      dbPassword: "[REDACTED]",
      awsSecretAccessKey: "[REDACTED]",
      sessionCookie: "[REDACTED]",
      regularValue: "keep",
    });
  });
});

describe("API security middleware", () => {
  it("applies CORS headers for configured allowed origins and rejects other origins", async () => {
    const app = createApp(new TaskManager(), { corsAllowedOrigins: ["https://allowed.example"] });

    await withServer(app, async (base) => {
      const allowed = await fetch(`${base}/api/setup`, { headers: { Origin: "https://allowed.example" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed.example");

      const denied = await fetch(`${base}/api/setup`, { headers: { Origin: "https://blocked.example" } });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  it("allows localhost origins in development without explicit CORS config", async () => {
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await withServer(createApp(new TaskManager()), async (base) => {
        const res = await fetch(`${base}/api/setup`, { headers: { Origin: "http://localhost:5173" } });
        expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      });
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });

  it("rate-limits chat POST endpoints per client", async () => {
    const app = createApp(new TaskManager(), { rateLimit: { windowMs: 60_000, maxRequests: 1 } });

    await withServer(app, async (base) => {
      const first = await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "one" }),
      });
      const second = await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "two" }),
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(429);
      expect(await second.json()).toEqual({ error: "Too many chat requests" });
    });
  });

  it("allows requests and sweeps expired buckets after rate-limit window reset", async () => {
    const app = createApp(new TaskManager(), { rateLimit: { windowMs: 250, maxRequests: 1 } });

    await withServer(app, async (base) => {
      const first = await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "one" }),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "two" }),
      });
      expect(second.status).toBe(429);

      // Wait for window to expire with enough buffer for loaded CI workers.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const third = await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "three" }),
      });
      expect(third.status).toBe(201);
    });
  });

  it("redacts chat run event payloads while retaining local provider-free behavior", async () => {
    await withServer(createApp(new TaskManager()), async (base) => {
      const created = await fetch(`${base}/api/chat/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "redaction" }),
      }).then((r) => r.json() as Promise<any>);

      const sent = await fetch(`${base}/api/chat/conversations/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "use apiKey=abc123 and mongodb://root:pw@localhost/db" }),
      });
      const body = (await sent.json()) as any;

      expect(sent.status).toBe(201);
      expect(body.run.budget.maxUsd).toBe(0);
      expect(body.run.budget.allowedProviders).toEqual([]);
      expect(JSON.stringify(body.events)).not.toContain("abc123");
      expect(JSON.stringify(body.events)).not.toContain("root:pw");
      expect(body.events[0].payload.promptPreview).toContain("apiKey=[REDACTED]");
      expect(body.events[0].payload.promptPreview).toContain("mongodb://[REDACTED]@localhost/db");
    });
  });
});
