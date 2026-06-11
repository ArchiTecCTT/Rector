# Chunk 26 — SLM Preprocessor + Structured Tool Calls (Neuro-Symbolic Step 1)

## Goal
Add the first neuro-symbolic efficiency layer: a cheap SLM preprocessor that runs *before* flagship models. It distills raw user prompts + bloated context into a clean `distilledContext` plus structured, validated `proposedToolCalls` (JSON). Flagship models (planner, skeptic, etc.) in external mode only ever see the distilled, structured form. This is the highest-leverage "small models first" improvement while preserving the symbolic control plane.

## Scope (Step 1 only)
- New module: `src/orchestration/preprocessor.ts`
- Minimal, safe wiring inside `runExternalChatRun` (right after `contextPack` is available, before the first live `runLivePlanner` call).
- Exact interfaces as specified in the neuro-symbolic feature prompt.
- Zod schema validation + deterministic post-JSON allowlist / safety rules on `proposedToolCalls`.
- Budget preflight + redaction respected for the SLM call.
- One fast-check property test proving arbitrary bloat always yields a valid `PreprocessorOutput` (no secret leakage, schema-valid, tools from allowlist or empty).
- Local / fake chat run path (`runFakeChatRun` + `createFakePlan`) remains **byte-for-byte unchanged** and requires zero providers.
- Update concerns-and-vulnerabilities.md with new risks (new cheap-model surface, JSON tool proposal trust boundary, distillation quality).
- Full `npm test` + `npm run build` gate.

## Non-goals (for this chunk)
- No changes to local-mode behavior or fake planner.
- No memory system, notes, time-awareness, ponder, proactive layer, symbolic engine, MCTS, decomposition, or concurrent execution.
- No UI changes.
- No new endpoints.
- The preprocessor is **not** required for the provider-free baseline; external/BYOK only for live distillation.
- No modification to `ContextPack` schema in this chunk (distilled data is passed alongside to planner for now).
- No production-grade SLM quality tuning or prompt iteration beyond making the contract work.

## Background / Rationale
The 0.1.0 architecture already states "Small models first" (Principle 5) and defers rich memory/learning to 0.4.x. The neuro-symbolic vision accelerates the "cheap SLM digests bloat → flagship sees clean structured meaning" pattern immediately in the external path. This matches the "LLM proposes; Rector decides" rule: the SLM proposes distilled context + tool calls; the existing symbolic pipeline (budget, redaction, skeptic, crucible, sandbox via `WorkspaceSandboxAdapter`) still validates and gates everything.

## Recommended Implementation Order (this chunk)
1. Add the `PreprocessorOutput` interface + Zod schema in a new `preprocessor.ts`.
2. Implement `runSLMPreprocessor`:
   - Build a compact prompt that includes (redacted) user prompt + triage + key contextPack elements.
   - Call via `invokeWithBudget` + a router-selected "cheap"/"slm" provider.
   - Force `responseFormat: { type: "json_object" }`.
   - Parse + `PreprocessorOutputSchema.safeParse`.
   - Run deterministic validation: tool names must be in the known safe allowlist (derived from `WorkspaceSandboxAdapter` supported operations + high-level names like read/write/run/search) or the proposal is dropped/filtered.
   - Redact any potential secrets in the output.
   - On any failure (budget, provider, parse, validation) produce a safe fallback `PreprocessorOutput` (original prompt as distilled, empty proposedToolCalls, entities/intent/constraints derived deterministically where possible).
3. Wire only in `runExternalChatRun`:
   - After contextPack and run creation, before planner.
   - Select cheap/SLM route from router.
   - Call preprocessor.
   - Record a span + provider call metadata (similar to direct-answer or planner).
   - Pass `distilledContext` (and validated `proposedToolCalls`) forward. For Step 1, minimally:
     - Augment the planner input (or create a lightweight wrapper) so the live planner prompt can benefit from `distilledContext`.
     - Log/attach the `proposedToolCalls` on the PLANNING event for observability (they are *proposals* only; downstream symbolic stages still decide).
4. Export from `src/orchestration/index.ts` (or the relevant barrel) if other modules need it later.
5. Add tests:
   - Basic happy-path unit test with a scripted cheap provider.
   - Property test (fast-check) using arbitraries similar to `tests/support/byokArbitraries.ts`: arbitrary rawPrompt + contextPack + triage → always produces schema-valid `PreprocessorOutput`, proposed tools are either empty or from the documented allowlist, no obvious secret substrings survive redaction.
