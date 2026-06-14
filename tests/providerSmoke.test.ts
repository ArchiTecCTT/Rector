import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { TogetherAIProvider, ProviderError } from "../src/providers/llm";

describe("TogetherAIProvider Smoke Test (Local HTTP Mock)", () => {
  let mockServer: http.Server;
  let mockServerPort: number;
  let lastRequestHeaders: Record<string, string | string[] | undefined> = {};
  let lastRequestBody = "";
  let mockResponseStatusCode = 200;
  let mockResponseBody: unknown = {};

  beforeEach(async () => {
    mockResponseBody = {
      choices: [
        {
          message: {
            content: "mocked assistant response",
          },
          finish_reason: "stop",
        },
      ],
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25,
      },
    };
    mockResponseStatusCode = 200;
    lastRequestBody = "";
    lastRequestHeaders = {};

    mockServer = http.createServer((req, res) => {
      lastRequestHeaders = req.headers;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        lastRequestBody = body;
        res.writeHead(mockResponseStatusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockResponseBody));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address();
        mockServerPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      mockServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("sends a valid request and parses a successful response correctly", async () => {
    const provider = new TogetherAIProvider({
      apiKey: "test-together-key",
      baseUrl: `http://127.0.0.1:${mockServerPort}`,
      enableNetwork: true,
    });

    const response = await provider.invoke({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      modelRoute: "fast",
    });

    // 1. Assert request reached the mock with correct headers
    expect(lastRequestHeaders["authorization"]).toBe("Bearer test-together-key");
    expect(lastRequestHeaders["content-type"]).toBe("application/json");

    // Assert request body matches what we built
    const reqBody = JSON.parse(lastRequestBody);
    expect(reqBody.model).toBe("Qwen/Qwen2.5-Coder-7B-Instruct"); // FAST route default
    expect(reqBody.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ]);

    // 2. Assert response parses correctly into valid LLMResponse
    expect(response.provider).toBe("together");
    expect(response.model).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
    expect(response.content).toBe("mocked assistant response");
    expect(response.finishReason).toBe("stop");

    // 3. Assert usage tokens are extracted correctly
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(15);
    expect(response.usage.totalTokens).toBe(25);
    expect(response.usage.estimatedUsd).toBeGreaterThan(0);
  });

  it("throws a retryable ProviderError on HTTP 500 response", async () => {
    mockResponseStatusCode = 500;
    mockResponseBody = { error: "Internal Server Error" };

    const provider = new TogetherAIProvider({
      apiKey: "test-together-key",
      baseUrl: `http://127.0.0.1:${mockServerPort}`,
      enableNetwork: true,
    });

    let thrownError: unknown;
    try {
      await provider.invoke({
        messages: [{ role: "user", content: "Hello" }],
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(ProviderError);
    const providerError = thrownError as ProviderError;
    expect(providerError.code).toBe("PROVIDER_HTTP_ERROR");
    expect(providerError.status).toBe(500);
    expect(providerError.retryable).toBe(true);
  });

  it("throws a non-retryable ProviderError on HTTP 400 response", async () => {
    mockResponseStatusCode = 400;
    mockResponseBody = { error: "Bad Request" };

    const provider = new TogetherAIProvider({
      apiKey: "test-together-key",
      baseUrl: `http://127.0.0.1:${mockServerPort}`,
      enableNetwork: true,
    });

    let thrownError: unknown;
    try {
      await provider.invoke({
        messages: [{ role: "user", content: "Hello" }],
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(ProviderError);
    const providerError = thrownError as ProviderError;
    expect(providerError.code).toBe("PROVIDER_HTTP_ERROR");
    expect(providerError.status).toBe(400);
    expect(providerError.retryable).toBe(false);
  });
});
