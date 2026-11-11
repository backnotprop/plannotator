import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';

const ts: typeof TypeScript = createRequire(new URL('../packages/core/package.json', import.meta.url))('typescript');

export interface FileProblem {
  path: string;
  reason: string;
}

export interface Verdict {
  commentsOnly: boolean;
  files: number;
  problems: FileProblem[];
}

const DIRECTIVE =
  /@ts-|^\/\/\/\s*<|eslint|oxlint|biome-ignore|deno-lint|[@#]__[A-Z_]+__|prettier-ignore|@jsx|istanbul|[cv]8 ignore|@license|@preserve|^\/[*/]!|@vite-ignore|webpack[A-Z]|-guard:/;

const LINE_SCOPED_DIRECTIVE = /@ts-expect-error|@ts-ignore|next-line|disable-line|biome-ignore|prettier-ignore|ignore next|-guard:/;

const SOURCE_EXTENSION = /\.tsx?$/;

function isJSDocKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

function isJsxText(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
}

function isEmptyJsxExpression(node: ts.Node): boolean {
  return ts.isJsxExpression(node) && !node.expression && !node.dotDotDotToken;
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

interface Shape {
  tree: string[];
  directives: string[];
  shebang: string | undefined;
  parseErrors: number;
}

function shapeOf(path: string, text: string): Shape {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const tree: string[] = [];
  const tokens: ts.Node[] = [];

  const emitJsxChildren = (children: readonly ts.Node[]) => {
    let pendingText = '';
    const flush = () => {
      if (pendingText) tree.push(`JsxText:${pendingText}`);
      pendingText = '';
    };
    for (const child of children) {
      if (isEmptyJsxExpression(child)) continue;
      if (isJsxText(child)) {
        pendingText += jsxTextAsCompiled(child.getText(file));
        continue;
      }
      flush();
      visit(child);
    }
    flush();
  };

  const visit = (node: ts.Node) => {
    if (isJSDocKind(node.kind)) return;
    const children = node.getChildren(file);
    if (node.kind <= ts.SyntaxKind.LastToken && !isJsxText(node)) tokens.push(node);
    if (children.length === 0) {
      tree.push(`${ts.SyntaxKind[node.kind]}:${node.getText(file)}`);
      return;
    }
    tree.push(`(${ts.SyntaxKind[node.kind]}`);
    const holdsJsxChildren = ts.isJsxElement(node) || ts.isJsxFragment(node);
    for (const child of children) {
      if (holdsJsxChildren && child.kind === ts.SyntaxKind.SyntaxList) {
        tree.push('(JsxChildren');
        emitJsxChildren(child.getChildren(file));
        tree.push(')');
      } else {
        visit(child);
      }
    }
    tree.push(')');
  };
  visit(file);

  const lineOf = (position: number) => file.getLineAndCharacterOfPosition(position).line;
  const directives: string[] = [];
  tokens.forEach((token, index) => {
    const previousEnd = index > 0 ? lineOf(tokens[index - 1].end) : -1;
    for (const range of ts.getLeadingCommentRanges(text, token.pos) ?? []) {
      const comment = text.slice(range.pos, range.end);
      if (!DIRECTIVE.test(comment)) continue;
      let placement = `before token ${index}`;
      if (LINE_SCOPED_DIRECTIVE.test(comment)) {
        const linesToToken = lineOf(token.getStart(file)) - lineOf(range.end);
        const trailsCode = lineOf(range.pos) === previousEnd;
        placement += `, ${linesToToken} lines above it${trailsCode ? ', after code on its line' : ''}`;
      }
      directives.push(`${comment.trim()} | ${placement}`);
    }
  });

  const parseErrors = (file as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0;
  return { tree, directives, shebang: ts.getShebang(text), parseErrors };
}

export function compareSource(path: string, before: string, after: string): string | null {
  if (!SOURCE_EXTENSION.test(path)) return 'not a .ts or .tsx file';
  const old = shapeOf(path, before);
  const next = shapeOf(path, after);
  if (old.parseErrors || next.parseErrors) return 'does not parse cleanly';
  if (old.shebang !== next.shebang) return 'shebang line changed';
  const length = Math.max(old.tree.length, next.tree.length);
  for (let i = 0; i < length; i++) {
    if (old.tree[i] !== next.tree[i]) {
      return `code changed: ${describe(old.tree[i])} became ${describe(next.tree[i])}`;
    }
  }
  const directiveCount = Math.max(old.directives.length, next.directives.length);
  for (let i = 0; i < directiveCount; i++) {
    if (old.directives[i] !== next.directives[i]) {
      return `tool directive comment changed: ${describe(old.directives[i])} became ${describe(next.directives[i])}`;
    }
  }
  return null;
}

function describe(item: string | undefined): string {
  if (item === undefined) return 'nothing';
  const oneLine = item.replace(/\s+/g, ' ');
  return JSON.stringify(oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine);
}

function git(repo: string, args: string[], input?: Uint8Array): Uint8Array {
  const run = Bun.spawnSync(['git', '-C', repo, ...args], { stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString().trim()}`);
  return run.stdout;
}

interface Change {
  path: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  status: string;
}

function changesBetween(repo: string, base: string, head: string): Change[] {
  const mergeBase = new TextDecoder().decode(git(repo, ['merge-base', base, head])).trim();
  const raw = new TextDecoder().decode(
    git(repo, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--abbrev=40', mergeBase, head]),
  );
  const fields = raw.split('\0').filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldBlob, newBlob, status] = fields[i].replace(/^:/, '').split(' ');
    changes.push({ path: fields[i + 1], oldMode, newMode, oldBlob, newBlob, status });
  }
  return changes;
}

function readBlobs(repo: string, ids: string[]): Map<string, string> {
  const out = git(repo, ['cat-file', '--batch'], new TextEncoder().encode(`${ids.join('\n')}\n`));
  const blobs = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < out.length) {
    const headerEnd = out.indexOf(10, offset);
    const [id, type, size] = decoder.decode(out.subarray(offset, headerEnd)).split(' ');
    if (type !== 'blob') throw new Error(`git object ${id} is ${type ?? 'missing'}`);
    const start = headerEnd + 1;
    blobs.set(id, decoder.decode(out.subarray(start, start + Number(size))));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

function problemWithChange(change: Change): string | null {
  if (change.status === 'A') return 'file added';
  if (change.status === 'D') return 'file deleted';
  if (change.status !== 'M') return `change of type ${change.status}`;
  if (!SOURCE_EXTENSION.test(change.path)) return 'not a .ts or .tsx file';
  if (change.oldMode !== change.newMode) return `file mode changed ${change.oldMode} -> ${change.newMode}`;
  if (change.newMode !== '100644' && change.newMode !== '100755') return `not a regular file (mode ${change.newMode})`;
  return null;
}

export function verifyCommentsOnly(repo: string, base: string, head: string): Verdict {
  const changes = changesBetween(repo, base, head);
  const problems: FileProblem[] = [];
  const comparable: Change[] = [];
  for (const change of changes) {
    const problem = problemWithChange(change);
    if (problem) problems.push({ path: change.path, reason: problem });
    else comparable.push(change);
  }
  const blobs = comparable.length ? readBlobs(repo, comparable.flatMap((c) => [c.oldBlob, c.newBlob])) : new Map();
  for (const change of comparable) {
    const reason = compareSource(change.path, blobs.get(change.oldBlob)!, blobs.get(change.newBlob)!);
    if (reason) problems.push({ path: change.path, reason });
  }
  return { commentsOnly: changes.length > 0 && problems.length === 0, files: changes.length, problems };
}

export function formatVerdict(verdict: Verdict, shown = 10): string {
  if (verdict.commentsOnly) return `Comments only: verified (${verdict.files} files, code identical once comments are removed).`;
  if (verdict.files === 0) return 'Not comments only: the change touches no files.';
  const lines = [`Not comments only: ${verdict.problems.length} of ${verdict.files} files changed more than comments.`];
  for (const problem of verdict.problems.slice(0, shown)) lines.push(`  ${problem.path}: ${problem.reason}`);
  if (verdict.problems.length > shown) lines.push(`  ... and ${verdict.problems.length - shown} more`);
  return lines.join('\n');
}

const BEHAVIOR_TESTS_IN_GUARD_FOLDERS = new Set(['scripts/install.test.ts', 'scripts/install-download.test.ts']);

export function sourceGuardTests(repo: string): string[] {
  const listed = new TextDecoder().decode(git(repo, ['ls-files', 'tests', 'scripts'])).split('\n');
  return listed.filter((path) => /^(tests|scripts)\/[^/]+\.test\.tsx?$/.test(path) && !BEHAVIOR_TESTS_IN_GUARD_FOLDERS.has(path));
}

function runSourceGuards(): never {
  const run = Bun.spawnSync(['bun', 'test', ...sourceGuardTests(process.cwd())], { stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit(run.exitCode ?? 1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === 'guards') runSourceGuards();
  const repoFlag = args.indexOf('--repo');
  const repo = repoFlag >= 0 ? args.splice(repoFlag, 2)[1] : process.cwd();
  const [base, head] = args;
  if (!repo || !base || !head) {
    console.error('usage: bun run scripts/ci-comments-only.ts [--repo <dir>] <base> <head> | guards');
    process.exit(2);
  }
  const verdict = verifyCommentsOnly(repo, base, head);
  const report = formatVerdict(verdict);
  console.log(report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verified=${verdict.commentsOnly}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${report}\n\`\`\`\n`);
  process.exit(verdict.commentsOnly ? 0 : 1);
}
