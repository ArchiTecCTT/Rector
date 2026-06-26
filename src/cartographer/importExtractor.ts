import path from "node:path";

import {
  createSourceFile,
  ScriptTarget,
  ScriptKind,
  flattenDiagnosticMessageText,
  forEachChild,
  isImportDeclaration,
  isExportDeclaration,
  isStringLiteral,
  isCallExpression,
  isIdentifier,
  SyntaxKind,
  type SourceFile,
  type Node,
  type ImportDeclaration,
  type ExportDeclaration,
  type CallExpression,
  type DiagnosticWithLocation,
} from "typescript";

import { normalizePath } from "./graphIds";
import type { ExtractionDiagnostic } from "./tsSymbolExtractor";

/**
 * importExtractor (Todo 19)
 *
 * Uses ONLY TypeScript Compiler API syntax parsing:
 * - createSourceFile with setParentNodes: true
 * - forEachChild traversal
 * - sourceFile.getLineAndCharacterOfPosition for 1-based lines
 *
 * No program construction, no type analysis, no tsconfig, no resolution beyond
 * deterministic relative lookup against a provided indexed file list.
 *
 * Extracts:
 * - static import declarations
 * - static-string dynamic import() literals
 * - export-from declarations (including export type * from)
 * - syntax-obvious CommonJS require("lit") calls (identifier callee + string literal arg)
 *
 * Resolution:
 * - Only relative specifiers (starting with "./" or "../") are resolved against indexedFiles.
 * - Deterministic candidates: exact, +supported extensions, +/index+extension.
 * - Bare specifiers become package targets.
 * - Path-alias-like specifiers (e.g. "@/...", "~/...") become unresolved/not_configured.
 * - Unresolved relative become unresolved/not_found.
 * - Never fabricate file nodes for unresolved cases.
 */

export type ImportKind = "staticImport" | "dynamicImport" | "exportFrom" | "requireCall";

export type FileTarget = {
  readonly kind: "file";
  readonly normalizedPath: string;
};

export type PackageTarget = {
  readonly kind: "package";
  readonly specifier: string;
};

export type UnresolvedTarget = {
  readonly kind: "unresolved";
  readonly reason: "not_found" | "not_configured";
};

export type ResolvedTarget = FileTarget | PackageTarget | UnresolvedTarget;

export type ImportRecord = {
  readonly kind: ImportKind;
  readonly specifier: string;
  readonly target: ResolvedTarget;
  readonly startLine: number;
  readonly endLine: number;
  readonly evidence: string;
};

export type ExtractImportsInput = {
  readonly filePath: string;
  readonly sourceText: string;
  readonly indexedFiles: readonly string[];
};

export type ExtractImportsResult = {
  readonly imports: readonly ImportRecord[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
};

const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"] as const;

function scriptKindFor(filePath: string): ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ScriptKind.JSX;
  if (lower.endsWith(".js")) return ScriptKind.JS;
  if (lower.endsWith(".mts")) return ScriptKind.TS;
  if (lower.endsWith(".cts")) return ScriptKind.TS;
  return ScriptKind.TS;
}

function lineOf(sourceFile: SourceFile, pos: number): number {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return lc.line + 1;
}

function evidenceFor(sourceFile: SourceFile, node: Node): string {
  const start = node.getStart(sourceFile);
  const startLine = lineOf(sourceFile, start);
  const lineStart = sourceFile.getLineStarts()[startLine - 1] ?? 0;
  const lineEnd = sourceFile.getLineStarts()[startLine] ?? sourceFile.text.length;
  const rawLine = sourceFile.text.slice(lineStart, lineEnd);
  return rawLine.trimEnd();
}

function hasParseDiagnostics(sf: SourceFile): sf is SourceFile & { parseDiagnostics: readonly DiagnosticWithLocation[] } {
  return Object.prototype.hasOwnProperty.call(sf, "parseDiagnostics");
}

function isAliasLike(specifier: string): boolean {
  // Phase 1: common tsconfig path alias patterns are reported unresolved/not_configured.
  // Do not implement alias resolution.
  if (specifier.startsWith("@/")) return true;
  if (specifier.startsWith("~/")) return true;
  // Also catch bare ~ or other root-mapped styles seen in some configs.
  return specifier === "~" || specifier.startsWith("~/");
}

function resolveRelative(
  specifier: string,
  importerFile: string,
  indexed: Set<string>,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  const normImporter = normalizePath(importerFile);
  const importerDir = normImporter.includes("/")
    ? normImporter.slice(0, normImporter.lastIndexOf("/"))
    : ".";
  // Join relative to importer dir (posix)
  const joined = path.posix.join(importerDir === "." ? "" : importerDir, specifier);
  const base = normalizePath(joined);

  if (indexed.has(base)) return base;

  for (const ext of SUPPORTED_EXTS) {
    const withExt = base + ext;
    if (indexed.has(withExt)) return withExt;
  }

  for (const ext of SUPPORTED_EXTS) {
    const idx = path.posix.join(base, `index${ext}`);
    if (indexed.has(idx)) return idx;
  }

  return null;
}

