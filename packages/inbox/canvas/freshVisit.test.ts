/**
 * A visit from the reply box's + → Canvas to a canvas that already holds something (freshVisit.ts, CanvasBoard.tsx
 * `fresh`): Send carries only what was drawn on this visit, never what the board held when it opened, what an agent
 * added meanwhile, or what this visit already sent; and the view opens on a spot clear of the whole drawing.
 *
 * What regresses: Send posting the whole board again; an agent's box counted as the person's drawing; a second Send
 * repeating the first; a "clear" spot that lands on the drawing.
 */
import { describe, expect, test } from 'bun:test';
import { boxesOverlap, unionBox, type Box } from '@plannotator/shared/inbox/canvas/scene';
import { clearSpotView, drawnThisVisit } from './freshVisit';

describe('what Send carries on a fresh visit', () => {
  test('only what was drawn on this visit: not what the board held, an agent added, was deleted, or was sent already', () => {
    const opened = [{ id: 'box-orders' }, { id: 'label-orders' }, { id: 'arrow-1' }];
    const known = new Set(opened.map((e) => e.id));
    // An agent's change lands while the person draws: the board learns those ids as it takes them.
    known.add('agent-note');
    const now = [...opened, { id: 'agent-note' }, { id: 'stroke-1' }, { id: 'stroke-2' }, { id: 'stroke-3', isDeleted: true }];
    expect(drawnThisVisit(now, known).map((e) => e.id)).toEqual(['stroke-1', 'stroke-2']);
    // Sent: those join what the board knows, and the next Send carries only what is drawn after.
    for (const e of drawnThisVisit(now, known)) known.add(e.id);
    expect(drawnThisVisit([...now, { id: 'stroke-4' }], known).map((e) => e.id)).toEqual(['stroke-4']);
  });
});

describe('the clear spot', () => {
  test('the view opens beside the drawing at full size, and nothing of the drawing is in it', () => {
    const drawing = unionBox([
      { x: -300, y: 120, w: 500, h: 240 },
      { x: 600, y: -80, w: 180, h: 900 },
    ]);
    const view = clearSpotView(drawing)!;
    // On screen x = sceneX + scrollX at zoom 1: the view's rectangle in scene units, for a 1440 × 900 window.
    const seen: Box = { x: -view.scrollX, y: -view.scrollY, w: 1440, h: 900 };
    expect(boxesOverlap(seen, drawing)).toBe(false);
    // Beside it, not far away: level with the drawing's top and a short pan to its right.
    expect(seen.x - (drawing.x + drawing.w)).toBeLessThan(400);
    expect(Math.abs(seen.y - drawing.y)).toBeLessThan(200);
  });

  test('an empty board has no clear spot to find: the view is left as it opens', () => {
    expect(clearSpotView(unionBox([]))).toBeNull();
    expect(clearSpotView(null)).toBeNull();
  });
});
