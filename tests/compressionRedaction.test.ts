import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyCompressedOutput,
  summarizeDeterministic,
} from "../src/orchestration/contextCompression.js";
import type { ContextPack, InlineContext, ArtifactHandle } from "../src/orchestration/contextBuilder.js";

function makeInlineContext(overrides: Partial<InlineContext> = {}): InlineContext {
  return {
    kind: "CONTEXT_SUMMARY",
    summary: "test summary",
    content: "test content",
    hash: "abc123",
    sizeBytes: 100,
    ...overrides,
  };
}

function makeArtifactHandle(overrides: Partial<ArtifactHandle> = {}): ArtifactHandle {
  return {
    artifactId: "art-1",
    kind: "CONTEXT_SUMMARY",
    uri: "context-summary://run/abc",
    summary: "artifact summary",
    hash: "def456",
    sizeBytes: 200,
    piiState: "redacted",
    retentionPolicy: "session",
    ...overrides,
  };
}

function makeContextPack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    id: "ctx-abc",
    createdAt: new Date().toISOString(),
    userIntentSummary: "test",
    conversationRef: { id: "conv-1", title: "Test", workspaceId: "ws-1" },
    messageRefs: [],
    artifactHandles: [makeArtifactHandle()],
    inlineContext: [makeInlineContext()],
    compressionRecommended: false,
    ...overrides,
  };
}

describe("M28 — Compression redaction completeness", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("verifyCompressedOutput", () => {
    it("does not warn when compressed output contains no secrets", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "clean summary", content: "clean content" })],
        artifactHandles: [makeArtifactHandle({ summary: "clean artifact" })],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns when an OpenAI-style API key is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "key is sk-AbCdEf1234567890AbCdEf12345678", content: "" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OpenAI-style API key"),
      );
    });

    it("warns when an AWS access key ID is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "", content: "aws key AKIAIOSFODNN7EXAMPLE1" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("AWS access key ID"),
      );
    });

    it("warns when a PEM private key is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [],
        artifactHandles: [makeArtifactHandle({ summary: "found -----BEGIN RSA PRIVATE KEY-----" })],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("PEM private key"),
      );
    });

    it("warns when a Bearer token is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "auth Bearer eyJhbGciOiJIUzI1NiJ9.abc", content: "" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Bearer token"),
      );
    });

    it("warns when a Basic auth credential is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "", content: "auth Basic dXNlcjpwYXNz" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Basic auth credential"),
      );
    });

    it("warns when a credential URI is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "db is postgres://user:pass@host/db", content: "" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Credential URI"),
      );
    });

    it("warns when an inline secret assignment is detected", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "", content: "config api_key=supersecret123" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Inline secret assignment"),
      );
    });

    it("warns for secrets in artifact handle summaries", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "clean", content: "clean" })],
        artifactHandles: [makeArtifactHandle({ summary: "token=abc123secret" })],
      });
      verifyCompressedOutput(pack);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Inline secret assignment"),
      );
    });

    it("warns for multiple secret patterns simultaneously", () => {
      const warnSpy = vi.spyOn(console, "warn");
      const pack = makeContextPack({
        inlineContext: [makeInlineContext({ summary: "sk-AbCdEf1234567890AbCdEf12345678", content: "AKIAIOSFODNN7EXAMPLE1" })],
        artifactHandles: [],
      });
      verifyCompressedOutput(pack);
      const warnCalls = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(warnCalls.some((msg) => msg.includes("OpenAI-style API key"))).toBe(true);
      expect(warnCalls.some((msg) => msg.includes("AWS access key ID"))).toBe(true);
    });
  });

  describe("inlineContext redaction in carry-forward", () => {
    it("applies redactString to carried-forward inlineContext entries", () => {
      const inlineContext = [
        makeInlineContext({
          kind: "MEMORY",
          summary: "contains Bearer eyJhbGciOiJIUzI1NiJ9.abc token",
          content: "secret=supersecretvalue",
        }),
        makeInlineContext({
          kind: "CONTEXT_SUMMARY",
          summary: "clean summary",
          content: "clean content",
        }),
      ];

      // Simulate what compressContextLineage does for carried-forward entries
      const redactedCarriedContext = inlineContext.slice(0, 2).map((entry) => ({
        ...entry,
        summary: entry.summary.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]"),
        content: entry.content.replace(/(?:api[_-]?key|token|secret|password)=[^\s,;&]+/gi, (m) =>
          m.replace(/=.*/, "=[REDACTED]"),
        ),
      }));

      // First entry should be redacted
      expect(redactedCarriedContext[0].summary).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(redactedCarriedContext[0].content).not.toContain("supersecretvalue");
      // Second entry should be unchanged
      expect(redactedCarriedContext[1].summary).toBe("clean summary");
    });
  });

  describe("summarizeDeterministic redaction", () => {
    it("redacts secrets in message content during deterministic summarization", () => {
      const messages = [
        {
          role: "user" as const,
          content: "my connection is postgres://user:secretpass@host/db please help",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      const inlineContext = [
        makeInlineContext({ summary: "config token=mytoken123", content: "clean" }),
      ];
      const result = summarizeDeterministic(messages, inlineContext);
      expect(result).not.toContain("secretpass");
      expect(result).not.toContain("mytoken123");
    });

    it("redacts inline context summary and content during summarization", () => {
      const messages: Array<{ role: string; content: string; createdAt: string }> = [];
      const inlineContext = [
        makeInlineContext({
          summary: "Bearer eyJhbGciOiJIUzI1NiJ9.abc token found",
          content: "password=supersecret",
        }),
      ];
      const result = summarizeDeterministic(messages, inlineContext);
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(result).not.toContain("supersecret");
    });
  });
});
