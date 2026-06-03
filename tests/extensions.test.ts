import { describe, expect, it, vi } from "vitest";
import {
  ExtensionCompatibilityError,
  ExtensionManifestSchema,
  PUBLIC_EXTENSION_API_VERSION,
  SandboxExecutionResultSchema,
  SandboxCommandSchema,
  TelemetryEventSchema,
  UiClientMessageSchema,
  ValidatorResultSchema,
  assertExtensionCompatibility,
  checkExtensionCompatibility,
  type IssueTrackerExtension,
  type LlmExtension,
  type MemoryExtension,
  type SandboxExtension,
  type SearchExtension,
  type TelemetryExtension,
  type UiClientExtension,
  type ValidatorExtension,
} from "../src/extensions";

const baseManifest = {
  id: "sample-extension",
  name: "Sample Extension",
  version: "0.0.1",
  apiVersion: PUBLIC_EXTENSION_API_VERSION,
  networkAccess: false,
  capabilities: [
    { point: "llm", operations: ["invoke", "estimate"] },
    { point: "memory", operations: ["upsert", "search"] },
  ],
} as const;

describe("public extension manifests", () => {
  it("validates a local no-network extension manifest", () => {
    const manifest = ExtensionManifestSchema.parse(baseManifest);

    expect(manifest.apiVersion).toBe(PUBLIC_EXTENSION_API_VERSION);
    expect(manifest.networkAccess).toBe(false);
    expect(manifest.capabilities.map((capability) => capability.point)).toEqual(["llm", "memory"]);
  });

  it("rejects network-enabled manifests for the alpha local contract", () => {
    expect(() =>
      ExtensionManifestSchema.parse({
        ...baseManifest,
        networkAccess: true,
      })
    ).toThrow();
  });
});

describe("extension compatibility checks", () => {
  it("accepts a manifest with the supported apiVersion and required capabilities", () => {
    const result = checkExtensionCompatibility(baseManifest, { requiredCapabilities: ["llm", "memory"] });

    expect(result.compatible).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest.capabilities).toHaveLength(2);
  });

  it("rejects unsupported apiVersion", () => {
    const result = checkExtensionCompatibility(
      { ...baseManifest, apiVersion: "rector.extensions.v0" },
      { requiredCapabilities: ["llm"] }
    );

    expect(result.compatible).toBe(false);
    expect(result.errors).toContain(
      `Unsupported extension apiVersion rector.extensions.v0; expected ${PUBLIC_EXTENSION_API_VERSION}`
    );
    expect(() => assertExtensionCompatibility({ ...baseManifest, apiVersion: "rector.extensions.v0" })).toThrow(
      ExtensionCompatibilityError
    );
  });

  it("rejects missing required capabilities", () => {
    const result = checkExtensionCompatibility(baseManifest, { requiredCapabilities: ["sandbox", "validator"] });

    expect(result.compatible).toBe(false);
    expect(result.errors).toEqual([
      "Missing required extension capability: sandbox",
      "Missing required extension capability: validator",
    ]);
  });
});

