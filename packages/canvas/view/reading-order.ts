/**
 * The order a keyboard walks the board in: top to bottom, and left to right
 * among things at about the same height, the way a page is read. Drawing
 * order would be the order things were made in, which means nothing to
 * someone who cannot see where they are.
 */
import { type CanvasDocument, type ObjectId, isPlaced } from '../model/types';

/** Objects whose tops are within this many world units count as one row. */
const ROW = 32;

export function readingOrder(doc: CanvasDocument): ObjectId[] {
  const placed = doc.order.map((id) => doc.objects[id]).filter((object) => !!object && isPlaced(object)) as { id: ObjectId; x: number; y: number }[];
  placed.sort((a, b) => a.y - b.y || a.x - b.x);
  // Walk down in rows: everything whose top is within ROW of the row's first object, left to right.
  const out: ObjectId[] = [];
  for (let i = 0; i < placed.length; ) {
    const top = placed[i].y;
    let j = i;
    while (j < placed.length && placed[j].y - top <= ROW) j++;
    out.push(...placed.slice(i, j).sort((a, b) => a.x - b.x || a.y - b.y).map((object) => object.id));
    i = j;
  }
  return out;
}

/** The object after (or before) `id` in reading order, or null at either end. */
export function neighbourInReadingOrder(doc: CanvasDocument, id: ObjectId, step: 1 | -1): ObjectId | null {
  const order = readingOrder(doc);
  const at = order.indexOf(id);
  return at === -1 ? null : (order[at + step] ?? null);
}
