/**
 * What a snapshot shows, and whether it is behind.
 *
 * A snapshot always shows its capture: the picture taken when it was made or
 * last updated. `resolveSnapshot` adds how that picture stands against the
 * canvas now:
 * - `current`: taking it again would give the same picture;
 * - `behind`: the canvas has changed where it looked, and it can be updated;
 * - `detached`: what it looked at is no longer on the canvas. The capture is
 *   all that is left of it, so it stays as it is and cannot be updated.
 */
import { type RectQuery, captureOf, capturesEqual } from '../model/capture';
import type { CanvasDocument, Snapshot, SnapshotCapture, SnapshotId } from '../model/types';
import type { DocumentIndex } from '../view/document-index';

export type SnapshotStanding = 'current' | 'behind' | 'detached';

export type ResolvedSnapshot =
  /** There is no canvas document to read, or it holds no snapshot with this id. */
  | { found: false; problem: 'no-canvas' | 'no-snapshot' }
  | { found: true; snapshot: Snapshot; capture: SnapshotCapture; standing: SnapshotStanding };

const queryOf = (index: DocumentIndex | null | undefined): RectQuery | undefined => (index ? (area) => index.spatial.query(area) : undefined);

/** How a snapshot's capture stands against the canvas now. Costs one look at what it covers. */
export function snapshotStanding(doc: CanvasDocument, index: DocumentIndex | null | undefined, snapshot: Snapshot): SnapshotStanding {
  const now = captureOf(doc, snapshot.source, queryOf(index));
  if (!now) return 'detached';
  return capturesEqual(now, snapshot.capture) ? 'current' : 'behind';
}

export function resolveSnapshot(doc: CanvasDocument | null | undefined, index: DocumentIndex | null | undefined, id: SnapshotId): ResolvedSnapshot {
  if (!doc) return { found: false, problem: 'no-canvas' };
  const snapshot = doc.snapshots[id];
  if (!snapshot) return { found: false, problem: 'no-snapshot' };
  return { found: true, snapshot, capture: snapshot.capture, standing: snapshotStanding(doc, index, snapshot) };
}

/** Of these snapshots, the ones that are behind: what "update all" would update. */
export function behindSnapshots(doc: CanvasDocument, index: DocumentIndex | null | undefined, ids: Iterable<SnapshotId>): SnapshotId[] {
  const out: SnapshotId[] = [];
  for (const id of new Set(ids)) {
    const snapshot = doc.snapshots[id];
    if (snapshot && snapshotStanding(doc, index, snapshot) === 'behind') out.push(id);
  }
  return out;
}
