import { describe, expect, test } from 'bun:test';
import { collectHeaderHeightHints, headerHeightFor } from './headerHeightHints';

describe('header height hints: a hinted item is first laid out at the hinted height', () => {
  const hints = collectHeaderHeightHints(
    [
      ['item-image', 'assets/logo.png'],
      ['item-code', 'src/server.ts'],
    ],
    (_itemId, path) => (path.endsWith('.png') ? 218.4 : undefined),
  );

  test('only the hinted item carries a height, rounded up', () => {
    expect([...hints]).toEqual([['item-image', 219]]);
  });

  test('before any measurement the first metrics use the hint; other items keep the base header', () => {
    const sources = { measured: new Map<string, number>(), measuredOnce: new Set<string>(), hints, baseHeight: 33 };
    expect(headerHeightFor('item-image', sources)).toBe(219);
    expect(headerHeightFor('item-code', sources)).toBe(33);
  });

  test('a measurement replaces the hint, and once measured the hint never comes back', () => {
    expect(headerHeightFor('item-image', { measured: new Map([['item-image', 160]]), measuredOnce: new Set(['item-image']), hints, baseHeight: 33 })).toBe(160);
    expect(headerHeightFor('item-image', { measured: new Map(), measuredOnce: new Set(['item-image']), hints, baseHeight: 33 })).toBe(33);
  });

  test('no hint function, no hints', () => {
    expect(collectHeaderHeightHints([['item-image', 'assets/logo.png']], undefined).size).toBe(0);
  });
});
