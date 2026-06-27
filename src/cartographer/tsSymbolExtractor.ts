import {
  createSourceFile,
  ScriptTarget,
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
} from "typescript";

import {
  collectSyntaxParseDiagnostics,
  evidenceFor,
  lineOf,
  scriptKindFor,
  type ExtractionDiagnostic,
} from "./tsSourceHelpers";

export type { ExtractionDiagnostic };

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

export type ExtractTsSymbolsInput = {
  readonly filePath: string;
  readonly sourceText: string;
};

export type ExtractTsSymbolsResult = {
  readonly symbols: readonly ExtractedSymbol[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
};

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
 * Returns true for declaration kinds that carry a .name (or can be anonymous default for fn/class).
 */
function isNameBearingDeclaration(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isClassDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node) ||
    isEnumDeclaration(node)
  );
}

/**
 * True only for anonymous (no .name) default-exported function or class declarations.
 */
function isAnonymousDefaultDeclaration(node: Node): boolean {
  if (isFunctionDeclaration(node)) {
    return !node.name && isDefaultExport(node);
  }
  if (isClassDeclaration(node)) {
    return !node.name && isDefaultExport(node);
  }
  return false;
}

/**
 * Extract a name for a declaration node when possible.
 * For anonymous default exports we return "default".
 */
function getDeclarationName(node: Node): string | undefined {
  if (!isNameBearingDeclaration(node)) {
    return undefined;
  }
  const decl = node as { name?: { text?: string } };
  if (decl.name?.text) {
    return decl.name.text;
  }
  // Anonymous default export function/class
  if (isAnonymousDefaultDeclaration(node)) {
    return "default";
  }
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
 * Collects direct (non-nested) variable binding names from an Identifier or
 * ObjectBindingPattern / ArrayBindingPattern. Returns pairs of the node to use
 * for makeSymbol (the id or the BindingElement) and the name text.
 * Matches prior logic: only direct identifiers; nested patterns and rests are ignored.
 */
function collectVariableNamesFromBindingName(
  nameNode: Node,
): { bindingNode: Node; name: string }[] {
  if (isIdentifier(nameNode)) {
    return [{ bindingNode: nameNode, name: nameNode.text }];
  }
  if (isObjectBindingPattern(nameNode)) {
    const results: { bindingNode: Node; name: string }[] = [];
    for (const el of nameNode.elements) {
      if (isBindingElement(el) && isIdentifier(el.name)) {
        results.push({ bindingNode: el, name: el.name.text });
      }
    }
    return results;
  }
  if (isArrayBindingPattern(nameNode)) {
    const results: { bindingNode: Node; name: string }[] = [];
    for (const el of nameNode.elements) {
      if (isBindingElement(el) && isIdentifier(el.name)) {
        results.push({ bindingNode: el, name: el.name.text });
      }
    }
    return results;
  }
  return [];
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
    const bindings = collectVariableNamesFromBindingName(decl.name);
    for (const { bindingNode, name } of bindings) {
      out.push(
        makeSymbol(sourceFile, bindingNode, "variable", name, isExported),
      );
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
 * Emit symbol for a function/class/interface/typeAlias/enum using shared name/export logic.
 * Preserves "default" fallback exactly for fn/class that reach without a name.
 */
function emitNamedDeclarationSymbol(
  sourceFile: SourceFile,
  node: Node,
  kind: "function" | "class" | "interface" | "typeAlias" | "enum",
  out: ExtractedSymbol[],
): void {
  let name = getDeclarationName(node);
  if (!name) {
    if (kind === "function" || kind === "class") {
      name = "default";
    } else {
      return;
    }
  }
  const isExported =
    kind === "function" || kind === "class"
      ? hasExportModifier(node) || isDefaultExport(node)
      : hasExportModifier(node);
  out.push(makeSymbol(sourceFile, node, kind, name, isExported));
}

/**
 * Small dispatcher for the named declaration kinds; keeps visitNode lean.
 */
function visitNamedDeclaration(
  sourceFile: SourceFile,
  node: Node,
  out: ExtractedSymbol[],
): void {
  if (isFunctionDeclaration(node)) {
    emitNamedDeclarationSymbol(sourceFile, node, "function", out);
  } else if (isClassDeclaration(node)) {
    emitNamedDeclarationSymbol(sourceFile, node, "class", out);
  } else if (isInterfaceDeclaration(node)) {
    emitNamedDeclarationSymbol(sourceFile, node, "interface", out);
  } else if (isTypeAliasDeclaration(node)) {
    emitNamedDeclarationSymbol(sourceFile, node, "typeAlias", out);
  } else if (isEnumDeclaration(node)) {
    emitNamedDeclarationSymbol(sourceFile, node, "enum", out);
  }
}

/**
 * Main recursive visitor using forEachChild.
 */
function visitNode(
  sourceFile: SourceFile,
  node: Node,
  out: ExtractedSymbol[],
): void {
  if (isNameBearingDeclaration(node)) {
    visitNamedDeclaration(sourceFile, node, out);
  } else if (isVariableStatement(node)) {
    visitVariableStatement(sourceFile, node, out);
  } else if (isExportDeclaration(node)) {
    visitExportDeclaration(sourceFile, node, out);
  }

  // Recurse
  forEachChild(node, (child) => visitNode(sourceFile, child, out));
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
  const diagnostics: ExtractionDiagnostic[] = collectSyntaxParseDiagnostics(sourceFile, filePath);

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
