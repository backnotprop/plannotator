import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { createDocument, resolveArrow } from '../model/document';
import { parseDocument, serializeDocument } from '../model/codec';
import type { ArrowObject, CanvasObject } from '../model/types';
import { cameraPlacing, fitPadding, fitRect, lerpCamera, screenToWorld, viewportRect, worldRectToScreen, worldToScreen, zoomAt } from './camera';
import { lodFor, lodForZoom, renderWindow, visibleIds, windowIsStale } from './cull';
import { BOX_SHAPES } from '../model/types';
import { snapToGuides } from './guides';
import { neighbourInReadingOrder, readingOrder } from './reading-order';
import { shapeOutline, toPath } from './shape-outline';
import { indexFor } from './document-index';
import { hitTest, objectsInRect, withFrameContents } from './hit-test';
import { SpatialIndex } from './spatial-index';

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

describe('the camera', () => {
  test('zooming keeps the point under the pointer where it is', () => {
    const camera = { x: 120, y: -40, z: 0.8 };
    const pointer = { x: 333, y: 217 };
    const before = screenToWorld(camera, pointer);
    const after = screenToWorld(zoomAt(camera, 2.4, pointer), pointer);
    close(after.x, before.x);
    close(after.y, before.y);
  });

  test('zoom stays inside its limits', () => {
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 1000, { x: 0, y: 0 }).z).toBe(4);
    expect(zoomAt({ x: 0, y: 0, z: 1 }, 0, { x: 0, y: 0 }).z).toBe(0.05);
  });

  test('fitting a rect shows all of it, centred, with the padding asked for', () => {
    const target = { x: 1000, y: 500, w: 800, h: 200 };
    const size = { w: 1000, h: 600 };
    const on = worldRectToScreen(fitRect(target, size, 50), target);
    close(on.x, 50);
    close(on.x + on.w, 950);
    close(on.y + on.h / 2, 300);
    // A small target is not blown up past the cap.
    expect(fitRect({ x: 0, y: 0, w: 10, h: 10 }, size, 0, 1).z).toBe(1);
  });

  test('the open transition starts with the snapshot drawn exactly where the figure drew it', () => {
    const world = { x: 40, y: 60, w: 880, h: 300 };
    const figure = { x: 24, y: 310, w: 614, h: 236 };
    // What the figure shows: the rect fitted into its own box.
    const inFigure = worldRectToScreen(fitRect(world, { w: figure.w, h: figure.h }, 0, 1), world);
    // What the full-window canvas shows at the start of the transition.
    const onStage = worldRectToScreen(cameraPlacing(world, figure, 1), world);
    close(onStage.x, figure.x + inFigure.x);
    close(onStage.y, figure.y + inFigure.y);
    close(onStage.w, inFigure.w);
    close(onStage.h, inFigure.h);
  });

  test('a camera blend keeps a shared fixed point fixed the whole way', () => {
    const size = { w: 1200, h: 800 };
    const a = { x: 0, y: 0, z: 0.5 };
    const anchor = { x: 400, y: 300 };
    const b = zoomAt(a, 2, anchor);
    const world = screenToWorld(a, anchor);
    for (const t of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const at = worldToScreen(lerpCamera(a, b, t, size), world);
      close(at.x, anchor.x);
      close(at.y, anchor.y);
    }
    expect(lerpCamera(a, b, 0.5, size).z).toBeCloseTo(1, 6);
  });
});

