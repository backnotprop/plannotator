/**
 * The contents rail's annotation marks (owner-approved 2026-11, variant 1:
 * "dots beside each heading's tick"): which section each annotation is in,
 * and how many dots each rail row draws. Pure, so the arithmetic is tested
 * without a page; MarkdownContentsRail.tsx draws it.
 *
 * - A section is a heading (levels 1 to 4, the rail's items) and the document
 *   down to the next one. An annotation belongs to the last heading at or
 *   before its first rendered highlight; one before the first heading belongs
 *   to the first.
 * - A global comment (no position) goes on the first row.
 * - A comment and its replies are one mark: the root's.
 * - A closed-rail row is a span of headings (more than ten are sampled into
 *   ten spans): its dots are every annotation in the span, so a heading
 *   sampled away folds its dots into the row that stands for it.
 * - Closed: at most three dots; more than three is two dots and a "more".
 *   Open panel: at most seven dots, then "+N" (a long "+N" gives back dots).
 */
import { resolveReplyParents } from '@plannotator/core/annotation-threads';
import { AnnotationType, type Annotation } from '../types';

/** Dots a closed-rail row draws before the third becomes a "more". */
export const CONTENTS_RAIL_CLOSED_MARKS = 3;
/** Dots an open-panel row draws before "+N". */
export const CONTENTS_RAIL_OPEN_MARKS = 7;

/** Where an annotation sits: its heading (the rail item's index) and its order in the document. */
export interface ContentsRailMarkPlace {
  readonly itemIndex: number;
  readonly order: number;
}

