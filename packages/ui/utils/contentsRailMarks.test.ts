/**
 * The contents rail's annotation marks, the arithmetic (utils/contentsRailMarks):
 * which section a highlight is in, how a sampled row folds the sections it
 * stands for, the closed rail's three-dot cap with its "more", the open
 * panel's seven and "+N", global comments on the first row, and the marks'
 * accessible names. No page needed: nodes are stand-ins ordered by number.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import {
  CONTENTS_RAIL_OPEN_MARK_WIDTH,
  CONTENTS_RAIL_OPEN_MARKS_SPAN,
  contentsRailMarkName,
  contentsRailMoreWidth,
  groupContentsRailMarks,
  layoutContentsRailMarks,
  placeContentsRailMarks,
  sectionIndexOf,
  type ContentsRailMarkPlace,
  type ContentsRailMarkRow,
  type DocumentPositioned,
} from './contentsRailMarks';

/** A node at a document position: `compareDocumentPosition` as the DOM answers it (2: other is before, 4: after). */
class At implements DocumentPositioned {
  constructor(readonly position: number) {}
  compareDocumentPosition(other: DocumentPositioned): number {
    const there = (other as At).position;
    return there < this.position ? 2 : there > this.position ? 4 : 0;
  }
}

const annotation = (id: string, type = AnnotationType.COMMENT, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  blockId: '',
  startOffset: 0,
  endOffset: 0,
  type,
  text: `Note ${id}`,
  originalText: `words ${id}`,
  createdA: 0,
  ...extra,
});

const ids = (row: { shown: readonly Annotation[] }) => row.shown.map((entry) => entry.id);
const each = (count: number): ContentsRailMarkRow[] =>
  Array.from({ length: count }, (_, itemIndex) => ({ rangeStart: itemIndex, rangeEnd: itemIndex }));
const lay = (
  rows: readonly ContentsRailMarkRow[],
  notes: readonly Annotation[],
  places: ReadonlyMap<string, ContentsRailMarkPlace>,
  open: boolean,
) => layoutContentsRailMarks(rows, groupContentsRailMarks(notes, places), open);

describe('contents rail marks: sections', () => {
  const headings = [new At(10), new At(20), new At(30), new At(40)];

  test('a highlight is in the last heading at or before it; one before them all is in the first', () => {
    expect(sectionIndexOf(headings, new At(5))).toBe(0);
    expect(sectionIndexOf(headings, new At(10))).toBe(0);
    expect(sectionIndexOf(headings, new At(11))).toBe(0);
    expect(sectionIndexOf(headings, new At(29))).toBe(1);
    expect(sectionIndexOf(headings, new At(31))).toBe(2);
    expect(sectionIndexOf(headings, new At(99))).toBe(3);
  });

  test('each annotation is placed by its first highlight, in document order; other ids are skipped', () => {
    const places = placeContentsRailMarks(
      headings,
      [0, 1, 3, 4], // a heading the page did not draw (item 2) is skipped by the bindings
      [
        { id: 'b', node: new At(21) },
        { id: 'a', node: new At(35) },
        { id: 'b', node: new At(45) }, // b's second highlight: b stays where it starts
        { id: 'elsewhere', node: new At(22) },
        { id: 'c', node: new At(41) },
      ],
      new Set(['a', 'b', 'c']),
    );
    expect(places.get('b')).toEqual({ itemIndex: 1, order: 0 });
    expect(places.get('a')).toEqual({ itemIndex: 3, order: 1 });
    expect(places.get('c')).toEqual({ itemIndex: 4, order: 2 });
    expect(places.has('elsewhere')).toBe(false);
  });
});

