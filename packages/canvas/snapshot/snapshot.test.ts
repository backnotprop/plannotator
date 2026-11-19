import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import type { CanvasObject } from '../model/types';
import { placeSelectionBar } from '../react/chrome';
import { indexFor } from '../view/document-index';
import { findSnapshotBlocks, insertSnapshotBlock, parseSnapshotBlock, serializeSnapshotBlock, serializeSnapshotBody } from './block';
import { snapshotFromRegion, snapshotFromSelection } from './create';
import { createSnapshotDirectiveRenderer } from './directive';
import { snapshotToDataUrl, snapshotToSvg } from './picture';
import { nearestGap } from './plan-drop';
import { resolveSnapshot, sameResolution } from './resolve';
import { frameAt, springAtRest, stepSpring } from './transition';

function board(): CanvasStore {
  const store = new CanvasStore(createDocument('board', 'Board'));
  const objects: CanvasObject[] = [
    { id: 'frame', type: 'frame', x: 0, y: 0, w: 600, h: 300, title: 'Architecture' },
    { id: 'a', type: 'box', x: 40, y: 40, w: 160, h: 40, text: 'Orders <API>' },
    { id: 'b', type: 'box', x: 400, y: 40, w: 100, h: 40, text: 'Worker' },
    { id: 'c', type: 'note', x: 40, y: 200, w: 100, h: 40, text: 'Why?' },
    { id: 'ab', type: 'arrow', from: { object: 'a' }, to: { object: 'b' } },
    { id: 'elsewhere', type: 'box', x: 2000, y: 2000, w: 100, h: 40, text: 'Elsewhere' },
  ];
  store.dispatch({ type: 'add', objects });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'by-frame', title: 'Frame', source: { kind: 'frame', frame: 'frame' } } });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'by-objects', title: 'Pair', source: { kind: 'objects', objects: ['a', 'b', 'ab'] } } });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'by-region', title: 'Corner', source: { kind: 'region', rect: { x: 0, y: 0, w: 200, h: 300 }, objects: ['a', 'c'] } } });
  return store;
}

const resolve = (store: CanvasStore, id: string) => resolveSnapshot(store.getDocument(), indexFor(store), id);

describe('a snapshot is a live reference', () => {
  test('a snapshot of chosen objects follows them when they move and draws only them', () => {
    const store = board();
    const before = resolve(store, 'by-objects');
    store.dispatch({ type: 'move', ids: ['b'], dx: 300, dy: 0 });
    const after = resolve(store, 'by-objects');
    expect(before.status).toBe('live');
    expect(after.rect!.w).toBe(before.rect!.w + 300);
    expect([...after.only!].sort()).toEqual(['a', 'ab', 'b']);
    expect(sameResolution(before, after)).toBe(false);
  });

  test('a frame snapshot follows its frame and shows whatever is in it', () => {
    const store = board();
    store.dispatch({ type: 'move', ids: ['frame'], dx: 1000, dy: 0 });
    const resolved = resolve(store, 'by-frame');
    expect(resolved.rect!.x).toBeGreaterThan(900);
    expect(resolved.only).toBeNull();
  });

  test('a change elsewhere on the canvas leaves the answer the same, so the figure need not redraw', () => {
    const store = board();
    const before = resolve(store, 'by-objects');
    store.dispatch({ type: 'move', ids: ['elsewhere'], dx: 5, dy: 5 });
    store.dispatch({ type: 'recolor', ids: ['elsewhere'], color: 'red' });
    expect(sameResolution(before, resolve(store, 'by-objects'))).toBe(true);
  });

  test('it says so when some of its objects were deleted, and still draws the rest', () => {
    const store = board();
    store.dispatch({ type: 'delete', ids: ['b'] });
    const resolved = resolve(store, 'by-objects');
    expect(resolved).toMatchObject({ status: 'partial', problem: 'some-deleted', missing: 1, total: 3 });
    // The arrow lost one end but is still here, so it is still drawn.
    expect([...resolved.only!].sort()).toEqual(['a', 'ab']);
  });

  test('it says so when everything it showed is gone, and comes back when a delete is undone', () => {
    const store = board();
    store.dispatch({ type: 'delete', ids: ['a', 'b', 'ab'] });
    expect(resolve(store, 'by-objects')).toMatchObject({ status: 'gone', problem: 'all-deleted', rect: null });
    store.undo();
    expect(resolve(store, 'by-objects').status).toBe('live');
    store.dispatch({ type: 'delete', ids: ['frame'] });
    expect(resolve(store, 'by-frame')).toMatchObject({ status: 'gone', problem: 'frame-deleted' });
  });

  test('a region keeps its rectangle; it is gone only when what it held was deleted and nothing else is there', () => {
    const store = board();
    store.dispatch({ type: 'delete', ids: ['a'] });
    expect(resolve(store, 'by-region')).toMatchObject({ status: 'partial', missing: 1, total: 2, rect: { x: 0, y: 0, w: 200, h: 300 } });
    store.dispatch({ type: 'delete', ids: ['c', 'frame', 'ab'] });
    expect(resolve(store, 'by-region').status).toBe('gone');
    store.dispatch({ type: 'add', objects: [{ id: 'new', type: 'note', x: 20, y: 20, w: 50, h: 50, text: 'New' }] });
    expect(resolve(store, 'by-region').status).toBe('partial');
  });

  test('a snapshot removed from the canvas, or a canvas that is not there, is reported, not thrown', () => {
    const store = board();
    store.dispatch({ type: 'remove-snapshot', id: 'by-frame' });
    expect(resolve(store, 'by-frame')).toMatchObject({ status: 'gone', problem: 'no-snapshot' });
    expect(resolveSnapshot(null, null, 'by-frame')).toMatchObject({ status: 'gone', problem: 'no-canvas' });
  });
});

