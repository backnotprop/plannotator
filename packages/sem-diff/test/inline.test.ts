// Inlined-function detection beyond Pierre's single fixture: TypeScript, and
// the cases that must NOT be reported.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiff } from '../src/index.ts';

const helperVersion = `export function checkout(items: Item[]) {
  const subtotal = sumLineItems(items);
  return subtotal * 1.2;
}

function sumLineItems(items: Item[]): number {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  return subtotal;
}
`;

const inlinedVersion = `export function checkout(items: Item[]) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty;
  }
  return subtotal * 1.2;
}
`;

test('TypeScript: helper inlined into its only caller', async () => {
  const ops = (await semanticDiff('typescript', helperVersion, inlinedVersion)).filter((o) => !['added', 'deleted', 'edited'].includes(o.type));
  assert.equal(ops.length, 1);
  const op = ops[0]!;
  assert.equal(op.type, 'inlinedFunction');
  assert.deepEqual(op.spans.map((s) => `${s.role}/${s.relation}`), [
    'body/moved',
    'call/removed',
    'focus/removed',
    'container/removed',
  ]);
  const body = op.spans[0]!;
  assert.ok(body.relation === 'moved');
  // Helper statements on old lines 7-11 land on new lines 2-5. The helper's own
  // `subtotal` takes over `const subtotal = sumLineItems(items)`, so the call is
  // removed rather than replaced, and the unchanged `return subtotal * 1.2` is
  // not part of the operation.
  assert.deepEqual(body.linePairs, [{ old: { start: 7, end: 11 }, new: { start: 2, end: 5 } }]);
  assert.deepEqual(op.lines.new, [{ start: 2, end: 5, spanIndex: 0 }]);
});

test('helper deleted without being inlined: nothing reported', async () => {
  const deletedOnly = `export function checkout(items: Item[]) {
  return 0;
}
`;
  const types = (await semanticDiff('typescript', helperVersion, deletedOnly)).map((o) => o.type);
  assert.ok(!types.includes('inlinedFunction'), types.join());
});

test('helper renamed but still called: a rename, not an inline', async () => {
  const renamed = helperVersion.replaceAll('sumLineItems', 'sumItems');
  const ops = await semanticDiff('typescript', helperVersion, renamed);
  assert.deepEqual(ops.map((o) => o.type).filter((t) => t !== 'edited'), ['renamed']);
});

test('no changes: nothing reported', async () => {
  assert.deepEqual(await semanticDiff('typescript', helperVersion, helperVersion), []);
});
