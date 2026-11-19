/**
 * A spatial index kept in step with a document, event by event. One index
 * serves every view of a canvas (the editor and every snapshot of it), so a
 * plan with fifty snapshots still pays for one.
 *
 * An arrow's place depends on the objects its ends are stuck to, so the
 * index remembers which arrows hang on which object and re-places them when
 * that object moves or goes.
 */
import { isBoundEnd, objectBounds } from '../model/document';
import { expandRect } from '../model/geometry';
import { inkBounds } from '../model/ink';
import type { CanvasStore } from '../events/store';
import type { CanvasEvent } from '../events/types';
import { type CanvasDocument, type ObjectId, isPlaced } from '../model/types';
import { SpatialIndex } from './spatial-index';

/**
 * Room around the straight line between an arrow's ends. A routed connector may run wide of that line to go
 * round something, so the room is generous: enough that a line on screen is mounted and can be grabbed.
 */
const ARROW_MARGIN = 72;

export class DocumentIndex {
  readonly spatial = new SpatialIndex();
  private readonly dependents = new Map<ObjectId, Set<ObjectId>>();
  private readonly arrowEnds = new Map<ObjectId, ObjectId[]>();
  private orderOf: Map<ObjectId, number> | null = null;
  private orderSource: readonly ObjectId[] | null = null;

  constructor(doc: CanvasDocument) {
    this.rebuild(doc);
  }

  rebuild(doc: CanvasDocument): void {
    this.spatial.clear();
    this.dependents.clear();
    this.arrowEnds.clear();
    for (const id of doc.order) this.place(doc, id);
  }

  /** Bring the index up to `doc` after `events` were applied to reach it. */
  apply(doc: CanvasDocument, events: readonly CanvasEvent[]): void {
    for (const event of events) {
      if (event.type === 'object-added') this.refresh(doc, event.object.id);
      else if (event.type === 'object-set' || event.type === 'object-removed') this.refresh(doc, event.id);
      // An object that changed group left one group's outline and joined another's. Which one it left is
      // not in the event, so every connector stuck to a group is placed again: few, and group changes are rare.
      if (event.type === 'object-set' && (Object.hasOwn(event.set, 'group') || event.unset?.includes('group'))) {
        // Gathered first: placing an arrow rewrites the very map being read.
        const again = new Set<ObjectId>();
        for (const [target, arrows] of this.dependents) {
          const object = doc.objects[target];
          if (object && object.type !== 'group') continue;
          for (const arrow of arrows) again.add(arrow);
        }
        for (const arrow of again) this.place(doc, arrow);
      }
    }
  }

  /** Each object's place in the drawing order, 0 at the back. */
  order(doc: CanvasDocument): Map<ObjectId, number> {
    if (this.orderSource !== doc.order || !this.orderOf) {
      this.orderOf = new Map();
      doc.order.forEach((id, at) => this.orderOf!.set(id, at));
      this.orderSource = doc.order;
    }
    return this.orderOf;
  }

  private refresh(doc: CanvasDocument, id: ObjectId): void {
    this.place(doc, id);
    // Arrows stuck to this object, or to a group it is in, follow it.
    const touched = new Set<ObjectId>();
    let current: ObjectId | undefined = id;
    for (let depth = 0; current && depth < 32; depth++) {
      for (const arrow of this.dependents.get(current) ?? []) touched.add(arrow);
      current = doc.objects[current]?.group;
    }
    for (const arrow of touched) if (arrow !== id) this.place(doc, arrow);
  }

  private place(doc: CanvasDocument, id: ObjectId): void {
    const object = doc.objects[id];
    this.forgetEnds(id);
    if (!object || object.type === 'group') {
      this.spatial.delete(id);
      return;
    }
    if (isPlaced(object)) {
      // A drawn line is indexed by what it covers, stroke included, so the pointer finds the half of a line that lies outside its box.
      this.spatial.set(id, object.type === 'ink' ? inkBounds(object) : object);
      return;
    }
    const ends: ObjectId[] = [];
    for (const end of [object.from, object.to]) {
      if (!isBoundEnd(end)) continue;
      ends.push(end.object);
      let set = this.dependents.get(end.object);
      if (!set) this.dependents.set(end.object, (set = new Set()));
      set.add(id);
    }
    if (ends.length) this.arrowEnds.set(id, ends);
    const bounds = objectBounds(doc, id);
    if (bounds) this.spatial.set(id, expandRect(bounds, ARROW_MARGIN));
    else this.spatial.delete(id);
  }

  private forgetEnds(id: ObjectId): void {
    const ends = this.arrowEnds.get(id);
    if (!ends) return;
    for (const end of ends) {
      const set = this.dependents.get(end);
      set?.delete(id);
      if (set && set.size === 0) this.dependents.delete(end);
    }
    this.arrowEnds.delete(id);
  }
}

const INDEXES = new WeakMap<CanvasStore, DocumentIndex>();

/**
 * The one index of a store, made on first use and kept current from the
 * store's own event stream for as long as the store lives.
 */
export function indexFor(store: CanvasStore): DocumentIndex {
  let index = INDEXES.get(store);
  if (!index) {
    const made = new DocumentIndex(store.getDocument());
    // After a rebase more may have changed than the envelope names: start again.
    store.onCommit((envelope, doc) => (envelope.rebased ? made.rebuild(doc) : made.apply(doc, envelope.events)));
    INDEXES.set(store, made);
    index = made;
  }
  return index;
}
