/**
 * The file pane's "Unanchored" set takes several restore reports (the text highlighter, each diagram block, the
 * image-region check), each about only the comments it tried.
 *
 * What regresses if this fails: a report replaces the whole set again, so the last reporter wins and a diagram
 * comment that could not be placed loses its "Unanchored" chip when the highlighter or another diagram reports with
 * nothing missing; or a comment that is placed again keeps its chip; or a report that changes nothing hands back a
 * new set, so the pane re-renders for nothing.
 */
import { describe, expect, test } from 'bun:test';
import { mergeUnanchoredReport } from './unanchoredSet';

describe('mergeUnanchoredReport', () => {
  test("a later report about other comments leaves an earlier reporter's unanchored comment in place", () => {
    // Diagram A could not place its comment; then the highlighter reports its text comments, all found.
    const afterA = mergeUnanchoredReport(new Set(), { attempted: ['diagram-a-1'], unanchored: ['diagram-a-1'] });
    const afterB = mergeUnanchoredReport(afterA, { attempted: ['text-1', 'text-2'], unanchored: [] });
    expect([...afterB]).toEqual(['diagram-a-1']);
  });

  test('a comment its reporter places again leaves the set, and one it loses joins it', () => {
    const start: ReadonlySet<string> = new Set(['diagram-a-1', 'text-9']);
    const next = mergeUnanchoredReport(start, { attempted: ['diagram-a-1', 'diagram-a-2'], unanchored: ['diagram-a-2'] });
    expect([...next].sort()).toEqual(['diagram-a-2', 'text-9']);
  });

  test('a report that changes nothing returns the same set', () => {
    const start: ReadonlySet<string> = new Set(['diagram-a-1']);
    expect(mergeUnanchoredReport(start, { attempted: ['diagram-a-1', 'text-1'], unanchored: ['diagram-a-1'] })).toBe(start);
    const empty: ReadonlySet<string> = new Set();
    expect(mergeUnanchoredReport(empty, { attempted: ['text-1'], unanchored: [] })).toBe(empty);
  });
});
