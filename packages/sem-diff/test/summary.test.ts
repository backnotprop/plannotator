// reviewSummary: what a reviewer has to read, and what they can skim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewSummary, semanticDiffFile } from '../src/index.ts';

const oldText = `export function formatPrice(cents: number) {
  const dollars = cents / 100;
  return '$' + dollars.toFixed(2);
}

export function checkout(cart: Cart, user: User) {
  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.qty;
  }
  if (user.coupon) {
    total = total * 0.9;
  }
  log('checkout', user.id);
  return db.save({ user: user.id, total: addTax(total) });
}

function addTax(amount: number) {
  const rate = 0.08;
  log('tax', rate);
  return amount + amount * rate;
}

export function refund(order: Order) {
  log('refund', order.id);
  return db.save({ user: order.user, total: -order.total });
}
`;
const newText = `export function checkout(cart: Cart, user: User) {
  let total = sumItems(cart);
  if (user.coupon) {
    total = total * 0.85;
  }
  log('checkout', user.id);
  return db.save({ user: user.id, total: addTax(total) });
}

function sumItems(cart: Cart) {
  let total = 0;
  for (const item of cart.items) {
    total += item.price * item.qty;
  }
  return total;
}

function addTax(amount: number) {
  const taxRate = 0.08;
  log('tax', taxRate);
  return amount + amount * taxRate;
}

export function refund(order: Order) {
  log('refund', order.id);
  return db.save({
    user: order.user,
    total: -order.total,
  });
}

export function formatPrice(cents: number) {
  const dollars = cents / 100;
  return '$' + dollars.toFixed(2);
}
`;

test('one real edit among a move, an extract, a rename and a reformat: one thing to read', async () => {
  const r = await semanticDiffFile('typescript', oldText, newText, 'checkout.ts');
  const s = reviewSummary(r.semanticOperations);
  assert.deepEqual(s.read.map((o) => o.type), ['edited']);
  assert.deepEqual(s.skim.map((o) => o.type).sort(), ['extractedFunction', 'moved', 'reformatted', 'renamed']);
  assert.deepEqual(s.counts, { extractedFunction: 1, moved: 1, renamed: 1, reformatted: 1, edited: 1 });
  assert.equal(s.lines.read, 2); // the discount line, old and new
  assert.ok(s.lines.skim > 20);
});

test('a kind the summary does not know is read, never skimmed', () => {
  const op = { type: 'somethingNew', lines: { old: [{ start: 3, end: 4, spanIndex: 0 }], new: [] }, spans: [] } as never;
  const s = reviewSummary([op]);
  assert.equal(s.read.length, 1);
  assert.equal(s.skim.length, 0);
  assert.equal(s.lines.read, 2);
});
