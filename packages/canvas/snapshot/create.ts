/**
 * Making a snapshot from what a person chose: a selection, or a rectangle
 * they dragged. Pure: it returns the snapshot to add, and the caller sends
 * the `add-snapshot` command.
 */
import { isBoundEnd } from '../model/document';
import type { Rect } from '../model/geometry';
import { createId } from '../model/ids';
import type { CanvasDocument, CanvasObject, ObjectId, Snapshot } from '../model/types';
import type { DocumentIndex } from '../view/document-index';
import { objectsInRect } from '../view/hit-test';

/** The words an object carries, for a snapshot's default title. */
function wordsOf(object: CanvasObject | undefined): string {
  if (!object) return '';
  if (object.type === 'frame') return object.title;
  if (object.type === 'box' || object.type === 'note' || object.type === 'text') return object.text.split('\n')[0];
  if (object.type === 'image' || object.type === 'sprite') return object.alt;
  return '';
}

/**
 * A snapshot of a selection. One frame alone becomes a frame snapshot (it
 * follows the frame and shows whatever is in it). Anything else becomes a
 * set of objects, with the arrows that run between two chosen objects
 * taken along: a picture of three boxes without the arrows joining them is
 * not what was on screen.
 */
export function snapshotFromSelection(doc: CanvasDocument, ids: Iterable<ObjectId>, title?: string): Snapshot | null {
  const chosen = [...new Set(ids)].filter((id) => doc.objects[id] && doc.objects[id].type !== 'group');
  if (chosen.length === 0) return null;
  const id = createId('snap');
  const only = doc.objects[chosen[0]];
  if (chosen.length === 1 && only.type === 'frame') {
    return { id, title: title ?? only.title, source: { kind: 'frame', frame: only.id } };
  }
  const set = new Set(chosen);
  for (const object of Object.values(doc.objects)) {
    if (object.type !== 'arrow' || set.has(object.id)) continue;
    if (isBoundEnd(object.from) && isBoundEnd(object.to) && set.has(object.from.object) && set.has(object.to.object)) set.add(object.id);
  }
  const ordered = doc.order.filter((object) => set.has(object));
  const named = ordered.map((object) => wordsOf(doc.objects[object])).find(Boolean) ?? '';
  return { id, title: title ?? named, source: { kind: 'objects', objects: ordered } };
}

/** A snapshot of a dragged rectangle, remembering what was in it. */
export function snapshotFromRegion(doc: CanvasDocument, index: DocumentIndex, area: Rect, title?: string): Snapshot {
  const inside = objectsInRect(doc, index, area);
  const frame = inside.map((object) => doc.objects[object]).find((object) => object?.type === 'frame');
  const named = wordsOf(frame) || inside.map((object) => wordsOf(doc.objects[object])).find(Boolean) || '';
  return {
    id: createId('snap'),
    title: title ?? named,
    source: { kind: 'region', rect: { x: Math.round(area.x), y: Math.round(area.y), w: Math.round(area.w), h: Math.round(area.h) }, objects: inside },
  };
}