describe('making a snapshot from what a person chose', () => {
  test('a selection takes along the arrows that run between the chosen objects', () => {
    const store = board();
    const snapshot = snapshotFromSelection(store.getDocument(), ['b', 'a'])!;
    expect(snapshot.source).toEqual({ kind: 'objects', objects: ['a', 'b', 'ab'] });
    expect(snapshot.title).toBe('Orders <API>');
    expect(store.dispatch({ type: 'add-snapshot', snapshot }).ok).toBe(true);
  });

  test('one frame alone becomes a frame snapshot; nothing chosen makes nothing', () => {
    const store = board();
    expect(snapshotFromSelection(store.getDocument(), ['frame'])!.source).toEqual({ kind: 'frame', frame: 'frame' });
    expect(snapshotFromSelection(store.getDocument(), [])).toBeNull();
    expect(snapshotFromSelection(store.getDocument(), ['ghost'])).toBeNull();
  });

  test('a dragged region remembers what was inside it', () => {
    const store = board();
    const snapshot = snapshotFromRegion(store.getDocument(), indexFor(store), { x: 20.4, y: 20.2, w: 160, h: 260 });
    expect(snapshot.source).toEqual({ kind: 'region', rect: { x: 20, y: 20, w: 160, h: 260 }, objects: ['a', 'c'] });
  });
});

