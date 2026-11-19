/**
 * What a snapshot shows right now. A snapshot is a reference into a document
 * that keeps changing, so every reader asks here, and the answer says
 * plainly when the thing it pointed at is no longer all there.
 */
import { boundsOf, objectBounds } from '../model/document';
import { type Rect, expandRect } from '../model/geometry';
import type { CanvasDocument, ObjectId, SnapshotId } from '../model/types';
import type { DocumentIndex } from '../view/document-index';
import { FRAME_TITLE_HEIGHT } from '../view/hit-test';

/** World units of air around a chosen set of objects. */
export const SNAPSHOT_PADDING = 24;

export type SnapshotProblem =
  /** There is no canvas document to read. */
  | 'no-canvas'
  /** The canvas has no snapshot with this id (it was removed). */
  | 'no-snapshot'
  /** The frame it showed was deleted. */
  | 'frame-deleted'
  /** Every object it showed was deleted. */
  | 'all-deleted'
  /** Some of the objects it showed were deleted. The rest are drawn. */
  | 'some-deleted';

export interface ResolvedSnapshot {
  /**
   * - `live`: all there.
   * - `partial`: drawn, with some of its objects gone (`missing` of `total`).
   * - `gone`: nothing to draw.
   */
  status: 'live' | 'partial' | 'gone';
  problem?: SnapshotProblem;
  /** The world rect to show. Null when gone. */
  rect: Rect | null;
  /** Draw only these objects, or everything in `rect` when null. */
  only: ReadonlySet<ObjectId> | null;
  title: string;
  missing: number;
  total: number;
}

const gone = (problem: SnapshotProblem, title = '', total = 0): ResolvedSnapshot => ({
  status: 'gone',
  problem,
  rect: null,
  only: null,
  title,
  missing: total,
  total,
});

export function resolveSnapshot(doc: CanvasDocument | null | undefined, index: DocumentIndex | null | undefined, id: SnapshotId): ResolvedSnapshot {
  if (!doc) return gone('no-canvas');
  const snapshot = doc.snapshots[id];
  if (!snapshot) return gone('no-snapshot');
  const { source, title } = snapshot;

  if (source.kind === 'frame') {
    const frame = doc.objects[source.frame];
    if (!frame || frame.type !== 'frame') return gone('frame-deleted', title, 1);
    const rect = expandRect({ x: frame.x, y: frame.y - FRAME_TITLE_HEIGHT, w: frame.w, h: frame.h + FRAME_TITLE_HEIGHT }, SNAPSHOT_PADDING / 2);
    return { status: 'live', rect, only: null, title, missing: 0, total: 1 };
  }

  const total = source.objects.length;
  const alive = source.objects.filter((object) => doc.objects[object]);
  const missing = total - alive.length;

  if (source.kind === 'objects') {
    const bounds = boundsOf(doc, alive);
    if (!bounds) return gone('all-deleted', title, total);
    return {
      status: missing ? 'partial' : 'live',
      ...(missing ? { problem: 'some-deleted' as const } : {}),
      rect: expandRect(bounds, SNAPSHOT_PADDING),
      only: new Set(alive.filter((object) => objectBounds(doc, object))),
      title,
      missing,
      total,
    };
  }

  // A region keeps its rectangle whatever happens inside it. It is gone only
  // when what it was made around was all deleted and nothing else is there.
  if (total > 0 && missing === total) {
    const anything = index ? index.spatial.query(source.rect).length > 0 : false;
    if (!anything) return gone('all-deleted', title, total);
  }
  return {
    status: missing ? 'partial' : 'live',
    ...(missing ? { problem: 'some-deleted' as const } : {}),
    rect: source.rect,
    only: null,
    title,
    missing,
    total,
  };
}

/** Whether two answers would draw the same figure. Lets a figure skip a redraw. */
export function sameResolution(a: ResolvedSnapshot, b: ResolvedSnapshot): boolean {
  if (a.status !== b.status || a.problem !== b.problem || a.title !== b.title || a.missing !== b.missing || a.total !== b.total) return false;
  if (!a.rect !== !b.rect) return false;
  if (a.rect && b.rect && (a.rect.x !== b.rect.x || a.rect.y !== b.rect.y || a.rect.w !== b.rect.w || a.rect.h !== b.rect.h)) return false;
  if (!a.only !== !b.only) return false;
  if (a.only && b.only) {
    if (a.only.size !== b.only.size) return false;
    for (const id of a.only) if (!b.only.has(id)) return false;
  }
  return true;
}
