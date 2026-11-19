/**
 * Events → state. Pure, and tolerant on purpose: an event about an object
 * that is no longer there does nothing instead of throwing, because events
 * also arrive from peers and from an undo made after someone else's change.
 *
 * A change to an object names only the fields it touches (`object-set`), so
 * its inverse does too. That is what makes undo safe beside other people:
 * undoing a move puts `x` and `y` back and leaves the text an agent wrote
 * in between alone.
 *
 * Applying a batch copies the object map once, so a drag of 500 objects is
 * one copy per frame, and every object the batch did not touch keeps its
 * identity (the renderer skips those with a reference check).
 */
import { LIMITS, checkObject } from '../model/codec';
import { bindingFault, groupCycle, idMap, isBoundEnd } from '../model/document';
import type { CanvasDocument, CanvasObject, Snapshot } from '../model/types';
import type { CanvasEvent, ObjectFields } from './types';

export interface Applied {
  doc: CanvasDocument;
  /** The events that put the document back, already in the order to apply. */
  inverse: CanvasEvent[];
  /** The events that did something. An event that changed nothing is left out. */
  applied: CanvasEvent[];
}

export interface ApplyOptions {
  /**
   * Check every object an event makes or changes (`checkObject`). On for
   * anything not planned a moment ago against this very document: a peer's
   * events, an undo, a replay. Off for the planner's own output, which was
   * just checked.
   */
  check?: boolean;
}

const clampIndex = (at: number | undefined, length: number): number =>
  at === undefined || !Number.isFinite(at) ? length : Math.max(0, Math.min(length, Math.trunc(at)));

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const key of ka) if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  return true;
}

/** The `object-set` event that turns `before` into `after`, or null when they are the same. */
export function setEvent(before: CanvasObject, after: CanvasObject): Extract<CanvasEvent, { type: 'object-set' }> | null {
  const a = before as unknown as ObjectFields;
  const b = after as unknown as ObjectFields;
  const set: ObjectFields = {};
  const unset: string[] = [];
  for (const key of Object.keys(b)) if (key !== 'id' && key !== 'type' && !same(a[key], b[key])) set[key] = b[key];
  for (const key of Object.keys(a)) if (!(key in b)) unset.push(key);
  if (Object.keys(set).length === 0 && unset.length === 0) return null;
  return { type: 'object-set', id: before.id, set, ...(unset.length ? { unset } : {}) };
}

/**
 * An object that would make the document go round in a circle: an arrow
 * stuck to an arrow or to a group it is inside, or a group inside itself.
 * The planner never makes one; a peer's event might, and it is dropped here.
 */
function unsound(objects: Readonly<Record<string, CanvasObject>>, object: CanvasObject, touched: readonly string[] | null): boolean {
  const ends = object.type === 'arrow' ? [object.from, object.to].filter(isBoundEnd) : [];
  if (!object.group && ends.length === 0) return false;
  // A change that touched neither the group nor an arrow's ends cannot close a circle.
  if (touched && !touched.some((key) => key === 'group' || key === 'from' || key === 'to')) return false;
  const lookup = (id: string) => (id === object.id ? object : objects[id]);
  if (object.group && groupCycle(lookup, object.id)) return true;
  for (const end of ends) if (lookup(end.object) && bindingFault(lookup, object, end.object)) return true;
  return false;
}

