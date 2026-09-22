/**
 * Source-level pin: every decision the review app posts to /api/feedback
 * carries `draftGeneration`. The server tombstones the draft (and, in PR mode,
 * its stable target key) at that generation; a decision without it leaves no
 * tombstone, so a late autosave could revive a submitted draft. The
 * platform-path status post after Post Comments once omitted it.
 *
 * Same idiom as autoViewedCallSites.test.ts: which call sites pass the field
 * is only visible in the source.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');

test('every /api/feedback post carries draftGeneration', () => {
  const calls = [...APP.matchAll(/fetch\('\/api\/feedback',\s*\{([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1]);
  // Sanity: the regex finds the agent-path and platform-path posts.
  expect(calls.length).toBeGreaterThanOrEqual(3);
  for (const body of calls) expect(body).toContain('draftGeneration: getDraftGeneration()');
});