describe('the snapshot block in a plan', () => {
  const ref = { canvas: 'parcel-alerts', snapshot: 'architecture', title: 'How it fits', fallback: { src: 'shots/arch.svg', alt: 'Orders API feeds two queues' } };

  test('what is written is read back the same', () => {
    expect(parseSnapshotBlock(serializeSnapshotBody(ref))).toEqual(ref);
    expect(parseSnapshotBlock(serializeSnapshotBody({ canvas: 'c1', snapshot: 's1' }))).toEqual({ canvas: 'c1', snapshot: 's1' });
    const awkward = { canvas: 'c1', snapshot: 's1', title: 'A  title\nover two lines', fallback: { src: 'my shots/a (1).png', alt: 'has [brackets]' } };
    expect(parseSnapshotBlock(serializeSnapshotBody(awkward))).toEqual({
      canvas: 'c1',
      snapshot: 's1',
      title: 'A title over two lines',
      fallback: { src: 'my shots/a (1).png', alt: 'has brackets' },
    });
  });

  test('a block that names no canvas or snapshot is not a snapshot, and unknown lines are skipped', () => {
    expect(parseSnapshotBlock('canvas: only-this')).toBeNull();
    expect(parseSnapshotBlock('canvas: Not An Id\nsnapshot: s')).toBeNull();
    expect(parseSnapshotBlock('Canvas: c\nSNAPSHOT: s\nzoom: 2\nsome prose')).toEqual({ canvas: 'c', snapshot: 's' });
  });

  test('blocks are found by line, and one inside a code fence is text', () => {
    const md = ['# Plan', '', serializeSnapshotBlock(ref), '', '```md', ':::canvas-snapshot', 'canvas: x', 'snapshot: y', ':::', '```', '', ':::note', 'canvas: x', 'snapshot: y', ':::', '', serializeSnapshotBlock({ canvas: 'c2', snapshot: 's2' })].join('\n');
    const found = findSnapshotBlocks(md);
    expect(found.map((block) => [block.ref.canvas, block.startLine, block.endLine])).toEqual([
      ['parcel-alerts', 3, 8],
      ['c2', 22, 25],
    ]);
  });

  test('inserting puts the block at the line asked, with one blank line each side', () => {
    const md = '# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const small = { canvas: 'c', snapshot: 's' };
    const block = ':::canvas-snapshot\ncanvas: c\nsnapshot: s\n:::';
    expect(insertSnapshotBlock(md, 3, small)).toBe(`# Plan\n\nFirst paragraph.\n\n${block}\n\nSecond paragraph.\n`);
    expect(insertSnapshotBlock(md, 4, small)).toBe(insertSnapshotBlock(md, 3, small));
    expect(insertSnapshotBlock(md, 0, small)).toBe(`${block}\n\n# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n`);
    expect(insertSnapshotBlock(md, 999, small)).toBe(`# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n\n${block}\n`);
    expect(insertSnapshotBlock('', 0, small)).toBe(block);
    // Any number of times: the same snapshot twice is two blocks.
    expect(findSnapshotBlocks(insertSnapshotBlock(insertSnapshotBlock(md, 3, small), 3, small))).toHaveLength(2);
  });

  test('the plan renderer is handed a figure for a snapshot block and nothing for any other block', () => {
    const render = createSnapshotDirectiveRenderer();
    expect(render({ id: 'b1', directiveKind: 'note', content: 'canvas: c\nsnapshot: s' })).toBeUndefined();
    expect(render({ id: 'b1', directiveKind: 'canvas-snapshot', content: 'not a reference' })).toBeUndefined();
    const node = render({ id: 'b1', directiveKind: 'canvas-snapshot', content: 'canvas: c\nsnapshot: s\ntitle: T' }) as { props: Record<string, unknown> };
    expect(node.props).toMatchObject({ canvas: 'c', snapshot: 's', title: 'T' });
  });
});

describe('the still picture fallback', () => {
  test('it is one self-contained SVG: no script, no outside address, text escaped', () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [{ id: 'remote', type: 'image', x: 200, y: 200, w: 160, h: 60, src: 'https://example.test/a.png', alt: 'Remote picture' }] });
    store.dispatch({ type: 'recolor', ids: ['b'], color: { custom: '#c2410c' } });
    const svg = snapshotToSvg(store.getDocument(), indexFor(store), 'by-frame')!;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('Orders &lt;API&gt;');
    expect(svg).toContain('#c2410c');
    expect(svg).toContain('Remote picture');
    expect(svg).not.toMatch(/<script|example\.test|href="http|javascript:/i);
    // Outside the frame, so not in the picture.
    expect(svg).not.toContain('Elsewhere');
  });

  test('a snapshot of chosen objects pictures only those', () => {
    const store = board();
    const svg = snapshotToSvg(store.getDocument(), indexFor(store), 'by-objects')!;
    expect(svg).toContain('Worker');
    expect(svg).not.toContain('Why?');
  });

  test('nothing to draw gives no picture; a data URL survives being a Markdown image address', () => {
    const store = board();
    const url = snapshotToDataUrl(store.getDocument(), indexFor(store), 'by-frame')!;
    expect(url).not.toMatch(/[()\s]/);
    expect(parseSnapshotBlock(serializeSnapshotBody({ canvas: 'c', snapshot: 's', fallback: { src: url, alt: 'x' } }))?.fallback?.src).toBe(url);
    store.dispatch({ type: 'delete', ids: ['frame'] });
    expect(snapshotToSvg(store.getDocument(), indexFor(store), 'by-frame')).toBeNull();
  });
});