describe('fitting a whole board into an editor', () => {
  const board = { x: 0, y: 0, w: 2400, h: 1200 };

  test('a wide view keeps the room it always had, so nothing moves on a desktop', () => {
    expect(fitPadding({ w: 1440, h: 900 })).toEqual({ x: 72, y: 72 });
    expect(fitRect(board, { w: 1440, h: 900 }, fitPadding({ w: 1440, h: 900 }), 1)).toEqual(fitRect(board, { w: 1440, h: 900 }, 72, 1));
  });

  test('a phone gives a board its width: the room at the sides is a twentieth of it, not 72 px', () => {
    const phone = { w: 390, h: 844 };
    const before = fitRect(board, phone, 72, 1).z;
    const after = fitRect(board, phone, fitPadding(phone), 1).z;
    expect(after / before).toBeGreaterThan(1.4);
    // The whole board is still in view, clear of both edges, and centred.
    const camera = fitRect(board, phone, fitPadding(phone), 1);
    const view = viewportRect(camera, phone);
    expect(view.x).toBeLessThan(board.x);
    expect(view.x + view.w).toBeGreaterThan(board.x + board.w);
    close(view.x + view.w / 2, board.x + board.w / 2);
    close(view.y + view.h / 2, board.y + board.h / 2);
  });

  test('above and below, the room clears the bars at every size, and a tiny view still leaves some of itself', () => {
    expect(fitPadding({ w: 390, h: 844 }).y).toBe(72);
    expect(fitPadding({ w: 2560, h: 1440 })).toEqual({ x: 72, y: 72 });
    for (const size of [{ w: 1, h: 1 }, { w: 120, h: 90 }, { w: 320, h: 480 }, { w: 0, h: 0 }]) {
      const pad = fitPadding(size);
      expect(pad.x).toBeGreaterThanOrEqual(12);
      expect(pad.y).toBeGreaterThanOrEqual(12);
      const camera = fitRect(board, size, pad, 1);
      expect(Number.isFinite(camera.x) && Number.isFinite(camera.y) && camera.z > 0).toBe(true);
    }
    // A tall board on a phone is bound by its height, and keeps clear of the bars.
    const tall = { x: 0, y: 0, w: 300, h: 3000 };
    expect(fitRect(tall, { w: 390, h: 844 }, fitPadding({ w: 390, h: 844 }), 1).z).toBeCloseTo((844 - 144) / 3000, 6);
  });
});

describe('the spatial index', () => {
  test('finds what overlaps a rect and nothing else, after moves and removals', () => {
    const index = new SpatialIndex(100);
    index.set('near', { x: 10, y: 10, w: 50, h: 50 });
    index.set('far', { x: 5000, y: 5000, w: 50, h: 50 });
    index.set('huge', { x: -10_000, y: -10_000, w: 40_000, h: 40_000 });
    index.set('line', { x: 0, y: 30, w: 400, h: 0 });
    expect(index.query({ x: 0, y: 0, w: 100, h: 100 }).sort()).toEqual(['huge', 'line', 'near']);
    index.set('near', { x: 5010, y: 5010, w: 50, h: 50 });
    expect(index.query({ x: 0, y: 0, w: 100, h: 100 }).sort()).toEqual(['huge', 'line']);
    expect(index.query({ x: 5000, y: 5000, w: 10, h: 10 }).sort()).toEqual(['far', 'huge']);
    index.delete('huge');
    index.delete('far');
    expect(index.query({ x: 4000, y: 4000, w: 2000, h: 2000 })).toEqual(['near']);
    expect(index.size).toBe(2);
  });

  test('agrees with a plain scan on a thousand random rects', () => {
    let seed = 9;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
    const index = new SpatialIndex();
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (let i = 0; i < 1000; i++) {
      const r = { x: random() * 8000 - 4000, y: random() * 8000 - 4000, w: 20 + random() * 600, h: 20 + random() * 300 };
      rects.set(`o${i}`, r);
      index.set(`o${i}`, r);
    }
    for (let q = 0; q < 50; q++) {
      const area = { x: random() * 8000 - 4000, y: random() * 8000 - 4000, w: 50 + random() * 1500, h: 50 + random() * 900 };
      const scan = [...rects].filter(([, r]) => r.x < area.x + area.w && area.x < r.x + r.w && r.y < area.y + area.h && area.y < r.y + r.h).map(([id]) => id);
      expect(index.query(area).sort()).toEqual(scan.sort());
    }
  });
});

function board(): CanvasStore {
  const store = new CanvasStore(createDocument('board'));
  const objects: CanvasObject[] = [
    { id: 'frame', type: 'frame', x: 0, y: 0, w: 600, h: 400, title: 'Frame' },
    { id: 'a', type: 'box', x: 40, y: 40, w: 100, h: 40, text: 'A' },
    { id: 'b', type: 'box', x: 400, y: 40, w: 100, h: 40, text: 'B' },
    { id: 'over-a', type: 'note', x: 100, y: 50, w: 100, h: 60, text: 'on top of A' },
    { id: 'ab', type: 'arrow', from: { object: 'a' }, to: { object: 'b' } },
    { id: 'outside', type: 'box', x: 900, y: 40, w: 100, h: 40, text: 'Outside' },
  ];
  store.dispatch({ type: 'add', objects });
  return store;
}

