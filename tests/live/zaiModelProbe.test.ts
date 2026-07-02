import { describe, expect, it, vi } from "vitest";

import {
  classifyZaiProbeHttpFailure,
  probeZaiModelCallability,
  probeZaiModelJsonCapability,
  runZaiModelProbe,
  ZAI_MODEL_PROBE_REPORT_SCHEMA,
} from "../../src/live/zaiModelProbe";

describe("zaiModelProbe", () => {
  it("classifies invalid model HTTP responses", () => {
    expect(classifyZaiProbeHttpFailure(404, "model not found")).toBe("invalid_model_id");
    expect(classifyZaiProbeHttpFailure(401, "unauthorized")).toBe("auth_failure");
  });

  it("probes callability with injected fetch", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const row = await probeZaiModelCallability({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "sk-test-key-1234567890",
      modelId: "glm-4.7",
      timeoutMs: 5_000,
      fetchImpl,
    });

    expect(row.classification).toBe("callable");
    expect(row.totalTokens).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstUrl = (fetchImpl.mock.calls as unknown as Array<[unknown, unknown]>)[0]?.[0];
    expect(String(firstUrl)).toContain("/chat/completions");
  });

  it("probes JSON capability when response parses as an object", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await probeZaiModelJsonCapability({
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "sk-test-key-1234567890",
      modelId: "glm-4.7",
      timeoutMs: 5_000,
      fetchImpl,
    });

    expect(result.jsonCapability).toBe("supported");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("reports environment_missing without network when credentials are absent", async () => {
    const fetchImpl = vi.fn();
    const report = await runZaiModelProbe({
      env: {},
      models: ["glm-4.7"],
      write: false,
      fetchImpl,
    });

    expect(report.schemaVersion).toBe(ZAI_MODEL_PROBE_REPORT_SCHEMA);
    expect(report.rows[0]?.classification).toBe("environment_missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});