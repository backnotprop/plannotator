import { describe, expect, test } from 'bun:test';
import { wordSpanAt } from './wordAtPoint';

// Click-a-word highlights exactly the word under the pointer: these pin which
// characters count as one word, with and without Intl.Segmenter.
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
    test(`${how}: an apostrophe inside a word keeps it whole`, () => {
      expect(word("don't stop", 1, seg)).toBe("don't");
    });
  }

  test('Intl.Segmenter: a word in text without spaces', () => {
    const text = '我们今天发布新版本';
    const w = word(text, 4);
    expect(w).not.toBeNull();
    expect(w!.length).toBeLessThan(text.length);
  });
});