describe('hit-testing', () => {
  test('the topmost object wins, and an arrow wins over what it crosses', () => {
    const store = board();
    const index = indexFor(store);
    const doc = store.getDocument();
    expect(hitTest(doc, index, { x: 60, y: 60 })).toBe('a');
    expect(hitTest(doc, index, { x: 120, y: 70 })).toBe('over-a');
    expect(hitTest(doc, index, { x: 300, y: 61 })).toBe('ab');
    expect(hitTest(doc, index, { x: 300, y: 90 })).toBeNull();
    store.dispatch({ type: 'reorder', ids: ['a'], to: 'front' });
    expect(hitTest(store.getDocument(), index, { x: 120, y: 70 })).toBe('a');
  });

  test('a drawn line is grabbed along the line, as wide as its pen, and what it was drawn round stays open', () => {
    const store = new CanvasStore(createDocument('board', 'Board'));
    // A ring drawn round a box: four strokes through the middle of each side of the ring's own box.
    const ring = { id: 'ring', type: 'ink', x: 0, y: 0, w: 200, h: 200, points: [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5, 0.5, 0] };
    store.dispatch({ type: 'add', objects: [{ id: 'inside', type: 'box', x: 80, y: 80, w: 40, h: 40, text: 'in' }, ring] as CanvasObject[] });
    const index = indexFor(store);
    const at = (x: number, y: number) => hitTest(store.getDocument(), index, { x, y });
    expect(at(100, 100)).toBe('inside');
    expect(at(150, 50)).toBe('ring');
    expect(at(10, 10)).toBeNull();
    expect(at(150, 110)).toBeNull();
    // Eight units off the line: past a marker, inside a highlighter, well past a fine pen.
    const off = { x: 150 + 8 * Math.SQRT1_2, y: 50 - 8 * Math.SQRT1_2 };
    expect(hitTest(store.getDocument(), index, off, 0)).toBeNull();
    store.dispatch({ type: 'edit', id: 'ring', patch: { pen: 'highlighter' } });
    expect(hitTest(store.getDocument(), index, off, 0)).toBe('ring');
    store.dispatch({ type: 'edit', id: 'ring', patch: { pen: 'fine' } });
    expect(hitTest(store.getDocument(), index, { x: 150 + 3 * Math.SQRT1_2, y: 50 - 3 * Math.SQRT1_2 }, 0)).toBeNull();
    // A marquee takes it by its box, and it moves with a frame it lies in.
    expect(objectsInRect(store.getDocument(), index, { x: -10, y: -10, w: 60, h: 60 })).toEqual(['ring']);
  });

  test('a frame is grabbed by its edge or title; its inside is open board', () => {
    const store = board();
    const index = indexFor(store);
    const doc = store.getDocument();
    expect(hitTest(doc, index, { x: 300, y: 250 })).toBeNull();
    expect(hitTest(doc, index, { x: 3, y: 250 })).toBe('frame');
    expect(hitTest(doc, index, { x: 30, y: -10 })).toBe('frame');
  });

  test('the index follows a moved object, and the arrow stuck to it', () => {
    const store = board();
    const index = indexFor(store);
    store.dispatch({ type: 'move', ids: ['b'], dx: 0, dy: 300 });
    const doc = store.getDocument();
    expect(hitTest(doc, index, { x: 450, y: 60 })).toBeNull();
    expect(hitTest(doc, index, { x: 450, y: 360 })).toBe('b');
    // The arrow now runs down to the moved box: its old line is empty, its new one is not.
    expect(hitTest(doc, index, { x: 300, y: 61 })).toBeNull();
    expect(visibleIds(doc, index, { x: 250, y: 150, w: 60, h: 60 })).toContain('ab');
    store.undo();
    expect(hitTest(store.getDocument(), index, { x: 300, y: 61 })).toBe('ab');
  });

  test('a marquee takes what it touches, but a frame or an arrow only when wholly inside', () => {
    const store = board();
    const index = indexFor(store);
    const doc = store.getDocument();
    expect(objectsInRect(doc, index, { x: 20, y: 20, w: 200, h: 120 })).toEqual(['a', 'over-a']);
    expect(objectsInRect(doc, index, { x: -50, y: -50, w: 700, h: 500 })).toEqual(['frame', 'a', 'b', 'over-a', 'ab']);
  });

  test('a free arrow drawn inside a frame goes with the frame; one that only starts there stays', () => {
    const store = board();
    store.dispatch({
      type: 'add',
      objects: [
        { id: 'free-in', type: 'arrow', from: { x: 60, y: 300 }, to: { x: 500, y: 350 } },
        { id: 'half-in', type: 'arrow', from: { object: 'a' }, to: { x: 500, y: 350 } },
        { id: 'leaves', type: 'arrow', from: { x: 60, y: 300 }, to: { x: 950, y: 60 } },
        { id: 'to-outside', type: 'arrow', from: { object: 'a' }, to: { object: 'outside' } },
      ],
    });
    const moved = withFrameContents(store.getDocument(), indexFor(store), ['frame']);
    expect(moved).toContain('free-in');
    expect(moved).toContain('half-in');
    expect(moved).not.toContain('leaves');
    expect(moved).not.toContain('to-outside');
  });

  test('a frame is grabbed by its title at any zoom, far out included', () => {
    const store = board();
    const doc = store.getDocument();
    // At 10% zoom five screen pixels are fifty world units, and the title strip is twice that tall.
    for (const tolerance of [4, 12, 50]) {
      const strip = Math.max(24, tolerance * 2);
      expect(hitTest(doc, indexFor(store), { x: 30, y: -strip + 1 }, tolerance)).toBe('frame');
    }
  });

  test('dragging a frame carries what is inside it, and the arrows between those', () => {
    const store = board();
    const moved = withFrameContents(store.getDocument(), indexFor(store), ['frame']);
    expect(moved.sort()).toEqual(['a', 'ab', 'b', 'frame', 'over-a']);
  });
});