export function applyEvents(doc: CanvasDocument, events: readonly CanvasEvent[], options: ApplyOptions = {}): Applied {
  let objects: Record<string, CanvasObject> | null = null;
  let order: string[] | null = null;
  let snapshots: Record<string, Snapshot> | null = null;
  let title = doc.title;
  const undo: CanvasEvent[] = [];
  const applied: CanvasEvent[] = [];

  const objs = () => (objects ??= idMap(doc.objects));
  const ord = () => (order ??= [...doc.order]);
  const snaps = () => (snapshots ??= idMap(doc.snapshots));
  const now = (): Readonly<Record<string, CanvasObject>> => objects ?? doc.objects;

  for (const event of events) {
    switch (event.type) {
      case 'object-added': {
        let object = event.object;
        if (now()[object.id] || (order ?? doc.order).length >= LIMITS.objects) break;
        // A group that is not there (removed by someone else a moment ago) is let go of.
        if (object.group && now()[object.group]?.type !== 'group') {
          const { group: _gone, ...rest } = object;
          object = rest as CanvasObject;
        }
        if (unsound(now(), object, null)) break;
        const list = ord();
        const at = clampIndex(event.at, list.length);
        objs()[object.id] = object;
        list.splice(at, 0, object.id);
        undo.push({ type: 'object-removed', id: object.id });
        applied.push(object === event.object ? event : { ...event, object });
        break;
      }
      case 'object-set': {
        const before = now()[event.id];
        if (!before) break;
        const from = before as unknown as ObjectFields;
        const next: ObjectFields = { ...from };
        const back: ObjectFields = {};
        const backUnset: string[] = [];
        const touched: string[] = [];
        const take = (key: string, value: unknown, present: boolean) => {
          if (key === 'id' || key === 'type') return;
          const had = key in from;
          if (present ? had && same(from[key], value) : !had) return;
          if (had) back[key] = from[key];
          else backUnset.push(key);
          if (present) next[key] = value;
          else delete next[key];
          touched.push(key);
        };
        for (const key of Object.keys(event.set)) take(key, event.set[key], true);
        for (const key of event.unset ?? []) if (!(key in event.set)) take(key, undefined, false);
        if (typeof next.group === 'string' && now()[next.group]?.type !== 'group' && touched.includes('group')) {
          // Put back into a group that has since gone: stay out of it.
          delete next.group;
          if (!('group' in from)) {
            touched.splice(touched.indexOf('group'), 1);
            backUnset.splice(backUnset.indexOf('group'), 1);
          }
        }
        if (touched.length === 0) break;
        let object = next as unknown as CanvasObject;
        if (options.check) {
          const checked = checkObject(next);
          if (!checked.ok) break;
          object = checked.value;
          // A field this object's type does not have was dropped by the check: nothing changed after all.
          if (same(before, object)) break;
        }
        if (unsound(now(), object, touched)) break;
        objs()[event.id] = object;
        undo.push({ type: 'object-set', id: event.id, set: back, ...(backUnset.length ? { unset: backUnset } : {}) });
        applied.push(event);
        break;
      }
      case 'object-removed': {
        const before = now()[event.id];
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
        if (!now()[event.id]) break;
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
        if (!before && Object.keys(snapshots ?? doc.snapshots).length >= LIMITS.snapshots) break;
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

/**
 * Fold a run of changes into the fewest events that have the same effect:
 * one `object-set` per object, each field at its last value. Only a list
 * made of `object-set` alone is folded (a drag, a resize, a colour pick);
 * anything else comes back as it was.
 */
export function compactSets(events: CanvasEvent[]): CanvasEvent[] {
  if (events.length < 2 || events.some((event) => event.type !== 'object-set')) return events;
  const byId = new Map<string, { set: ObjectFields; unset: Set<string> }>();
  for (const event of events) {
    if (event.type !== 'object-set') continue;
    let entry = byId.get(event.id);
    if (!entry) byId.set(event.id, (entry = { set: {}, unset: new Set() }));
    for (const key of Object.keys(event.set)) {
      entry.set[key] = event.set[key];
      entry.unset.delete(key);
    }
    for (const key of event.unset ?? []) {
      if (key in event.set) continue;
      delete entry.set[key];
      entry.unset.add(key);
    }
  }
  return [...byId].map(([id, { set, unset }]) => ({ type: 'object-set', id, set, ...(unset.size ? { unset: [...unset] } : {}) }));
}
