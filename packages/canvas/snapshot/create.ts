/**
 * Making a snapshot from what a person chose: a selection, or a rectangle
 * they dragged. Pure: it returns what to ask for, and the caller sends the
 * `add-snapshot` command, which takes the capture.
 */
import { isBoundEnd, objectBounds } from '../model/document';
import { type Rect, rectContainsRect } from '../model/geometry';
import { createId } from '../model/ids';
import type { CanvasDocument, CanvasObject, FrameObject, ObjectId, SnapshotInput } from '../model/types';
import type { DocumentIndex } from '../view/document-index';
import { objectsInRect } from '../view/hit-test';

const TITLE_MAX = 60;

/** The words an object carries. */
function wordsOf(object: CanvasObject | undefined): string {
  if (!object) return '';
  if (object.type === 'frame') return object.title;
  if (object.type === 'box' || object.type === 'note' || object.type === 'text') return object.text.split('\n')[0];
  if (object.type === 'image' || object.type === 'sprite') return object.alt;
  if (object.type === 'reference') return object.title ?? '';
  return '';
}

const short = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
};

/** The smallest frame that wholly holds every one of these objects, if one does. */
function frameAround(doc: CanvasDocument, ids: readonly ObjectId[]): FrameObject | null {
  const bounds = ids.map((id) => objectBounds(doc, id)).filter((r): r is Rect => !!r);
  if (bounds.length === 0) return null;
  let best: FrameObject | null = null;
  for (const object of Object.values(doc.objects)) {
    if (object.type !== 'frame' || ids.includes(object.id)) continue;
    if (!bounds.every((r) => rectContainsRect(object, r))) continue;
    if (!best || object.w * object.h < best.w * best.h) best = object;
  }
  return best;
}

/**
 * The name a new snapshot starts with. In order:
 * 1. a frame chosen by itself, or the one frame among what was chosen: its title;
 * 2. everything chosen sits inside one frame: that frame's title;
 * 3. one object chosen: its own words;
 * 4. otherwise no name. The figure then shows only how many items it holds,
 *    and the person names it in place if they want to.
 * Never the words of whichever object happens to come first.
 */
export function defaultSnapshotTitle(doc: CanvasDocument, ids: readonly ObjectId[]): string {
  const objects = ids.map((id) => doc.objects[id]).filter((object): object is CanvasObject => !!object && object.type !== 'arrow' && object.type !== 'group');
  const frames = objects.filter((object) => object.type === 'frame');
  if (frames.length === 1) return short(wordsOf(frames[0]));
  const around = frames.length === 0 ? frameAround(doc, objects.map((object) => object.id)) : null;
  if (around?.title) return short(around.title);
  if (objects.length === 1) return short(wordsOf(objects[0]));
  return '';
}

/**
 * A snapshot of a selection. One frame alone becomes a frame snapshot (the
 * frame and whatever is in it). Anything else becomes a set of objects, with
 * the arrows that run between two chosen objects taken along: a picture of
 * three boxes without the arrows joining them is not what was on screen.
 */
export function snapshotFromSelection(doc: CanvasDocument, ids: Iterable<ObjectId>, title?: string): SnapshotInput | null {
  const chosen = [...new Set(ids)].filter((id) => doc.objects[id] && doc.objects[id].type !== 'group');
  if (chosen.length === 0) return null;
  const id = createId('snap');
  const only = doc.objects[chosen[0]];
  if (chosen.length === 1 && only.type === 'frame') {
    return { id, title: title ?? short(only.title), source: { kind: 'frame', frame: only.id } };
  }
  const set = new Set(chosen);
  for (const object of Object.values(doc.objects)) {
    if (object.type !== 'arrow' || set.has(object.id)) continue;
    if (isBoundEnd(object.from) && isBoundEnd(object.to) && set.has(object.from.object) && set.has(object.to.object)) set.add(object.id);
  }
  const ordered = doc.order.filter((object) => set.has(object));
  return { id, title: title ?? defaultSnapshotTitle(doc, ordered), source: { kind: 'objects', objects: ordered } };
}

/** A snapshot of a dragged rectangle. */
export function snapshotFromRegion(doc: CanvasDocument, index: DocumentIndex, area: Rect, title?: string): SnapshotInput {
  const inside = objectsInRect(doc, index, area);
  return {
    id: createId('snap'),
    title: title ?? defaultSnapshotTitle(doc, inside),
    source: { kind: 'region', rect: { x: Math.round(area.x), y: Math.round(area.y), w: Math.round(area.w), h: Math.round(area.h) } },
  };
}