describe("sample extension contracts", () => {
  it("compile and validate for all public extension points without network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const allCapabilities = [
      { point: "llm", operations: ["invoke"] },
      { point: "memory", operations: ["upsert", "search"] },
      { point: "sandbox", operations: ["execute"] },
      { point: "telemetry", operations: ["capture"] },
      { point: "search", operations: ["index", "search"] },
      { point: "issueTracker", operations: ["create", "list"] },
      { point: "validator", operations: ["validate"] },
      { point: "uiClient", operations: ["notify"] },
    ] as const;

    const manifest = ExtensionManifestSchema.parse({
      id: "all-sample-extension",
      name: "All Sample Extension",
      version: "0.0.1",
      apiVersion: PUBLIC_EXTENSION_API_VERSION,
      networkAccess: false,
      capabilities: allCapabilities,
    });

    const llm: LlmExtension = {
      manifest,
      point: "llm",
      async estimate() {
        return { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedUsd: 0 };
      },
      async invoke(request) {
        return {
          content: `local:${request.messages.at(-1)?.content ?? ""}`,
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedUsd: 0 },
        };
      },
    };

    const memory: MemoryExtension = {
      manifest,
      point: "memory",
      async upsert(items) {
        return { accepted: items.length, skipped: 0 };
      },
      async search(query) {
        return [{ id: "mem-1", title: "Memory", content: query.query, score: 1 }];
      },
    };

    const sandbox: SandboxExtension = {
      manifest,
      point: "sandbox",
      async execute(command) {
        return SandboxExecutionResultSchema.parse({
          exitCode: 0,
          stdout: command.command,
          stderr: "",
          durationMs: 0,
          networkCalls: 0,
        });
      },
    };

    const telemetry: TelemetryExtension = {
      manifest,
      point: "telemetry",
      async capture(event) {
        TelemetryEventSchema.parse(event);
      },
    };

    const search: SearchExtension = {
      manifest,
      point: "search",
      async index(documents) {
        return { accepted: documents.length, skipped: 0 };
      },
      async search(query) {
        return [{ id: "doc-1", title: "Doc", content: query.query, score: 1 }];
      },
    };

    const issueTracker: IssueTrackerExtension = {
      manifest,
      point: "issueTracker",
      async create(issue) {
        return { id: "issue-1", url: undefined, title: issue.title, status: "open" };
      },
      async list() {
        return [{ id: "issue-1", title: "Issue", status: "open" }];
      },
    };

    const validator: ValidatorExtension = {
      manifest,
      point: "validator",
      async validate(input) {
        return ValidatorResultSchema.parse({
          status: input.subject.length > 0 ? "passed" : "failed",
          findings: [],
        });
      },
    };

    const uiClient: UiClientExtension = {
      manifest,
      point: "uiClient",
      async notify(message) {
        UiClientMessageSchema.parse(message);
        return { delivered: true };
      },
    };

    assertExtensionCompatibility(manifest, {
      requiredCapabilities: [
        "llm",
        "memory",
        "sandbox",
        "telemetry",
        "search",
        "issueTracker",
        "validator",
        "uiClient",
      ],
    });

    await expect(llm.invoke({ messages: [{ role: "user", content: "hello" }] })).resolves.toMatchObject({
      content: "local:hello",
      finishReason: "stop",
    });
    await expect(memory.upsert([{ id: "mem-1", title: "Memory", content: "hello" }])).resolves.toEqual({
      accepted: 1,
      skipped: 0,
    });
    await expect(sandbox.execute({ command: "npm test", timeoutMs: 1_000 })).resolves.toMatchObject({
      exitCode: 0,
      networkCalls: 0,
    });
    await expect(telemetry.capture({ name: "extension.test", level: "info", timestamp: "2026-01-01T00:00:00.000Z" })).resolves.toBeUndefined();
    await expect(search.index([{ id: "doc-1", title: "Doc", content: "hello" }])).resolves.toEqual({
      accepted: 1,
      skipped: 0,
    });
    await expect(issueTracker.create({ title: "Issue" })).resolves.toMatchObject({ id: "issue-1", status: "open" });
    await expect(validator.validate({ subject: "artifact" })).resolves.toMatchObject({ status: "passed" });
    await expect(uiClient.notify({ type: "toast", message: "Done" })).resolves.toEqual({ delivered: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("SandboxCommandSchema validation", () => {
  it("accepts valid commands with positive timeoutMs", () => {
    const validCommand = {
      command: "echo 'hello'",
      timeoutMs: 1000,
    };
    const parsed = SandboxCommandSchema.parse(validCommand);
    expect(parsed.command).toBe("echo 'hello'");
    expect(parsed.timeoutMs).toBe(1000);
  });

  it("rejects command with timeoutMs of 0", () => {
    const invalidCommand = {
      command: "echo 'hello'",
      timeoutMs: 0,
    };
    const result = SandboxCommandSchema.safeParse(invalidCommand);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMsg = result.error.errors.map(e => e.message).join("\n");
      expect(errorMsg).toContain("timeoutMs must be at least 1");
    }
  });

  it("rejects command with negative timeoutMs", () => {
    const invalidCommand = {
      command: "echo 'hello'",
      timeoutMs: -50,
    };
    const result = SandboxCommandSchema.safeParse(invalidCommand);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMsg = result.error.errors.map(e => e.message).join("\n");
      expect(errorMsg).toContain("timeoutMs must be at least 1");
    }
  });
});

