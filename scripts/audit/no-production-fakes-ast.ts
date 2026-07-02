import ts from "typescript";

export type AstRuleMatch = {
  readonly index: number;
  readonly evidence: string;
};

export type AstDetector = (content: string, fileName: string) => readonly AstRuleMatch[];

export function scriptKindForFileName(fileName: string): ts.ScriptKind {
  const extension = fileName.slice(fileName.lastIndexOf("."));
  switch (extension) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".mts":
      return ts.ScriptKind.JS;
    case ".cts":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

export function parseSourceFile(content: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKindForFileName(fileName));
}

export function collectAstMatches(content: string, fileName: string, collect: (sourceFile: ts.SourceFile) => readonly AstRuleMatch[]): readonly AstRuleMatch[] {
  try {
    const sourceFile = parseSourceFile(content, fileName);
    return collect(sourceFile);
  } catch {
    return [];
  }
}

export function astDetector(collect: (sourceFile: ts.SourceFile) => readonly AstRuleMatch[]): AstDetector {
  return (content, fileName) => collectAstMatches(content, fileName, collect);
}

export function withRegexFallback(ast: AstDetector, regex: RegExp): (content: string, fileName?: string) => readonly AstRuleMatch[] {
  return (content, fileName = "source.ts") => {
    const astMatches = ast(content, fileName);
    if (astMatches.length > 0) {
      return astMatches;
    }
    const detectorPattern = new RegExp(regex.source, regex.flags);
    return [...content.matchAll(detectorPattern)].map((match) => ({
      index: match.index ?? 0,
      evidence: match[0],
    }));
  };
}

export function findIdentifierMatches(sourceFile: ts.SourceFile, names: readonly string[]): readonly AstRuleMatch[] {
  const wanted = new Set(names);
  const matches: AstRuleMatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && wanted.has(node.text)) {
      matches.push(matchFromNode(sourceFile, node, node.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

export function findImportModuleMatches(sourceFile: ts.SourceFile, moduleIncludes: readonly string[]): readonly AstRuleMatch[] {
  const matches: AstRuleMatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier !== undefined && moduleIncludes.some((fragment) => specifier.includes(fragment))) {
        const evidenceNode = node.moduleSpecifier ?? node;
        matches.push(matchFromNode(sourceFile, evidenceNode, evidenceNode.getText(sourceFile)));
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = dynamicImportSpecifierText(node.arguments[0]);
      if (specifier !== undefined && moduleIncludes.some((fragment) => specifier.includes(fragment))) {
        const evidenceNode = node.arguments[0] ?? node;
        matches.push(matchFromNode(sourceFile, evidenceNode, node.getText(sourceFile)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

export function findPropertyAccessMatches(sourceFile: ts.SourceFile, propertyPath: string): readonly AstRuleMatch[] {
  const matches: AstRuleMatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.getText(sourceFile) === propertyPath) {
      matches.push(matchFromNode(sourceFile, node, propertyPath));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

export function findStringLiteralMatches(sourceFile: ts.SourceFile, literal: string): readonly AstRuleMatch[] {
  const matches: AstRuleMatch[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === literal) {
      matches.push(matchFromNode(sourceFile, node, node.getText(sourceFile)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function moduleSpecifierText(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}

function dynamicImportSpecifierText(argument: ts.Expression | undefined): string | undefined {
  return moduleSpecifierText(argument);
}

function matchFromNode(sourceFile: ts.SourceFile, node: ts.Node, evidence: string): AstRuleMatch {
  const index = node.getStart(sourceFile, false);
  return { index, evidence: compactEvidence(evidence || node.getText(sourceFile)) };
}

function compactEvidence(evidence: string): string {
  return evidence.replace(/\s+/g, " ").trim();
}