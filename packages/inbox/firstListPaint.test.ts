import { expect, test } from 'bun:test';
import { afterListPaint, listPainted } from './firstListPaint';

test('settings that land before the first list paint wait for it; the cap lets them go when no list paints', async () => {
  const start = Date.now();
  await afterListPaint(30);
  expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  let applied = false;
  const waiting = afterListPaint(5_000).then(() => (applied = true));
  listPainted();
  await Promise.resolve();
  expect(applied).toBe(false);
  await waiting;
  expect(applied).toBe(true);
  let after = false;
  await afterListPaint(5_000).then(() => (after = true));
  expect(after).toBe(true);
});
