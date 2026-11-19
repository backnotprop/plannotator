/**
 * Events → state. Pure, and tolerant on purpose: an event about an object
 * that is no longer there does nothing instead of throwing, because events
 * also arrive from peers and from an undo made after someone else's change.
 *
 * Applying a batch copies the object map once, so a drag of 500 objects is
 * one copy per frame, and every object the batch did not touch keeps its
 * identity (the renderer skips those with a reference check).
 */
import { bindingFault, groupCycle, idMap, isBoundEnd } from '../model/document';
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

/**
 * An object that would make the document go round in a circle: an arrow
 * stuck to an arrow or to a group it is inside, or a group inside itself.
 * The planner never makes one; a peer's event might, and it is dropped here.
 * (An end stuck to an object that is not there is allowed: that object may
 * have been removed by someone else a moment ago.)
 */
function unsound(objects: Readonly<Record<string, CanvasObject>>, object: CanvasObject, before?: CanvasObject): boolean {
  // The common case, a move or an edit, touches neither: nothing to look at.
  const ends = object.type === 'arrow' ? [object.from, object.to].filter(isBoundEnd) : [];
  if (!object.group && ends.length === 0) return false;
  if (before && before.group === object.group && before.type === 'arrow' && object.type === 'arrow' && before.from === object.from && before.to === object.to) return false;
  if (before && before.group === object.group && ends.length === 0) return false;
  const lookup = (id: string) => (id === object.id ? object : objects[id]);
  if (object.group && groupCycle(lookup, object.id)) return true;
  for (const end of ends) {
    if (lookup(end.object) && bindingFault(lookup, object, end.object)) return true;
  }
  return false;
}

export function applyEvents(doc: CanvasDocument, events: readonly CanvasEvent[]): Applied {
  let objects: Record<string, CanvasObject> | null = null;
  let order: string[] | null = null;
  let snapshots: Record<string, Snapshot> | null = null;
  let title = doc.title;
  const undo: CanvasEvent[] = [];
  const applied: CanvasEvent[] = [];

  const objs = () => (objects ??= idMap(doc.objects));
  const ord = () => (order ??= [...doc.order]);
  const snaps = () => (snapshots ??= idMap(doc.snapshots));
  const current = (id: string): CanvasObject | undefined => (objects ?? doc.objects)[id];

  for (const event of events) {
    switch (event.type) {
      case 'object-added': {
        if (current(event.object.id) || unsound(objects ?? doc.objects, event.object)) break;
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
        if (!before || before === event.object || unsound(objects ?? doc.objects, event.object, before)) break;
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