describe('contents rail marks: rows', () => {
  test('closed: up to three dots; more is two dots and a "more" for the rest', () => {
    const notes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => annotation(id));
    const places = new Map([
      ['a', { itemIndex: 0, order: 0 }],
      ['b', { itemIndex: 1, order: 1 }],
      ['c', { itemIndex: 1, order: 2 }],
      ['d', { itemIndex: 1, order: 3 }],
      ['e', { itemIndex: 2, order: 4 }],
      ['f', { itemIndex: 2, order: 5 }],
    ]);
    const rows = lay(each(4), notes, places, false);
    expect(rows.map(ids)).toEqual([['a'], ['b', 'c', 'd'], ['e', 'f'], []]);
    expect(rows.map((row) => row.more)).toEqual([0, 0, 0, 0]);

    const busy = [...notes, annotation('g')];
    const busyPlaces = new Map([...places, ['g', { itemIndex: 1, order: 6 }]]);
    const busyRow = lay(each(4), busy, busyPlaces, false)[1]!;
    expect(ids(busyRow)).toEqual(['b', 'c']);
    expect(busyRow.more).toBe(2);
    expect(busyRow.total).toBe(4);
  });

  test('open: up to seven dots, then "+N"', () => {
    const notes = Array.from({ length: 20 }, (_, index) => annotation(`n${index}`));
    const places = new Map(notes.map((note, order) => [note.id, { itemIndex: 2, order }]));
    const row = lay(each(3), notes, places, true)[2]!;
    expect(ids(row)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(row.more).toBe(13);

    const seven = notes.slice(0, 7);
    const full = lay(each(3), seven, places, true)[2]!;
    expect(full.shown).toHaveLength(7);
    expect(full.more).toBe(0);
  });

  test('a sampled row holds every section it stands for, in document order', () => {
    // 30 headings sampled into ten rows of three: row 4 stands for items 12 to 14 (it shows one of them).
    const rows: ContentsRailMarkRow[] = Array.from({ length: 10 }, (_, slot) => ({
      rangeStart: slot * 3,
      rangeEnd: slot * 3 + 2,
    }));
    const notes = ['x', 'y', 'z'].map((id) => annotation(id));
    const places = new Map([
      ['y', { itemIndex: 14, order: 1 }], // sampled away: folds into row 4
      ['x', { itemIndex: 12, order: 0 }],
      ['z', { itemIndex: 15, order: 2 }], // the next span
    ]);
    const laid = lay(rows, notes, places, false);
    expect(ids(laid[4]!)).toEqual(['x', 'y']);
    expect(ids(laid[5]!)).toEqual(['z']);
  });

  test('global comments come first on the first row; unplaced comments are not drawn; a reply has no dot of its own', () => {
    const notes = [
      annotation('late'),
      annotation('g1', AnnotationType.GLOBAL_COMMENT),
      annotation('first'),
      annotation('g2', AnnotationType.GLOBAL_COMMENT),
      annotation('lost'),
      annotation('reply', AnnotationType.COMMENT, { inReplyTo: 'late' }),
    ];
    const places = new Map([
      ['late', { itemIndex: 1, order: 1 }],
      ['first', { itemIndex: 0, order: 0 }],
    ]);
    const rows = lay(each(2), notes, places, true);
    expect(ids(rows[0]!)).toEqual(['g1', 'g2', 'first']);
    expect(ids(rows[1]!)).toEqual(['late']);

    // Closed, a third global fills the first row past three: two globals and a "more".
    const closed = lay(each(2), [...notes, annotation('g3', AnnotationType.GLOBAL_COMMENT)], places, false);
    expect(ids(closed[0]!)).toEqual(['g1', 'g2']);
    expect(closed[0]!.more).toBe(2);
  });

  test('a thread is one dot, its root’s: six replies to an inline comment, a reply to a global comment', () => {
    const notes = [
      annotation('root'),
      ...Array.from({ length: 6 }, (_, index) =>
        annotation(`r${index}`, AnnotationType.COMMENT, { inReplyTo: index === 0 ? 'root' : `r${index - 1}` }),
      ),
      annotation('g', AnnotationType.GLOBAL_COMMENT),
      annotation('g-reply', AnnotationType.COMMENT, { inReplyTo: 'g' }),
      annotation('other'),
    ];
    // Replies drawn as highlights of their own (they may be) are still the thread's one dot.
    const places = new Map<string, ContentsRailMarkPlace>([
      ['root', { itemIndex: 1, order: 0 }],
      ['r3', { itemIndex: 1, order: 1 }],
      ['g-reply', { itemIndex: 2, order: 2 }],
      ['other', { itemIndex: 1, order: 3 }],
    ]);
    const groups = groupContentsRailMarks(notes, places);
    for (const open of [false, true]) {
      const rows = layoutContentsRailMarks(each(3), groups, open);
      expect(rows.map(ids)).toEqual([['g'], ['root', 'other'], []]);
      expect(rows.map((row) => row.more)).toEqual([0, 0, 0]);
    }
    // A selected reply is its thread's.
    expect(groups.rootOf.get('r5')).toBe('root');
    expect(groups.rootOf.get('g-reply')).toBe('g');
    expect(groups.rootOf.get('other')).toBe('other');

    // A root with no highlight of its own is where its first placed reply is.
    const late = groupContentsRailMarks(notes, new Map([['r2', { itemIndex: 2, order: 0 }]]));
    expect(layoutContentsRailMarks(each(3), late, false).map(ids)).toEqual([['g'], [], ['root']]);
  });

  test('open: a "+N" of three digits gives back dots so the row keeps to its span', () => {
    for (const total of [8, 106, 107, 1010]) {
      const notes = Array.from({ length: total }, (_, index) => annotation(`n${index}`));
      const places = new Map(notes.map((note, order) => [note.id, { itemIndex: 0, order }]));
      const row = lay(each(1), notes, places, true)[0]!;
      expect(row.shown.length + row.more).toBe(total);
      expect(row.shown.length * CONTENTS_RAIL_OPEN_MARK_WIDTH + contentsRailMoreWidth(row.more)).toBeLessThanOrEqual(
        CONTENTS_RAIL_OPEN_MARKS_SPAN,
      );
    }
    const at = (total: number) => {
      const notes = Array.from({ length: total }, (_, index) => annotation(`n${index}`));
      return lay(each(1), notes, new Map(notes.map((note, order) => [note.id, { itemIndex: 0, order }])), true)[0]!;
    };
    expect([at(8).shown.length, at(8).more]).toEqual([7, 1]);
    expect([at(106).shown.length, at(106).more]).toEqual([7, 99]);
    expect([at(107).shown.length, at(107).more]).toEqual([6, 101]);
    // Wider digits, wider slot.
    expect(contentsRailMoreWidth(100)).toBeGreaterThan(contentsRailMoreWidth(99));
  });

  test('a mark is named by its kind, its quote and the start of its comment', () => {
    expect(
      contentsRailMarkName(
        annotation('a', AnnotationType.COMMENT, {
          originalText: 'Four workers to start',
          text: 'Four is a guess. Size it from the peak retry rate.',
        }),
      ),
    ).toBe('Comment, "Four workers to start": Four is a guess…');
    expect(contentsRailMarkName(annotation('d', AnnotationType.DELETION, { originalText: 'the old queue', text: '' }))).toBe(
      'Deletion, "the old queue"',
    );
    expect(contentsRailMarkName(annotation('g', AnnotationType.GLOBAL_COMMENT, { originalText: '', text: 'Looks right.' }))).toBe(
      'Global: Looks right.',
    );
    const long = contentsRailMarkName(annotation('l', AnnotationType.COMMENT, { originalText: 'x', text: 'word '.repeat(40) }));
    expect(long.length).toBeLessThan(80);
    expect(long.endsWith('…')).toBe(true);
  });
});
