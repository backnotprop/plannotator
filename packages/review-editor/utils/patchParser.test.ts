import { describe, expect, test } from 'bun:test';
import { isLineRangeInPatch } from './patchParser';

const PATCH = [
  '@@ -10,4 +20,5 @@',
  ' context',
  '-old',
  '+new',
  '+added',
  ' context',
  '@@ -40 +50 @@',
  '-before',
  '+after',
].join('\n');

describe('isLineRangeInPatch', () => {
  test('accepts complete ranges represented by one hunk on the requested side', () => {
    expect(isLineRangeInPatch(PATCH, 20, 24, 'new')).toBe(true);
    expect(isLineRangeInPatch(PATCH, 10, 13, 'old')).toBe(true);
    expect(isLineRangeInPatch(PATCH, 50, 50, 'new')).toBe(true);
  });

  test('rejects out-of-hunk, cross-hunk, and side-mismatched ranges', () => {
    expect(isLineRangeInPatch(PATCH, 19, 20, 'new')).toBe(false);
    expect(isLineRangeInPatch(PATCH, 24, 50, 'new')).toBe(false);
    expect(isLineRangeInPatch(PATCH, 14, 14, 'old')).toBe(false);
  });

  test('rejects empty hunk sides and invalid ranges', () => {
    const addition = '@@ -0,0 +1,2 @@\n+one\n+two';
    expect(isLineRangeInPatch(addition, 1, 1, 'old')).toBe(false);
    expect(isLineRangeInPatch(addition, 1, 2, 'new')).toBe(true);
    expect(isLineRangeInPatch(PATCH, 4, 3, 'new')).toBe(false);
  });
});
