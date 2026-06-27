import {
  ScriptKind,
  flattenDiagnosticMessageText,
  type SourceFile,
  type Node,
  type DiagnosticWithLocation,
} from "typescript";

export type ExtractionDiagnostic = {
  readonly path: string;
  readonly line: number;
  readonly message: string;
};

/**
 * Map extension to the correct ScriptKind for createSourceFile.
 * Only TS/JS family is supported for syntax parsing.
 */
export function scriptKindFor(filePath: string): ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ScriptKind.JSX;
  if (lower.endsWith(".js")) return ScriptKind.JS;
  if (lower.endsWith(".mts")) return ScriptKind.TS;
  if (lower.endsWith(".cts")) return ScriptKind.TS;
  return ScriptKind.TS;
}

/** Get 1-based line number for a position. */
export function lineOf(sourceFile: SourceFile, pos: number): number {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return lc.line + 1;
}

/**
 * Get a stable evidence string: the trimmed first line of the declaration.
 * Bounded to the declaration's start line only.
 */
export function evidenceFor(sourceFile: SourceFile, node: Node): string {
  const start = node.getStart(sourceFile);
  const startLine = lineOf(sourceFile, start);
  const lineStart = sourceFile.getLineStarts()[startLine - 1] ?? 0;
  const lineEnd = sourceFile.getLineStarts()[startLine] ?? sourceFile.text.length;
  const rawLine = sourceFile.text.slice(lineStart, lineEnd);
  return rawLine.trimEnd();
}

/**
 * Type predicate to access parse diagnostics without casts at the call site.
 */
export function hasParseDiagnostics(
  sf: SourceFile,
): sf is SourceFile & { parseDiagnostics: readonly DiagnosticWithLocation[] } {
  return Object.prototype.hasOwnProperty.call(sf, "parseDiagnostics");
}

/** Collect syntax parse diagnostics from a source file into extraction diagnostics. */
export function collectSyntaxParseDiagnostics(
  sourceFile: SourceFile,
  filePath: string,
): ExtractionDiagnostic[] {
  const out: ExtractionDiagnostic[] = [];
  const diags = hasParseDiagnostics(sourceFile) ? sourceFile.parseDiagnostics : [];
  for (const d of diags) {
    const line = d.start !== undefined ? lineOf(sourceFile, d.start) : 1;
    const message = flattenDiagnosticMessageText(d.messageText, "\n");
    out.push({
      path: filePath,
      line,
      message,
    });
  }
  return out;
}