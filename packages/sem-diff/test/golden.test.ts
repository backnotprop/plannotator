// Golden test: reproduce, exactly, the one real output of Pierre's private
// engine that ships in Pierre's tests (Go, inlined function).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { semanticDiff } from '../src/index.ts';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/pierre-inlined-function-go.json', import.meta.url), 'utf8'));

// Known erratum in Pierre's fixture: the moved body's new range ends at
// (14, 27), one character short of the statement on line 14, which is
// `\t\t\tshipping := item.Shipping` (28 characters). That cuts the final `g` off
// `item.Shipping`. Every other value must match exactly.
const ERRATA: Array<[path: string, theirs: unknown, correct: unknown]> = [
  ['0.spans.0.new.0.end.character', 27, 28],
];

function applyErrata(expected: unknown) {
  const copy = structuredClone(expected) as Record<string, unknown>;
  for (const [path, theirs, correct] of ERRATA) {
    const keys = path.split('.');
    let at: Record<string, unknown> = copy;
    for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
    assert.equal(at[keys.at(-1)!], theirs, `erratum ${path} no longer present in fixture`);
    at[keys.at(-1)!] = correct;
  }
  return copy;
}

test('matches Pierre fixture op-inlined-function-nested exactly (one documented erratum)', async () => {
  const ops = await semanticDiff(fixture.language, fixture.oldContents, fixture.newContents);
  assert.deepStrictEqual(ops, applyErrata(fixture.expected));
});

test('is deterministic', async () => {
  const a = await semanticDiff(fixture.language, fixture.oldContents, fixture.newContents);
  const b = await semanticDiff(fixture.language, fixture.oldContents, fixture.newContents);
  assert.deepStrictEqual(a, b);
});
