import { describe, expect, test } from 'bun:test';
import { wordSpanAt } from './wordAtPoint';

describe('wordSpanAt', () => {
  const word = (text: string, index: number, seg = true) => {
    const span = wordSpanAt(text, index, seg);
    return span ? text.slice(span[0], span[1]) : null;
  };

  for (const seg of [true, false]) {
    const how = seg ? 'Intl.Segmenter' : 'fallback';
    test(`${how}: the word around any of its letters`, () => {
      const text = 'Run the focused tests, then the boot check.';
      expect(word(text, 8, seg)).toBe('focused');
      expect(word(text, 14, seg)).toBe('focused');
      expect(word(text, 0, seg)).toBe('Run');
    });
    test(`${how}: spaces and punctuation are no word`, () => {
      const text = 'tests, then';
      expect(word(text, 5, seg)).toBeNull();
      expect(word(text, 6, seg)).toBeNull();
    });
    test(`${how}: words joined by a hyphen are one word, from any part of it`, () => {
      const text = 'Dead-lettered charges, a well-known re-run.';
      expect(word(text, 1, seg)).toBe('Dead-lettered');
      expect(word(text, 8, seg)).toBe('Dead-lettered');
      expect(word(text, 4, seg)).toBe('Dead-lettered');
      expect(word(text, 27, seg)).toBe('well-known');
      expect(word(text, 38, seg)).toBe('re-run');
      expect(word('state-of-the-art', 7, seg)).toBe('state-of-the-art');
    });
    test(`${how}: a possessive or a contraction is one word`, () => {
      expect(word("the user's key", 5, seg)).toBe("user's");
      expect(word("the user's key", 9, seg)).toBe("user's");
      expect(word('it’s fine', 0, seg)).toBe('it’s');
    });
    test(`${how}: a spaced dash, a slash and a dot do not join words`, () => {
      expect(word('a - b', 0, seg)).toBe('a');
      expect(word('a - b', 2, seg)).toBeNull();
      expect(word('a - b', 4, seg)).toBe('b');
      expect(word('read/write access', 1, seg)).toBe('read');
      expect(word('read/write access', 6, seg)).toBe('write');
      expect(word('retry.cap = 5m', 1, seg)).toBe('retry');
      expect(word('one -- two', 0, seg)).toBe('one');
      expect(word('retry.cap = 5m', 7, seg)).toBe('cap');
      expect(word('retry.cap = 5m', 5, seg)).toBeNull();
    });
    test(`${how}: a leading or trailing hyphen is not part of the word`, () => {
      expect(word('-flag on', 2, seg)).toBe('flag');
      expect(word('-flag on', 0, seg)).toBeNull();
      expect(word('pre- and post', 1, seg)).toBe('pre');
      expect(word('pre- and post', 3, seg)).toBeNull();
      expect(word("'quoted'", 3, seg)).toBe('quoted');
    });
    test(`${how}: an apostrophe inside a word keeps it whole`, () => {
      expect(word("don't stop", 1, seg)).toBe("don't");
    });
  }

  test('Intl.Segmenter: a number with a decimal point stays whole', () => {
    expect(word('version 0.28 today', 9)).toBe('0.28');
  });

  test('Intl.Segmenter: a word in text without spaces', () => {
    const text = '我们今天发布新版本';
    const w = word(text, 4);
    expect(w).not.toBeNull();
    expect(w!.length).toBeLessThan(text.length);
  });
});
