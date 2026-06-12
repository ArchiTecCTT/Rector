# Rector Productization Alpha — Opus 4.8 Agent Prompts

Use these prompts with Kiro / Opus 4.8 after the BYOK Alpha implementation. These are for making Rector usable as a hassle-free desktop/web product, not for rebuilding the completed symbolic/BYOK core.

## Global Context for Every Prompt

Rector is a configured-product BYOK neuro-symbolic AI coding/orchestration agent (v0.3.0+).

Current state:

- Product model: **unconfigured** (mandatory onboarding) → **configured** (live orchestration).
- Source of truth: `.rector/runtime-settings.json` written by the UI.
- Single orchestration path: `runOrchestratedChatRun` — no fake chat as product.
- Live BYOK orchestration: planner, skeptic, synthesizer, safe workspace executor, validation/healing, persistence, SSE streaming, cost dashboard, cumulative budget enforcement.
- CI uses `SpyLLMProvider` test doubles only — not a user-facing provider-free path.
- `ORCHESTRATOR_MODE` env is deprecated (migration/advanced override only).
- Runtime requirement: Node.js `>=22.5.0`.
- Canonical architecture: `docs/architecture/configured-product-architecture.md`.
- BYOK handoff: `docs/implementation/byok-alpha-handoff.md`.
- Do not restore deleted stale local-MVP/cloud-heavy docs.
- No real provider/network calls in tests; use `SpyLLMProvider` and injectable doubles.

Verification gates after each issue:

```bash
npm test
npm run build
npm run check
node scripts/generate-roadmap-issues.js --check
node scripts/export-linear-issues.js --check
```

---

## Prompt 1 — Productization 01: Setup Wizard UI

```text
You are implementing Rector Productization Alpha 01: Setup Wizard UI.

Goal: make first-run Rector setup understandable from the browser UI instead of requiring users to read docs and edit `.env` manually.

Read first:
- docs/architecture/configured-product-architecture.md
- docs/getting-started/first-run-setup.md
- docs/implementation/byok-alpha-handoff.md
- src/public/index.html
- src/public/app.js
- src/public/styles.css
- src/api/server.ts
- src/setupChecklist.ts
- src/deployment/index.ts

Scope:
- Add a setup wizard surface to the existing local web UI.
- It should explain and display the current mode: `local` vs `external`.
- It should show required/optional config categories: provider, persistence, workspace, budget.
- It should not require real secrets in tests.
- It should not store secrets in browser localStorage unless explicitly designed and redacted.
- It may initially be read-only/status-oriented if server-side env mutation is not safe yet.

Implementation guidance:
1. Add API support if needed to expose safe setup status.
   - Redact all sensitive values.
   - Avoid returning raw env values.
2. Add UI wizard entry point.
   - Suggested locations: sidebar button or initial empty-state panel.
3. Add sections:
   - Mode: local/external
   - Provider readiness
   - Persistence readiness
   - Workspace safety
   - Budget/cost guardrails
4. Keep the current chat UX intact.
5. Add tests for API response redaction and any UI-adjacent pure helpers.

Acceptance criteria:
- Users can see whether Rector is running local or external mode.
- Users can understand what is missing before BYOK mode works.
- No secret values are exposed in API or UI.
- Existing chat and trace UI still work.
- All verification gates pass.

When done:
- Comment on the matching Linear issue with summary, files changed, and verification output.
```

---

## Prompt 2 — Productization 02: Provider Key Test UI

```text
You are implementing Rector Productization Alpha 02: Provider Key Test UI.

Goal: let users validate BYOK provider credentials from the UI using the existing provider connection-test API.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/api/server.ts
- src/providers/llm.ts
- src/public/app.js
- src/public/index.html
- src/public/styles.css
- tests/connectionVerification.test.ts

Scope:
- Add UI controls for selecting provider and running a connection test.
- Reuse existing `/api/setup/test-connection` behavior.
- Show success/failure in human language.
- Never echo secrets.
- Do not add real provider calls to tests.

Implementation guidance:
1. Identify current request/response shape of connection-test endpoint.
2. Add a provider test panel in setup wizard.
3. Show:
   - provider id
   - model/route if available
   - success/failure
   - redacted error details
4. Add loading/error states.
5. Add tests for response rendering helpers or endpoint integration if needed.

Acceptance criteria:
- Invalid/missing provider config produces a useful redacted message.
- Successful mocked provider test displays readiness.
- Browser UI never displays raw API key material.
- All verification gates pass.
```

---

## Prompt 3 — Productization 03: Workspace Picker and Safety Panel

