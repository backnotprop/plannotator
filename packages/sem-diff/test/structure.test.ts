// Moved, renamed and formatting-only changes at the declaration level.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';
import type { SemanticDiffOperation } from '../src/pierre-types.ts';

const PLAIN = new Set(['added', 'deleted', 'edited']);
/** The semantic operations only; plain edits are tested separately. */
const types = (ops: SemanticDiffOperation[]) => ops.map((o) => o.type).filter((t) => !PLAIN.has(t));

const users = `import { db } from './db';

export function formatUser(user: User): string {
  const name = \`\${user.first} \${user.last}\`;
  return \`\${name} <\${user.email}>\`;
}

export async function loadUser(id: string) {
  return db.users.find(id);
}

export async function saveUser(user: User) {
  await db.users.upsert(user);
}
`;

const usersMoved = `import { db } from './db';

export async function loadUser(id: string) {
  return db.users.find(id);
}

export async function saveUser(user: User) {
  await db.users.upsert(user);
}

export function formatUser(user: User): string {
  const name = \`\${user.first} \${user.last}\`;
  return \`\${name} <\${user.email}>\`;
}
`;

test('a function moved to the end is one move, and folds', async () => {
  const r = await semanticDiffFile('typescript', users, usersMoved);
  assert.deepEqual(types(r.semanticOperations), ['moved']);
  const op = r.semanticOperations[0]!;
  assert.deepEqual(op.lines, { old: [{ start: 3, end: 6, spanIndex: 0 }], new: [{ start: 11, end: 14, spanIndex: 0 }] });
  assert.deepEqual(r.semanticFolds, [{ old: { start: 3, end: 6 }, operations: [0], counts: { moved: 4, edited: 0, removed: 0 } }]);
});

test('moved and edited is movedWithEdit and does not fold', async () => {
  const r = await semanticDiffFile('typescript', users, usersMoved.replace('user.email', 'user.mail'));
  assert.deepEqual(types(r.semanticOperations), ['movedWithEdit']);
  assert.deepEqual(r.semanticFolds, []);
});

const retry = `const MAX_RETRIES = 3;

export function retry(fn: () => void) {
  for (let i = 0; i < MAX_RETRIES; i++) fn();
}
`;

test('a constant renamed everywhere is one rename covering every use', async () => {
  const r = await semanticDiffFile('typescript', retry, retry.replaceAll('MAX_RETRIES', 'MAX_ATTEMPTS'));
  assert.deepEqual(types(r.semanticOperations), ['renamed']);
  const span = r.semanticOperations[0]!.spans[0]!;
  assert.ok(span.relation === 'replaced');
  assert.equal(span.old.length, 2);
  assert.equal(span.new.length, 2);
  assert.deepEqual(r.semanticOperations[0]!.lines.old.map((l) => l.start), [1, 4]);
});

test('a local variable renamed inside a function is a rename', async () => {
  const r = await semanticDiffFile('typescript', retry, retry.replaceAll('let i', 'let n').replaceAll('i <', 'n <').replaceAll('i++', 'n++'));
  assert.deepEqual(types(r.semanticOperations), ['renamed']);
});

test('a name changed in only some places is not a rename', async () => {
  const partial = retry.replace('i < MAX_RETRIES', 'i < LIMIT');
  const r = await semanticDiffFile('typescript', retry, partial);
  assert.deepEqual(types(r.semanticOperations), []);
});

const config = `export function config() {
  return { timeout: 5000, retries: 3, verbose: false };
}
`;

test('re-wrapping an object is formatting only', async () => {
  const wrapped = `export function config() {
  return {
    timeout: 5000,
    retries: 3,
    verbose: false
  };
}
`;
  const r = await semanticDiffFile('typescript', config, wrapped);
  assert.deepEqual(types(r.semanticOperations), ['reformatted']);
  assert.deepEqual(r.semanticOperations[0]!.lines, { old: [{ start: 2, end: 2, spanIndex: 0 }], new: [{ start: 2, end: 6, spanIndex: 0 }] });
});

// Formatters (Prettier, rustfmt, gofmt) add a trailing comma when they wrap a list.
test('a trailing comma before a closing bracket is formatting', async () => {
  const comma = config.replace('verbose: false }', 'verbose: false, }');
  assert.deepEqual(types((await semanticDiffFile('typescript', config, comma)).semanticOperations), ['reformatted']);
});

test('a Python one-element tuple comma is a real change', async () => {
  const a = `def f():\n    return (x)\n`;
  const b = `def f():\n    return (x,)\n`;
  assert.deepEqual(types((await semanticDiffFile('python', a, b)).semanticOperations), []);
});

test('a line break that changes meaning is not formatting', async () => {
  const a = `export function f() {\n  return value\n}\n`;
  const b = `export function f() {\n  return\n  value\n}\n`;
  assert.deepEqual(types((await semanticDiffFile('typescript', a, b)).semanticOperations), []);
});

