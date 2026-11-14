// Guardrails: a file too large, or out of time, falls back to a plain diff, and says so.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';

const a = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
const b = 'function b() {\n  return 2;\n}\n\nfunction a() {\n  return 1;\n}\n';

test('every pass reports what it did', async () => {
  const r = await semanticDiffFile('typescript', a, b);
  assert.deepEqual(r.diagnostics.map((d) => [d.pass, d.status]), [['inline-extract', 'ok'], ['structure', 'ok'], ['text-moves', 'ok']]);
  assert.ok(r.semanticOperations.some((o) => o.type === 'moved'));
});

test('a file over the size cap gets a plain diff, with the reason', async () => {
  const r = await semanticDiffFile('typescript', a, b, 'x.ts', { maxChars: 10 });
  assert.ok(r.diagnostics.every((d) => d.status === 'skipped' && d.reason === 'file too large'));
  assert.ok(!r.semanticOperations.some((o) => o.type === 'moved'));
  assert.ok(r.patch.length > 0);
});

test('an exhausted time budget skips the remaining passes', async () => {
  const r = await semanticDiffFile('typescript', a, b, 'x.ts', { timeBudgetMs: -1 });
  assert.ok(r.diagnostics.every((d) => d.status === 'skipped' && d.reason === 'time budget used up'));
});