function resolveTarget(
  specifier: string,
  importerFile: string,
  indexed: Set<string>,
): ResolvedTarget {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = resolveRelative(specifier, importerFile, indexed);
    if (resolved) {
      return { kind: "file", normalizedPath: resolved };
    }
    return { kind: "unresolved", reason: "not_found" };
  }

  if (isAliasLike(specifier)) {
    return { kind: "unresolved", reason: "not_configured" };
  }

  // Bare specifier or subpath package (e.g. "express", "zod", "@scope/pkg", "foo/bar")
  return { kind: "package", specifier };
}

function makeRecord(
  sourceFile: SourceFile,
  node: Node,
  kind: ImportKind,
  specifier: string,
  target: ResolvedTarget,
): ImportRecord {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startLine = lineOf(sourceFile, start);
  const endLine = lineOf(sourceFile, end);
  return {
    kind,
    specifier,
    target,
    startLine,
    endLine,
    evidence: evidenceFor(sourceFile, node),
  };
}

function visitNode(
  sourceFile: SourceFile,
  node: Node,
  out: ImportRecord[],
  diagnostics: ExtractionDiagnostic[],
  filePath: string,
  indexed: Set<string>,
): void {
  if (isImportDeclaration(node)) {
    const mod = (node as ImportDeclaration).moduleSpecifier;
    if (isStringLiteral(mod)) {
      const spec = mod.text;
      const target = resolveTarget(spec, filePath, indexed);
      out.push(makeRecord(sourceFile, node, "staticImport", spec, target));
      if (target.kind === "unresolved") {
        diagnostics.push({
          path: filePath,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          message: `unresolved import ${spec} (${target.reason})`,
        });
      }
    }
  } else if (isExportDeclaration(node)) {
    const mod = (node as ExportDeclaration).moduleSpecifier;
    if (mod && isStringLiteral(mod)) {
      const spec = mod.text;
      const target = resolveTarget(spec, filePath, indexed);
      out.push(makeRecord(sourceFile, node, "exportFrom", spec, target));
      if (target.kind === "unresolved") {
        diagnostics.push({
          path: filePath,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          message: `unresolved export from ${spec} (${target.reason})`,
        });
      }
    }
  } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (arg && isStringLiteral(arg)) {
      const spec = arg.text;
      const target = resolveTarget(spec, filePath, indexed);
      out.push(makeRecord(sourceFile, node, "dynamicImport", spec, target));
      if (target.kind === "unresolved") {
        diagnostics.push({
          path: filePath,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          message: `unresolved dynamic import ${spec} (${target.reason})`,
        });
      }
    }
  } else if (isCallExpression(node)) {
    const call = node as CallExpression;
    const callee = call.expression;
    if (isIdentifier(callee) && callee.text === "require") {
      const arg = call.arguments[0];
      if (arg && isStringLiteral(arg)) {
        const spec = arg.text;
        const target = resolveTarget(spec, filePath, indexed);
        out.push(makeRecord(sourceFile, node, "requireCall", spec, target));
        if (target.kind === "unresolved") {
          diagnostics.push({
            path: filePath,
            line: lineOf(sourceFile, node.getStart(sourceFile)),
            message: `unresolved require ${spec} (${target.reason})`,
          });
        }
      }
    }
  }

  forEachChild(node, (child) => visitNode(sourceFile, child, out, diagnostics, filePath, indexed));
}

export function extractImports(input: ExtractImportsInput): ExtractImportsResult {
  const { filePath, sourceText, indexedFiles } = input;

  const scriptKind = scriptKindFor(filePath);
  const sourceFile = createSourceFile(
    filePath,
    sourceText,
    ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind,
  );

  const imports: ImportRecord[] = [];
  const diagnostics: ExtractionDiagnostic[] = [];

  // Surface syntax parse diagnostics (recoverable)
  const diags = hasParseDiagnostics(sourceFile) ? sourceFile.parseDiagnostics : [];
  for (const d of diags) {
    const line = d.start !== undefined ? lineOf(sourceFile, d.start) : 1;
    const message = flattenDiagnosticMessageText(d.messageText, "\n");
    diagnostics.push({
      path: filePath,
      line,
      message,
    });
  }

  const indexed = new Set(indexedFiles.map((p) => normalizePath(p)));

  visitNode(sourceFile, sourceFile, imports, diagnostics, filePath, indexed);

  // Deterministic sort: startLine asc, then specifier asc
  const sorted = [...imports].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0;
  });

  return {
    imports: sorted,
    diagnostics,
  };
}
