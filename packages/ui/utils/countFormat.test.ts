import { describe, expect, test } from 'bun:test';
import { formatCount, plural } from './countFormat';

describe('counts read as numbers and words', () => {
  test('separators above a thousand, singular for one', () => {
    expect(formatCount(12457)).toBe('12,457');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(1500, 'file')).toBe('1,500 files');
  });
});
