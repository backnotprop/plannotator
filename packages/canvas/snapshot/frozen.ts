/**
 * A capture as something the ordinary renderer can draw: a small read-only
 * store holding just the captured objects. One per capture, made on first
 * use; only the few most recently drawn are kept, so a plan with many
 * snapshots holds stores for the figures near the screen and no more.
 */
import { CanvasStore } from '../events/store';
import { captureDocument } from '../model/capture';
import type { SnapshotCapture } from '../model/types';

const KEEP = 12;
const stores = new Map<SnapshotCapture, CanvasStore>();

export function frozenStore(capture: SnapshotCapture): CanvasStore {
  const hit = stores.get(capture);
  if (hit) {
    stores.delete(capture);
    stores.set(capture, hit);
    return hit;
  }
  const store = new CanvasStore(captureDocument(capture), { undoLimit: 0, logLimit: 0 });
  stores.set(capture, store);
  if (stores.size > KEEP) stores.delete(stores.keys().next().value as SnapshotCapture);
  return store;
}
