import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageForPath, semanticDiffFile } from '../src/index.ts';
import { brokenTree, getParser, LANGUAGES } from '../src/parse.ts';

const ops = async (a: string, b: string) => (await semanticDiffFile('kotlin', a, b, 'x.kt')).semanticOperations.map((o) => o.type);
const moves = (t: string[]) => t.filter((x) => x === 'moved' || x === 'movedWithEdit');

test('Kotlin files and scripts are read', () => {
  assert.equal(languageForPath('src/main/kotlin/App.kt'), 'kotlin');
  assert.equal(languageForPath('build.gradle.kts'), 'kotlin');
  assert.equal(languageForPath('notes.ktx'), null);
});

const helpers = Array.from({ length: 4 }, (_, i) => `fun helper${i}(x: Int): Int {\n    val y = x + ${i}\n    return y * 2\n}\n`).join('\n');
const withCompanion = `/** Made by make(). */\nclass A {\n    fun a() = 1\n\n    companion object {\n        fun make(): A {\n            return A()\n        }\n    }\n}\n`;

test('a whole class moved with its doc comment and companion object is a move', async () => {
  assert.deepEqual(moves(await ops(`${withCompanion}\n${helpers}`, `${helpers}\n${withCompanion}`)), ['moved']);
});

const method = `    fun convert(f: Double): Double {\n        val c = (f - 32) * 5 / 9\n        return c * 1.0\n    }\n`;
const holder = (inClass: boolean, open: string) =>
  `class T {\n    fun a(): Int = 1\n${inClass ? `\n${method}` : ''}\n    ${open} {\n        val Z = 0\n${inClass ? '' : `\n${method.replace(/^ {4}/gm, '        ')}`}    }\n}\n`;

test('a method moved into a nested object is an edit, like a move into the companion', async () => {
  assert.deepEqual(moves(await ops(holder(true, 'object Units'), holder(false, 'object Units'))), []);
  assert.deepEqual(moves(await ops(holder(true, 'companion object'), holder(false, 'companion object'))), []);
});

test('a top-level function moved into a class is an edit', async () => {
  const f = `fun one(a: Int): Int {\n    val b = a * 2\n    return b + 1\n}`;
  const k = (inside: boolean) => `${inside ? '' : `${f}\n\n`}class K {\n    fun z() = 0\n${inside ? `\n    ${f.replace(/\n/g, '\n    ')}\n` : ''}}\n`;
  assert.deepEqual(moves(await ops(k(false), k(true))), []);
});

test('constructor parameters and enum entries never move', async () => {
  const dc = (s: string) => `data class P(\n${s}\n) {\n    fun f() = 1\n}\n`;
  assert.deepEqual(moves(await ops(dc('    val a: Int,\n    val b: Int,\n    val c: Int,'), dc('    val c: Int,\n    val a: Int,\n    val b: Int,'))), []);
  const entries = (x: string, y: string) => `enum class E {\n${x},\n${y};\n    abstract fun f(): Int\n}\n`;
  const a = '    A {\n        override fun f() = 1\n    }';
  const b = '    B {\n        override fun f() = 2\n    }';
  assert.deepEqual(moves(await ops(entries(a, b), entries(b, a))), []);
});

test('a parameter renamed and retyped is not a rename', async () => {
  const t = await ops(`fun f(by: Int): Int {\n    val x = by + 1\n    return x * by\n}\n`, `fun f(n: Long): Int {\n    val x = n + 1\n    return x * n\n}\n`);
  assert.ok(!t.includes('renamed'), t.join());
});

test('the missing token on a one-line class body is harmless; other missing tokens are not', async () => {
  const parser = await getParser('kotlin');
  const ok = parser.parse('class A { val x = 1 }\n')!;
  const bad = parser.parse('fun f() {\n    val x = listOf(1, 2\n}\n')!;
  assert.ok(ok.rootNode.hasError);
  assert.equal(brokenTree(ok.rootNode, LANGUAGES.kotlin), false);
  assert.equal(brokenTree(bad.rootNode, LANGUAGES.kotlin), true);
  ok.delete();
  bad.delete();
  parser.delete();
});
