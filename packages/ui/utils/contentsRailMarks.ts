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
 * - A closed-rail row is a span of headings (more than ten are sampled into
 *   ten spans): its dots are every annotation in the span, so a heading
 *   sampled away folds its dots into the row that stands for it.
 * - Closed: at most three dots; more than three is two dots and a "more".
 *   Open panel: at most seven dots, then "+N".
 */
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

/** One rendered rail row: the item it shows and the span of items it stands for. */
export interface ContentsRailMarkRow {
  readonly itemIndex: number;
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

/** A reply sits where the comment it answers sits. */
function placeOf(
  annotation: Annotation,
  places: ReadonlyMap<string, ContentsRailMarkPlace>,
  byId: ReadonlyMap<string, Annotation>,
): ContentsRailMarkPlace | undefined {
  let current: Annotation | undefined = annotation;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    const place = places.get(current.id);
    if (place !== undefined) return place;
    seen.add(current.id);
    current = current.inReplyTo === undefined ? undefined : byId.get(current.inReplyTo);
  }
  return undefined;
}

/**
 * Each rendered row's marks. `open`: the open panel's caps (seven, then
 * "+N"), else the closed rail's (three; more is two and a "more"). Global
 * comments come first on the row that starts the document; the rest follow
 * in document order. An annotation with no place (no rendered highlight, and
 * not global) is not drawn.
 */
export function layoutContentsRailMarks(
  rows: readonly ContentsRailMarkRow[],
  annotations: readonly Annotation[],
  places: ReadonlyMap<string, ContentsRailMarkPlace>,
  open: boolean,
): ContentsRailRowMarks[] {
  const byId = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const globals = annotations.filter((annotation) => annotation.type === AnnotationType.GLOBAL_COMMENT && annotation.inReplyTo === undefined);
  const placed: Array<{ annotation: Annotation; place: ContentsRailMarkPlace }> = [];
  for (const annotation of annotations) {
    if (annotation.type === AnnotationType.GLOBAL_COMMENT && annotation.inReplyTo === undefined) continue;
    const place = placeOf(annotation, places, byId);
    if (place !== undefined) placed.push({ annotation, place });
  }
  // Document order; a reply after the comment it answers (a stable sort keeps their input order).
  placed.sort((a, b) => a.place.order - b.place.order);
  const firstRow = rows.findIndex((row) => row.rangeStart === 0);
  const cap = open ? CONTENTS_RAIL_OPEN_MARKS : CONTENTS_RAIL_CLOSED_MARKS;

  return rows.map((row, rowIndex) => {
    const marks = [
      ...(rowIndex === firstRow ? globals : []),
      ...placed
        .filter(({ place }) => place.itemIndex >= row.rangeStart && place.itemIndex <= row.rangeEnd)
        .map(({ annotation }) => annotation),
    ];
    if (marks.length <= cap) return { shown: marks, more: 0, total: marks.length };
    // Closed: the third dot is the "more". Open: seven dots, then "+N".
    const shownCount = open ? cap : cap - 1;
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
