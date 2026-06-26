import {
  createSourceFile,
  ScriptTarget,
  ScriptKind,
  flattenDiagnosticMessageText,
  SyntaxKind,
  canHaveModifiers,
  getModifiers,
  forEachChild,
  isFunctionDeclaration,
  isClassDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isEnumDeclaration,
  isIdentifier,
  isObjectBindingPattern,
  isArrayBindingPattern,
  isBindingElement,
  isNamedExports,
  isNamespaceExport,
  isStringLiteral,
  isVariableStatement,
  isExportDeclaration,
  type SourceFile,
  type Node,
  type VariableStatement,
  type ExportDeclaration,
  type DiagnosticWithLocation,
} from "typescript";

/**
 * tsSymbolExtractor (Todo 18)
 *
 * Uses ONLY TypeScript Compiler API syntax parsing:
 * - createSourceFile with setParentNodes: true
 * - forEachChild traversal
 * - sourceFile.getLineAndCharacterOfPosition for 1-based lines
 *
 * No program construction or type analysis. No configuration or resolution.
 * Only syntax nodes from supported extensions are visited.
 */

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "typeAlias"
  | "enum"
  | "variable"
  | "export";

export type ExtractedSymbol = {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly isExported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly evidence: string;
};

export type ExtractionDiagnostic = {
  readonly path: string;
  readonly line: number;
  readonly message: string;
};

export type ExtractTsSymbolsInput = {
  readonly filePath: string;
  readonly sourceText: string;
};

export type ExtractTsSymbolsResult = {
  readonly symbols: readonly ExtractedSymbol[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
};

/**
 * Map extension to the correct ScriptKind for createSourceFile.
 * Only TS/JS family is supported for symbol extraction.
 */
function scriptKindFor(filePath: string): ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ScriptKind.JSX;
  if (lower.endsWith(".js")) return ScriptKind.JS;
  if (lower.endsWith(".mts")) return ScriptKind.TS;
  if (lower.endsWith(".cts")) return ScriptKind.TS;
  // Default to TS for unknown but we only call this for supported extensions upstream.
  return ScriptKind.TS;
}

/**
 * Get 1-based line number for a position.
 */
function lineOf(sourceFile: SourceFile, pos: number): number {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return lc.line + 1;
}

/**
 * Get a stable evidence string: the trimmed first line of the declaration.
 * Bounded to the declaration's start line only.
 */
function evidenceFor(sourceFile: SourceFile, node: Node): string {
  const start = node.getStart(sourceFile);
  const startLine = lineOf(sourceFile, start);
  const lineStart = sourceFile.getLineStarts()[startLine - 1] ?? 0;
  const lineEnd = sourceFile.getLineStarts()[startLine] ?? sourceFile.text.length;
  const rawLine = sourceFile.text.slice(lineStart, lineEnd);
  return rawLine.trimEnd();
}

/**
 * Determine if a node has an export modifier.
 */
function hasExportModifier(node: Node): boolean {
  if (!canHaveModifiers(node)) {
    return false;
  }
  const mods = getModifiers(node);
  if (!mods) return false;
  return mods.some((m) => m.kind === SyntaxKind.ExportKeyword);
}

/**
 * Determine if a node is a default export (export default ...).
 */
function isDefaultExport(node: Node): boolean {
  if (!canHaveModifiers(node)) {
    return false;
  }
  const mods = getModifiers(node);
  if (!mods) return false;
  return mods.some((m) => m.kind === SyntaxKind.ExportKeyword) &&
         mods.some((m) => m.kind === SyntaxKind.DefaultKeyword);
}

/**
 * Extract a name for a declaration node when possible.
 * For anonymous default exports we return "default".
 */
function getDeclarationName(node: Node): string | undefined {
  // FunctionDeclaration / ClassDeclaration / InterfaceDeclaration / TypeAlias / Enum
  if (
    isFunctionDeclaration(node) ||
    isClassDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node) ||
    isEnumDeclaration(node)
  ) {
    if (node.name) {
      return node.name.text;
    }
    // Anonymous default export function/class
    if (isDefaultExport(node)) {
      return "default";
    }
    return undefined;
  }

  // VariableStatement: we will handle inside visitVariableStatement
  return undefined;
}

/**
 * Create an ExtractedSymbol for a named declaration.
 */
function makeSymbol(
  sourceFile: SourceFile,
  node: Node,
  kind: SymbolKind,
  name: string,
  isExported: boolean,
): ExtractedSymbol {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startLine = lineOf(sourceFile, start);
  const endLine = lineOf(sourceFile, end);
  return {
    kind,
    name,
    isExported,
    startLine,
    endLine,
    evidence: evidenceFor(sourceFile, node),
  };
}

/**
 * Handle VariableStatement: may contain multiple declarations.
 * We emit one symbol per exported/local binding we can name.
 */
