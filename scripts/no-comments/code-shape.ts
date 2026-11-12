import type * as TypeScript from 'typescript';
import { parseErrorCount, parseSource, tokensOf, ts } from './find-comments.ts';

function isJsxText(node: TypeScript.Node): boolean {
  return node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
}

function jsxTextAsCompiled(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  const kept: string[] = [];
  lines.forEach((line, index) => {
    let text = line;
    if (index > 0) text = text.replace(/^[ \t]+/, '');
    if (index < lines.length - 1) text = text.replace(/[ \t]+$/, '');
    if (text) kept.push(text);
  });
  return kept.join(' ');
}

function isEmptyJsxExpressionBrace(token: TypeScript.Node): boolean {
  const parent = token.parent;
  return parent !== undefined && ts.isJsxExpression(parent) && !parent.expression && !parent.dotDotDotToken;
}

export function codeShape(path: string, text: string): string[] | null {
  const file = parseSource(path, text);
  if (parseErrorCount(file) > 0) return null;
  const shape: string[] = [];
  let pendingJsxText: string | null = null;
  const flush = () => {
    if (pendingJsxText) shape.push(`JsxText:${pendingJsxText}`);
    pendingJsxText = null;
  };
  for (const token of tokensOf(file)) {
    if (isEmptyJsxExpressionBrace(token)) continue;
    if (isJsxText(token)) {
      pendingJsxText = (pendingJsxText ?? '') + jsxTextAsCompiled(token.getText(file));
      continue;
    }
    flush();
    shape.push(`${token.kind}:${token.getText(file)}`);
  }
  flush();
  return shape;
}

export function sameCode(path: string, before: string, after: string): string | null {
  const old = codeShape(path, before);
  const next = codeShape(path, after);
  if (!old || !next) return 'does not parse cleanly';
  const length = Math.max(old.length, next.length);
  for (let i = 0; i < length; i++) {
    if (old[i] !== next[i]) return `code changed at token ${i}: ${JSON.stringify(old[i] ?? null)} became ${JSON.stringify(next[i] ?? null)}`;
  }
  return null;
}
