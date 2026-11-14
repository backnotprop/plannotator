// Re-indenting a Rust string continued with a backslash leaves it unchanged (Rust drops the leading
// whitespace after `\` + newline); a plain multi-line string changes, so it is never "reformatted".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';

const types = async (a: string, b: string) => (await semanticDiffFile('rust', a, b, 'x.rs')).semanticOperations.map((o) => o.type);

test('a backslash-continued string re-indents as formatting', async () => {
  const a = 'fn f() {\n    let s = "abc \\\n     def";\n    g(s)\n}\n';
  const b = 'fn f() {\n      let s = "abc \\\n       def";\n      g(s)\n}\n';
  assert.deepEqual(await types(a, b), ['reformatted']);
});

test('a plain multi-line string that gains spaces is an edit', async () => {
  const a = 'fn f() {\n    let s = "abc\n     def";\n    g(s)\n}\n';
  const b = 'fn f() {\n      let s = "abc\n       def";\n      g(s)\n}\n';
  assert.ok(!(await types(a, b)).includes('reformatted'));
});
