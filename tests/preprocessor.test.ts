import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  PreprocessorOutputSchema,
  runSLMPreprocessor,
  runDeterministicPreprocessor,
  ALLOWED_PREPROCESSOR_TOOLS,
  type PreprocessorOutput,
} from "../src/orchestration/preprocessor";
import { SpyLLMProvider, makeContextPack, arbPrompt, DEFAULT_SPY_USAGE } from "./support/byokArbitraries";
import { triageUserMessage } from "../src/orchestration/triage";
import type { LLMRequest, LLMResponse, LLMUsage } from "../src/providers/llm";
import { makeExternalRun } from "./support/byokArbitraries";

/**
 * Tests for the SLM Preprocessor (Chunk 26 / neuro-symbolic Step 1).
 *
 * Goals:
 * - Exact interface contract is honored.
 * - JSON mode + Zod validation + deterministic allowlist filtering work.
 * - Budget denial / provider failure / bad JSON all produce safe fallbacks (never throw).
 * - Property: arbitrary bloat always yields a valid PreprocessorOutput with safe tool proposals.
 * - Deterministic (no-provider) path exists and is stable for local-mode readiness.
 */

function makeSpyThatReturns(json: unknown, usage: LLMUsage = DEFAULT_SPY_USAGE): SpyLLMProvider {
  const content = JSON.stringify(json);
  const provider = new SpyLLMProvider({
    estimate: usage,
    script: [
      {
        match: () => true,
        response: {
          id: "prep-1",
          model: "test-slm",
          content,
          usage,
          provider: "spy",
          finishReason: "stop",
        } as LLMResponse,
      },
    ],
  });
  return provider;
}

function makeMalformedSpy(): SpyLLMProvider {
  const provider = new SpyLLMProvider({
    estimate: DEFAULT_SPY_USAGE,
    script: [
      {
        match: () => true,
        response: {
          id: "prep-bad",
          model: "test-slm",
          content: "this is not valid json {{{",
          usage: DEFAULT_SPY_USAGE,
          provider: "spy",
          finishReason: "stop",
        } as LLMResponse,
      },
    ],
  });
  return provider;
}

describe("preprocessor contract and safety", () => {
  it("returns schema-valid output for a well-formed SLM JSON response", async () => {
    const provider = makeSpyThatReturns({
      distilledContext: "User wants to add pagination to the user list endpoint.",
      proposedToolCalls: [
        { tool: "read_file", args: { path: "src/api/users.ts" } },
        { tool: "write_file", args: { path: "src/api/users.ts" } },
      ],
      entities: ["pagination", "users", "endpoint"],
      intent: "Add pagination support",
      constraints: ["Keep existing tests green"],
    });

    const contextPack = makeContextPack("Add pagination");
    const triage = triageUserMessage("Add pagination to the user list and update tests.");
    const run = makeExternalRun();

    const result = await runSLMPreprocessor(
      { rawPrompt: "Add pagination to the user list and update tests.", contextPack, triage },
      { slmProvider: provider, run }
    );

    expect(() => PreprocessorOutputSchema.parse(result)).not.toThrow();
    expect(result.distilledContext).toContain("pagination");
    expect(result.proposedToolCalls.length).toBe(2);
    expect(result.entities).toContain("pagination");
    expect(result.intent).toBe("Add pagination support");
  });

  it("filters out tool proposals that are not on the allowlist", async () => {
    const provider = makeSpyThatReturns({
      distilledContext: "Do something dangerous",
      proposedToolCalls: [
        { tool: "read_file", args: {} },
        { tool: "rm", args: { path: "." } }, // not allowed
        { tool: "write_file", args: {} },
        { tool: "format_c_drive", args: {} }, // not allowed
      ],
      entities: [],
      intent: "rm -rf everything",
      constraints: [],
    });

    const contextPack = makeContextPack("danger");
    const triage = triageUserMessage("danger");
    const run = makeExternalRun();

    const result = await runSLMPreprocessor(
      { rawPrompt: "danger", contextPack, triage },
      { slmProvider: provider, run }
    );

    const tools = result.proposedToolCalls.map((t) => t.tool);
    expect(tools).toContain("read_file");
    expect(tools).toContain("write_file");
    expect(tools).not.toContain("rm");
    expect(tools).not.toContain("format_c_drive");
    // All surviving tools must be in the documented allowlist
    for (const t of tools) {
      expect(ALLOWED_PREPROCESSOR_TOOLS).toContain(t as (typeof ALLOWED_PREPROCESSOR_TOOLS)[number]);
    }
  });

  it("returns a safe fallback (no tool calls) on malformed JSON from the SLM", async () => {
    const provider = makeMalformedSpy();
    const contextPack = makeContextPack("anything");
    const triage = triageUserMessage("anything");
    const run = makeExternalRun();

    const result = await runSLMPreprocessor(
      { rawPrompt: "anything", contextPack, triage },
      { slmProvider: provider, run }
    );

    expect(result.proposedToolCalls).toEqual([]);
    expect(result.distilledContext.length).toBeGreaterThan(0);
    expect(() => PreprocessorOutputSchema.parse(result)).not.toThrow();
  });

  it("runDeterministicPreprocessor produces valid output with no provider and no network", () => {
    const contextPack = makeContextPack("Refactor the redaction module safely.");
    const triage = triageUserMessage("Refactor the redaction module safely.");
    const result = runDeterministicPreprocessor({
      rawPrompt: "Refactor the redaction module safely.",
      contextPack,
      triage,
    });

    expect(() => PreprocessorOutputSchema.parse(result)).not.toThrow();
    expect(result.proposedToolCalls).toEqual([]);
    expect(result.distilledContext.length).toBeGreaterThan(0);
  });
});

