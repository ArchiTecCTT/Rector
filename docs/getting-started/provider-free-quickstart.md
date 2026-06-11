# Provider-Free Local Quickstart

Use this path for first-time development and documentation/testing work. It should not require paid model, sandbox, database, or telemetry credentials.

## Prerequisites

- Node.js 22.5.0 or newer
- npm 10 or newer

## Install

```bash
npm install
```

## Verify

```bash
npm test
npm run build
```

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000`.

## Environment files

A `.env` file is optional for provider-free work. If you need one, copy the example and keep credentials blank unless you are intentionally testing a live provider:

```bash
cp .env.example .env
```

Do not commit `.env` or secrets.

## Provider-free expectations

Contributions should keep this workflow working. Missing provider credentials should not break basic local development, tests, or TypeScript builds unless a test explicitly covers live provider setup and is opt-in.

When adding integration points, prefer adapters with safe local defaults, clear missing-credential behavior, and focused tests.
