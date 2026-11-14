// The line diff is bounded by work done, not by the clock: a slow or busy machine
// gets the same answer as a fast one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeTextDiff, lastWork } from '../src/textdiff.ts';
import * as textdiff from '../src/textdiff.ts';

// Two large texts with little in common: costly enough to run into a small budget.
function noise(seed: number, lines: number) {
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  return Array.from({ length: lines }, () => `const v${next() % 400} = ${next() % 7};`).join('\n');
}
const oldText = noise(1, 3000);
const newText = noise(2, 3000);

test('a diff that runs out of budget stops at the same point whatever the clock says', () => {
  const realNow = Date.now;
  const run = (clock: () => number) => {
    Date.now = clock;
    try {
      const d = computeTextDiff(oldText, newText, 200_000);
      return { hit: d.hitTimeout, changes: JSON.stringify(d.edits.replacements.map((r) => [r.range.start, r.range.endExclusive, r.newText.length])), work: textdiff.lastWork };
    } finally {
      Date.now = realNow;
    }
  };
  let t = 0;
  const frozen = run(() => 0);
  const racing = run(() => (t += 3_600_000));
  assert.equal(frozen.hit, true);
  assert.deepEqual(racing, frozen);
});

test('the real clock is put back afterwards, also when the budget is not reached', () => {
  const realNow = Date.now;
  const d = computeTextDiff('a\nb\n', 'a\nc\n');
  assert.equal(d.hitTimeout, false);
  assert.equal(Date.now, realNow);
  assert.ok(lastWork >= 0);
});
