import { describe, expect, it } from "vitest";

import {
  buildIsolatedCampaignEnv,
  parseRegoloModelsList,
  resolveRegoloMatrixModels,
} from "../../src/live/regoloModelMatrix";

describe("regoloModelMatrix parsing", () => {
  it("resolves models from REGOLO_MODELS with optional cap", () => {
    const env = {
      REGOLO_MODELS: "qwen3.5-9b,Llama-3.3-70B-Instruct,mistral-small-4-119b",
      REGOLO_MATRIX_MAX_MODELS: "2",
    };
    expect(resolveRegoloMatrixModels(env)).toEqual({
      models: ["qwen3.5-9b", "Llama-3.3-70B-Instruct"],
      source: "REGOLO_MODELS",
    });
  });

  it("falls back to single REGOLO_MODEL", () => {
    expect(resolveRegoloMatrixModels({ REGOLO_MODEL: "gpt-oss-20b" })).toEqual({
      models: ["gpt-oss-20b"],
      source: "REGOLO_MODEL",
    });
  });

  it("isolates REGOLO_MODEL per campaign env", () => {
    const env = buildIsolatedCampaignEnv(
      {
        REGOLO_API_KEY: "secret-key-value",
        REGOLO_BASE_URL: "https://api.regolo.ai/v1",
        REGOLO_MODEL: "old",
      },
      "qwen3.5-9b",
    );
    expect(env.REGOLO_MODEL).toBe("qwen3.5-9b");
    expect(env.RECTOR_LIVE_PROVIDER).toBe("regolo");
    expect(env.REGOLO_API_KEY).toBe("secret-key-value");
  });

  it("parses model lists via regoloModelsEnv", () => {
    expect(parseRegoloModelsList("a,b")).toEqual(["a", "b"]);
  });
});