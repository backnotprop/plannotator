// Mistakes found by running the engine over real history in vite, Hugo and
// TypeScript (see bench/history.ts). Each test is a minimal copy of one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';
import type { SemanticDiffOperation } from '../src/pierre-types.ts';

const PLAIN = new Set(['added', 'deleted', 'edited']);
const types = (ops: SemanticDiffOperation[]) => ops.map((o) => o.type).filter((t) => !PLAIN.has(t));

// TypeScript diagnostics_generated.go: one message deleted near the top, one
// added further down. Every name in between shifted by one inside the list.
test('names shifting inside a list are not renames', async () => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const file = (ns: string[]) => `package d\n\n${ns.map((n) => `var ${n} = &Message{code: ${n.charCodeAt(0)}, key: "${n}"}\n`).join('\n')}\nvar all = []*Message{\n${ns.map((n) => `\t&${n},\n`).join('')}}\n`;
  const r = await semanticDiffFile('go', file(names), file([...names.slice(1), 'F']));
  assert.deepEqual(types(r.semanticOperations), []);
});

// vite css.ts: `Once(root) {` -> `OnceExit(root) {`, a different PostCSS hook.
test('a name used once that changes is an edit, not a rename', async () => {
  const a = `export const plugin = {\n  postcssPlugin: 'x',\n  Once(root) {\n    walk(root)\n  },\n}\n`;
  const b = a.replace('Once(', 'OnceExit(');
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

// vite server/index.ts: a type imported from a different module is a different type.
test('importing a different name is not a rename', async () => {
  const a = `import type { WatchOptions } from 'chokidar'\n\nexport interface S {\n  watch?: WatchOptions | null\n}\n`;
  const b = `import type { ServerWatchOptions } from '../watch'\n\nexport interface S {\n  watch?: ServerWatchOptions | null\n}\n`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

test('renaming a local import alias is still a rename', async () => {
  const a = `import { readFile as read } from 'node:fs'\n\nexport function f(p: string) {\n  return read(p)\n}\n`;
  const b = a.replaceAll('read(', 'load(').replace('as read', 'as load');
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(types(r.semanticOperations), ['renamed']);
});

// Hugo images/image.go: a comment that now sits after a constant describes something else.
test('a comment changing places is not formatting only', async () => {
  const a = `package images\n\nconst (\n\tPNG = iota\n\n\t// Metadata only below.\n\tAVIF\n)\n`;
  const b = `package images\n\nconst (\n\tPNG = iota\n\tAVIF\n\n\t// Metadata only below.\n)\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.ok(!types(r.semanticOperations).includes('reformatted'), JSON.stringify(types(r.semanticOperations)));
});

// Hugo commands/gen.go: `if err != nil { return err }` appears all over a Go file.
test('a block that repeats in the file is not reported as moved', async () => {
  const step = (n: string) => `\tif err := ${n}(); err != nil {\n\t\treturn err\n\t}\n`;
  const check = `\tif err != nil {\n\t\treturn err\n\t}\n`;
  const a = `package p\n\nfunc run() error {\n\terr := one()\n${check}\terr = two()\n${check}${step('three')}\treturn nil\n}\n\nfunc other() error {\n\terr := four()\n${check}\treturn nil\n}\n`;
  const b = `package p\n\nfunc run() error {\n\terr := one()\n${check}${step('three')}\terr = two()\n\treturn nil\n}\n\nfunc other() error {\n\terr := four()\n${check}\treturn nil\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  for (const o of r.semanticOperations.filter((x) => x.type === 'moved' || x.type === 'movedWithEdit')) {
    const text = a.split('\n').slice(o.lines.old[0]!.start - 1, o.lines.old[0]!.end).join('\n');
    assert.ok(!/^\s*if err != nil \{\s*return err\s*\}\s*$/.test(text), text);
  }
});

// vite config.ts (import sorting): a moved import block took in the next,
// unrelated import and showed up as "moved with edit".
test('a moved block does not swallow an unrelated neighbouring line', async () => {
  const block = `import {\n  resolveServerOptions,\n  serverConfigDefaults,\n} from './server'\n`;
  const a = `import { a } from './a'\n${block}import type { WebSocketServer } from './server/ws'\nimport { z } from './z'\n\nexport const x = 1\n`;
  const b = `import { a } from './a'\nimport { z } from './z'\n${block}import { getAllowedHosts } from './server/hostCheck'\n\nexport const x = 1\n`;
  const r = await semanticDiffFile('typescript', a, b);
  const moves = r.semanticOperations.filter((o) => o.type === 'moved' || o.type === 'movedWithEdit');
  for (const o of moves) {
    const moved = b.split('\n').slice(o.lines.new[0]!.start - 1, o.lines.new[0]!.end).join('\n');
    assert.ok(!moved.includes('getAllowedHosts'), moved);
  }
});

// vite html.ts: the same extract found from a second call site came back as an empty operation.
test('no operation is left without lines', async () => {
  const a = `export function f(n) {\n  const big =\n    n.kind === 'link' &&\n    n.rel &&\n    n.rel.includes('preload')\n  use(big)\n}\n\nexport function g(n) {\n  const big =\n    n.kind === 'link' &&\n    n.rel &&\n    n.rel.includes('preload')\n  keep(big)\n}\n`;
  const b = `function isPreload(n) {\n  const big =\n    n.kind === 'link' &&\n    n.rel &&\n    n.rel.includes('preload')\n  return big\n}\n\nexport function f(n) {\n  use(isPreload(n))\n}\n\nexport function g(n) {\n  keep(isPreload(n))\n}\n`;
  const r = await semanticDiffFile('typescript', a, b);
  for (const o of r.semanticOperations) assert.ok(o.lines.old.length + o.lines.new.length > 0, o.type);
});

// TypeScript api/session.go: `s.currentDirectory()` became `s.GetCurrentDirectory()`,
// a different method that only looks like the helper's body.
test('a one-line helper replaced by a look-alike call is not inlined', async () => {
  const a = `package api\n\nfunc (s *Session) currentDirectory() string {\n\treturn s.snapshotHost.GetCurrentDirectory()\n}\n\nfunc (s *Session) init() *Resp {\n\treturn &Resp{Dir: s.currentDirectory()}\n}\n`;
  const b = `package api\n\nfunc (s *Session) init() *Resp {\n\treturn &Resp{Dir: s.GetCurrentDirectory()}\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

// TypeScript proto.generated.ts: an interface moved, and its doc comment was left
// behind as a separate "moved" scrap together with the neighbouring brace.
test('a doc comment moves with its declaration', async () => {
  const p = `/** P is used for getters. */\nexport interface P {\n  snapshot: number;\n  project: number;\n}\n`;
  const q = `export interface Q {\n  file: string;\n}\n`;
  const q2 = q.replaceAll('Q', 'R');
  const r = await semanticDiffFile('typescript', `${p}\n${q}\n${q2}`, `${q}\n${q2}\n${p}`);
  const moves = r.semanticOperations.filter((o) => o.type === 'moved');
  assert.equal(moves.length, 1, JSON.stringify(r.semanticOperations.map((o) => [o.type, o.lines])));
  assert.deepEqual([moves[0]!.lines.old[0]!.start, moves[0]!.lines.old[0]!.end], [1, 5]);
});

// TypeScript tspath/path.go: `type Path string` deleted, `type CaseSensitivity uint8` added.
test('two unrelated short declarations are not paired as one renamed and moved', async () => {
  const a = `package tspath\n\ntype Path string\n\nfunc A() {}\n`;
  const b = `package tspath\n\nfunc A() {}\n\ntype CaseSensitivity uint8\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

// TypeScript compiler/filesparser.go: `loader.caseSensitivity.PathKey(p)` is another
// type's method; the new `(t *parseTask) PathKey()` takes no arguments.
test('a call with more arguments than the helper takes is not a call to it', async () => {
  const a = `package c\n\nfunc (t *task) load() {\n\tx := Entry{file: t.path}\n\tuse(x)\n}\n`;
  const b = `package c\n\nfunc (t *task) PathKey() Key {\n\treturn t.path\n}\n\nfunc (t *task) load() {\n\tx := Entry{path: loader.cs.PathKey(name)}\n\tuse(x)\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

// TypeScript compiler/program.go: `p.opts.Config.FileNames()` is not the new
// helper's `p.opts.Config.BaseDirectory()`, however alike they look.
test('old code calling something else is not extracted into a look-alike helper', async () => {
  const a = `package c\n\nfunc (p *Program) files() {\n\tfor _, f := range p.opts.Config.FileNames() {\n\t\tuse(f)\n\t}\n}\n`;
  const b = `package c\n\nfunc (p *Program) BaseDirectory() string {\n\treturn p.opts.Config.BaseDirectory()\n}\n\nfunc (p *Program) files() {\n\tfor _, f := range p.opts.Config.FileNames() {\n\t\tuse(f, p.BaseDirectory())\n\t}\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), []);
});

// vite pluginContainer.ts: two classes each have a `close()`; the engine compared
// the helper's caller with the wrong one.
test('same-named methods in different classes are told apart', async () => {
  const other = `class B {\n  async close(): Promise<void> {\n    await this.shutdown()\n  }\n}\n`;
  const a = `class A {\n  async close(): Promise<void> {\n    if (this._closed) return\n    this._closed = true\n    await Promise.allSettled(this._pending)\n    const config = this.env.getTopLevelConfig()\n    await this.hookParallel('buildEnd', config)\n    await this.hookParallel('closeBundle', config)\n  }\n}\n\n${other}`;
  const b = `class A {\n  async close(): Promise<void> {\n    if (this._closed) return this._closePromise\n    this._closed = true\n    this._closePromise = this._close()\n    await this._closePromise\n  }\n\n  private async _close(): Promise<void> {\n    await Promise.allSettled(this._pending)\n    const config = this.env.getTopLevelConfig()\n    await this.hookParallel('buildEnd', config)\n    await this.hookParallel('closeBundle', config)\n  }\n}\n\n${other}`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(types(r.semanticOperations), ['extractedFunction']);
});

// Hugo dartsass/transform.go: an if/else chain assigning a variable became a
// helper that returns from each branch. Statements changed shape; the values did not.
test('an if/else chain that became early returns is still an extract', async () => {
  const lists = [`[]string{"_%s", "%s"}`, `[]string{"_%s.scss", "_%s.sass", "_%s.css"}`, `[]string{\n\t\t"_%s.scss", "%s.scss",\n\t\t"_%s.sass", "%s.sass",\n\t}`];
  const a = `package s\n\nfunc resolve(name string) string {\n\tvar patterns []string\n\tif strings.Contains(name, ".") {\n\t\tpatterns = ${lists[0]}\n\t} else if strings.HasPrefix(name, "_") {\n\t\tpatterns = ${lists[1]}\n\t} else {\n\t\tpatterns = ${lists[2]}\n\t}\n\treturn pick(patterns, name)\n}\n`;
  const b = `package s\n\nfunc resolve(name string) string {\n\tpatterns := namePatterns(name)\n\treturn pick(patterns, name)\n}\n\nfunc namePatterns(name string) []string {\n\tif strings.Contains(name, ".") {\n\t\treturn ${lists[0]}\n\t}\n\tif strings.HasPrefix(name, "_") {\n\t\treturn ${lists[1]}\n\t}\n\treturn ${lists[2]}\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), ['extractedFunction']);
});

// TypeScript ast/symbol.go: the helper's statements came from the caller, but it
// returns a new value (`return true`) the old code never had.
test('an extract whose helper returns a new value is still an extract', async () => {
  const a = `package ast\n\nfunc (m *Map) Set(key string, v *Symbol) {\n\tif i := m.find(key); i >= 0 {\n\t\tm.values[i] = v\n\t\treturn\n\t}\n\tm.keys = append(m.keys, key)\n\tm.values = append(m.values, v)\n}\n`;
  const b = `package ast\n\nfunc (m *Map) Set(key string, v *Symbol) {\n\tm.setOrAdd(key, v, true)\n}\n\nfunc (m *Map) setOrAdd(key string, v *Symbol, replace bool) bool {\n\tif i := m.find(key); i >= 0 {\n\t\tif replace {\n\t\t\tm.values[i] = v\n\t\t}\n\t\treturn false\n\t}\n\tm.keys = append(m.keys, key)\n\tm.values = append(m.values, v)\n\treturn true\n}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(types(r.semanticOperations), ['extractedFunction']);
});

// Fuzzer finds: emptying a file whose one line had no final newline, and the reverse.
test('a file emptied or filled from nothing attaches to the empty side as empty', async () => {
  for (const [a, b] of [['x', ''], ['', 'x'], ['x\n', ''], ['', 'x\n']]) {
    const r = await semanticDiffFile('typescript', a!, b!);
    for (const op of r.semanticOperations)
      for (const side of ['old', 'new'] as const)
        for (const l of op.lines[side]) if (l.attachment) assert.deepEqual(l.attachment, { empty: true }, JSON.stringify([a, b, op]));
  }
});
