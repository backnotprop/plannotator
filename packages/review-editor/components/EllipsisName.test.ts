import { describe, expect, test } from 'bun:test';
import { fitDirectory, fitMiddle } from './EllipsisName';

const monospace = (text: string) => text.length * 7;

describe('a name too long for its room', () => {
  test('keeps its end, so two names that differ only at the end still differ', () => {
    expect(fitMiddle('quarterly-revenue-summary-v12-final.ts', 91, monospace)).toBe('…v12-final.ts');
    expect(fitMiddle('quarterly-revenue-summary-v12-final-2.ts', 91, monospace)).toBe('…2-final-2.ts');
  });

  test('cuts between whole characters: an emoji family is never split', () => {
    const family = '👨‍👩‍👧‍👦';
    const width = (text: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length * 7;
    expect(fitMiddle(`report-${family}${family}.md`, 49, width)).toBe(`…-${family}${family}.md`);
  });

  test('a name that fits is left whole', () => {
    expect(fitMiddle('a.ts', 70, monospace)).toBe('a.ts');
  });
});

describe('a folder prefix too long for its room', () => {
  test('drops whole leading folders, cut at a separator, never mid-word', () => {
    expect(fitDirectory('src/ui/components/', 200, monospace)).toBe('src/ui/components/');
    expect(fitDirectory('src/ui/components/', 98, monospace)).toBe('…/components/');
    expect(fitDirectory('src/ui/components/', 40, monospace)).toBe('');
  });
});
