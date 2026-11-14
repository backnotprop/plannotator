import { expect, test } from 'bun:test';
import { semanticMinimapNotes } from './semanticMinimapNotes';

const op = (type: string, old: [number, number][], neu: [number, number][]) =>
  ({ type, lines: { old: old.map(([start, end]) => ({ start, end })), new: neu.map(([start, end]) => ({ start, end })) } }) as never;

test('moved, renamed and reformatted code become minimap notes on both sides; plain edits stay with the diff', () => {
  const notes = semanticMinimapNotes('src/a.ts', [
    op('moved', [[3, 9]], [[20, 26]]),
    op('movedWithEdit', [[30, 32]], [[40, 42]]),
    op('renamed', [[5, 5]], [[5, 5]]),
    op('reformatted', [], [[50, 60]]),
    op('extractedFunction', [[70, 74]], [[80, 86]]),
    op('edited', [[1, 1]], [[1, 1]]),
    op('added', [], [[90, 95]]),
  ]);
  expect(notes.map((n) => `${n.kind} ${n.side} ${n.lineStart}-${n.lineEnd}`)).toEqual([
    'moved old 3-9', 'moved new 20-26',
    'moved old 30-32', 'moved new 40-42',
    'renamed old 5-5', 'renamed new 5-5',
    'reformatted new 50-60',
    'moved old 70-74', 'moved new 80-86',
  ]);
  expect(notes.every((n) => n.filePath === 'src/a.ts')).toBe(true);
});
