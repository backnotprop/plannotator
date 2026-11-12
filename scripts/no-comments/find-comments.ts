import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';

export const ts: typeof TypeScript = createRequire(new URL('../../packages/core/package.json', import.meta.url))('typescript');

export interface FoundComment {
  start: number;
  end: number;
  text: string;
}

export interface CommentSite {
  start: number;
  end: number;
  comments: FoundComment[];
  jsxExpression: boolean;
}

export interface ParsedSource {
  sites: CommentSite[];
  parseErrors: number;
}

const SCRIPT_KIND_BY_EXTENSION: Record<string, TypeScript.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

export const SOURCE_EXTENSIONS = Object.keys(SCRIPT_KIND_BY_EXTENSION);

export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function scriptKindOf(path: string): TypeScript.ScriptKind {
  const extension = SOURCE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  if (!extension) throw new Error(`not a source file: ${path}`);
  return SCRIPT_KIND_BY_EXTENSION[extension]!;
}

function isJSDocKind(kind: TypeScript.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

function isJsxText(node: TypeScript.Node): boolean {
  return node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
}

export function parseSource(path: string, text: string): TypeScript.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
}

export function parseErrorCount(file: TypeScript.SourceFile): number {
  return (file as unknown as { parseDiagnostics?: readonly TypeScript.Diagnostic[] }).parseDiagnostics?.length ?? 0;
}

export function tokensOf(file: TypeScript.SourceFile): TypeScript.Node[] {
  const tokens: TypeScript.Node[] = [];
  const visit = (node: TypeScript.Node) => {
    if (isJSDocKind(node.kind)) return;
    if (node.kind <= ts.SyntaxKind.LastToken) {
      tokens.push(node);
      return;
    }
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return tokens;
}

function commentsBefore(text: string, token: TypeScript.Node, file: TypeScript.SourceFile): FoundComment[] {
  if (isJsxText(token)) return [];
  const triviaEnd = token.getStart(file);
  if (triviaEnd === token.pos) return [];
  const ranges = [...(ts.getTrailingCommentRanges(text, token.pos) ?? []), ...(ts.getLeadingCommentRanges(text, token.pos) ?? [])];
  const seen = new Set<number>();
  const found: FoundComment[] = [];
  for (const range of ranges.sort((a, b) => a.pos - b.pos)) {
    if (seen.has(range.pos) || range.end > triviaEnd) continue;
    seen.add(range.pos);
    found.push({ start: range.pos, end: range.end, text: text.slice(range.pos, range.end) });
  }
  return found;
}

function emptyJsxExpressions(file: TypeScript.SourceFile): TypeScript.JsxExpression[] {
  const found: TypeScript.JsxExpression[] = [];
  const visit = (node: TypeScript.Node) => {
    if (ts.isJsxExpression(node) && !node.expression && !node.dotDotDotToken && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function findComments(path: string, text: string): ParsedSource {
  const file = parseSource(path, text);
  const comments = tokensOf(file).flatMap((token) => commentsBefore(text, token, file));
  const containers = emptyJsxExpressions(file).map((node) => ({ start: node.getStart(file), end: node.end }));
  const sites: CommentSite[] = [];
  const claimed = new Set<FoundComment>();
  for (const container of containers) {
    const inside = comments.filter((comment) => comment.start >= container.start && comment.end <= container.end);
    if (inside.length === 0) continue;
    inside.forEach((comment) => claimed.add(comment));
    sites.push({ start: container.start, end: container.end, comments: inside, jsxExpression: true });
  }
  for (const comment of comments) {
    if (!claimed.has(comment)) sites.push({ start: comment.start, end: comment.end, comments: [comment], jsxExpression: false });
  }
  sites.sort((a, b) => a.start - b.start);
  return { sites, parseErrors: parseErrorCount(file) };
}
