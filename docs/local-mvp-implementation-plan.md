> [!WARNING]
> STALE / QUARANTINED DOC: This document is preserved for historical research only.
> Do not use it as the active implementation plan for Rector 0.1.0.
> Current source of truth: `docs/architecture/rector-0.1.0-architecture.md` and `docs/plans/rector-master-roadmap.md`.

# Rector Local MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for production behavior. Implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Rector MVP with localhost UI, deterministic state machine, local workers, adapter boundaries, tests, and setup checklist.

**Architecture:** Single TypeScript/Express app. In-memory adapters emulate Kafka/Mongo/providers. Thalamus router owns all state transitions. Vanilla frontend polls API and displays task state.

**Tech Stack:** Node.js, TypeScript, Express, Zod, Vitest, Supertest, Vite-free static frontend.

---

## Files

- Create `package.json`: scripts and dependencies.
- Create `tsconfig.json`: TypeScript config.
- Create `vitest.config.ts`: Vitest config.
- Create `src/domain/states.ts`: states, topics, constants.
- Create `src/domain/schemas.ts`: Zod schemas and exported types.
- Create `src/domain/transitions.ts`: deterministic transition helpers.
- Create `src/adapters/eventBus.ts`: local event bus.
- Create `src/adapters/taskRepository.ts`: local task repository.
- Create `src/adapters/providers.ts`: provider interfaces and local provider implementations.
- Create `src/workers/workers.ts`: intake, flagship, SLM, sandbox, healing, synthesis worker registration.
- Create `src/thalamus/router.ts`: TaskManager and transition orchestration.
- Create `src/api/server.ts`: Express app factory and REST routes.
- Create `src/index.ts`: executable server entrypoint.
- Create `src/public/index.html`: localhost UI.
- Create `src/public/styles.css`: UI styles.
- Create `src/public/app.js`: UI client logic.
- Create `src/setupChecklist.ts`: provider setup checklist for user.
- Create tests in `tests/*.test.ts`.
- Create `.env.example`: future provider variables.
- Create `README.md`: run/test/setup instructions.

---

## Task 1: Project scaffold and state schemas

- [ ] Write failing tests for state schemas and transitions in `tests/state.test.ts`.
- [ ] Run `npm test -- tests/state.test.ts` and confirm failures due missing modules.
- [ ] Create package/config files.
- [ ] Implement `states.ts`, `schemas.ts`, `transitions.ts`.
- [ ] Run state tests until green.

## Task 2: Local event bus and repository

- [ ] Write failing tests in `tests/adapters.test.ts` covering publish/subscribe, stored task copy safety, update semantics.
- [ ] Run adapter tests and confirm missing modules fail.
- [ ] Implement `eventBus.ts` and `taskRepository.ts`.
- [ ] Run adapter tests until green.

## Task 3: Local provider adapters and setup checklist

- [ ] Write failing tests in `tests/providers.test.ts` covering deterministic planning, SLM success/failure generation, validation failure payload, telemetry cost events, setup checklist keys.
- [ ] Implement `providers.ts` and `setupChecklist.ts`.
- [ ] Run provider tests until green.

## Task 4: Thalamus router and workers

- [ ] Write failing tests in `tests/pipeline.test.ts` for happy path and healing loop path.
- [ ] Implement `workers.ts` and `router.ts`.
- [ ] Ensure create task starts at `1_INTAKE` and eventually reaches `7_HUMAN_HANDOFF`.
- [ ] Ensure failing scenario enters `5_HEALING_LOOP`, applies one fix, validates again, and completes.
- [ ] Run pipeline tests until green.

## Task 5: HTTP API

- [ ] Write failing tests in `tests/api.test.ts` for create/list/get/retry/pause/approve/abort/setup/telemetry/static UI.
- [ ] Implement `server.ts` and `index.ts`.
- [ ] Run API tests until green.

## Task 6: Browser UI

- [ ] Create localhost UI files.
- [ ] UI must create tasks, show columns, show selected task details, show telemetry, show setup checklist, and call manual controls.
- [ ] Add DOM smoke test or API static serving test that verifies `/` returns the UI shell.
- [ ] Run tests.

## Task 7: Documentation and verification

- [ ] Create `.env.example` with all future provider variables.
- [ ] Create `README.md` with quickstart: `npm install`, `npm test`, `npm run dev`, open `http://localhost:3000`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Optionally start server and smoke `GET /api/setup` using Node fetch.
- [ ] Report changed files, commands, test results, and setup checklist.

## Acceptance Criteria

- `npm test` passes.
- `npm run build` passes.
- `npm run dev` serves UI on `http://localhost:3000`.
- Creating a normal task reaches `7_HUMAN_HANDOFF`.
- Creating a task containing `fail` or `retry` demonstrates healing loop before completion.
- UI shows tasks, subtasks, event history, telemetry, and setup checklist.
- README lists all real-provider connection values needed later.
