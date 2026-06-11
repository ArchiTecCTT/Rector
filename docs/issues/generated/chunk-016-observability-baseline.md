# Chunk 16 — Observability Baseline

Add local trace IDs, latency, model-call counts, cost estimates, provider failure events, and no-op telemetry adapter shapes.

## Metadata

- chunk: 016
- labels: roadmap, chunk:016, observability, telemetry, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Runs expose trace IDs, span-like timing, model-call count, estimated cost, and structured provider failure events.
- [ ] Sentry, PostHog, and OpenTelemetry-style adapters are represented as no-op/local shapes.
- [ ] Tests verify redaction and no external telemetry calls in local mode.

## Test commands

- `npm test -- tests/observability.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:016, observability, telemetry, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