6. Ensure byokExternalE2E / chatBrainstemE2E / localMode* property tests still pass unchanged.
7. Update `docs/plans/concerns-and-vulnerabilities.md`.
8. Run `npm test` then `npm run build`. Fix until both green.

## Exact Interfaces to Implement
```ts
export interface PreprocessorOutput {
  distilledContext: string;
  proposedToolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  entities: string[];
  intent: string;
  constraints: string[];
}

export async function runSLMPreprocessor(
  input: { rawPrompt: string; contextPack: ContextPack; triage: TriageResult },
  deps: { slmProvider: LLMProvider; run: Run }
): Promise<PreprocessorOutput>
```

The function must:
- Never throw for budget/provider/parse errors (return safe fallback, mirroring live planner/skeptic blocker discipline).
- Run budget preflight before the provider call.
- Use `redactSecrets` / `redactString` on material that leaves the boundary.
- Force JSON object response format.
- After parse, apply deterministic safety filter on `proposedToolCalls`.

## Tool Allowlist (initial)
Conservative starting set derived from `WorkspaceSandboxAdapter` capabilities + common high-level operations the system already supports conceptually:
- `read_file`, `write_file`, `run_command`, `list_dir`, `search_code`, `search_memory`, `propose_patch`

Any proposed tool not in the allowlist (or whose args fail basic shape checks) is dropped with a note. Downstream code (future steps or current skeptic/healing) remains the final arbiter.

## Acceptance Criteria
- New file `src/orchestration/preprocessor.ts` implements the exact interface and behaviors.
- In external mode, the preprocessor is invoked (using a cheap/SLM router selection) before the live planner; its `distilledContext` and `proposedToolCalls` are visible in the PLANNING phase payload / observability.
- Local mode (`ORCHESTRATOR_MODE=local`, `runFakeChatRun`, all local property tests) produces identical outputs and makes zero provider calls for preprocessing.
- At least one fast-check property test (modeled on livePlanner / synthesizer property tests) that for 100+ generated bloat inputs the preprocessor always returns a valid `PreprocessorOutput` (schema + basic safety).
- All existing tests pass (`npm test` reports the prior baseline or better; no regressions in local determinism, redaction, or budget properties).
- `npm run build` succeeds.
- `docs/plans/concerns-and-vulnerabilities.md` contains a new entry under Open for the preprocessor surface (new cheap LLM call site, reliance on SLM JSON quality, proposed-tool trust boundary that is still symbolically gated).
- A short note in the chunk plan or a follow-up comment explains the integration point in `chatRunner.ts`.

## Risks / Follow-ups (to be tracked in concerns)
- SLM JSON quality can be poor → safe fallback + later prompt hardening / few-shot in a future micro-chunk.
- `proposedToolCalls` are only proposals; they must never bypass `WorkspaceSandboxAdapter` policy, budget, or human approval. (Enforced by existing machinery.)
- Distilled context could drop critical details → the original `contextPack` and raw prompt remain available to skeptic/crucible/healing for cross-checks (do not throw away the original pack).
- Adds one more "cheap" model route usage; ensure router has a sensible cheap/slm fallback or the preprocessor falls back gracefully.

## Integration Note for Later Steps
This chunk deliberately keeps the change small and the contract stable so that:
- Step 2 (advanced memory) can inject richer episodic notes into the preprocessor input.
- Step 5 (MCTS) can use preprocessor-proposed paths as seeds.
- Step 7 (decomposition) can consume validated proposed high-level operations.

The symbolic control plane stays fully in charge.

## Verification Commands (run fresh before claiming done)
```bash
npm test
npm run build
```

## References
- Neuro-symbolic feature prompt (user-provided Step 1 spec)
- `src/orchestration/chatRunner.ts` (external run path)
- `src/orchestration/planner.ts` (Zod style, `invokeWithBudget` + budget preflight patterns, live planner blocker discipline)
- `tests/livePlanner.test.ts` + `tests/support/byokArbitraries.ts` (property test style)
- `src/security/budget.ts`, `src/security/redaction.ts`
- `src/sandbox/index.ts` (WorkspaceSandboxAdapter for allowlist derivation)
- `docs/architecture/rector-0.1.0-architecture.md` (Small models first principle)
- `docs/plans/concerns-and-vulnerabilities.md`
