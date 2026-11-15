import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { languageForPath, semanticDiffFile } from '../src/index.ts';

test('Swift files are read', () => {
  assert.equal(languageForPath('Sources/App/Circle.swift'), 'swift');
  assert.equal(languageForPath('Package.swift'), 'swift');
  assert.equal(languageForPath('Sources/App/Circle.swiftinterface'), null);
});

test('the grammar is the tree-sitter-swift 0.7.3 release file, unchanged', () => {
  const dir = path.join(import.meta.dirname, '..', '..', '..', 'vendor', 'tree-sitter-swift');
  const sum = createHash('sha256').update(fs.readFileSync(path.join(dir, 'tree-sitter-swift.wasm'))).digest('hex');
  assert.equal(sum, '0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2');
  assert.match(fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8'), new RegExp(`^${sum}  tree-sitter-swift.wasm$`, 'm'));
});

import { LANGUAGES } from '../src/parse.ts';

const rules = async (a: string, b: string) => {
  const held = LANGUAGES.swift.holdBack;
  LANGUAGES.swift.holdBack = undefined;
  try {
    return (await semanticDiffFile('swift', a, b, 'x.swift')).semanticOperations;
  } finally {
    LANGUAGES.swift.holdBack = held;
  }
};
const types = async (a: string, b: string) => (await rules(a, b)).map((o) => o.type);
const shipped = async (a: string, b: string) => (await semanticDiffFile('swift', a, b, 'x.swift')).semanticOperations.map((o) => o.type);
const fn = `    func label() -> String {\n        let r = radius\n        return "r=\\(r)"\n    }\n`;
const other = `    func area() -> Double {\n        Double.pi * radius * radius\n    }\n`;
const ops = rules;

test('a function moved out of an #if DEBUG block is an edit; the whole block moved is a move', async () => {
  const big = `    func summary() -> String {\n        let a = area()\n        let d = radius * 2\n        let c = Double.pi * d\n        return "\\(a) \\(d) \\(c)"\n    }\n`;
  const inside = `struct Circle {\n    var radius: Double\n\n#if DEBUG\n${fn}#endif\n\n${big}}\n`;
  const outside = `struct Circle {\n    var radius: Double\n\n#if DEBUG\n#endif\n\n${big}\n${fn}}\n`;
  const onLabel = (list: Awaited<ReturnType<typeof ops>>) => list.filter((o) => (o.type === 'moved' || o.type === 'movedWithEdit') && o.lines.old.some((l) => l.start <= 8 && 5 <= l.end));
  assert.deepEqual(onLabel(await ops(inside, outside)), []);
  const strip = (t: string) => t.replace('#if DEBUG\n', '\n').replace('#endif\n', '\n');
  assert.equal(onLabel(await ops(strip(inside), strip(outside))).length, 1);
  const after = `struct Circle {\n    var radius: Double\n\n${other}\n#if DEBUG\n${fn}#endif\n}\n`;
  assert.ok((await types(`struct Circle {\n    var radius: Double\n\n#if DEBUG\n${fn}#endif\n\n${other}}\n`, after)).includes('moved'));
});

test('a whole constrained extension moved is a move; a method moved into it is not', async () => {
  const ext = `extension Circle where Unit == Double {\n    func area() -> Double {\n        Double.pi * radius * radius\n    }\n}\n`;
  const type = `struct Circle<Unit: Numeric> {\n    var radius: Unit\n\n${fn}}\n`;
  const proto = `protocol Shape {\n    func label() -> String\n}\n`;
  assert.ok((await types(`${type}\n${ext}\n${proto}`, `${ext}\n${type}\n${proto}`)).some((t) => t === 'moved'));
  const into = `struct Circle<Unit: Numeric> {\n    var radius: Unit\n}\n\nextension Circle where Unit == Double {\n${fn}\n    func area() -> Double {\n        Double.pi * radius * radius\n    }\n}\n\n${proto}`;
  const t = await types(`${type}\n${ext}\n${proto}`, into);
  assert.ok(!t.includes('moved') && !t.includes('movedWithEdit'), t.join());
});

test('a method moved into a new plain extension of its type is a move', async () => {
  const before = `struct Circle {\n    var radius: Double\n\n${fn}\n${other}}\n`;
  const after = `struct Circle {\n    var radius: Double\n\n${other}}\n\nextension Circle {\n${fn}}\n`;
  assert.ok((await types(before, after)).includes('moved'));
});

test('self.name and a bare name are one property for a rename', async () => {
  const before = `struct Box {\n    var size: Int\n\n    func twice() -> Int {\n        self.size * 2\n    }\n\n    func plus(_ n: Int) -> Int {\n        size + n\n    }\n}\n`;
  const after = before.replaceAll('size', 'width');
  assert.ok((await types(before, after)).includes('renamed'));
});

test('a body re-indented into an #if branch or a constrained extension is not reformatted', async () => {
  const body = `    func area() -> Double {\n        let r = radius\n        let d = r * 2\n        return Double.pi * d * d / 4\n    }\n`;
  const plain = `struct Circle<Unit> {\n    var radius: Double\n\n${body}}\n`;
  const wrapped = `struct Circle<Unit> {\n    var radius: Double\n\n#if DEBUG\n${body.replace(/^/gm, '    ').replace(/^    $/gm, '')}#endif\n}\n`;
  assert.ok(!(await types(plain, wrapped)).includes('reformatted'));
  const ext = `struct Circle<Unit> {\n    var radius: Double\n}\n\nextension Circle where Unit == Double {\n${body}}\n`;
  const before = `struct Circle<Unit> {\n    var radius: Double\n}\n\n${body.replace(/^    /gm, '')}`;
  assert.ok(!(await types(before, ext)).includes('reformatted'));
});

test('Swift v1 holds back moved-with-edits only: its lines are plain edits; moves and renames are claimed', async () => {
  assert.deepEqual([...(LANGUAGES.swift.holdBack ?? [])], ['movedWithEdit']);
  const long = (n: string) => `    func ${n}() -> Int {\n${[1, 2, 3, 4, 5].map((i) => `        let v${i} = ${i} * 2\n`).join('')}        return v1 + v5\n    }\n`;
  const moving = (y: number) => `    func b() -> Int {\n        let x = 2\n        let y = ${y}\n        return x + y\n    }\n`;
  const t = await shipped(`struct A {\n${moving(3)}\n${long('a')}\n${long('c')}}\n`, `struct A {\n${long('a')}\n${long('c')}\n${moving(30)}}\n`);
  assert.ok(!t.includes('movedWithEdit') && !t.includes('moved') && t.some((x) => x === 'edited' || x === 'added' || x === 'deleted'), t.join());
  const before = `struct Box {\n    var size: Int\n\n    func twice() -> Int {\n        self.size * 2\n    }\n\n    func plus(_ n: Int) -> Int {\n        size + n\n    }\n}\n`;
  assert.ok((await shipped(before, before.replaceAll('size', 'width'))).includes('renamed'));
  assert.deepEqual(await shipped(before, before.replace('        size + n', '            size + n')), ['reformatted']);
});
