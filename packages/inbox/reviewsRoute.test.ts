import { expect, test } from 'bun:test';
import { reviewsAlias } from './reviewsRoute';

test('an old #pulls link becomes #reviews with everything it named', () => {
  expect(reviewsAlias('#pulls')).toBe('#reviews');
  expect(reviewsAlias('#pulls&project=prj_1&stack=github.com%2Fo%2Fr%23412&layer=x&scope=stack')).toBe('#reviews&project=prj_1&stack=github.com%2Fo%2Fr%23412&layer=x&scope=stack');
});

test('nothing else is touched: a thread, the new address, or a name that only starts alike', () => {
  for (const hash of ['', '#', '#reviews', '#reviews&new', '#thread=msg_pulls', '#pullsish', '#project=pulls']) expect(reviewsAlias(hash)).toBeNull();
});