/**
 * Property test: for arbitrary user bloat (long messy prompts + context), the preprocessor
 * (even when the cheap model returns noisy or partially-invalid JSON) must always return
 * a schema-valid PreprocessorOutput whose proposed tools are either empty or from the allowlist.
 *
 * This mirrors the spirit of the livePlanner / synthesizer property tests.
 */
describe("Property: arbitrary bloat always yields safe valid PreprocessorOutput", () => {
  it("never leaks secrets and always produces allowlisted (or empty) tool proposals", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPrompt(),
        fc.array(fc.string({ minLength: 0, maxLength: 200 }), { maxLength: 6 }),
        async (rawPrompt, extraContextBits) => {
          // A "helpful but noisy" cheap model that sometimes proposes disallowed tools
          // and sometimes injects fake secret-like strings (which must be redacted by the boundary).
          const noisyJson = {
            distilledContext: `Goal: ${rawPrompt.slice(0, 300)} ${extraContextBits.join(" ")}`.slice(0, 900),
            proposedToolCalls: [
              { tool: "read_file", args: { path: "src/foo.ts" } },
              { tool: "run_command", args: { cmd: "npm test" } },
              { tool: "evil_delete_everything", args: { target: "/ " } },
              { tool: "write_file", args: { path: "README.md", content: "API_KEY=sk-123" } },
            ],
            entities: ["foo", "bar"],
            intent: rawPrompt.slice(0, 120),
            constraints: ["tests must pass"],
          };

          const provider = makeSpyThatReturns(noisyJson);

          const contextPack = makeContextPack(rawPrompt);
          const triage = triageUserMessage(rawPrompt);
          const run = makeExternalRun();

          const result = await runSLMPreprocessor(
            { rawPrompt, contextPack, triage },
            { slmProvider: provider, run }
          );

          // Must always be schema valid
          const parsed = PreprocessorOutputSchema.safeParse(result);
          expect(parsed.success).toBe(true);

          // Tool names must be from the documented allowlist (or the list is empty)
          for (const call of result.proposedToolCalls) {
            expect(ALLOWED_PREPROCESSOR_TOOLS).toContain(call.tool as (typeof ALLOWED_PREPROCESSOR_TOOLS)[number]);
          }

          // Redaction should have removed obvious secret-like content from string fields
          const allText = [
            result.distilledContext,
            result.intent,
            ...result.entities,
            ...result.constraints,
            ...result.proposedToolCalls.flatMap((c) => Object.values(c.args).filter((v): v is string => typeof v === "string")),
          ].join(" ");

          // Very conservative secret smell check (the real redaction tests are elsewhere)
          expect(allText.toLowerCase()).not.toMatch(/sk-[a-z0-9]{10,}/);
          expect(allText).not.toMatch(/API_KEY\s*=\s*[^ ]+/i);
        }
      ),
      { numRuns: 80 }
    );
  });
});