describe('alignment guides', () => {
  const other = { x: 300, y: 100, w: 100, h: 60 };

  test('an edge that comes close settles on the edge it lines up with, and says how far apart the two are', () => {
    // Its left edge 3 off the other's left edge, well below it.
    const snap = snapToGuides({ x: 303, y: 300, w: 80, h: 40 }, [other], 6);
    expect(snap).toMatchObject({ dx: -3, dy: 0 });
    expect(snap.guides).toEqual([{ axis: 'x', at: 300, from: 100, to: 340, gap: { distance: 140, at: 230 } }]);
  });

  test('middles line up too, each axis by itself, and nothing moves when nothing is near', () => {
    const both = snapToGuides({ x: 312, y: 128, w: 80, h: 6 }, [other], 6);
    // Centre x 352 against 350; centre y 131 against 130 (nearer than its top edge is to the other's).
    expect(both).toMatchObject({ dx: -2, dy: -1 });
    expect(both.guides.map((guide) => guide.axis)).toEqual(['x', 'y']);
    expect(both.guides.every((guide) => !guide.gap)).toBe(true);
    expect(snapToGuides({ x: 600, y: 600, w: 80, h: 40 }, [other], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(snapToGuides({ x: 303, y: 300, w: 80, h: 40 }, [], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  test('of several near things the closest wins', () => {
    const snap = snapToGuides({ x: 304, y: 300, w: 80, h: 40 }, [other, { x: 303, y: 500, w: 50, h: 50 }], 6);
    expect(snap.dx).toBe(-1);
  });
});

describe('box shapes', () => {
  test('every shape has a closed outline inside its own box, and room for words', () => {
    for (const shape of BOX_SHAPES) {
      const made = shapeOutline(shape, 170, 120, shape === 'container' ? 2 : 0);
      expect(made.outline[0][0]).toBe('M');
      expect(made.outline[made.outline.length - 1][0]).toBe('Z');
      for (const seg of [...made.outline, ...made.details.flat()]) {
        for (let i = 1; i < seg.length; i += 2) {
          expect(seg[i] as number).toBeGreaterThanOrEqual(-0.01);
          expect(seg[i] as number).toBeLessThanOrEqual(170.01);
          // A document's wave may dip a little under its box; nothing else leaves it.
          expect(seg[i + 1] as number).toBeGreaterThanOrEqual(-12);
          expect(seg[i + 1] as number).toBeLessThanOrEqual(120 + 14);
        }
      }
      const [top, right, bottom, left] = made.text;
      expect(top + bottom).toBeLessThan(120);
      expect(left + right).toBeLessThan(170);
      expect(toPath(made.outline)).toMatch(/^M[\d. -]+[LC]/);
    }
  });

  test('a container draws one divider between each pair of lanes', () => {
    expect(shapeOutline('container', 250, 390, 2).details).toHaveLength(3);
    expect(shapeOutline('container', 250, 390, 0).details).toHaveLength(1);
  });

  test('an agent may leave the size out: each shape has its own', () => {
    const store = new CanvasStore(createDocument('board'));
    const added = store.dispatch({ type: 'add', objects: [{ id: 'db', type: 'box', shape: 'database', x: 0, y: 0, text: 'Alert log' }, { id: 'n', type: 'note', x: 300, y: 0, text: 'Hi' }, { id: 'p', type: 'box', x: 600, y: 0, text: 'Plain', h: 40 }] as never });
    expect(added.ok).toBe(true);
    expect(store.getDocument().objects.db).toMatchObject({ w: 124, h: 124 });
    expect(store.getDocument().objects.n).toMatchObject({ w: 184, h: 158 });
    expect(store.getDocument().objects.p).toMatchObject({ w: 170, h: 40 });
    expect(store.dispatch({ type: 'add', objects: [{ id: 'x', type: 'constructor', x: 0, y: 0 }] as never }).ok).toBe(false);
  });
});

describe('the order a keyboard walks the board in', () => {
  test('top to bottom, left to right within a row, whatever order things were made in', () => {
    const store = new CanvasStore(createDocument('board'));
    const at = (id: string, x: number, y: number): CanvasObject => ({ id, type: 'box', x, y, w: 100, h: 40, text: id });
    store.dispatch({ type: 'add', objects: [at('bottom-right', 400, 300), at('top-right', 400, 10), at('bottom-left', 0, 310), at('top-left', 0, 0), { id: 'arrow', type: 'arrow', from: { x: 0, y: 0 }, to: { x: 9, y: 9 } }] });
    expect(readingOrder(store.getDocument())).toEqual(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    expect(neighbourInReadingOrder(store.getDocument(), 'top-right', 1)).toBe('bottom-left');
    expect(neighbourInReadingOrder(store.getDocument(), 'top-left', -1)).toBeNull();
    expect(neighbourInReadingOrder(store.getDocument(), 'bottom-right', 1)).toBeNull();
  });
});

describe('culling and level of detail', () => {
  function big(): CanvasStore {
    const store = new CanvasStore(createDocument('board'));
    const objects: CanvasObject[] = [];
    for (let i = 0; i < 2000; i++) objects.push({ id: `b${i}`, type: 'box', x: (i % 50) * 230, y: Math.floor(i / 50) * 120, w: 176, h: 56, text: String(i) });
    store.dispatch({ type: 'add', objects });
    return store;
  }

  test('of 2,000 objects only those near the view are mounted', () => {
    const store = big();
    const size = { w: 1440, h: 900 };
    const camera = { x: 4000, y: 1800, z: 1 };
    const mounted = visibleIds(store.getDocument(), indexFor(store), renderWindow(camera, size));
    expect(mounted.length).toBeGreaterThan(40);
    expect(mounted.length).toBeLessThan(300);
    // Everything actually on screen is among them.
    const view = viewportRect(camera, size);
    for (const object of Object.values(store.getDocument().objects)) {
      if (!('x' in object)) continue;
      const onScreen = object.x < view.x + view.w && view.x < object.x + object.w && object.y < view.y + view.h && view.y < object.y + object.h;
      if (onScreen) expect(mounted).toContain(object.id);
    }
  });

  test('mounted objects come back to front', () => {
    const store = big();
    store.dispatch({ type: 'reorder', ids: ['b0'], to: 'front' });
    const mounted = visibleIds(store.getDocument(), indexFor(store), { x: 0, y: 0, w: 700, h: 300 });
    expect(mounted[mounted.length - 1]).toBe('b0');
    expect(mounted[0]).toBe('b1');
  });

  test('a small pan stays inside the render window; leaving it, or zooming far in, asks for a new one', () => {
    const size = { w: 1000, h: 800 };
    const camera = { x: 0, y: 0, z: 1 };
    const window = renderWindow(camera, size);
    expect(windowIsStale(null, camera, size)).toBe(true);
    expect(windowIsStale(window, { x: 300, y: -200, z: 1 }, size)).toBe(false);
    expect(windowIsStale(window, { x: 700, y: 0, z: 1 }, size)).toBe(true);
    expect(windowIsStale(window, zoomAt(camera, 0.8, { x: 500, y: 400 }), size)).toBe(false);
    expect(windowIsStale(window, zoomAt(camera, 0.4, { x: 500, y: 400 }), size)).toBe(true);
    expect(windowIsStale(window, zoomAt(camera, 3.5, { x: 500, y: 400 }), size)).toBe(true);
  });

  test('detail drops as a crowded board zooms out, and never for a view that holds few objects', () => {
    expect(lodForZoom(1)).toBe('full');
    expect(lodForZoom(0.3)).toBe('plain');
    expect(lodForZoom(0.1)).toBe('far');
    expect(lodFor(0.1, 2000)).toBe('far');
    expect(lodFor(0.3, 400)).toBe('plain');
    // A figure in a narrow column, a phone looking at one frame: small on screen, but everything is drawn.
    expect(lodFor(0.1, 40)).toBe('full');
    expect(lodFor(0.31, 150)).toBe('full');
  });
});

describe('groups that lose their members', () => {
  const box = (id: string, x: number, y: number): CanvasObject => ({ id, type: 'box', x, y, w: 100, h: 40, text: id });

  test('grouping everything out of a group removes the group it emptied, and frees a connector stuck to it', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({ type: 'add', objects: [box('x', 0, 0), box('y', 0, 100), box('t', 600, 0)] });
    store.dispatch({ type: 'group', id: 'old', ids: ['x', 'y'] });
    store.dispatch({ type: 'add', objects: [{ id: 'link', type: 'arrow', from: { object: 'old' }, to: { object: 't' } }] });
    expect(store.dispatch({ type: 'group', id: 'new', ids: ['x', 'y', 't'] }).ok).toBe(true);
    const doc = store.getDocument();
    expect(doc.objects.old).toBeUndefined();
    expect(doc.objects.x.group).toBe('new');
    const link = doc.objects.link;
    expect(link.type === 'arrow' && 'x' in link.from).toBe(true);
    expect(parseDocument(JSON.parse(serializeDocument(doc))).ok).toBe(true);
    // One step takes all of it back.
    store.undo();
    expect(store.getDocument().objects.old).toBeDefined();
    expect(store.getDocument().objects.x.group).toBe('old');
  });

  test('a connector stuck to a group is found where it now runs after a member leaves the group', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({ type: 'add', objects: [box('x', 0, 0), box('z', 1000, 0), box('q', 1000, 300), box('t', 2000, 600)] });
    store.dispatch({ type: 'group', id: 'g', ids: ['x', 'z'] });
    store.dispatch({ type: 'add', objects: [{ id: 'link', type: 'arrow', routing: 'straight', from: { object: 'g' }, to: { object: 't' } }] });
    const index = indexFor(store);
    // z leaves for another group: g is now x alone, far to the left, and the connector starts there.
    store.dispatch({ type: 'group', id: 'h', ids: ['z', 'q'] });
    const doc = store.getDocument();
    expect(doc.objects.g).toBeDefined();
    const line = resolveArrow(doc, doc.objects.link as ArrowObject)!;
    expect(line.from.x).toBeLessThan(200);
    const near = { x: line.from.x + (line.to.x - line.from.x) * 0.15, y: line.from.y + (line.to.y - line.from.y) * 0.15 };
    expect(hitTest(doc, index, near, 4)).toBe('link');
  });
});