test('a blank line changed inside a multi-line string is shown', async () => {
  const a = 'export const t = `a\n\nb`;\n';
  const b = 'export const t = `a\nb`;\n';
  const r = await semanticDiffFile('typescript', a, b);
  assert.ok(r.semanticOperations.some((o) => o.lines.old.some((l) => l.start <= 2 && 2 <= l.end)), JSON.stringify(r.semanticOperations));
});

test('a comment-only edit is not hidden as formatting', async () => {
  const a = `export function f() {\n  // old note\n  return 1;\n}\n`;
  const b = `export function f() {\n  // new note\n  return 1;\n}\n`;
  assert.deepEqual(types((await semanticDiffFile('typescript', a, b)).semanticOperations), []);
});

test('Go: a function moved is one move', async () => {
  const a = `package p\n\nfunc A() int {\n\treturn 1\n}\n\nfunc B() int {\n\treturn 2\n}\n\nfunc C() int {\n\treturn 3\n}\n`;
  const b = `package p\n\nfunc B() int {\n\treturn 2\n}\n\nfunc C() int {\n\treturn 3\n}\n\nfunc A() int {\n\treturn 1\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), ['moved']);
});

test('getter and setter with the same name are told apart', async () => {
  const a = `class A {\n  get x(): number { return this._x; }\n  set x(v: number) { this._x = v; }\n}\n`;
  const b = `class A {\n  set x(v: number) { this._x = v; }\n  get x(): number { return this._x; }\n}\n`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(types(r.semanticOperations), ['moved']);
});

test('a different declaration is not a rename just because it has the same shape', async () => {
  const a = `interface S {\n  setActive(session: IActiveSession | undefined, focus?: boolean): void;\n}\n`;
  const b = `interface S {\n  activatePane(pane: ISessionGridPane | undefined, focus?: boolean): void;\n}\n`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

// VS Code's own move fixture: a 60-line block of statements moved inside a file.
test("VS Code fixture noisy-move1: the moved block is found", async () => {
  const fs = await import('node:fs');
  const dir = new URL('./fixtures/vscode/noisy-move1/', import.meta.url);
  const r = await semanticDiffFile('typescript', fs.readFileSync(new URL('1.tst', dir), 'utf8'), fs.readFileSync(new URL('2.tst', dir), 'utf8'));
  const moves = r.semanticOperations.filter((o) => o.type === 'moved' || o.type === 'movedWithEdit');
  // VS Code expects old lines [477, 537) to move to [107, 165).
  assert.ok(moves.some((o) => o.lines.old.some((l) => l.start <= 477 && l.end >= 536)), JSON.stringify(moves.map((o) => o.lines)));
});

test('plain changes are still described, so Pierre colors them', async () => {
  const a = `export function f() {\n  return 5000;\n}\n\nconst gone = 1;\n`;
  const b = `export function f() {\n  return 10_000;\n}\n\nconst added = 2;\nconst more = 3;\n`;
  const r = await semanticDiffFile('typescript', a, b);
  const all = r.semanticOperations.map((o) => o.type);
  assert.ok(all.includes('edited'), all.join());
  // Every changed line on both sides is owned by some operation.
  const owned = (side: 'old' | 'new') => new Set(r.semanticOperations.flatMap((o) => o.lines[side].flatMap((l) => Array.from({ length: l.end - l.start + 1 }, (_, i) => l.start + i))));
  for (const l of [2, 5]) assert.ok(owned('old').has(l), `old line ${l}`);
  for (const l of [2, 5, 6]) assert.ok(owned('new').has(l), `new line ${l}`);
});

test('every line Pierre would mark as changed is owned by an operation', async () => {
  const { structuredPatch } = await import('diff');
  const a = `function a() {\n  if (x) {\n    run();\n  }\n}\n\n/**\n * doc\n */\nfunction b() {}\n`;
  const b = `function a() {\n  if (x) {\n    run();\n    log();\n  }\n  done();\n}\n\n/**\n * doc\n */\nfunction c() {}\n/**\n * new\n */\nfunction b() {}\n`;
  const r = await semanticDiffFile('typescript', a, b);
  const owned = { old: new Set<number>(), new: new Set<number>() };
  for (const op of r.semanticOperations) for (const side of ['old', 'new'] as const) for (const l of op.lines[side]) for (let n = l.start; n <= l.end; n++) owned[side].add(n);
  for (const h of structuredPatch('a', 'b', a, b, '', '', { context: 0 }).hunks) {
    let o = h.oldStart;
    let n = h.newStart;
    for (const line of h.lines) {
      if (line[0] === '-') { if (line.slice(1).trim()) assert.ok(owned.old.has(o), `old ${o}`); o++; }
      else if (line[0] === '+') { if (line.slice(1).trim()) assert.ok(owned.new.has(n), `new ${n}`); n++; }
    }
  }
});