/** One rendered rail row: the span of items it stands for (an open row: its one item). */
export interface ContentsRailMarkRow {
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

/** A row's marks: the dots drawn, in order, and how many more there are. */
export interface ContentsRailRowMarks {
  readonly shown: readonly Annotation[];
  readonly more: number;
  readonly total: number;
}

/** What the section math needs of a DOM node (a test passes stand-ins). */
export interface DocumentPositioned {
  compareDocumentPosition(other: DocumentPositioned): number;
}

const DOCUMENT_POSITION_PRECEDING = 2;

/**
 * The index of the last heading at or before `node`, by document order;
 * 0 when it is before them all. `headings` are in document order.
 */
export function sectionIndexOf(headings: readonly DocumentPositioned[], node: DocumentPositioned): number {
  let low = 0;
  let high = headings.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const heading = headings[middle]!;
    // The heading is the node, contains it, or comes before it.
    const atOrBefore = heading === node || (node.compareDocumentPosition(heading) & DOCUMENT_POSITION_PRECEDING) !== 0;
    if (atOrBefore) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Each annotation's place from its rendered highlights. `highlights` are the
 * page's highlight elements in document order, each with its annotation id;
 * the first one of an id is where it is. `headings[i]` is item `itemIndexes[i]`.
 * Ids that are not in `ids` (another document's) are skipped.
 */
export function placeContentsRailMarks(
  headings: readonly DocumentPositioned[],
  itemIndexes: readonly number[],
  highlights: Iterable<{ readonly id: string; readonly node: DocumentPositioned }>,
  ids: ReadonlySet<string>,
): Map<string, ContentsRailMarkPlace> {
  const places = new Map<string, ContentsRailMarkPlace>();
  if (headings.length === 0) return places;
  for (const { id, node } of highlights) {
    if (!ids.has(id) || places.has(id)) continue;
    const section = sectionIndexOf(headings, node);
    places.set(id, { itemIndex: itemIndexes[section] ?? 0, order: places.size });
  }
  return places;
}

/**
 * The document's annotations by thread, grouped once per measure (linear):
 * a comment and its replies are one mark, the root's (its kind, its place),
 * by the shared threading rule (resolveReplyParents). Global threads, in
 * their order, go on the row that starts the document; the rest by the
 * section their root is in (else the first placed reply's), in document
 * order. A thread with no place (no rendered highlight, not global) is not
 * drawn. `rootOf` is each annotation's thread root (a selected reply
 * selects its thread's mark).
 */
export interface ContentsRailMarkGroups {
  readonly globals: readonly Annotation[];
  readonly byItem: ReadonlyMap<number, readonly Annotation[]>;
  readonly rootOf: ReadonlyMap<string, string>;
}

export function groupContentsRailMarks(
  annotations: readonly Annotation[],
  places: ReadonlyMap<string, ContentsRailMarkPlace>,
): ContentsRailMarkGroups {
  const parents = resolveReplyParents(annotations);
  const rootOf = new Map<string, string>();
  const rootIdOf = (id: string): string => {
    const path: string[] = [];
    let current = id;
    let root: string | undefined;
    while (root === undefined) {
      const known = rootOf.get(current);
      if (known !== undefined) {
        root = known;
        break;
      }
      path.push(current);
      const parent = parents.get(current) ?? null;
      // resolveReplyParents leaves no cycle: every chain ends at a root.
      if (parent === null) root = current;
      else current = parent;
    }
    for (const entry of path) rootOf.set(entry, root);
    return root;
  };
  const threadPlace = new Map<string, ContentsRailMarkPlace>();
  for (const annotation of annotations) {
    const root = rootIdOf(annotation.id);
    const place = places.get(annotation.id);
    if (place === undefined) continue;
    const held = threadPlace.get(root);
    // The root's own place wins; else the earliest placed reply's.
    if (held === undefined || annotation.id === root || (places.get(root) === undefined && place.order < held.order)) {
      threadPlace.set(root, place);
    }
  }
  const globals: Annotation[] = [];
  const placed: Array<{ annotation: Annotation; place: ContentsRailMarkPlace }> = [];
  for (const annotation of annotations) {
    if (rootOf.get(annotation.id) !== annotation.id) continue;
    if (annotation.type === AnnotationType.GLOBAL_COMMENT) {
      globals.push(annotation);
      continue;
    }
    const place = threadPlace.get(annotation.id);
    if (place !== undefined) placed.push({ annotation, place });
  }
  placed.sort((a, b) => a.place.order - b.place.order);
  const byItem = new Map<number, Annotation[]>();
  for (const { annotation, place } of placed) {
    const list = byItem.get(place.itemIndex);
    if (list === undefined) byItem.set(place.itemIndex, [annotation]);
    else list.push(annotation);
  }
  return { globals, byItem, rootOf };
}

/** An open-panel dot's slot, px. */
export const CONTENTS_RAIL_OPEN_MARK_WIDTH = 8;

/** The open panel's "+N" slot, px: its characters at 10 px tabular digits (6.5 px each, the widest common mono) and 4 px. */
export function contentsRailMoreWidth(more: number): number {
  return Math.ceil((String(more).length + 1) * 6.5) + 4;
}

/** An open row's dots and "+N" never take more than seven dots and a two-digit "+N". */
export const CONTENTS_RAIL_OPEN_MARKS_SPAN =
  CONTENTS_RAIL_OPEN_MARKS * CONTENTS_RAIL_OPEN_MARK_WIDTH + contentsRailMoreWidth(99);

/**
 * Each rendered row's marks, from the groups. `open`: the open panel's caps
 * (seven, then "+N"; a "+N" of three digits or more gives back a dot so the
 * row's marks stay in their span), else the closed rail's (three; more is
 * two and a "more"). Rows are spans of items that do not overlap, so this is
 * linear in the rows and the marks.
 */
export function layoutContentsRailMarks(
  rows: readonly ContentsRailMarkRow[],
  groups: ContentsRailMarkGroups,
  open: boolean,
): ContentsRailRowMarks[] {
  const firstRow = rows.findIndex((row) => row.rangeStart === 0);
  const cap = open ? CONTENTS_RAIL_OPEN_MARKS : CONTENTS_RAIL_CLOSED_MARKS;

  return rows.map((row, rowIndex) => {
    const marks: Annotation[] = rowIndex === firstRow ? [...groups.globals] : [];
    for (let item = row.rangeStart; item <= row.rangeEnd; item++) {
      const list = groups.byItem.get(item);
      if (list !== undefined) marks.push(...list);
    }
    if (marks.length <= cap) return { shown: marks, more: 0, total: marks.length };
    if (!open) {
      // Closed: the third dot is the "more".
      const shownCount = cap - 1;
      return { shown: marks.slice(0, shownCount), more: marks.length - shownCount, total: marks.length };
    }
    let shownCount = cap;
    while (
      shownCount > 1 &&
      shownCount * CONTENTS_RAIL_OPEN_MARK_WIDTH + contentsRailMoreWidth(marks.length - shownCount) > CONTENTS_RAIL_OPEN_MARKS_SPAN
    ) {
      shownCount--;
    }
    return { shown: marks.slice(0, shownCount), more: marks.length - shownCount, total: marks.length };
  });
}

const KIND_WORD: Record<AnnotationType, string> = {
  [AnnotationType.COMMENT]: 'Comment',
  [AnnotationType.DELETION]: 'Deletion',
  [AnnotationType.GLOBAL_COMMENT]: 'Global',
};

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > limit / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}

/** The start of a comment: its first sentence when that is short, else its first words. */
function commentStart(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?)[.!?](?:\s|$)/.exec(flat);
  if (sentence !== null && sentence[1]!.length <= limit) {
    return sentence[0].trim().length < flat.length ? `${sentence[1]}…` : flat;
  }
  return clip(flat, limit);
}

/** A mark's accessible name: `Comment, "Four workers to start": Four is a guess…` (kind, quote, the comment's start). */
export function contentsRailMarkName(annotation: Annotation): string {
  const kind = KIND_WORD[annotation.type] ?? 'Comment';
  const quote = annotation.type === AnnotationType.GLOBAL_COMMENT ? '' : annotation.originalText.trim();
  const text = annotation.type === AnnotationType.DELETION ? '' : (annotation.text ?? '').trim();
  return `${kind}${quote ? `, "${clip(quote, 48)}"` : ''}${text ? `: ${commentStart(text)}` : ''}`;
}
