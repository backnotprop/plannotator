// Imports as units: re-sorted imports are moves, not deletes and adds.
// Plus the basics for Rust, the third language.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';
import type { SemanticDiffOperation } from '../src/pierre-types.ts';

const summary = (ops: SemanticDiffOperation[]) => ops.map((o) => `${o.type} ${o.lines.old.map((l) => `${l.start}-${l.end}`)}>${o.lines.new.map((l) => `${l.start}-${l.end}`)}`);
const kinds = (ops: SemanticDiffOperation[]) => [...new Set(ops.map((o) => o.type))].sort();

test('TypeScript: re-sorted imports are moves', async () => {
  const a = `import { z } from './z';\nimport { a } from './a';\nimport fs from 'node:fs';\nimport { m, n } from './m';\n\nexport const x = a + z;\n`;
  const b = `import fs from 'node:fs';\nimport { a } from './a';\nimport { m, n } from './m';\nimport { z } from './z';\n\nexport const x = a + z;\n`;
  const r = await semanticDiffFile('typescript', a, b);
  // `./a` stays on line 2: it is not reported, even though keeping `./m` instead would move as few.
  assert.deepEqual(summary(r.semanticOperations), ['moved 1-1>4-4', 'moved 3-3>1-1']);
});

test('TypeScript: an import that moved and gained a name is moved with an edit', async () => {
  const a = `import { b } from './b';\nimport { a } from './a';\n`;
  const b = `import { a, c } from './a';\nimport { b } from './b';\n`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(kinds(r.semanticOperations), ['movedWithEdit']);
});

test('TypeScript: a type import and a value import from one module are different imports', async () => {
  const a = `import type { T } from './m';\nimport { v } from './m';\n`;
  const b = `import { v } from './m';\nimport type { T } from './m';\n`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(kinds(r.semanticOperations), ['moved']);
});

test('TypeScript: re-exports are imports too', async () => {
  const a = `export * from './b';\nexport { a } from './a';\n`;
  const b = `export { a } from './a';\nexport * from './b';\n`;
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(kinds(r.semanticOperations), ['moved']);
});

test('Go: re-sorted imports in a group are moves', async () => {
  const a = `package x\n\nimport (\n\t"strings"\n\t"fmt"\n\t"os"\n)\n\nfunc F() {}\n`;
  const b = `package x\n\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc F() {}\n`;
  const r = await semanticDiffFile('go', a, b);
  assert.deepEqual(summary(r.semanticOperations), ['moved 4-4>6-6']);
});

test('Go: an import moved between groups is a move', async () => {
  const a = `package x\n\nimport (\n\t"fmt"\n\t"github.com/a/b"\n)\n\nimport "os"\n`;
  const b = `package x\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nimport "github.com/a/b"\n`;
  const r = await semanticDiffFile('go', a, b);
  // One of the two swapped imports is the move; the other only gained or lost
  // `import`, an edit (the group's closing brace and blank line are re-aligned around it).
  assert.equal(r.semanticOperations.filter((o) => o.type === 'moved').length, 1);
});

test('Rust: re-sorted use declarations are moves; re-sorting inside braces is an edit', async () => {
  const a = `use std::fmt;\nuse crate::b::{X, Y};\nuse anyhow::Result;\n`;
  const b = `use anyhow::Result;\nuse crate::b::{Y, X, Z};\nuse std::fmt;\n`;
  const r = await semanticDiffFile('rust', a, b);
  assert.deepEqual(summary(r.semanticOperations), ['moved 1-1>3-3', 'moved 3-3>1-1', 'edited 2-2>2-2']);
});

test('Rust: a moved item takes its doc comment and attributes along, and is the only move', async () => {
  const a = `#[derive(Debug)]\nstruct A { x: u8 }\n\n/// B docs\n#[derive(Clone)]\nstruct B { y: u8 }\n\nimpl A {\n    fn get(&self) -> u8 { self.x }\n}\n`;
  const b = `/// B docs\n#[derive(Clone)]\nstruct B { y: u8 }\n\n#[derive(Debug)]\nstruct A { x: u8 }\n\nimpl A {\n    fn get(&self) -> u8 { self.x }\n}\n`;
  const r = await semanticDiffFile('rust', a, b);
  assert.deepEqual(summary(r.semanticOperations), ['moved 4-6>1-3']);
});

test('Rust: an extract whose helper returns its value without `return`', async () => {
  const a = `fn total(items: &[u32]) -> u32 {\n    let mut sum = 0;\n    for i in items {\n        if *i > 10 {\n            sum += *i * 2;\n        }\n    }\n    println!("{}", sum);\n    sum\n}\n`;
  const b = `fn total(items: &[u32]) -> u32 {\n    let sum = weighted(items);\n    println!("{}", sum);\n    sum\n}\n\nfn weighted(items: &[u32]) -> u32 {\n    let mut sum = 0;\n    for i in items {\n        if *i > 10 {\n            sum += *i * 2;\n        }\n    }\n    sum\n}\n`;
  const r = await semanticDiffFile('rust', a, b);
  assert.deepEqual(kinds(r.semanticOperations).filter((k) => k !== 'edited'), ['extractedFunction']);
});

test('Rust: methods of one type are scoped by their impl', async () => {
  const a = `struct A;\nstruct B;\nimpl A {\n    fn close(&self) {}\n}\nimpl B {\n    fn close(&self) {}\n}\n`;
  const b = `struct A;\nstruct B;\nimpl B {\n    fn close(&self) {}\n}\nimpl A {\n    fn close(&self) {}\n}\n`;
  const r = await semanticDiffFile('rust', a, b);
  assert.deepEqual(kinds(r.semanticOperations), ['moved']);
});
