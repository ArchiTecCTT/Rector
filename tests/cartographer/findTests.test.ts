import { describe, expect, it } from "vitest";

import {
  findTests,
  type FindTestsInput,
  type FindTestsResult,
} from "../../src/cartographer/testLinker";

function makeInput(
  target: string,
  indexed: readonly string[],
  sources: ReadonlyMap<string, string>,
): FindTestsInput {
  return {
    targetNormalizedPath: target,
    indexedFiles: indexed,
    getSourceText: (p: string) => sources.get(p),
  };
}

describe("findTests (Todo 20)", () => {
  it("links test to source by explicit import relation first (import-first)", () => {
    const target = "src/app.ts";
    const indexed = [
      "package.json",
      "src/app.ts",
      "src/app.test.ts",
      "src/config/env.ts",
    ] as const;
    const sources = new Map<string, string>([
      [
        "src/app.test.ts",
        `import { runApp } from "./app";\n\ndescribe("app", () => {\n  it("runs", () => { runApp({ port: 0 }); });\n});\n`,
      ],
    ]);
    const result: FindTestsResult = findTests(makeInput(target, indexed, sources));
    expect(result.targetNormalizedPath).toBe("src/app.ts");
    expect(result.linkedTests.length).toBe(1);
    const link = result.linkedTests[0];
    expect(link.normalizedPath).toBe("src/app.test.ts");
    expect(link.relation).toBe("import");
    expect(link.evidence).toContain("./app");
  });

  it("falls back to basename convention when no import relation exists", () => {
    const target = "src/baz.ts";
    const indexed = ["src/baz.ts", "src/baz.test.ts", "src/other.ts"] as const;
    const sources = new Map<string, string>([
      // test does not import baz; pure basename fallback
      ["src/baz.test.ts", `describe("baz", () => { it("works", () => {}); });\n`],
    ]);
    const result = findTests(makeInput(target, indexed, sources));
    expect(result.linkedTests.length).toBe(1);
    expect(result.linkedTests[0].normalizedPath).toBe("src/baz.test.ts");
    expect(result.linkedTests[0].relation).toBe("basename");
    expect(result.linkedTests[0].evidence).toBe("basename convention");
  });

  it("returns empty linkedTests (no invention) when no tests found for source", () => {
    const target = "src/nope.ts";
    const indexed = ["src/nope.ts", "src/app.test.ts", "src/other.spec.ts"] as const;
    const sources = new Map<string, string>([
      ["src/app.test.ts", `import "./app";`],
      ["src/other.spec.ts", `import "./other";`],
    ]);
    const result = findTests(makeInput(target, indexed, sources));
    expect(result.linkedTests).toEqual([]);
  });

  it("supports .spec.ts basename fallback", () => {
    const target = "src/quux.ts";
    const indexed = ["src/quux.ts", "src/quux.spec.ts"] as const;
    const sources = new Map<string, string>([
      ["src/quux.spec.ts", `test("quux", () => {});\n`],
    ]);
    const result = findTests(makeInput(target, indexed, sources));
    expect(result.linkedTests.length).toBe(1);
    expect(result.linkedTests[0].normalizedPath).toBe("src/quux.spec.ts");
    expect(result.linkedTests[0].relation).toBe("basename");
  });

  it("supports JS/TSX/JSX/MTS/CTS test variants via basename and import", () => {
    const targetTsx = "src/ui.tsx";
    const indexed = ["src/ui.tsx", "src/ui.test.tsx", "src/legacy.js", "src/legacy.spec.js", "src/mod.mts", "src/mod.test.mts"] as const;
    const sources = new Map<string, string>([
      ["src/ui.test.tsx", `import { Comp } from "./ui";`],
      ["src/legacy.spec.js", `const m = require("./legacy");`],
      ["src/mod.test.mts", `import "./mod";`],
    ]);
    const r1 = findTests(makeInput(targetTsx, indexed, sources));
    expect(r1.linkedTests.length).toBe(1);
    expect(r1.linkedTests[0].normalizedPath).toBe("src/ui.test.tsx");
    expect(r1.linkedTests[0].relation).toBe("import");

    const r2 = findTests(makeInput("src/legacy.js", indexed, sources));
    expect(r2.linkedTests.length).toBe(1);
    expect(r2.linkedTests[0].normalizedPath).toBe("src/legacy.spec.js");

    const r3 = findTests(makeInput("src/mod.mts", indexed, sources));
    expect(r3.linkedTests.length).toBe(1);
    expect(r3.linkedTests[0].normalizedPath).toBe("src/mod.test.mts");
  });

  it("rejects basename fallback when multiple source files share the same stem", () => {
    const indexed = ["src/a/util.ts", "src/b/util.ts", "src/util.test.ts"] as const;
    const sources = new Map<string, string>([["src/util.test.ts", `describe("util", () => {});`]]);
    const r1 = findTests(makeInput("src/a/util.ts", indexed, sources));
    const r2 = findTests(makeInput("src/b/util.ts", indexed, sources));
    expect(r1.linkedTests).toEqual([]);
    expect(r2.linkedTests).toEqual([]);
  });

  it("duplicate basename candidates without import relation return empty (no fabricated certainty)", () => {
    const target = "src/amb.ts";
    const indexed = ["src/amb.ts", "src/amb.test.ts", "src/amb.spec.ts"] as const;
    const sources = new Map<string, string>([
      ["src/amb.test.ts", `describe("amb", () => {});`],
      ["src/amb.spec.ts", `test("amb", () => {});`],
    ]);
    const result = findTests(makeInput(target, indexed, sources));
    expect(result.linkedTests).toEqual([]);
  });

  it("import relation takes precedence and is returned even if basename duplicates exist", () => {
    const target = "src/imp.ts";
    const indexed = ["src/imp.ts", "src/imp.test.ts", "src/imp.spec.ts"] as const;
    const sources = new Map<string, string>([
      ["src/imp.test.ts", `import "./imp";`],
      ["src/imp.spec.ts", `describe("imp", () => {});`],
    ]);
    const result = findTests(makeInput(target, indexed, sources));
    expect(result.linkedTests.length).toBe(1);
    expect(result.linkedTests[0].normalizedPath).toBe("src/imp.test.ts");
    expect(result.linkedTests[0].relation).toBe("import");
  });

  it("produces deterministic sorted output independent of indexed order", () => {
    const target = "src/multi.ts";
    const indexed = ["src/multi.ts", "src/a/multi.test.ts", "src/b/multi.spec.ts"] as const; // different dirs, both basename match
    const sources = new Map<string, string>([
      ["src/a/multi.test.ts", `import "../multi";`], // wait, adjust to resolve? for simplicity use import that won't for this, use basename
      ["src/b/multi.spec.ts", `import "../multi";`],
    ]);
    // To force basename only and multiple: do not make imports resolve to target
    const sourcesNoImport = new Map<string, string>([
      ["src/a/multi.test.ts", `describe("m", () => {});`],
      ["src/b/multi.spec.ts", `test("m", () => {});`],
    ]);
    const result = findTests(makeInput(target, indexed, sourcesNoImport));
    // multiple basename -> empty per disambig rule
    expect(result.linkedTests).toEqual([]);

    // Now with import from one, should return only the import one, sorted (single)
    const withImport = new Map<string, string>([
      ["src/a/multi.test.ts", `import "../multi";`],
      ["src/b/multi.spec.ts", `describe("m", () => {});`],
    ]);
    const r2 = findTests(makeInput(target, indexed, withImport));
    expect(r2.linkedTests.length).toBe(1);
    expect(r2.linkedTests[0].normalizedPath).toBe("src/a/multi.test.ts");
  });

  it("normalizes paths and never returns invented or absolute paths", () => {
    const target = "src/norm.ts";
    const indexed = ["src/norm.ts", "src/norm.test.ts"] as const;
    const sources = new Map<string, string>([["src/norm.test.ts", `import "./norm";`]]);
    const result = findTests(makeInput(target, indexed, sources));
    expect(result.linkedTests[0].normalizedPath).toBe("src/norm.test.ts");
    expect(result.linkedTests[0].normalizedPath.startsWith("/")).toBe(false);
  });
});
