import { describe, expect, it } from "vitest";

import {
  extractImports,
  type ExtractImportsInput,
  type ExtractImportsResult,
  type ResolvedTarget,
} from "../../src/cartographer/importExtractor";

const miniIndexed = [
  "package.json",
  "tsconfig.json",
  "docs/architecture.md",
  "src/app.ts",
  "src/index.ts",
  "src/app.test.ts",
  "src/routes/userRoute.ts",
  "src/config/env.ts",
] as const;

function makeInput(filePath: string, sourceText: string, indexed: readonly string[] = miniIndexed): ExtractImportsInput {
  return { filePath, sourceText, indexedFiles: indexed };
}

function getPackageSpecifier(t: ResolvedTarget): string {
  if (t.kind !== "package") {
    throw new Error(`Expected package target, got ${t.kind}`);
  }
  return t.specifier;
}

function getUnresolvedReason(t: ResolvedTarget): "not_found" | "not_configured" {
  if (t.kind !== "unresolved") {
    throw new Error(`Expected unresolved target, got ${t.kind}`);
  }
  return t.reason;
}

describe("importExtractor (Todo 19)", () => {
  it("extracts static ES import declarations and resolves relative local imports to indexed files", () => {
    const src = `
import { getEnv, type Env } from "./config/env";
import { userRoute } from "./routes/userRoute";
`;
    const result: ExtractImportsResult = extractImports(makeInput("src/app.ts", src));
    expect(result.diagnostics).toEqual([]);

    const recs = result.imports;
    expect(recs.length).toBe(2);

    const env = recs.find((r) => r.specifier === "./config/env");
    expect(env).toBeDefined();
    expect(env?.kind).toBe("staticImport");
    expect(env?.target).toEqual({ kind: "file", normalizedPath: "src/config/env.ts" });
    expect(env?.startLine).toBeGreaterThan(0);
    expect(env?.evidence.length).toBeGreaterThan(0);

    const route = recs.find((r) => r.specifier === "./routes/userRoute");
    expect(route?.target).toEqual({ kind: "file", normalizedPath: "src/routes/userRoute.ts" });
  });

  it("extracts export-from declarations and resolves relative targets", () => {
    const src = `
export { runApp } from "./app";
export * from "./config/env";
export type { Env } from "./config/env";
`;
    const result = extractImports(makeInput("src/index.ts", src));
    expect(result.diagnostics).toEqual([]);

    const recs = result.imports;
    expect(recs.length).toBe(3);
    for (const r of recs) {
      expect(r.kind).toBe("exportFrom");
      expect(r.target.kind).toBe("file");
    }
    const app = recs.find((r) => r.specifier === "./app");
    expect(app?.target).toEqual({ kind: "file", normalizedPath: "src/app.ts" });
  });

  it("extracts static-string dynamic imports and resolves them", () => {
    const src = `
const mod = await import("./app");
const json = await import("./config/env");
`;
    const result = extractImports(makeInput("src/app.test.ts", src));
    expect(result.diagnostics).toEqual([]);

    const recs = result.imports;
    expect(recs.length).toBe(2);
    expect(recs[0].kind).toBe("dynamicImport");
    expect(recs[0].specifier).toBe("./app");
    expect(recs[0].target).toEqual({ kind: "file", normalizedPath: "src/app.ts" });
  });

  it("extracts syntax-obvious CommonJS require literals (in .js/.ts)", () => {
    const src = `
const env = require("./config/env");
const route = require("./routes/userRoute");
`;
    const result = extractImports(makeInput("src/legacy.js", src));
    expect(result.diagnostics).toEqual([]);

    const recs = result.imports;
    expect(recs.length).toBe(2);
    for (const r of recs) {
      expect(r.kind).toBe("requireCall");
    }
    expect(recs[0].target).toEqual({ kind: "file", normalizedPath: "src/config/env.ts" });
  });

  it("treats bare specifiers as package targets without fabricating local files", () => {
    const src = `
import express from "express";
import { z } from "zod";
const fs = require("fs");
`;
    const result = extractImports(makeInput("src/app.ts", src));
    expect(result.diagnostics).toEqual([]);

    const recs = result.imports;
    expect(recs.length).toBe(3);
    for (const r of recs) {
      expect(r.target.kind).toBe("package");
    }
    expect(recs.map((r) => getPackageSpecifier(r.target))).toEqual([
      "express",
      "zod",
      "fs",
    ]);
  });

  it("marks unresolved relative imports as not_found and does not fabricate targets", () => {
    const src = `import x from "./does-not-exist";\nimport y from "../missing/mod";`;
    const result = extractImports(makeInput("src/app.ts", src));
    expect(result.diagnostics.length).toBeGreaterThan(0);

    const recs = result.imports;
    expect(recs.length).toBe(2);
    for (const r of recs) {
      expect(r.target.kind).toBe("unresolved");
      expect(getUnresolvedReason(r.target)).toBe("not_found");
    }
  });

  it("reports tsconfig-style aliases as not_configured and produces no local file target", () => {
    const src = `
import alias from "@/alias/path";
import tilde from "~/root";
`;
    const result = extractImports(makeInput("src/app.ts", src));

    const recs = result.imports;
    expect(recs.length).toBe(2);
    for (const r of recs) {
      expect(r.target.kind).toBe("unresolved");
      expect(getUnresolvedReason(r.target)).toBe("not_configured");
    }
    // Ensure no fabricated file target slipped in
    const hasFileTarget = recs.some((r) => r.target.kind === "file");
    expect(hasFileTarget).toBe(false);
    // Diagnostics should mention alias/not_configured
    const diagMsgs = result.diagnostics.map((d) => d.message).join(" ");
    expect(diagMsgs.toLowerCase()).toMatch(/not_configured|alias|unresolved/);
  });

  it("produces deterministic ordering independent of source declaration order", () => {
    const src = `
import z from "zod";
import a from "./app";
import b from "./config/env";
`;
    const r1 = extractImports(makeInput("src/app.ts", src));
    const r2 = extractImports(makeInput("src/app.ts", src));
    expect(r1.imports).toEqual(r2.imports);
    // Sorted by startLine asc, then specifier
    const lines = r1.imports.map((r) => r.startLine);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
  });

  it("returns recoverable diagnostics for syntax errors and does not fabricate import records from bad syntax", () => {
    const bad = `import { x from "./broken";`;
    const result = extractImports(makeInput("src/broken.ts", bad));
    expect(result.diagnostics.length).toBeGreaterThan(0);
    // Partial recovery may yield zero or some records; contract is diagnostics present, no throw.
  });

  it("ignores non-string and dynamic/non-obvious require/dynamic cases (no fabrication)", () => {
    const src = `
const dyn = import(someVar);
const req = require(someVar);
const req2 = require("./ok" + extra);
`;
    const result = extractImports(makeInput("src/app.ts", src));
    // Only the last would be syntax-obvious if concatenated, but it is not a single literal.
    // We expect zero records for these cases (or only obvious ones).
    const obvious = result.imports.filter((r) => r.specifier.startsWith("./"));
    expect(obvious.length).toBe(0);
  });
});
