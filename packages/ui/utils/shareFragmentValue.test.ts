/**
 * A share link clicked in a terminal that took the sentence's punctuation into the link (`…#key=abc).`) still
 * opens the shared document: the key, the paste origin and the payload are base64url, which never ends with one.
 */
import { describe, expect, test } from 'bun:test';
import { compress, decompress } from '@plannotator/core/compress';
import { shareFragmentValue } from './sharing';

describe('shareFragmentValue', () => {
  test('a key or payload with the punctuation after its link loses it', async () => {
    const payload = await compress({ p: '# Plan', a: [] });
    for (const tail of [').', '.', ',', ';', ':', ']', '>', '"', "'"]) {
      expect(shareFragmentValue(`abc-DEF_123${tail}`)).toBe('abc-DEF_123');
      expect(await decompress(shareFragmentValue(`${payload}${tail}`))).toEqual({ p: '# Plan', a: [] });
    }
  });

  test('a value that is not base64url keeps every character', () => {
    for (const value of ['abc-DEF_123', 'a+b/c=.', 'notes (v2).', '']) expect(shareFragmentValue(value)).toBe(value);
  });
});
