/**
 * A long file name is cut in its middle, never at its end (the stress test of
 * 2026-10-12, rows 16 to 20, 49 and 74, and the owner's own screenshot of a
 * tile): the end tells two files apart, so it is what stays.
 */
import { describe, expect, test } from 'bun:test';
import { splitFileName } from './components/FileName';

describe('splitFileName', () => {
  test('a short name is never split', () => {
    expect(splitFileName('notes.md')).toEqual(['notes.md', '']);
    expect(splitFileName('retry-policy.md')).toEqual(['retry-policy.md', '']);
  });

  test('the end keeps the extension and the last part of the stem', () => {
    expect(splitFileName('SPIKE-claude-code-mobile-annotations-20261012.md')).toEqual(['SPIKE-claude-code-mobile-annotations', '-20261012.md']);
    expect(splitFileName('checkout flow screenshot final v3.png')).toEqual(['checkout flow screenshot final', ' v3.png']);
  });

  test('two names that differ only at the end stay different where they are cut', () => {
    const [, a] = splitFileName('quarterly-revenue-forecast-model-2026-10-11.csv');
    const [, b] = splitFileName('quarterly-revenue-forecast-model-2026-10-12.csv');
    expect(a).not.toBe(b);
  });

  test('a stem with no separator near its end keeps its last characters', () => {
    expect(splitFileName('averyveryverylongfilenamewithoutanyseparators.tar')).toEqual(['averyveryverylongfilenamewithoutanysepa', 'rators.tar']);
  });

  test('the parts always make the name again, and never split a character', () => {
    for (const name of ['تقرير-المبيعات-الربعي-للمنطقة-الشمالية-٢٠٢٦.md', '設計レビューの議事録と次のアクション項目.txt', 'photo-of-the-team-🎉🎉🎉-offsite.jpg', 'x'.repeat(300)]) {
      const [head, tail] = splitFileName(name);
      expect(head + tail).toBe(name);
      expect(head).not.toMatch(/[\ud800-\udbff]$/);
    }
  });
});
