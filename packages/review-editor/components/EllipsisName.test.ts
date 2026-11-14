import { describe, expect, test } from 'bun:test';
import { fitDirectory, fitMiddle } from './EllipsisName';

const monospace = (text: string) => text.length * 7;

describe('a name too long for its room', () => {
  test('keeps its extension and puts the ellipsis right against it, with no space', () => {
    expect(fitMiddle('reviewDecision.ts', 70, monospace)).toBe('reviewD…ts');
    expect(fitMiddle('CountBadge.tsx', 70, monospace)).toBe('CountB…tsx');
  });

  test('never loses its end, however narrow', () => {
    expect(fitMiddle('reviewDecision.ts', 10, monospace).endsWith('ts')).toBe(true);
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
