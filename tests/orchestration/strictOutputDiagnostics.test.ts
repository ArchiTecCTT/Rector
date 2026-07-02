import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  diagnosticFromSemanticInvariant,
  diagnosticsFromProviderRuntimeMetadata,
  diagnosticsFromValidationHooks,
  parseStrictJsonObject,
  projectSafeStrictOutputDiagnostics,
  summarizeStrictOutputDiagnostics,
  zodDiagnostics,
} from "../../src/orchestration/strictOutputDiagnostics";

describe("strict output diagnostics", () => {
  it("normalizes JSON syntax failures without leaking raw secrets", () => {
    const result = parseStrictJsonObject("{\"token\":\"sk-test-secret1234567890\"");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        kind: "json_syntax",
        code: "json_syntax_error",
        path: "(root)",
        severity: "error",
      });
      expect(result.diagnostics[0].message).not.toContain("sk-test-secret1234567890");
      expect(result.diagnostics[0].message.length).toBeLessThanOrEqual(500);
    }
  });

  it("normalizes Zod schema failures with stable issue paths", () => {
    const Schema = z
      .object({
        items: z.array(z.object({ name: z.string().min(1) })),
      })
      .strict();

    const parsed = Schema.safeParse({ items: [{}], extra: true });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const diagnostics = zodDiagnostics(parsed.error);
      expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual(["items.0.name", "(root)"]);
      expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["schema", "schema"]);
      expect(diagnostics[0].code).toBe("zod_invalid_type");
    }
  });

  it("normalizes semantic invariant and provenance-style hook diagnostics", () => {
    const semantic = diagnosticFromSemanticInvariant({
      code: "dangling_dependency",
      message: "Dependency references a missing task",
      path: ["dependencies", 0, "to"],
    });
    const hooks = diagnosticsFromValidationHooks([
      {
        hook: "provenance",
        diagnostics: [{ code: "missing_source", message: "Missing source artifact", path: ["provenance", 0] }],
      },
      {
        hook: "grounding",
        ok: false,
      },
      {
        hook: "scope",
        ok: true,
      },
      {
        hook: "redaction",
        diagnostics: [
          {
            code: "secret_like_payload",
            message: "api_key=sk-test-secret1234567890 appears in summary",
            path: "summary",
          },
        ],
      },
    ]);

    expect(semantic).toMatchObject({
      kind: "semantic_invariant",
      code: "dangling_dependency",
      path: "dependencies.0.to",
    });
    expect(hooks.map((diagnostic) => `${diagnostic.kind}:${diagnostic.code}:${diagnostic.path}`)).toEqual([
      "provenance:missing_source:provenance.0",
      "grounding:grounding_check_failed:(root)",
      "redaction:secret_like_payload:summary",
    ]);
    expect(hooks[2].message).not.toContain("sk-test-secret1234567890");
  });

  it("classifies truncation and provider runtime metadata when supplied", () => {
    const diagnostics = diagnosticsFromProviderRuntimeMetadata({
      provider: "zai",
      model: "glm",
      finishReason: "length",
      timedOut: true,
      errorCode: "provider_timeout",
      errorMessage: "Provider timed out after 300s",
    });

    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["truncation", "provider_runtime"]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "provider_output_truncated",
      "provider_timeout",
    ]);
  });

  it("projects persistence-safe diagnostics without model-derived messages", () => {
    const sentinel = "MODEL_DERIVED_TASK_ID_sentinel_xyz";
    const diagnostics = [
      diagnosticFromSemanticInvariant({
        code: "dangling_dependency",
        message: `Planner task ${sentinel} references missing dependency`,
        path: ["dependencies", 0, "to"],
      }),
    ];

    const safe = projectSafeStrictOutputDiagnostics(diagnostics);
    const serialized = JSON.stringify(safe);

    expect(safe).toEqual([
      {
        kind: "semantic_invariant",
        code: "dangling_dependency",
        path: "dependencies.0.to",
        severity: "error",
      },
    ]);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("message");
  });

  it("caps safe diagnostic projections to a bounded item count", () => {
    const diagnostics = Array.from({ length: 40 }, (_, index) =>
      diagnosticFromSemanticInvariant({
        code: `code_${index}`,
        message: `message ${index}`,
        path: `field.${index}`,
      }),
    );

    expect(projectSafeStrictOutputDiagnostics(diagnostics, { maxItems: 8 })).toHaveLength(8);
  });

  it("renders bounded redacted summaries for repair prompts and reports", () => {
    const diagnostics = [
      diagnosticFromSemanticInvariant({
        code: "secret_context",
        message: `Bad output contains ${"x".repeat(400)} sk-test-secret1234567890`,
        path: "(root)",
      }),
    ];

    const summary = summarizeStrictOutputDiagnostics(diagnostics, { maxChars: 180 });

    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary).toContain("[REDACTED]");
    expect(summary).not.toContain("sk-test-secret1234567890");
  });
});
