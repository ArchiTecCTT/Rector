import http from "node:http";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/api/server";
import {
  InMemoryRateLimiter,
  classifyRateLimitRoute,
  createRateLimitPolicy,
  createUnavailableDistributedRateLimiter,
} from "../src/security/rateLimiter";
import { TaskManager } from "../src/thalamus/router";

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

async function postConversation(base: string, title: string): Promise<Response> {
  return fetch(`${base}/api/chat/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

describe("rate limiter hardening", () => {
  it("classifies API routes into specific and general buckets", () => {
    expect(classifyRateLimitRoute("POST", "/api/chat/conversations")).toBe("chat");
    expect(classifyRateLimitRoute("GET", "/api/chat/conversations")).toBe("general");
    expect(classifyRateLimitRoute("GET", "/api/auth/session")).toBe("auth-login");
    expect(classifyRateLimitRoute("POST", "/api/setup/test-connection")).toBe("provider-test-connection");
    expect(classifyRateLimitRoute("POST", "/api/memory-providers/mem0/test-connection")).toBe("memory-provider-test");
    expect(classifyRateLimitRoute("GET", "/api/setup")).toBe("general");
    expect(classifyRateLimitRoute("GET", "/api/rbac/permissions")).toBe("general");
    expect(classifyRateLimitRoute("GET", "/index.html")).toBeUndefined();
  });

  it("keeps deterministic, independent buckets per identity and route", () => {
    const policy = createRateLimitPolicy({
      windowMs: 1_000,
      maxRequests: 1,
      providerTestConnection: { maxRequests: 1 },
    });
    const limiter = new InMemoryRateLimiter(policy);
    const now = 1_000;

    expect(limiter.commit("user:alice", "chat", now).allowed).toBe(true);
    expect(limiter.check("user:alice", "chat", now + 1).allowed).toBe(false);

    // Different route bucket for the same user is independent.
    expect(limiter.commit("user:alice", "provider-test-connection", now + 2).allowed).toBe(true);
    // Different identity bucket for the same route is independent.
    expect(limiter.commit("user:bob", "chat", now + 3).allowed).toBe(true);

    // Clock injection controls reset deterministically.
    expect(limiter.check("user:alice", "chat", now + 999).allowed).toBe(false);
    expect(limiter.check("user:alice", "chat", now + 1_000).allowed).toBe(true);
  });

  it("rate-limits general API routes independently from chat POST routes", async () => {
    const app = createApp(new TaskManager(), {
      rateLimit: {
        windowMs: 60_000,
        maxRequests: 1,
        general: { maxRequests: 1 },
      },
    });

    await withServer(app, async (base) => {
      const firstSetup = await fetch(`${base}/api/setup`);
      const secondSetup = await fetch(`${base}/api/setup`);
      const chat = await postConversation(base, "still-allowed");

      expect(firstSetup.status).not.toBe(429);
      expect(secondSetup.status).toBe(429);
      expect(await secondSetup.json()).toEqual({ error: "Too many requests" });
      expect(chat.status).toBe(201);
    });
  });

  it("emits standard rate-limit headers and preserves the legacy chat 429 body", async () => {
    const app = createApp(new TaskManager(), {
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
    });

    await withServer(app, async (base) => {
      const first = await postConversation(base, "one");
      const second = await postConversation(base, "two");

      expect(first.status).toBe(201);
      expect(first.headers.get("x-ratelimit-limit")).toBe("1");
      expect(first.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(first.headers.get("x-ratelimit-reset")).toMatch(/^\d+$/);

      expect(second.status).toBe(429);
      expect(second.headers.get("x-ratelimit-limit")).toBe("1");
      expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(await second.json()).toEqual({ error: "Too many chat requests" });
    });
  });

  it("fails closed when the limiter backend is unavailable and failClosed is enabled", async () => {
    const app = createApp(new TaskManager(), {
      rateLimit: { failClosed: true },
      rateLimiter: createUnavailableDistributedRateLimiter("token=SHOULD_NOT_LEAK"),
    });

    await withServer(app, async (base) => {
      const response = await postConversation(base, "blocked");
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toBe("Rate limiter unavailable");
      expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
      expect(JSON.stringify(body)).toContain("[REDACTED]");
    });
  });

  it("can fail open only when explicitly configured", async () => {
    const app = createApp(new TaskManager(), {
      rateLimit: { failClosed: false },
      rateLimiter: createUnavailableDistributedRateLimiter("backend unavailable"),
    });

    await withServer(app, async (base) => {
      const response = await postConversation(base, "allowed");
      expect(response.status).toBe(201);
    });
  });
});
