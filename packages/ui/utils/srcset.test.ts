/**
 * Failure to catch: a comma inside a URL (a `data:` URL, a query string) treated as a separator,
 * so a rewritten `srcset` names URLs the page never wrote.
 */
import { describe, expect, test } from 'bun:test';
import { parseSrcset } from './srcset';

describe('parseSrcset', () => {
  test('a comma inside a URL stays in the URL; one at its end separates', () => {
    expect(parseSrcset('data:image/png;base64,AAAA 2x, /a.png?w=1,2 1x,/b.png,, /c.png 640w')).toEqual([
      { url: 'data:image/png;base64,AAAA', descriptors: '2x' },
      { url: '/a.png?w=1,2', descriptors: '1x' },
      { url: '/b.png', descriptors: '' },
      { url: '/c.png', descriptors: '640w' },
    ]);
  });

  test('a comma inside a descriptor\'s parentheses does not end the candidate', () => {
    expect(parseSrcset('/a.png 1x (a, b), /b.png 2x')).toEqual([
      { url: '/a.png', descriptors: '1x (a, b)' },
      { url: '/b.png', descriptors: '2x' },
    ]);
  });

  test('an empty or comma-only value has no candidates', () => {
    expect(parseSrcset('')).toEqual([]);
    expect(parseSrcset(' , ,, ')).toEqual([]);
  });
});
