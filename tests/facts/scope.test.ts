import { describe, expect, it } from "vitest";

import { FactScopeSchema, SafeFactPathSchema, createFactScope, isSafeFactPath, normalizeFactPath, parseFactPath } from "../../src/facts";

describe("fact scope and path helpers", () => {
  it("accepts safe relative paths and bare dot", () => {
    expect(parseFactPath("src/facts/schemas.ts")).toBe("src/facts/schemas.ts");
    expect(parseFactPath(".")).toBe(".");
    expect(normalizeFactPath("src\\facts\\schemas.ts")).toBe("src/facts/schemas.ts");
  });

  it("rejects absolute, drive-prefixed, UNC, leading-dot, parent, and empty-segment paths", () => {
    const unsafe = [
      "/etc/passwd",
      "C:/Users/alice/secret.txt",
      "C:\\Users\\alice\\secret.txt",
      "//server/share/file.txt",
      "\\\\server\\share\\file.txt",
      "./src/index.ts",
      "src/../package.json",
      "src//index.ts",
      "src/index.ts/",
    ];

    expect(unsafe.every((path) => !isSafeFactPath(path))).toBe(true);
  });

  it("rejects prototype pollution keys as path segments", () => {
    expect(SafeFactPathSchema.safeParse("src/__proto__/x.ts").success).toBe(false);
    expect(SafeFactPathSchema.safeParse("src/constructor/x.ts").success).toBe(false);
    expect(SafeFactPathSchema.safeParse("src/prototype/x.ts").success).toBe(false);
  });

  it("creates strict fact scopes with safe paths and graph refs", () => {
    const scope = createFactScope({
      scopeType: "workspace",
      workspacePaths: ["src/facts/scope.ts"],
      graphRefs: [{ refType: "graph", snapshotId: "snap-1", nodeId: "file:src/facts/scope.ts" }],
      taskIds: ["task-1"],
    });

    expect(scope.scopeType).toBe("workspace");
    expect(scope.workspacePaths).toEqual(["src/facts/scope.ts"]);
    expect(FactScopeSchema.safeParse({ ...scope, extra: "nope" }).success).toBe(false);
  });

  it("rejects scope objects with unsafe paths", () => {
    const result = FactScopeSchema.safeParse({ scopeType: "workspace", workspacePaths: ["../outside"], graphRefs: [], taskIds: [] });

    expect(result.success).toBe(false);
  });
});
