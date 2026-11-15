import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageForPath, semanticDiffFile } from '../src/index.ts';

test('PHP files are read; Blade templates are not', () => {
  assert.equal(languageForPath('src/Http/Kernel.php'), 'php');
  assert.equal(languageForPath('views/list.phtml'), 'php');
  assert.equal(languageForPath('resources/views/welcome.blade.php'), null);
});

const method = `    public function greet(string $who): string\n    {\n        $text = $this->hello() . ', ' . $who;\n        return ucfirst($text);\n    }\n`;
const classes = (inA: boolean, nsB: string) =>
  `<?php\nnamespace A;\n\nclass Greets\n{\n    public function hello(): string\n    {\n        return 'hello';\n    }\n${inA ? `\n${method}` : ''}}\n\nnamespace ${nsB};\n\nclass Person\n{\n    public function name(): string\n    {\n        return $this->name;\n    }\n${inA ? '' : `\n${method}`}}\n`;
const types = async (a: string, b: string) => (await semanticDiffFile('php', a, b, 'x.php')).semanticOperations.map((o) => o.type);

test('a method moved into a class of another namespace is an edit, not a move', async () => {
  const t = await types(classes(false, 'B'), classes(true, 'B'));
  assert.ok(!t.includes('moved') && !t.includes('movedWithEdit'), t.join());
});

test('the same move inside one namespace is a move', async () => {
  const one = (inA: boolean) => classes(inA, 'B').replace('namespace B;\n', '');
  assert.ok((await types(one(false), one(true))).includes('moved'));
});
