import { describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import { createApp } from "../src/api/server";
import {
  createInMemoryObservabilityTrace,
  createNoopObservabilityAdapters,
  ObservabilitySpanSchema,
} from "../src/observability";
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

describe("observability baseline", () => {
  it("records nonnegative local spans and zero provider cost/model calls", async () => {
    const trace = createInMemoryObservabilityTrace({ traceId: "trace-test", provider: "local" });

    const value = await trace.recordSpan("TRIAGE", async () => "ok");
    const spans = trace.listSpans();
    const summary = trace.getSummary();

    expect(value).toBe("ok");
    expect(spans).toHaveLength(1);
    expect(ObservabilitySpanSchema.parse(spans[0])).toEqual(spans[0]);
    expect(spans[0].traceId).toBe("trace-test");
    expect(spans[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(spans[0].modelCallCount).toBe(0);
    expect(spans[0].estimatedCostUsd).toBe(0);
    expect(spans[0].provider).toBe("local");
    expect(summary.modelCallCount).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.status).toBe("OK");
  });

  it("records error spans on failure", async () => {
    const trace = createInMemoryObservabilityTrace({ traceId: "trace-failure" });

    await expect(
      trace.recordSpan("PLANNING", async () => {
        throw new Error("planner exploded");
      })
    ).rejects.toThrow("planner exploded");

    const [span] = trace.listSpans();
    const summary = trace.getSummary();
    expect(span.status).toBe("ERROR");
    expect(span.error).toContain("planner exploded");
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.status).toBe("ERROR");
  });

  it("exposes no-op Sentry/PostHog/OpenTelemetry adapter stubs without network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapters = createNoopObservabilityAdapters();
    const trace = createInMemoryObservabilityTrace({ traceId: "trace-adapters" });
    await trace.recordSpan("SYNTHESIZING", async () => undefined);
    const span = trace.listSpans()[0];
    const summary = trace.getSummary();

    await expect(adapters.sentry.captureSpan(span)).resolves.toBeUndefined();
    await expect(adapters.postHog.captureSpan(span)).resolves.toBeUndefined();
    await expect(adapters.openTelemetry.captureSpan(span)).resolves.toBeUndefined();
    await expect(adapters.sentry.captureSummary(summary)).resolves.toBeUndefined();
    await expect(adapters.postHog.captureSummary(summary)).resolves.toBeUndefined();
    await expect(adapters.openTelemetry.captureSummary(summary)).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps one traceId across chat events and exposes observability summary in final payloads", async () => {
    await withServer(createApp(new TaskManager()), async (base) => {
      const created = await api(base, "/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "Observability" }),
      });

      const sent = await api(base, `/api/chat/conversations/${(created.data as any).id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "Explain the Rector brainstem." }),
      });

      if (sent.status !== 201) {
        console.log("ERROR DATA:", sent.status, sent.data);
      }
      expect(sent.status).toBe(201);
      const body = sent.data as any;
      const traceId = body.run.traceId;
      expect(body.observability.traceId).toBe(traceId);
      expect(body.observability.modelCallCount).toBe(0);
      expect(body.observability.estimatedCostUsd).toBe(0);
      expect(body.observability.durationMs).toBeGreaterThanOrEqual(0);
      expect(body.observability.spans.length).toBeGreaterThanOrEqual(10);

      // The DIRECT_ANSWER reply is route-aware (ORN-57/58): the observability summary prose
      // ("Observed: ...", "provider cost: $0") no longer lives on the assistant message. It is
      // exposed on the dedicated observability payload (asserted above) and the synthesis event below.
      const assistantContent = body.assistantMessage.content as string;
      expect(assistantContent).not.toContain("Observed:");
      expect(assistantContent).not.toContain("provider cost: $0");
      expect(assistantContent).not.toContain("Status:");

      for (const event of body.events) {
        expect(event.traceId).toBe(traceId);
      }

      const phaseEvents = body.events.filter((event: any) => event.type === "PHASE_CHANGED" || event.type === "RUN_COMPLETED");
      for (const event of phaseEvents) {
        expect(event.payload.observability.traceId).toBe(traceId);
        expect(event.payload.observability.summary.traceId).toBe(traceId);
        expect(event.payload.observability.span.traceId).toBe(traceId);
        expect(event.payload.observability.span.durationMs).toBeGreaterThanOrEqual(0);
        expect(event.payload.observability.summary.modelCallCount).toBe(0);
        expect(event.payload.observability.summary.estimatedCostUsd).toBe(0);
      }

      const synthesis = phaseEvents.find((event: any) => event.phase === "SYNTHESIZING");
      expect(synthesis.payload.synthesis.observability.traceId).toBe(traceId);
      expect(synthesis.payload.synthesis.observability.modelCallCount).toBe(0);
    });
  });

  it("supports manual startSpan and endSpan API", async () => {
    const trace = createInMemoryObservabilityTrace({ traceId: "manual-trace" });

    const spanId = trace.startSpan("MANUAL_PHASE");
    expect(spanId).toBeTypeOf("string");
    expect(spanId.length).toBeGreaterThan(0);

    const span = trace.endSpan(spanId, "OK");
    expect(span.spanId).toBe(spanId);
    expect(span.phase).toBe("MANUAL_PHASE");
    expect(span.status).toBe("OK");

    // Double endSpan throws error
    expect(() => trace.endSpan(spanId)).toThrow("Unknown observability span");

    const spans = trace.listSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].spanId).toBe(spanId);
  });

  it("propagates parentSpanId correctly", async () => {
    const trace = createInMemoryObservabilityTrace({ traceId: "parent-trace" });

    const parentId = trace.startSpan("PARENT_PHASE");
    const childId = trace.startSpan("CHILD_PHASE", parentId);

    const childSpan = trace.endSpan(childId);
    const parentSpan = trace.endSpan(parentId);

    expect(childSpan.parentSpanId).toBe(parentId);
    expect(parentSpan.parentSpanId).toBeUndefined();

    const spans = trace.listSpans();
    expect(spans).toHaveLength(2);
    // Spans are added to the list in order of being ended
    expect(spans[0].spanId).toBe(childId);
    expect(spans[0].parentSpanId).toBe(parentId);
    expect(spans[1].spanId).toBe(parentId);
    expect(spans[1].parentSpanId).toBeUndefined();
  });

  it("supports injectable now/idFactory for deterministic tests", async () => {
    let timeMs = new Date("2026-06-03T12:00:00.000Z").getTime();
    const mockNow = () => {
      const d = new Date(timeMs);
      timeMs += 1234; // Deterministic clock tick
      return d;
    };

    let idCounter = 1;
    const mockIdFactory = () => `mock-span-${idCounter++}`;

    const trace = createInMemoryObservabilityTrace({
      traceId: "deterministic-trace",
      now: mockNow,
      idFactory: mockIdFactory,
    });

    const s1 = trace.startSpan("FIRST");
    expect(s1).toBe("mock-span-1");

    const span1 = trace.endSpan(s1, "OK");
    expect(span1.startedAt).toBe("2026-06-03T12:00:00.000Z");
    expect(span1.endedAt).toBe("2026-06-03T12:00:01.234Z");
    expect(span1.durationMs).toBe(1234);

    const s2 = trace.startSpan("SECOND");
    expect(s2).toBe("mock-span-2");

    const span2 = trace.endSpan(s2, "ERROR", new Error("test-err"));
    expect(span2.startedAt).toBe("2026-06-03T12:00:02.468Z");
    expect(span2.endedAt).toBe("2026-06-03T12:00:03.702Z");
    expect(span2.durationMs).toBe(1234);
    expect(span2.status).toBe("ERROR");
    expect(span2.error).toBe("test-err");
  });
});

