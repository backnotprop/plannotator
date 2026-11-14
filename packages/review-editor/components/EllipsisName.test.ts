import { describe, expect, test } from 'bun:test';
import { fitMiddle } from './EllipsisName';

const monospace = (text: string) => text.length * 7;

describe('a name too long for its room', () => {
  test('keeps its extension and puts the ellipsis right against it, with no space', () => {
    expect(fitMiddle('reviewDecision.ts', 70, monospace)).toBe('review….ts');
    expect(fitMiddle('CountBadge.tsx', 70, monospace)).toBe('Count….tsx');
  });

  test('never loses its end, however narrow', () => {
    expect(fitMiddle('reviewDecision.ts', 10, monospace).endsWith('.ts')).toBe(true);
  });

  test('a name that fits is left whole', () => {
    expect(fitMiddle('a.ts', 70, monospace)).toBe('a.ts');
  });
});