describe('dropping a snapshot into a plan', () => {
  const blocks = [
    { id: 'b1', top: 100, bottom: 140 },
    { id: 'b2', top: 160, bottom: 300 },
    { id: 'b3', top: 320, bottom: 360 },
  ];

  test('the nearest gap between blocks is chosen', () => {
    expect(nearestGap(blocks, 20)).toMatchObject({ blockId: 'b1', place: 'before' });
    expect(nearestGap(blocks, 145)).toMatchObject({ blockId: 'b1', place: 'after', at: 150 });
    expect(nearestGap(blocks, 250)).toMatchObject({ blockId: 'b2', place: 'after' });
    expect(nearestGap(blocks, 900)).toMatchObject({ blockId: 'b3', place: 'after' });
    expect(nearestGap([], 10)).toBeNull();
  });
});

describe('the open transition', () => {
  const ends = {
    from: { x: 24, y: 310, w: 614, h: 236 },
    viewport: { w: 1440, h: 900 },
    startCamera: { x: 0, y: 0, z: 0.6 },
    endCamera: { x: -200, y: -100, z: 1.2 },
    radius: 12,
  };

  test('it starts on the figure and ends filling the window', () => {
    expect(frameAt(ends, 0)).toMatchObject({ inset: { top: 310, left: 24, right: 802, bottom: 354, radius: 12 }, camera: ends.startCamera, chrome: 0 });
    expect(frameAt(ends, 1)).toMatchObject({ inset: { top: 0, left: 0, right: 0, bottom: 0, radius: 0 }, camera: ends.endCamera, chrome: 1 });
  });

  test('the first step already moves: the frame after a click is not the frame before it', () => {
    const first = stepSpring({ p: 0, v: 0 }, 1, 1 / 60);
    expect(first.p).toBeGreaterThan(0.01);
    expect(frameAt(ends, first.p).inset.top).toBeLessThan(310);
  });

  test('it never overshoots, always advances, and settles in well under a second', () => {
    let spring = { p: 0, v: 0 };
    let frames = 0;
    let last = 0;
    while (!springAtRest(spring, 1) && frames < 600) {
      spring = stepSpring(spring, 1, 1 / 60);
      expect(spring.p).toBeGreaterThanOrEqual(last);
      expect(spring.p).toBeLessThanOrEqual(1);
      last = spring.p;
      frames++;
    }
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(45);
  });

  test('turned round mid-flight it carries on from where it is, without a jump', () => {
    let spring = { p: 0, v: 0 };
    for (let i = 0; i < 8; i++) spring = stepSpring(spring, 1, 1 / 60);
    const turned = stepSpring(spring, 0, 1 / 60);
    // Still within one frame's travel of where it was, and already slowing.
    expect(Math.abs(turned.p - spring.p)).toBeLessThan(0.08);
    expect(turned.v).toBeLessThan(spring.v);
    let back = turned;
    for (let i = 0; i < 120; i++) back = stepSpring(back, 0, 1 / 60);
    expect(springAtRest(back, 0)).toBe(true);
  });

  test('a long frame does not blow it up', () => {
    const after = stepSpring({ p: 0.2, v: 3 }, 1, 5);
    expect(after.p).toBeGreaterThan(0.2);
    expect(after.p).toBeLessThanOrEqual(1);
    expect(Number.isFinite(after.v)).toBe(true);
  });
});

describe('the selection bar', () => {
  const bar = { w: 300, h: 44 };
  const view = { w: 390, h: 700 };

  test('it sits above the selection, below when there is no room, and always inside the view', () => {
    expect(placeSelectionBar({ x: 100, y: 300, w: 100, h: 40 }, bar, view)).toEqual({ x: 6, y: 244 });
    expect(placeSelectionBar({ x: 100, y: 20, w: 100, h: 40 }, bar, view)).toEqual({ x: 6, y: 72 });
    for (const target of [{ x: -500, y: -500, w: 10, h: 10 }, { x: 5000, y: 5000, w: 10, h: 10 }, { x: 0, y: 0, w: 390, h: 700 }]) {
      const at = placeSelectionBar(target, bar, view);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x + bar.w).toBeLessThanOrEqual(view.w);
      expect(at.y + bar.h).toBeLessThanOrEqual(view.h);
    }
  });
});
