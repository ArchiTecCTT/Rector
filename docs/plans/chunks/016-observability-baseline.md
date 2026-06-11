# Chunk 16 — Observability Baseline

## Goal

Add a fast, in-memory observability layer for the local provider-free chat brainstem. Every run should expose a stable trace ID, phase latency spans, zero provider/model-call/cost accounting, and adapter shapes for future telemetry sinks without making network calls.

## Scope

- Add observability schemas/types and an in-memory trace recorder.
- Record spans for chat brainstem phases and attach span/summary data to run event payloads and final chat response payloads.
- Keep provider-free defaults explicit: provider `local`, model calls `0`, estimated cost `$0`.
- Add no-op adapter stubs for Sentry/PostHog/OpenTelemetry-style LLM spans.
- Cover the behavior with unit/API tests.
- Update concerns register with alpha limitations.

## Non-goals

- No real Sentry/PostHog/OpenTelemetry SDK dependency.
- No outbound telemetry/network calls.
- No durable tracing store.
- No provider-backed token/cost metering yet.

## Implementation Plan

1. Write tests for trace stability, nonnegative duration, zero provider cost/calls, no-op adapter behavior, error span capture, and response/event observability exposure.
2. Implement `src/observability` with zod schemas, tracer/session helpers, summary calculation, and no-op adapters.
3. Wire the chat API brainstem to create one trace, record phase spans, and include observability data in phase events and final response payload.
4. Update synthesis typing/response to carry an observability summary.
5. Run `npm test` and `npm run build`.
