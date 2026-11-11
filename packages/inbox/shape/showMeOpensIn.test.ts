import { expect, test } from 'bun:test';
import { showMeBoardOpensIn } from './showMeOpensIn';

const A = 'msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0A';
const B = 'msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0B';

test('still on its own thread, or on the grid: it opens where the person is', () => {
  expect(showMeBoardOpensIn({ page: 'inbox', thread: A }, A)).toBe('here');
  expect(showMeBoardOpensIn({ page: 'shapes', thread: null }, A)).toBe('here');
});

test('moved to another thread, or to a page with no thread: it opens in its own thread', () => {
  expect(showMeBoardOpensIn({ page: 'inbox', thread: B }, A)).toBe('home');
  expect(showMeBoardOpensIn({ page: 'inbox', thread: null }, A)).toBe('home');
  expect(showMeBoardOpensIn({ page: 'settings', thread: null }, A)).toBe('home');
});
