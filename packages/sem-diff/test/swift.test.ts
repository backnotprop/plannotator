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

const types = async (a: string, b: string) => (await semanticDiffFile('swift', a, b, 'x.swift')).semanticOperations.map((o) => o.type);
const fn = `    func label() -> String {\n        let r = radius\n        return "r=\\(r)"\n    }\n`;
const other = `    func area() -> Double {\n        Double.pi * radius * radius\n    }\n`;
const ops = async (a: string, b: string) => (await semanticDiffFile('swift', a, b, 'x.swift')).semanticOperations;

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
