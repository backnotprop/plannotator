/**
 * What changed between two reads of a board, as the board's events
 * (ShapeHost `events`). Shared by the Inbox's host (inboxShapeHost.ts) and the
 * standalone Shape page's (standalone/host.ts); no request of its own.
 */
import type { ShapeEvent, ShapeSessionStatus } from '@plannotator/ui/components/shape';
import type { ShapeLoadedWire } from '../api';

/** What changed between two reads of a board, as the board's events. */
export function shapeEventsBetween(before: ShapeLoadedWire | null, now: ShapeLoadedWire): ShapeEvent[] {
  const out: ShapeEvent[] = [];
  if (!before) return out;
  if (now.version.n !== before.version.n) out.push({ type: 'version', shape: now.shape, version: now.version });
  const wasDrawing = before.shape.drawing?.until ?? null;
  const drawing = now.shape.drawing?.until ?? null;
  if (drawing !== wasDrawing && now.version.n === before.version.n) out.push({ type: 'drawing', until: drawing });
  if (now.shape.state !== before.shape.state) out.push({ type: 'state', shape: now.shape });
  const old = new Map(before.notes.map((n) => [n.id, n]));
  for (const note of now.notes) {
    const was = old.get(note.id);
    if (!was || was.delivered !== note.delivered || was.text !== note.text) out.push({ type: 'note', note });
  }
  if (now.session.state !== before.session.state || now.session.agent !== before.session.agent) out.push({ type: 'session', session: now.session as ShapeSessionStatus });
  return out;
}
