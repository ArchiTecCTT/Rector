import { describe, expect, it } from "vitest";

import {
  buildOpenAiCompatibleStrictJsonBodyExtensions,
  resolveOpenAiCompatibleStrictJsonHostPolicy,
} from "../../src/providers/openAiCompatibleStrictJson";
import { LLMRequestSchema, OpenAICompatibleProvider } from "../../src/providers/llm";

describe("openAiCompatible strict JSON body policy", () => {
  it("classifies Z.ai and Regolo hosts", () => {
    expect(resolveOpenAiCompatibleStrictJsonHostPolicy("https://api.z.ai/v1")).toBe("zai");
    expect(resolveOpenAiCompatibleStrictJsonHostPolicy("https://gateway.z.ai/v1")).toBe("zai");
    expect(resolveOpenAiCompatibleStrictJsonHostPolicy("https://api.regolo.ai/v1")).toBe("regolo");
    expect(resolveOpenAiCompatibleStrictJsonHostPolicy("https://proxy.unit.test/v1")).toBe("none");
  });

  it("emits thinking disabled only for Z.ai when strict JSON minimize reasoning is requested", () => {
    const extensions = buildOpenAiCompatibleStrictJsonBodyExtensions(
      {
        responseFormat: { type: "json_object" },
        providerOptions: { strictJsonMinimizeReasoning: true },
      },
      "https://api.z.ai/v1",
    );
    expect(extensions).toEqual({ thinking: { type: "disabled" } });
  });

  it("emits reasoning_effort low only for Regolo when strict JSON minimize reasoning is requested", () => {
    const extensions = buildOpenAiCompatibleStrictJsonBodyExtensions(
      {
        responseFormat: { type: "json_object" },
        providerOptions: { strictJsonMinimizeReasoning: true },
      },
      "https://api.regolo.ai/v1",
    );
    expect(extensions).toEqual({ reasoning_effort: "low" });
  });

  it("omits non-standard keys for unknown OpenAI-compatible hosts", () => {
    const extensions = buildOpenAiCompatibleStrictJsonBodyExtensions(
      {
        responseFormat: { type: "json_object" },
        providerOptions: { strictJsonMinimizeReasoning: true },
      },
      "https://proxy.unit.test/v1",
    );
    expect(extensions).toEqual({});
  });

  it("does not emit extensions without json_object response format", () => {
    const extensions = buildOpenAiCompatibleStrictJsonBodyExtensions(
      {
        providerOptions: { strictJsonMinimizeReasoning: true },
      },
      "https://api.z.ai/v1",
    );
    expect(extensions).toEqual({});
  });

  it("does not emit extensions when providerOptions omit strictJsonMinimizeReasoning", () => {
    const extensions = buildOpenAiCompatibleStrictJsonBodyExtensions(
      { responseFormat: { type: "json_object" } },
      "https://api.z.ai/v1",
    );
    expect(extensions).toEqual({});
  });
});

describe("OpenAICompatibleProvider strict JSON serialization", () => {
  const baseRequest = {
    messages: [{ role: "user" as const, content: "Return JSON" }],
    responseFormat: { type: "json_object" as const },
    providerOptions: { strictJsonMinimizeReasoning: true as const },
    maxOutputTokens: 256,
  };

  it("serializes Z.ai thinking disabled into the chat completions body", () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.z.ai/v1",
      model: "glm-4.7",
    });
    const built = provider.buildRequest(baseRequest);
    const body = JSON.parse(String(built.init.body)) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("serializes Regolo reasoning_effort low into the chat completions body", () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.regolo.ai/v1",
      model: "qwen-2.5",
    });
    const built = provider.buildRequest(baseRequest);
    const body = JSON.parse(String(built.init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("low");
    expect(body.thinking).toBeUndefined();
  });

  it("does not add Z.ai or Regolo keys for generic compatible hosts", () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      baseUrl: "https://proxy.unit.test/v1",
      model: "meta-llama/Llama-3.3-70B-Instruct",
    });
    const built = provider.buildRequest(baseRequest);
    const body = JSON.parse(String(built.init.body)) as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("LLMRequestSchema providerOptions", () => {
  it("rejects arbitrary providerOptions keys", () => {
    const result = LLMRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      providerOptions: { strictJsonMinimizeReasoning: true, thinking: { type: "disabled" } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts strictJsonMinimizeReasoning literal true", () => {
    const result = LLMRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      providerOptions: { strictJsonMinimizeReasoning: true },
    });
    expect(result.success).toBe(true);
  });
});