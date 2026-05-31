# Rector — Local-First MVP

Run Rector locally on `http://localhost:3000` with in-memory adapters for the event bus, task store, LLMs, sandbox, and telemetry.

## Quickstart

```bash
npm install
npm test
npm run build
npm run dev
```

Open `http://localhost:3000`.

## What the MVP Does

- Creates Rector tasks from the browser UI or REST API.
- Advances each task through a deterministic Thalamus state machine.
- Simulates intake, flagship planning, SLM fan-out, sandbox validation, healing, synthesis, and human handoff.
- Shows task cards, subtask detail, event history, telemetry, and provider setup checklist in the UI.
- Keeps real provider calls disabled; every provider is local/in-memory for now.

## Testing

- `npm test` — Vitest + API smoke tests.
- `npm run build` — TypeScript compile.

Covered: state transitions, schemas, event bus, repository immutability, local providers, happy path, healing path, unhealable abort path, API controls, setup masking, and static UI serving.

## State Flow

```text
1_INTAKE → 2_ARCHITECTURAL_PLAN → 3_SLM_EXECUTION_FANOUT → 4_SANDBOX_VALIDATION
  ↙ fail                                                        pass ↘
5_HEALING_LOOP → 4_SANDBOX_VALIDATION → 6_FINAL_SYNTHESIS → 7_HUMAN_HANDOFF
       ↘ unhealable failure → ABORTED
```

Tasks containing `fail`, `broken`, or `retry` intentionally trigger the healing loop. Tasks containing `unhealable` intentionally prove the abort path.

## REST API

- `POST /api/tasks` — create task: `{ "description": "Build a REST API" }`
- `GET /api/tasks` — list tasks
- `GET /api/tasks/:id` — get one task
- `POST /api/tasks/:id/advance` — advance one pipeline step
- `POST /api/tasks/:id/pause` — pause task
- `POST /api/tasks/:id/retry` — resume paused task from intake
- `POST /api/tasks/:id/approve` — persist approval at human handoff
- `POST /api/tasks/:id/abort` — abort non-terminal task
- `GET /api/telemetry` — local metrics
- `GET /api/setup` — masked setup checklist
- `POST /api/dev/scenario` — seed `happy` or `healing` demo task in local/dev mode

## Setup Checklist for Real Provider Mode

Copy `.env.example` and fill only the providers you want to activate. The current MVP reads these for display/masking only; real adapters can be wired behind the existing interfaces later.

### Core

| Variable | Purpose | Local default |
|---|---|---|
| `NODE_ENV` | `development` for local mode, `production` for provider mode | `development` |
| `PORT` | API/UI port | `3000` |
| `DOPPLER_TOKEN` | Secret loading in deployed environments | unset |

### Kafka / Confluent

| Variable | Purpose | Local default |
|---|---|---|
| `KAFKA_BROKERS` | Kafka bootstrap servers | `localhost:9092` |
| `KAFKA_CLIENT_ID` | Client ID for workers/router | `rector-local` |
| `KAFKA_USERNAME` | Confluent API key/SASL username | unset |
| `KAFKA_PASSWORD` | Confluent API secret/SASL password | unset |
| `KAFKA_SSL` | TLS for Confluent Cloud | `false` |

### MongoDB

| Variable | Purpose | Local default |
|---|---|---|
| `MONGO_URI` | MongoDB task-state storage | `mongodb://localhost:27017/rector` |
| `MONGO_DB` | Database name | `rector_core` |

### LLMs

| Variable | Purpose | Local default |
|---|---|---|
| `LLM_API_KEY` | Generic OpenAI-compatible key | unset |
| `LLM_BASE_URL` | Generic OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `FLAGSHIP_MODEL` | Architecture/final synthesis model | `gpt-4o` |
| `SLM_MODEL` | Cheap SLM fan-out model | `Qwen/Qwen2.5-Coder-7B-Instruct` |
| `TOGETHER_API_KEY` | Together AI key for SLM/APC | unset |
| `TOGETHER_BASE_URL` | Together endpoint | `https://api.together.xyz/v1` |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint | unset |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key | unset |
| `AZURE_OPENAI_DEPLOYMENT` | Azure deployment name | unset |
| `AWS_REGION` | Bedrock region | unset |
| `AWS_ACCESS_KEY_ID` | Bedrock IAM access key | unset |
| `AWS_SECRET_ACCESS_KEY` | Bedrock IAM secret | unset |

### Sandbox / Quality Gates

| Variable | Purpose | Local default |
|---|---|---|
| `SANDBOX_RUNTIME` | `local` or `depot` | `local` |
| `DEPOT_API_KEY` | Depot sandbox key | unset |
| `SENTRY_DSN` | Error/healing telemetry | unset |
| `CODECOV_TOKEN` | Coverage reporting | unset |
| `CODESCENE_TOKEN` | Codescene quality gate | unset |

### Memory / Research

| Variable | Purpose | Local default |
|---|---|---|
| `CHROMA_URL` | Vector memory endpoint | `http://localhost:8000` |
| `CHROMA_API_KEY` | Hosted Chroma key | unset |
| `PERPLEXITY_API_KEY` | Docs/research distillation | unset |

### Linear / Make

| Variable | Purpose | Local default |
|---|---|---|
| `LINEAR_API_KEY` | Linear GraphQL API | unset |
| `LINEAR_WEBHOOK_SECRET` | Verify Linear webhooks | unset |
| `MAKE_WEBHOOK_URL` | Human approval automations | unset |

### Telemetry

| Variable | Purpose | Local default |
|---|---|---|
| `TELEMETRY_BACKEND` | `local`, `posthog`, `datadog`, or `newrelic` | `local` |
| `POSTHOG_API_KEY` | Cost/token analytics | unset |
| `POSTHOG_HOST` | PostHog ingest host | `https://app.posthog.com` |
| `DATADOG_API_KEY` | APM/infrastructure metrics | unset |
| `DATADOG_SITE` | DataDog site | `datadoghq.com` |
| `NEW_RELIC_LICENSE_KEY` | New Relic fallback APM | unset |
| `AMPLITUDE_API_KEY` | Frontend product analytics | unset |
