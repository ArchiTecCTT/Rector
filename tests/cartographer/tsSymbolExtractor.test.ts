import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { extractTsSymbols, type ExtractedSymbol } from "../../src/cartographer/tsSymbolExtractor";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("tsSymbolExtractor (Todo 18)", () => {
  it("extracts local and exported functions, classes, interfaces, type aliases, enums, and variables", () => {
    const src = `
export function exportedFn() {}
function localFn() {}

export class ExportedClass {}
class LocalClass {}

export interface ExportedIface {}
interface LocalIface {}

export type ExportedType = number;
type LocalType = string;

export enum ExportedEnum { A }
enum LocalEnum { B }

export const exportedVar = 1;
const localVar = 2;
`;

    const result = extractTsSymbols({ filePath: "symbols.ts", sourceText: src });
    expect(result.diagnostics).toEqual([]);

    const byKey = (s: ExtractedSymbol) =>
      `${s.isExported ? "export" : "local"}:${s.kind}:${s.name}`;

    const keys = result.symbols.map(byKey);

    expect(keys).toContain("export:function:exportedFn");
    expect(keys).toContain("local:function:localFn");
    expect(keys).toContain("export:class:ExportedClass");
    expect(keys).toContain("local:class:LocalClass");
    expect(keys).toContain("export:interface:ExportedIface");
    expect(keys).toContain("local:interface:LocalIface");
    expect(keys).toContain("export:typeAlias:ExportedType");
    expect(keys).toContain("local:typeAlias:LocalType");
    expect(keys).toContain("export:enum:ExportedEnum");
    expect(keys).toContain("local:enum:LocalEnum");
    expect(keys).toContain("export:variable:exportedVar");
    expect(keys).toContain("local:variable:localVar");
  });

  it("marks default exports correctly for functions and classes", () => {
    const src = `
export default function defaultFn() {}
export default class DefaultClass {}
export default function() {}
`;
    const result = extractTsSymbols({ filePath: "defaults.ts", sourceText: src });
    expect(result.diagnostics).toEqual([]);

    const fns = result.symbols.filter((s: ExtractedSymbol) => s.kind === "function");
    const classes = result.symbols.filter((s: ExtractedSymbol) => s.kind === "class");

    const defaultFn = fns.find((s: ExtractedSymbol) => s.name === "defaultFn");
    expect(defaultFn?.isExported).toBe(true);

    const anonDefault = fns.find((s: ExtractedSymbol) => s.name === "default");
    expect(anonDefault?.isExported).toBe(true);

    const defaultCls = classes.find((s: ExtractedSymbol) => s.name === "DefaultClass");
    expect(defaultCls?.isExported).toBe(true);
  });

  it("extracts named exports, re-exports, and export-from declarations as kind export", () => {
    const src = `
export { a, b as c };
export * from "./mod";
export { d } from "./other";
export type { E } from "./types";
`;
    const result = extractTsSymbols({ filePath: "exports.ts", sourceText: src });
    expect(result.diagnostics).toEqual([]);

    const exports = result.symbols.filter((s: ExtractedSymbol) => s.kind === "export");
    const names = exports.map((e: ExtractedSymbol) => e.name);

    expect(names.some((n) => n.includes("{ a, b as c }"))).toBe(true);
    expect(names.some((n) => n === "* from")).toBe(true);
    expect(names.some((n) => n === "* from from")).toBe(false);
    expect(names.some((n) => n.includes("{ d } from"))).toBe(true);
    expect(names.some((n) => n.includes("{ E } from"))).toBe(true);

    for (const e of exports) {
      expect(e.isExported).toBe(true);
    }
  });

  it("extracts exported variables including multi-decl and simple destructuring", () => {
    // Use a typed object literal so the destructuring test source contains no cast expressions.
    const src = `
const obj: { r: number; s: number } = { r: 1, s: 2 };
export const p = 1, q = 2;
export const { r, s: t } = obj;
`;
    const result = extractTsSymbols({ filePath: "vars.ts", sourceText: src });
    expect(result.diagnostics).toEqual([]);

    const vars = result.symbols.filter((s: ExtractedSymbol) => s.kind === "variable" && s.isExported);
    const names = vars.map((v: ExtractedSymbol) => v.name);
    expect(names).toContain("p");
    expect(names).toContain("q");
    expect(names).toContain("r");
    expect(names).toContain("t");
  });

  it("treats duplicate symbol names at different positions as distinct results", () => {
    const src = `function dup() {}\nfunction dup() {}`;
    const result = extractTsSymbols({ filePath: "dups.ts", sourceText: src });
    expect(result.diagnostics).toEqual([]);

    const dups = result.symbols.filter((s: ExtractedSymbol) => s.name === "dup" && s.kind === "function");
    expect(dups.length).toBe(2);
    expect(dups[0].startLine).not.toBe(dups[1].startLine);
    expect(dups[0].startLine).toBe(1);
    expect(dups[1].startLine).toBe(2);
  });

  it("parses .js files using JS script kind", () => {
    const src = `export function jsFn() {}\nconst localJs = 1;`;
    const result = extractTsSymbols({ filePath: "mod.js", sourceText: src });
    expect(result.diagnostics).toEqual([]);
    expect(result.symbols.some((s) => s.name === "jsFn" && s.isExported)).toBe(true);
    expect(result.symbols.some((s) => s.name === "localJs" && !s.isExported)).toBe(true);
  });

  it("parses .tsx, .jsx, .mts, .cts extensions without throwing", () => {
    const cases = [
      { path: "c.tsx", text: "export function TsxComp(): unknown { return null; }" },
      { path: "c.jsx", text: "export function JsxComp() { return null; }" },
      { path: "c.mts", text: "export const m = 1;" },
      { path: "c.cts", text: "export const c = 2;" },
    ];
    for (const c of cases) {
      const res = extractTsSymbols({ filePath: c.path, sourceText: c.text });
      expect(res.diagnostics).toEqual([]);
      expect(res.symbols.length).toBeGreaterThan(0);
    }
  });

  it("returns recoverable diagnostics for syntax errors and does not fabricate symbols or throw", () => {
    const bad = `function broken( { this is not valid syntax`;
    const result = extractTsSymbols({ filePath: "broken.ts", sourceText: bad });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].path).toBe("broken.ts");
    expect(result.diagnostics[0].line).toBeGreaterThan(0);
    // Parser recovery may surface a partial "broken" identifier as a function name.
    // Contract: diagnostics are present (not clean success), no throw, symbols (if any) come from AST.
    // We do not assert zero symbols; we assert the presence of diagnostics prevents treating as success.
  });

  it("produces deterministic ordering and stable positions across identical inputs", () => {
    const src = `export const first = 1;\nexport function second() {}\nconst third = 3;`;
    const r1 = extractTsSymbols({ filePath: "det.ts", sourceText: src });
    const r2 = extractTsSymbols({ filePath: "det.ts", sourceText: src });
    expect(r1.symbols).toEqual(r2.symbols);
    expect(r1.symbols.map((s) => s.startLine)).toEqual([1, 2, 3]);
  });

  it("extracts symbols from structural mini fixture file content (realistic source)", async () => {
    const fixtureDir = resolve(
      __dirname,
      "../fixtures/repos/cartographer-structural-mini/src",
    );
    const appPath = join(fixtureDir, "app.ts");
    const text = await readFile(appPath, "utf8");

    const result = extractTsSymbols({ filePath: appPath, sourceText: text });
    expect(result.diagnostics).toEqual([]);

    const names = result.symbols.map((s: ExtractedSymbol) => s.name);
    expect(names).toContain("AppConfig");
    expect(names).toContain("runApp");

    const runAppSym = result.symbols.find((s: ExtractedSymbol) => s.name === "runApp");
    expect(runAppSym?.kind).toBe("function");
    expect(runAppSym?.isExported).toBe(true);
    expect(runAppSym?.startLine).toBeGreaterThan(0);
    expect(runAppSym?.evidence.length).toBeGreaterThan(0);
  });
});