function visitVariableStatement(
  sourceFile: SourceFile,
  stmt: VariableStatement,
  out: ExtractedSymbol[],
): void {
  const isExported = hasExportModifier(stmt);
  for (const decl of stmt.declarationList.declarations) {
    // Simple identifier binding
    if (isIdentifier(decl.name)) {
      out.push(
        makeSymbol(sourceFile, decl, "variable", decl.name.text, isExported),
      );
      continue;
    }
    // Object binding pattern: export const { a, b: c } = ...
    if (isObjectBindingPattern(decl.name)) {
      for (const el of decl.name.elements) {
        if (isBindingElement(el) && isIdentifier(el.name)) {
          out.push(
            makeSymbol(sourceFile, el, "variable", el.name.text, isExported),
          );
        }
      }
    }
    // Array binding pattern: export const [a, b] = ...
    if (isArrayBindingPattern(decl.name)) {
      for (const el of decl.name.elements) {
        if (isBindingElement(el) && isIdentifier(el.name)) {
          out.push(
            makeSymbol(sourceFile, el, "variable", el.name.text, isExported),
          );
        }
      }
    }
  }
}

/**
 * Handle ExportDeclaration nodes (export {..}, export * from, export {..} from, export type {..} from).
 * We record them as kind "export" with a descriptive name for evidence.
 */
function visitExportDeclaration(
  sourceFile: SourceFile,
  node: ExportDeclaration,
  out: ExtractedSymbol[],
): void {
  const start = node.getStart(sourceFile);
  const startLine = lineOf(sourceFile, start);
  const evidence = evidenceFor(sourceFile, node);

  let name = "export";
  if (node.exportClause) {
    if (isNamedExports(node.exportClause)) {
      const specifiers = node.exportClause.elements
        .map((e) => {
          if (e.propertyName && isIdentifier(e.name)) {
            return `${e.propertyName.text} as ${e.name.text}`;
          }
          return e.name.text;
        })
        .join(", ");
      name = `{ ${specifiers} }`;
    } else if (isNamespaceExport(node.exportClause)) {
      name = `* as ${node.exportClause.name.text}`;
    }
  } else {
    // export * from "..."
    name = "* from";
  }

  if (node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
    name = `${name} from`;
  }

  // Type-only re-exports are still "export" kind for our purposes.
  out.push({
    kind: "export",
    name,
    isExported: true,
    startLine,
    endLine: lineOf(sourceFile, node.getEnd()),
    evidence,
  });
}

/**
 * Main recursive visitor using forEachChild.
 */
function visitNode(
  sourceFile: SourceFile,
  node: Node,
  out: ExtractedSymbol[],
): void {
  // Declarations we care about
  if (isFunctionDeclaration(node)) {
    const name = getDeclarationName(node) ?? "default";
    const exported = hasExportModifier(node) || isDefaultExport(node);
    out.push(makeSymbol(sourceFile, node, "function", name, exported));
  } else if (isClassDeclaration(node)) {
    const name = getDeclarationName(node) ?? "default";
    const exported = hasExportModifier(node) || isDefaultExport(node);
    out.push(makeSymbol(sourceFile, node, "class", name, exported));
  } else if (isInterfaceDeclaration(node)) {
    const name = getDeclarationName(node);
    if (name) {
      out.push(makeSymbol(sourceFile, node, "interface", name, hasExportModifier(node)));
    }
  } else if (isTypeAliasDeclaration(node)) {
    const name = getDeclarationName(node);
    if (name) {
      out.push(makeSymbol(sourceFile, node, "typeAlias", name, hasExportModifier(node)));
    }
  } else if (isEnumDeclaration(node)) {
    const name = getDeclarationName(node);
    if (name) {
      out.push(makeSymbol(sourceFile, node, "enum", name, hasExportModifier(node)));
    }
  } else if (isVariableStatement(node)) {
    visitVariableStatement(sourceFile, node, out);
  } else if (isExportDeclaration(node)) {
    visitExportDeclaration(sourceFile, node, out);
  }

  // Recurse
  forEachChild(node, (child) => visitNode(sourceFile, child, out));
}

/**
 * Type predicate to access parse diagnostics without casts at the call site.
 */
function hasParseDiagnostics(sf: SourceFile): sf is SourceFile & { parseDiagnostics: readonly DiagnosticWithLocation[] } {
  return Object.prototype.hasOwnProperty.call(sf, "parseDiagnostics");
}

/**
 * Extract symbols using syntax parsing only.
 * Returns symbols (sorted by startLine then name for determinism) and any parse diagnostics.
 */
export function extractTsSymbols(input: ExtractTsSymbolsInput): ExtractTsSymbolsResult {
  const { filePath, sourceText } = input;

  const scriptKind = scriptKindFor(filePath);
  const sourceFile = createSourceFile(
    filePath,
    sourceText,
    ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind,
  );

  const symbols: ExtractedSymbol[] = [];
  const diagnostics: ExtractionDiagnostic[] = [];

  // Surface syntax errors reported by the parser.
  // The parser attaches them directly to the returned source file object.
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

  // Traverse and collect symbols even if there were errors (partial results are acceptable).
  visitNode(sourceFile, sourceFile, symbols);

  // Deterministic ordering: by startLine asc, then name asc.
  const sorted = [...symbols].sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return {
    symbols: sorted,
    diagnostics,
  };
}
