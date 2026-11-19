import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import type { CanvasObject } from '../model/types';
import { cameraPlacing, fitRect, lerpCamera, screenToWorld, viewportRect, worldRectToScreen, worldToScreen, zoomAt } from './camera';
import { lodForZoom, renderWindow, visibleIds, windowIsStale } from './cull';
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

  test('dragging a frame carries what is inside it, and the arrows between those', () => {
    const store = board();
    const moved = withFrameContents(store.getDocument(), indexFor(store), ['frame']);
    expect(moved.sort()).toEqual(['a', 'ab', 'b', 'frame', 'over-a']);
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

  test('detail drops as the board zooms out', () => {
    expect(lodForZoom(1)).toBe('full');
    expect(lodForZoom(0.3)).toBe('plain');
    expect(lodForZoom(0.1)).toBe('far');
  });
});
