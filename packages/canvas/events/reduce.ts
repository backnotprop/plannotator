/**
 * Events → state. Pure, and tolerant on purpose: an event about an object
 * that is no longer there does nothing instead of throwing, because events
 * also arrive from peers and from an undo made after someone else's change.
 *
 * Applying a batch copies the object map once, so a drag of 500 objects is
 * one copy per frame, and every object the batch did not touch keeps its
 * identity (the renderer skips those with a reference check).
 */
import type { CanvasDocument, CanvasObject, Snapshot } from '../model/types';
import type { CanvasEvent } from './types';

export interface Applied {
  doc: CanvasDocument;
  /** The events that put the document back, already in the order to apply. */
  inverse: CanvasEvent[];
  /** The events that did something. An event that changed nothing is left out. */
  applied: CanvasEvent[];
}

const clampIndex = (at: number | undefined, length: number): number =>
  at === undefined || !Number.isFinite(at) ? length : Math.max(0, Math.min(length, Math.trunc(at)));

export function applyEvents(doc: CanvasDocument, events: readonly CanvasEvent[]): Applied {
  let objects: Record<string, CanvasObject> | null = null;
  let order: string[] | null = null;
  let snapshots: Record<string, Snapshot> | null = null;
  let title = doc.title;
  const undo: CanvasEvent[] = [];
  const applied: CanvasEvent[] = [];

  const objs = () => (objects ??= { ...doc.objects });
  const ord = () => (order ??= [...doc.order]);
  const snaps = () => (snapshots ??= { ...doc.snapshots });
  const current = (id: string): CanvasObject | undefined => (objects ?? doc.objects)[id];

  for (const event of events) {
    switch (event.type) {
      case 'object-added': {
        if (current(event.object.id)) break;
        const list = ord();
        const at = clampIndex(event.at, list.length);
        objs()[event.object.id] = event.object;
        list.splice(at, 0, event.object.id);
        undo.push({ type: 'object-removed', id: event.object.id });
        applied.push(event);
        break;
      }
      case 'object-changed': {
        const before = current(event.object.id);
        if (!before || before === event.object) break;
        objs()[event.object.id] = event.object;
        undo.push({ type: 'object-changed', object: before });
        applied.push(event);
        break;
      }
      case 'object-removed': {
        const before = current(event.id);
        if (!before) break;
        const list = ord();
        const at = list.indexOf(event.id);
        if (at !== -1) list.splice(at, 1);
        delete objs()[event.id];
        undo.push({ type: 'object-added', object: before, at: at === -1 ? undefined : at });
        applied.push(event);
        break;
      }
      case 'object-ordered': {
        if (!current(event.id)) break;
        const list = ord();
        const from = list.indexOf(event.id);
        if (from === -1) break;
        list.splice(from, 1);
        const to = clampIndex(event.at, list.length);
        list.splice(to, 0, event.id);
        if (from === to) break;
        undo.push({ type: 'object-ordered', id: event.id, at: from });
        applied.push(event);
        break;
      }
      case 'snapshot-put': {
        const before = (snapshots ?? doc.snapshots)[event.snapshot.id];
        snaps()[event.snapshot.id] = event.snapshot;
        undo.push(before ? { type: 'snapshot-put', snapshot: before } : { type: 'snapshot-removed', id: event.snapshot.id });
        applied.push(event);
        break;
      }
      case 'snapshot-removed': {
        const before = (snapshots ?? doc.snapshots)[event.id];
        if (!before) break;
        delete snaps()[event.id];
        undo.push({ type: 'snapshot-put', snapshot: before });
        applied.push(event);
        break;
      }
      case 'title-set': {
        if (event.title === title) break;
        undo.push({ type: 'title-set', title });
        title = event.title;
        applied.push(event);
        break;
      }
    }
  }

  if (applied.length === 0) return { doc, inverse: [], applied };
  return {
    doc: {
      version: doc.version,
      id: doc.id,
      title,
      objects: objects ?? doc.objects,
      order: order ?? doc.order,
      snapshots: snapshots ?? doc.snapshots,
    },
    inverse: undo.reverse(),
    applied,
  };
}
