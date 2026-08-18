import { describe, expect, test } from 'bun:test';
import { mapEditedRangeToPristine, selectionToLineRange } from './selectionAnchor';

/**
 * Anchor mapping for "Make annotation" selections made inside an edit session:
 * edited-buffer line ranges map to PRISTINE (pre-edit, new-side) coordinates,
 * which are what the rendered diff and the feedback export anchor to. See
 * selectionAnchor.ts for the rules under test.
 */
describe('mapEditedRangeToPristine', () => {
  test('identity when nothing was edited', () => {
    const content = 'a\nb\nc\nd\n';
    expect(mapEditedRangeToPristine(content, content, 2, 3)).toEqual({
      lineStart: 2,
      lineEnd: 3,
      exact: true,
    });
  });

  test('unedited-region selection maps exactly through line shifts from edits above', () => {
    const pristine = 'a\nb\nc\nd\ne\n';
    // Line 1 replaced by two lines: everything below shifts down by one.
    const edited = 'x\ny\nb\nc\nd\ne\n';
    expect(mapEditedRangeToPristine(pristine, edited, 3, 4)).toEqual({
      lineStart: 2,
      lineEnd: 3,
      exact: true,
    });
  });

  test('unedited-region selection maps exactly through line shifts from a deletion above', () => {
    const pristine = 'a\nb\nc\nd\ne\n';
    const edited = 'a\nd\ne\n'; // b, c deleted
    expect(mapEditedRangeToPristine(pristine, edited, 2, 3)).toEqual({
      lineStart: 4,
      lineEnd: 5,
      exact: true,
    });
  });

  test('selection inside a modified region anchors to the pristine lines it replaces', () => {
    const pristine = 'a\nb\nc\nd\n';
    const edited = 'a\nB1\nB2\nc\nd\n'; // line 2 replaced by two lines
    expect(mapEditedRangeToPristine(pristine, edited, 2, 3)).toEqual({
      lineStart: 2,
      lineEnd: 2,
      exact: false,
    });
  });

  test('selection on a pure insertion anchors to the preceding pristine line', () => {
    const pristine = 'a\nb\nc\n';
    const edited = 'a\nb\nX\nc\n';
    expect(mapEditedRangeToPristine(pristine, edited, 3, 3)).toEqual({
      lineStart: 2,
      lineEnd: 2,
      exact: false,
    });
  });

  test('selection on an insertion at the top of the file anchors to line 1', () => {
    const pristine = 'a\nb\n';
    const edited = 'X\na\nb\n';
    expect(mapEditedRangeToPristine(pristine, edited, 1, 1)).toEqual({
      lineStart: 1,
      lineEnd: 1,
      exact: false,
    });
  });

  test('selection on an end-of-file append anchors to the last pristine line', () => {
    const pristine = 'a\nb\n';
    const edited = 'a\nb\nc\nd\n';
    expect(mapEditedRangeToPristine(pristine, edited, 3, 4)).toEqual({
      lineStart: 2,
      lineEnd: 2,
      exact: false,
    });
  });

  test('selection spanning unchanged and edited regions covers the union (hunk boundary)', () => {
    const pristine = 'a\nb\nc\nd\ne\n';
    const edited = 'a\nb\nC\nd\ne\n'; // line 3 modified
    expect(mapEditedRangeToPristine(pristine, edited, 2, 4)).toEqual({
      lineStart: 2,
      lineEnd: 4,
      exact: false,
    });
  });

  test('selection spanning two separate edit regions covers both plus the gap', () => {
    const pristine = 'a\nb\nc\nd\ne\n';
    const edited = 'a\nB\nc\nD\ne\n'; // lines 2 and 4 modified, line 3 untouched
    expect(mapEditedRangeToPristine(pristine, edited, 2, 4)).toEqual({
      lineStart: 2,
      lineEnd: 4,
      exact: false,
    });
  });

  test('a deletion strictly inside the selection widens the range and is not exact', () => {
    const pristine = 'a\nb\nc\nd\ne\n';
    const edited = 'a\nb\nd\ne\n'; // c deleted
    // Highlighting edited b and d straddles the deleted pristine c.
    expect(mapEditedRangeToPristine(pristine, edited, 2, 3)).toEqual({
      lineStart: 2,
      lineEnd: 4,
      exact: false,
    });
  });

  test('a deletion adjacent to (but outside) the selection stays exact', () => {
    const pristine = 'a\nb\nc\nd\ne\n';
    const edited = 'a\nb\nd\ne\n'; // c deleted
    // Selection starts AT the line after the deletion: nothing removed inside.
    expect(mapEditedRangeToPristine(pristine, edited, 3, 4)).toEqual({
      lineStart: 4,
      lineEnd: 5,
      exact: true,
    });
  });

  test('whole-file replacement anchors to the whole pristine file', () => {
    const pristine = 'a\nb\n';
    const edited = 'x\ny\nz\n';
    expect(mapEditedRangeToPristine(pristine, edited, 1, 3)).toEqual({
      lineStart: 1,
      lineEnd: 2,
      exact: false,
    });
  });

  test('empty pristine content falls back to line 1, not exact', () => {
    expect(mapEditedRangeToPristine('', 'x\ny\n', 1, 2)).toEqual({
      lineStart: 1,
      lineEnd: 1,
      exact: false,
    });
  });

  test('CRLF pristine against LF edited content still maps exactly', () => {
    const pristine = 'a\r\nb\r\nc\r\n';
    const edited = 'a\nb\nc\n';
    expect(mapEditedRangeToPristine(pristine, edited, 2, 2)).toEqual({
      lineStart: 2,
      lineEnd: 2,
      exact: true,
    });
  });

  test('out-of-range selection lines clamp into the file', () => {
    const content = 'a\nb\nc\n';
    expect(mapEditedRangeToPristine(content, content, 2, 99)).toEqual({
      lineStart: 2,
      lineEnd: 3,
      exact: true,
    });
    expect(mapEditedRangeToPristine(content, content, -5, 0)).toEqual({
      lineStart: 1,
      lineEnd: 1,
      exact: true,
    });
  });

  test('reversed input range is normalized', () => {
    const content = 'a\nb\nc\nd\n';
    expect(mapEditedRangeToPristine(content, content, 3, 2)).toEqual({
      lineStart: 2,
      lineEnd: 3,
      exact: true,
    });
  });
});

describe('selectionToLineRange', () => {
  test('converts zero-based positions to a 1-based inclusive range', () => {
    expect(
      selectionToLineRange({ start: { line: 2, character: 4 }, end: { line: 4, character: 7 } }),
    ).toEqual({ lineStart: 3, lineEnd: 5 });
  });

  test('a selection ending at character 0 does not include that line', () => {
    expect(
      selectionToLineRange({ start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }),
    ).toEqual({ lineStart: 3, lineEnd: 4 });
  });

  test('a single-line selection ending at character 0 keeps its line', () => {
    expect(
      selectionToLineRange({ start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }),
    ).toEqual({ lineStart: 4, lineEnd: 4 });
  });

  test('reversed positions are normalized', () => {
    expect(
      selectionToLineRange({ start: { line: 5, character: 2 }, end: { line: 1, character: 3 } }),
    ).toEqual({ lineStart: 2, lineEnd: 6 });
  });
});
