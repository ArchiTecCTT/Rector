# Chunk 014 — Validation and Healing Loop

## Goal

Add deterministic local validation/healing after DAG execution. Keep alpha behavior provider-free, shell-free, filesystem-free, and bounded.

## Scope

- Add `src/orchestration/validationHealing.ts` with Zod schemas and TypeScript types.
- Classify executor node errors into validation failure classes.
- Retry only safe transient/timeout failures through the existing executor simulator.
- Never auto-heal permission or unsafe shell failures.
- Link dependency failures to the upstream/root failed node when possible.
- Add a `VALIDATING` chat event payload with the validation/healing result or skipped reason.
- Cover success, retry heal, timeout, permission, dependency root cause, max-attempt bound, and chat event integration with tests.

## Deterministic Design

`validateAndHealExecution` accepts a compiled DAG, an execution result, optional executor/options, and `maxHealingAttempts` (default `2`). It performs no provider, shell, or filesystem calls. If execution already succeeded, it returns `VALIDATED` with no actions. Otherwise it classifies node failures. If all actionable root failures are safe transient/timeout classes, it re-executes the whole DAG with adjusted simulator options that remove injected failures and reduce timed-out simulated durations to node timeout values. The loop stops on success, non-healable failures, repeated failures, or max attempts.

## Risks / Deferrals

- Whole-DAG re-execution is acceptable for the alpha simulator, but real execution will need node-level replay and artifact isolation.
- Timeout healing only adjusts simulator options; real timeout diagnosis remains future work.
- Permission failures require human/product policy decisions and are not auto-healed.
