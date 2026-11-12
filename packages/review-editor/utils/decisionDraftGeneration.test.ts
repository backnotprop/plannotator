import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');

test('every /api/feedback post carries draftGeneration', () => {
  const calls = [...APP.matchAll(/fetch\((?:'\/api\/feedback'|feedbackUrl),\s*\{([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1]);
  expect(calls.length).toBeGreaterThanOrEqual(3);
  for (const body of calls) expect(body).toContain('draftGeneration: getDraftGeneration()');
});