```text
You are implementing Rector Productization Alpha 03: Workspace Picker and Safety Panel.

Goal: make workspace safety visible before Rector executes or proposes real workspace actions.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/sandbox/index.ts
- src/orchestration/sandboxExecutor.ts
- src/api/server.ts
- src/public/app.js
- src/public/index.html
- src/public/styles.css
- tests/workspaceSandbox.test.ts
- tests/sandboxExecutor.test.ts

Scope:
- Add a UI surface showing configured workspace root and safety policy.
- If browser cannot choose folders directly in current architecture, expose current configured root and document desktop-native folder picker as future work.
- Do not loosen sandbox constraints.
- Do not allow arbitrary command execution from UI.

Implementation guidance:
1. Add safe workspace status API if missing.
2. Show:
   - current workspace root, redacted/normalized if needed
   - allowlisted commands
   - destructive command protection status
   - approval-required policy
3. Add explanatory copy for users.
4. Add tests for redacted workspace status and command policy display helpers.

Acceptance criteria:
- User can see what workspace Rector is allowed to touch.
- User can see that destructive commands are blocked.
- No absolute sensitive paths leak if redaction policy says to hide them.
- Existing sandbox tests still pass.
- All verification gates pass.
```

---

## Prompt 4 — Productization 04: Real Task Benchmark Harness

```text
You are implementing Rector Productization Alpha 04: Real Task Benchmark Harness.

Goal: create a repeatable benchmark suite that proves Rector can perform useful coding tasks, not just pass unit tests around mocked agents.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/orchestration/chatRunner.ts
- src/orchestration/sandboxExecutor.ts
- src/sandbox/index.ts
- tests/byokExternalE2E.test.ts
- tests/chatRunner.test.ts

Scope:
- Build a benchmark harness using fixture repositories or fixture workspaces.
- It must run without real provider calls by default, using deterministic test doubles.
- It should be designed so live provider benchmarking can be enabled manually later.
- It must capture result, patch, commands, cost estimate, duration, and final status.

Implementation guidance:
1. Create fixture workspace(s) under an appropriate test fixture path.
2. Define 5-10 representative coding tasks.
3. Add a runner script or test helper that executes Rector external mode against those fixtures using a scripted provider.
4. Output structured benchmark results as JSON or Markdown.
5. Do not mutate real repo files; use temp dirs.

Acceptance criteria:
- Harness runs provider-free in CI.
- Each task produces structured result data.
- Failed tasks preserve artifacts/logs.
- Harness can later be pointed at real providers manually.
- All verification gates pass.
```

---

## Prompt 5 — Productization 05: Prompt Hardening from Benchmark Failures

```text
You are implementing Rector Productization Alpha 05: Prompt Hardening from Benchmark Failures.

Goal: improve live planner/skeptic/repair/synthesizer prompts using evidence from the benchmark harness.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/orchestration/prompts.ts
- src/orchestration/planner.ts
- src/orchestration/skeptic.ts
- src/orchestration/validationHealing.ts
- src/orchestration/synthesizer.ts
- benchmark harness from Productization 04

Scope:
- Use benchmark failures to tighten prompts and schema repair behavior.
- Do not reduce safety constraints to make benchmarks pass.
- Prefer explicit instructions and better schema examples over broad hacks.
- Preserve local mode.

Implementation guidance:
1. Review benchmark failure artifacts.
2. Identify recurring failure modes:
   - malformed JSON
   - unsafe plan
   - missing validation
   - poor patch target
   - weak final answer
3. Update prompts and tests.
4. Add regression cases for each fixed failure mode.

Acceptance criteria:
- Benchmark pass rate improves or failure quality improves.
- Prompts remain schema-focused and injection-resistant.
- No new secret leakage.
- All verification gates pass.
```

---

## Prompt 6 — Productization 06: Desktop Shell Spike

```text
You are implementing Rector Productization Alpha 06: Desktop Shell Spike.

Goal: determine whether Rector should use Tauri or Electron for the first desktop app shell, and produce a minimal working prototype path.

Read first:
- docs/architecture/current-rector-byok-architecture.md section on desktop/web/mobile target architecture
- src/bin/server.ts
- src/api/server.ts
- src/public/*
- package.json

Scope:
- This is a spike, not the final desktop app.
- Compare Tauri vs Electron for Rector's needs.
- Prefer Tauri if it can cleanly launch/manage the local Node server or embed the web UI without painful complexity.
- Do not break the existing web app.

Implementation guidance:
1. Write a short decision doc under `docs/architecture/` or `docs/implementation/`.
2. Include:
   - packaging complexity
   - local server lifecycle
   - native folder picker
   - secure secret storage
   - auto-update path
   - Windows/macOS/Linux concerns
3. If feasible, add a minimal scaffold/prototype behind an isolated folder or script.
4. Do not add heavy dependencies without documenting why.

Acceptance criteria:
- Clear recommendation: Tauri or Electron.
- Prototype path or explicit reason prototype was deferred.
- Existing Node/web app remains unchanged.
- All verification gates pass.
```

---

## Prompt 7 — Productization 07: Local Secret Storage

```text
You are implementing Rector Productization Alpha 07: Local Secret Storage.

Goal: stop relying on manual `.env` editing for desktop users by designing and/or implementing a local secret storage abstraction.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/deployment/index.ts
- src/setupChecklist.ts
- src/security/redaction.ts
- src/api/server.ts

Scope:
- Create an abstraction for provider secret storage.
- It may be an interface + local dev implementation first.
- Future desktop shell should be able to back it with OS keychain.
- Never persist secrets in plain JSON by default.
- Do not expose secrets through API/UI.

Implementation guidance:
1. Define `SecretStore` interface.
2. Decide safe local dev behavior:
   - environment-only lookup, or
   - encrypted/keychain-backed if desktop dependency exists.
3. Add setup API shape for checking whether a secret exists without returning it.
4. Add redaction tests.

Acceptance criteria:
- Code can ask whether a provider secret is configured without reading raw value into UI.
- No secret values returned by API.
- Future Tauri/Electron keychain integration is clear.
- All verification gates pass.
```

---

## Prompt 8 — Productization 08: TiDB Cloud Smoke Test Path

```text
You are implementing Rector Productization Alpha 08: TiDB Cloud Smoke Test Path.

Goal: validate the optional TiDB Cloud persistence path enough that hosted/server alpha is credible.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/store/tidbRectorStore.ts
- src/store/sqlRectorStore.ts
- src/store/index.ts
- src/deployment/index.ts
- tests/persistentStore*.ts

Scope:
- Do not require TiDB credentials in CI.
- Add a manual smoke test script or documented command path for TiDB Cloud.
- Keep SQLite as local default.
- Ensure config errors are redacted and clear.

Implementation guidance:
1. Add a manual script or docs section for TiDB smoke test.
2. Validate required env vars are documented.
3. Add test coverage for missing/incomplete TiDB config.
4. If adding a script, ensure it exits safely and redacts credentials.

Acceptance criteria:
- Maintainer can test TiDB Cloud with documented env vars.
- CI still runs without TiDB credentials.
- Missing TiDB config fails before network attempt.
- All verification gates pass.
```

---

## Prompt 9 — Productization 09: Run Approval UX

```text
You are implementing Rector Productization Alpha 09: Run Approval UX.

Goal: let users approve or deny risky operations from the UI instead of runs getting stuck or requiring developer-level inspection.

Read first:
- docs/architecture/current-rector-byok-architecture.md
- src/orchestration/runStateMachine.ts
- src/orchestration/chatRunner.ts
- src/sandbox/index.ts
- src/orchestration/sandboxExecutor.ts
- src/api/server.ts
- src/public/app.js

Scope:
- Build UI/API flow for operations that return `NEEDS_APPROVAL` or runs in `NEEDS_DECISION`.
- Do not auto-approve risky shell commands.
- Show clear diff/command/target path before approval.
- Record approval decision in event log.

Implementation guidance:
1. Identify current approval/decision data structures.
2. Add endpoint(s) for approve/deny if missing.
3. Add UI panel in trace drawer or setup/run panel.
4. Ensure denied operation leads to safe final answer.
5. Add tests around state transition and redaction.

Acceptance criteria:
- User can approve/deny a pending file write or command from UI.
- Approval decision is persisted as an event.
- Risky operation details are clear and redacted.
- Denial does not crash the run.
- All verification gates pass.
```

---

## Prompt 10 — Productization 10: Mobile Companion Design

```text
You are implementing Rector Productization Alpha 10: Mobile Companion Design.

Goal: design mobile support as a companion/control surface, not as a direct code executor.

Read first:
- docs/architecture/current-rector-byok-architecture.md section on desktop/web/mobile target architecture
- current API routes in src/api/server.ts
- current SSE/cost/approval architecture

Scope:
- Design only unless explicitly asked to prototype.
- Mobile v1 should:
  - send instructions
  - monitor run status
  - approve/deny risky operations
  - receive completion notifications
  - read final summaries
- Mobile must not directly execute local workspace code.
- Mobile should talk to desktop app or hosted relay.

Implementation guidance:
1. Write a design doc under `docs/architecture/` or `docs/implementation/`.
2. Include diagrams for:
   - phone → relay → desktop agent
   - auth/session model
   - approval flow
   - notification flow
3. Identify backend APIs needed.
4. Identify security risks:
   - stolen phone
   - relay compromise
   - prompt injection over mobile
   - approval spoofing

Acceptance criteria:
- Clear mobile companion architecture.
- Clear non-goals.
- Security risks documented.
- No implementation churn unless approved.
- All verification gates pass if files/code changed.
```
