import { describe, expect, test } from 'bun:test';
import { CanvasStore } from '../events/store';
import { decodeCommand, decodeEnvelope } from '../events/wire';
import { createDocument } from '../model/document';
import type { CanvasObject } from '../model/types';
import { placeSelectionBar } from '../react/chrome';
import { indexFor } from '../view/document-index';
import { findSnapshotBlocks, insertSnapshotBlock, parseSnapshotBlock, serializeSnapshotBlock, serializeSnapshotBody } from './block';
import { defaultSnapshotTitle, snapshotFromRegion, snapshotFromSelection } from '../view/snapshot-source';
import { createSnapshotDirectiveRenderer } from './directive';
import { snapshotToSvg, stillPalette } from './picture';
import { chartShapes } from '../view/chart';
import { checkObject } from '../model/codec';
import type { ChartObject } from '../model/types';
import { nearestGap } from '../react/plan-drop';
import { behindSnapshots, resolveSnapshot } from './resolve';
import { frameAt, ghostOpacity, recedeAt, rimOpacity, springAtRest, stepSpring } from './transition';

function board(): CanvasStore {
  const store = new CanvasStore(createDocument('board', 'Board'));
  const objects: CanvasObject[] = [
    { id: 'frame', type: 'frame', x: 0, y: 0, w: 600, h: 300, title: 'Architecture' },
    { id: 'a', type: 'box', x: 40, y: 40, w: 160, h: 40, text: 'Orders <API>' },
    { id: 'b', type: 'box', x: 400, y: 40, w: 100, h: 40, text: 'Worker' },
    { id: 'c', type: 'note', x: 40, y: 200, w: 100, h: 40, text: 'Why?' },
    { id: 'ab', type: 'arrow', from: { object: 'a' }, to: { object: 'b' } },
    { id: 'elsewhere', type: 'box', x: 2000, y: 2000, w: 100, h: 40, text: 'Elsewhere' },
    { id: 'into', type: 'arrow', from: { object: 'elsewhere' }, to: { object: 'c' } },
  ];
  store.dispatch({ type: 'add', objects });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'by-frame', title: 'Frame', source: { kind: 'frame', frame: 'frame' } } });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'by-objects', title: 'Pair', source: { kind: 'objects', objects: ['a', 'b', 'ab'] } } });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'by-region', title: 'Corner', source: { kind: 'region', rect: { x: 0, y: 0, w: 250, h: 300 } } } });
  return store;
}

const standing = (store: CanvasStore, id: string) => {
  const resolved = resolveSnapshot(store.getDocument(), indexFor(store), id);
  return resolved.found ? resolved.standing : resolved.problem;
};
const captured = (store: CanvasStore, id: string) => store.getDocument().snapshots[id].capture;

describe('a snapshot is a capture taken at one moment', () => {
  test('editing the canvas afterwards does not change what the snapshot holds', () => {
    const store = board();
    const before = captured(store, 'by-objects');
    store.dispatch({ type: 'move', ids: ['b'], dx: 300, dy: 0 });
    store.dispatch({ type: 'edit', id: 'a', patch: { text: 'Renamed' } });
    store.dispatch({ type: 'delete', ids: ['ab'] });
    expect(captured(store, 'by-objects')).toBe(before);
    expect(before.objects.map((object) => object.id)).toEqual(['a', 'b', 'ab']);
    expect(before.objects[0]).toMatchObject({ text: 'Orders <API>' });
    expect(before.objects[1]).toMatchObject({ x: 400 });
  });

  test('taking it costs no copies: the capture holds the very objects the canvas holds', () => {
    const store = board();
    const doc = store.getDocument();
    expect(captured(store, 'by-objects').objects[0]).toBe(doc.objects.a);
    expect(captured(store, 'by-frame').objects.find((object) => object.id === 'b')).toBe(doc.objects.b);
  });

  test('an arrow that leaves a region has that end fixed where it was, so the capture draws alone', () => {
    const store = board();
    const into = captured(store, 'by-region').objects.find((object) => object.id === 'into');
    expect(into).toMatchObject({ type: 'arrow', to: { object: 'c' } });
    expect(into && 'from' in into && 'x' in into.from).toBe(true);
  });

  test('a frame snapshot is the frame and what is wholly inside it: no sliced neighbours, no title strip', () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [{ id: 'straddles', type: 'note', x: 560, y: 100, w: 120, h: 60, text: 'Half in' }] });
    store.dispatch({ type: 'update-snapshot', id: 'by-frame' });
    const capture = captured(store, 'by-frame');
    expect(capture.objects.map((object) => object.id)).toEqual(['frame', 'a', 'b', 'c', 'ab']);
    // The rectangle hugs the frame; its title, drawn above it, falls outside and the caption carries the name.
    expect(capture.rect).toEqual({ x: -2, y: -2, w: 604, h: 304 });
    // The frozen document resolves its arrow without the canvas.
    expect(snapshotToSvg(store.getDocument(), 'by-frame')!.match(/<polyline /g)).toHaveLength(1);
  });

  test('the capture is taken by the planner; one sent from outside is ignored', () => {
    const store = board();
    const forged = { id: 'forged', title: '', source: { kind: 'objects', objects: ['a'] }, capture: { rect: { x: 0, y: 0, w: 5, h: 5 }, objects: [] } };
    expect(store.dispatch({ type: 'add-snapshot', snapshot: forged as never }, { actor: { kind: 'agent', id: 'x' } }).ok).toBe(true);
    expect(captured(store, 'forged').objects.map((object) => object.id)).toEqual(['a']);
    expect(store.dispatch({ type: 'add-snapshot', snapshot: { id: 'empty', title: '', source: { kind: 'region', rect: { x: 9000, y: 9000, w: 50, h: 50 } } } }).ok).toBe(false);
    expect(store.dispatch({ type: 'add-snapshot', snapshot: { id: 'ghost', title: '', source: { kind: 'frame', frame: 'a' } } }).ok).toBe(false);
  });
});

describe('a snapshot knows when it is behind', () => {
  test('fresh snapshots are current, and a change elsewhere leaves them so', () => {
    const store = board();
    store.dispatch({ type: 'move', ids: ['elsewhere'], dx: 0, dy: 500 });
    store.dispatch({ type: 'recolor', ids: ['elsewhere'], color: 'red' });
    expect(standing(store, 'by-objects')).toBe('current');
    expect(standing(store, 'by-frame')).toBe('current');
    // The region shows an arrow coming in from the moved object, so its picture did change.
    expect(standing(store, 'by-region')).toBe('behind');
  });

  test('a set of objects is behind when one of them changes or is deleted, and not when another object arrives', () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [{ id: 'new', type: 'note', x: 220, y: 40, w: 50, h: 40, text: 'New' }] });
    expect(standing(store, 'by-objects')).toBe('current');
    store.dispatch({ type: 'recolor', ids: ['b'], color: 'green' });
    expect(standing(store, 'by-objects')).toBe('behind');
    store.undo();
    expect(standing(store, 'by-objects')).toBe('current');
    store.dispatch({ type: 'delete', ids: ['b'] });
    expect(standing(store, 'by-objects')).toBe('behind');
  });

  test('a frame is behind when the frame changes or anything inside it does, arrivals included', () => {
    const store = board();
    expect(standing(store, 'by-frame')).toBe('current');
    store.dispatch({ type: 'add', objects: [{ id: 'new', type: 'note', x: 220, y: 40, w: 50, h: 40, text: 'New' }] });
    expect(standing(store, 'by-frame')).toBe('behind');
    store.undo();
    store.dispatch({ type: 'edit', id: 'frame', patch: { title: 'Renamed' } });
    expect(standing(store, 'by-frame')).toBe('behind');
  });

  test('a region is behind when what is in its rectangle changes, whoever it is', () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [{ id: 'far', type: 'note', x: 5000, y: 0, w: 50, h: 40, text: 'Far' }] });
    expect(standing(store, 'by-region')).toBe('current');
    store.dispatch({ type: 'add', objects: [{ id: 'near', type: 'note', x: 150, y: 120, w: 50, h: 40, text: 'Near' }] });
    expect(standing(store, 'by-region')).toBe('behind');
    store.undo();
    // An arrow crossing the edge is in the picture too: moving the box it points at, outside, changes it.
    store.dispatch({ type: 'move', ids: ['b'], dx: 0, dy: 80 });
    expect(standing(store, 'by-region')).toBe('behind');
  });

  test('changing something back makes it current again: behind means "would look different", not "was touched"', () => {
    const store = board();
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.dispatch({ type: 'move', ids: ['a'], dx: -10, dy: 0 });
    store.dispatch({ type: 'recolor', ids: ['a'], color: 'blue' });
    store.dispatch({ type: 'recolor', ids: ['a'], color: null });
    expect(standing(store, 'by-objects')).toBe('current');
  });

  test('when what it showed is gone it is detached: the capture stays, and it cannot be updated', () => {
    const store = board();
    const before = captured(store, 'by-objects');
    store.dispatch({ type: 'delete', ids: ['a', 'b', 'ab'] });
    expect(standing(store, 'by-objects')).toBe('detached');
    expect(store.dispatch({ type: 'update-snapshot', id: 'by-objects' }).ok).toBe(false);
    expect(captured(store, 'by-objects')).toBe(before);
    store.dispatch({ type: 'delete', ids: ['frame'] });
    expect(standing(store, 'by-frame')).toBe('detached');
    store.dispatch({ type: 'remove-snapshot', id: 'by-frame' });
    expect(standing(store, 'by-frame')).toBe('no-snapshot');
    expect(resolveSnapshot(null, null, 'x')).toEqual({ found: false, problem: 'no-canvas' });
  });

  test('the plan can ask which of its snapshots are behind', () => {
    const store = board();
    store.dispatch({ type: 'recolor', ids: ['a'], color: 'red' });
    expect(behindSnapshots(store.getDocument(), indexFor(store), ['by-objects', 'by-objects', 'by-frame', 'by-region', 'nope']).sort()).toEqual(['by-frame', 'by-objects', 'by-region']);
  });
});

describe('updating a snapshot', () => {
  test('update takes the capture again, in place, and is one undo step', () => {
    const store = board();
    const old = captured(store, 'by-objects');
    store.dispatch({ type: 'delete', ids: ['b'] }, { actor: { kind: 'agent', id: 'x' } });
    store.dispatch({ type: 'edit', id: 'a', patch: { text: 'Renamed' } }, { actor: { kind: 'agent', id: 'x' } });
    const result = store.dispatch({ type: 'update-snapshot', id: 'by-objects' });
    expect(result.ok && result.envelope?.events.map((event) => event.type)).toEqual(['snapshot-put']);
    expect(captured(store, 'by-objects').objects.map((object) => object.id)).toEqual(['a', 'ab']);
    expect(captured(store, 'by-objects').objects[0]).toMatchObject({ text: 'Renamed' });
    expect(standing(store, 'by-objects')).toBe('current');
    expect(store.getDocument().snapshots['by-objects'].title).toBe('Pair');
    store.undo();
    expect(captured(store, 'by-objects')).toBe(old);
    expect(standing(store, 'by-objects')).toBe('behind');
    store.redo();
    expect(standing(store, 'by-objects')).toBe('current');
  });

  test('updating a current snapshot does nothing and leaves no undo step', () => {
    const store = board();
    while (store.canUndo) store.undo();
    const fresh = board();
    const result = fresh.dispatch({ type: 'update-snapshot', id: 'by-frame' });
    expect(result.ok && result.envelope).toBeNull();
  });

  test('an agent updates with the same command, and a peer receives the new capture', () => {
    const store = board();
    const mirror = new CanvasStore(JSON.parse(JSON.stringify(store.getDocument())));
    store.onCommit((envelope) => {
      const decoded = decodeEnvelope(JSON.stringify(envelope));
      if (decoded.ok) mirror.receive(decoded.value);
    });
    store.dispatch({ type: 'move', ids: ['a'], dx: 0, dy: 20 });
    const command = decodeCommand('{"type":"update-snapshot","id":"by-objects"}');
    expect(command.ok && store.dispatch(command.value, { actor: { kind: 'agent', id: 'x' } }).ok).toBe(true);
    expect(mirror.getDocument().snapshots['by-objects'].capture).toEqual(captured(store, 'by-objects'));
    expect(standing(mirror, 'by-objects')).toBe('current');
  });

  test('renaming keeps the capture; a new source takes it again', () => {
    const store = board();
    const before = captured(store, 'by-objects');
    store.dispatch({ type: 'edit-snapshot', id: 'by-objects', title: 'Orders to worker' });
    expect(store.getDocument().snapshots['by-objects']).toMatchObject({ title: 'Orders to worker' });
    expect(captured(store, 'by-objects')).toBe(before);
    store.dispatch({ type: 'edit-snapshot', id: 'by-objects', source: { kind: 'objects', objects: ['c'] } });
    expect(captured(store, 'by-objects').objects.map((object) => object.id)).toEqual(['c']);
  });

  test('fifty snapshots of an unchanged canvas share its objects instead of copying them', () => {
    const store = board();
    for (let i = 0; i < 50; i++) store.dispatch({ type: 'add-snapshot', snapshot: { id: `s${i}`, title: '', source: { kind: 'frame', frame: 'frame' } } });
    const doc = store.getDocument();
    const distinct = new Set(Object.values(doc.snapshots).flatMap((snapshot) => snapshot.capture.objects));
    // Everything but an arrow with an end fixed in place is the canvas's own object, held once.
    const shared = [...distinct].filter((object) => object.type !== 'arrow');
    expect(shared).toHaveLength(4);
    expect(shared.every((object) => doc.objects[object.id] === object)).toBe(true);
  });
});

describe('making a snapshot from what a person chose', () => {
  test('a selection takes along the arrows that run between the chosen objects', () => {
    const store = board();
    const input = snapshotFromSelection(store.getDocument(), ['b', 'a'])!;
    expect(input.source).toEqual({ kind: 'objects', objects: ['a', 'b', 'ab'] });
    expect(store.dispatch({ type: 'add-snapshot', snapshot: input }).ok).toBe(true);
  });

  test('its name follows one rule, and is never the words of whichever object is first', () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [{ id: 'far', type: 'box', x: 3000, y: 2000, w: 100, h: 40, text: 'Far' }] });
    store.dispatch({ type: 'group', id: 'pair', ids: ['elsewhere', 'far'], label: 'Outliers' });
    const doc = store.getDocument();
    // One object: its own words, even inside a frame.
    expect(snapshotFromSelection(doc, ['elsewhere'])!.title).toBe('Elsewhere');
    expect(snapshotFromSelection(doc, ['c'])!.title).toBe('Why?');
    // One frame alone or with its contents, or several objects inside one frame: the frame's title.
    expect(snapshotFromSelection(doc, ['frame'])).toMatchObject({ title: 'Architecture', source: { kind: 'frame', frame: 'frame' } });
    expect(snapshotFromSelection(doc, ['frame', 'a', 'b'])!.title).toBe('Architecture');
    expect(snapshotFromSelection(doc, ['a', 'b', 'c'])!.title).toBe('Architecture');
    // Everything in one labelled group: the label.
    expect(snapshotFromSelection(doc, ['elsewhere', 'far'])!.title).toBe('Outliers');
    // Otherwise none.
    expect(snapshotFromSelection(doc, ['a', 'elsewhere'])!.title).toBe('');
    expect(defaultSnapshotTitle(doc, ['a', 'elsewhere'])).toBe('');
    expect(snapshotFromSelection(doc, [])).toBeNull();
    expect(snapshotFromSelection(doc, ['ghost'])).toBeNull();
  });

  test('a dragged region is the rectangle, rounded, named after the frame around it or the one frame inside it', () => {
    const store = board();
    const index = indexFor(store);
    const inside = snapshotFromRegion(store.getDocument(), index, { x: 20.4, y: 20.2, w: 200, h: 260 });
    expect(inside.source).toEqual({ kind: 'region', rect: { x: 20, y: 20, w: 200, h: 260 } });
    expect(inside.title).toBe('Architecture');
    expect(snapshotFromRegion(store.getDocument(), index, { x: -50, y: -50, w: 800, h: 500 }).title).toBe('Architecture');
    expect(snapshotFromRegion(store.getDocument(), index, { x: 300, y: 20, w: 1900, h: 2100 }).title).toBe('');
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
    store.dispatch({ type: 'update-snapshot', id: 'by-frame' });
    const svg = snapshotToSvg(store.getDocument(), 'by-frame')!;
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('Orders &lt;API&gt;');
    expect(svg).toContain('#c2410c');
    expect(svg).toContain('Remote picture');
    expect(svg).not.toMatch(/<script|example\.test|href="http|javascript:/i);
    expect(svg).not.toContain('Elsewhere');
  });

  test('a drawn line, a curved connector and a heading are drawn as themselves', () => {
    const store = board();
    store.dispatch({
      type: 'add',
      objects: [
        { id: 'ring', type: 'ink', x: 300, y: 100, w: 100, h: 50, points: [0, 0, 0.5, 1, 1, 0], pen: 'highlighter', color: { custom: '#ffd23f' } },
        { id: 'under', type: 'ink', x: 300, y: 200, w: 100, h: 10, points: [0, 0, 1, 1] },
        { id: 'name', type: 'text', x: 20, y: 120, w: 400, h: 50, text: 'Parcel <alerts>', size: 'title', face: 'serif' },
        { id: 'bend', type: 'arrow', from: { x: 40, y: 280 }, to: { x: 440, y: 280 }, routing: 'curve' },
      ] as CanvasObject[],
    });
    store.dispatch({ type: 'update-snapshot', id: 'by-frame' });
    const svg = snapshotToSvg(store.getDocument(), 'by-frame')!;
    // The highlighter: its own colour, its width, see-through; the points across its box, in board units.
    expect(svg).toContain('<path transform="translate(300 100)" d="M0 0L25 25Q50 50 75 25L100 0" fill="none" stroke="#ffd23f" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.4"/>');
    expect(svg).toContain('d="M0 0L100 10" fill="none" stroke="#10131c" stroke-width="4.5"');
    expect(svg).toContain('font-size="40" font-weight="700" font-family="Georgia, serif"');
    expect(svg).toContain('Parcel &lt;alerts&gt;');
    // The curve as a curve, with the bow the board draws.
    expect(svg).toContain('<path d="M40 280Q240 152 440 280"');
    expect(svg).not.toMatch(/NaN|undefined/);
    // A snapshot of the line alone is its box and the room round it, and goes behind when the line is redrawn.
    store.dispatch({ type: 'add-snapshot', snapshot: { id: 'the-ring', title: 'Ring', source: { kind: 'objects', objects: ['ring'] } } });
    // The capture holds the stroke, which runs nine units past a highlighter's box, and the room round that.
    expect(captured(store, 'the-ring').rect).toEqual({ x: 267, y: 67, w: 166, h: 116 });
    expect(standing(store, 'the-ring')).toBe('current');
    store.dispatch({ type: 'edit', id: 'ring', patch: { points: [0, 0, 1, 1] } });
    expect(standing(store, 'the-ring')).toBe('behind');
    store.undo();
    expect(standing(store, 'the-ring')).toBe('current');
  });

  test('a chart is drawn in it from its rows, with its own words escaped and its colour kept', () => {
    const store = board();
    const chart = { id: 'ch', type: 'chart', x: 0, y: 400, w: 380, h: 240, mark: 'line', title: 'Scan <to> alert', unit: 'min', fields: ['week', 'minutes'], rows: [['W1', 11.2], ['W2', 4.1], ['W3', 1.3]], encode: { x: 'week', y: 'minutes' }, color: { custom: '#c2410c' } };
    store.dispatch({ type: 'add', objects: [chart as unknown as CanvasObject] });
    store.dispatch({ type: 'add-snapshot', snapshot: { id: 'chart', title: 'A chart', source: { kind: 'objects', objects: ['ch'] } } });
    const svg = snapshotToSvg(store.getDocument(), 'chart')!;
    expect(svg).toContain('SCAN &lt;TO&gt; ALERT');
    // The line itself, in the object's colour, and the latest value.
    expect(svg).toMatch(/<path d="M[^"]+L[^"]+L[^"]+" fill="none" stroke="#c2410c"/);
    expect(svg).toContain('>1.3<');
    expect(svg).not.toMatch(/<script|<foreignObject|href=/i);
    // Changing the rows afterwards leaves the picture as it was, until the snapshot is taken again.
    store.dispatch({ type: 'edit', id: 'ch', patch: { rows: [['W1', 11.2], ['W2', 4.1], ['W3', 77]] } });
    expect(snapshotToSvg(store.getDocument(), 'chart')).toBe(svg);
    store.dispatch({ type: 'update-snapshot', id: 'chart' });
    expect(snapshotToSvg(store.getDocument(), 'chart')).toContain('>77<');
  });

  test('a chart is a drawing of its own in the file: what it draws past its box is cut off there', () => {
    const store = board();
    // An end label of a long number and a long name runs past the chart's right edge.
    const chart = { id: 'ch', type: 'chart', x: 40, y: 400, w: 210, h: 140, mark: 'line', fields: ['week', 'team', 'v'], rows: [[1, 'a team with a long name', 123456.789], [2, 'a team with a long name', 987654.321], [1, 'b', 5], [2, 'b', 6]], encode: { x: 'week', y: 'v', series: 'team' } };
    store.dispatch({ type: 'add', objects: [chart as unknown as CanvasObject] });
    store.dispatch({ type: 'add-snapshot', snapshot: { id: 'chart', title: '', source: { kind: 'objects', objects: ['ch'] } } });
    const svg = snapshotToSvg(store.getDocument(), 'chart')!;
    expect(svg).toContain('<svg x="40" y="400" width="210" height="140" viewBox="0 0 210 140" overflow="hidden">');
    // Everything the chart draws is inside that drawing, and no id is made (two charts in one file cannot collide).
    const inner = svg.slice(svg.indexOf('overflow="hidden">'), svg.indexOf('</svg>'));
    expect(inner).toContain('<path');
    expect(svg).not.toMatch(/ id="|url\(#/);
  });

  test('a chart with no colour of its own is the board\'s accent for the theme, and a custom colour is written once', () => {
    const store = board();
    const base = { type: 'chart', x: 0, y: 400, w: 380, h: 240, mark: 'bar', fields: ['x', 'v'], rows: [['a', 1], ['b', 2]], encode: { x: 'x', y: 'v' } };
    store.dispatch({ type: 'add', objects: [{ ...base, id: 'plain' }, { ...base, id: 'own', x: 500, color: { custom: 'rgb(194 65 12)' } }] as unknown as CanvasObject[] });
    store.dispatch({ type: 'add-snapshot', snapshot: { id: 'two', title: '', source: { kind: 'objects', objects: ['plain', 'own'] } } });
    for (const theme of ['light', 'dark'] as const) {
      const svg = snapshotToSvg(store.getDocument(), 'two', { theme })!;
      expect(svg).toContain(`fill="${stillPalette(theme).accent}"`);
      expect(svg).toContain('fill="rgb(194 65 12)"');
    }
    expect(stillPalette('light').accent).not.toBe(stillPalette('dark').accent);
  });

  test('every mark of a chart, in every step it can be drawn in, is at least 3 to 1 against its card, light and dark', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const blend = (over: string, under: string, alpha: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(over.slice(i, i + 2), 16) * alpha + parseInt(under.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
    const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    const rows = Array.from({ length: 16 }, (_row, i) => [i % 2, `k${i % 8}`, i + 1]);
    const charts = (['bar', 'line', 'dot', 'area'] as const).map((mark) => {
      const checked = checkObject({ id: 'c', type: 'chart', x: 0, y: 0, w: 380, h: 240, mark, fields: ['x', 'k', 'v'], rows, encode: { x: 'x', y: 'v', series: 'k' }, stack: true });
      if (!checked.ok) throw new Error(checked.error);
      return checked.value as ChartObject;
    });
    let seen = 0;
    for (const theme of ['light', 'dark'] as const) {
      const palette = stillPalette(theme);
      const colour = { ink: palette.ink, muted: palette.muted, accent: palette.accent, rule: palette.line };
      for (const chart of charts) for (const shape of chartShapes(chart)) {
        // The rules behind the marks are not marks.
        const role = shape.kind === 'text' ? shape.fill : (shape.stroke ?? shape.fill);
        if (!role || role === 'rule') continue;
        const drawn = blend(colour[role], palette.card, shape.kind === 'path' ? (shape.opacity ?? 1) : 1);
        if (contrast(drawn, palette.card) < 3) throw new Error(`${theme} ${chart.mark}: ${role} at ${shape.kind === 'path' ? (shape.opacity ?? 1) : 1} is ${contrast(drawn, palette.card).toFixed(2)} to 1`);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(200);
  });

  test('it pictures the capture, not the canvas as it is now', () => {
    const store = board();
    store.dispatch({ type: 'edit', id: 'b', patch: { text: 'Changed' } });
    expect(snapshotToSvg(store.getDocument(), 'by-objects')).toContain('Worker');
    store.dispatch({ type: 'update-snapshot', id: 'by-objects' });
    expect(snapshotToSvg(store.getDocument(), 'by-objects')).toContain('Changed');
    expect(snapshotToSvg(store.getDocument(), 'by-objects')).not.toContain('Why?');
  });

  test('no snapshot gives no picture; text that XML cannot hold does not break the file', () => {
    const store = board();
    expect(snapshotToSvg(store.getDocument(), 'nope')).toBeNull();
    store.dispatch({ type: 'edit', id: 'a', patch: { text: 'be\u0007ll\u0000 ok' } });
    store.dispatch({ type: 'update-snapshot', id: 'by-objects' });
    const svg = snapshotToSvg(store.getDocument(), 'by-objects')!;
    expect(svg).toContain('>bell ok<');
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)).toBe(false);
  });

  test('the plan block holds a reference to the still picture, never the picture', () => {
    const body = serializeSnapshotBody({ canvas: 'c', snapshot: 's', fallback: { src: 'asset:sha256-9f2c1a7b', alt: 'x' } });
    expect(body.length).toBeLessThan(80);
    expect(parseSnapshotBlock(body)?.fallback?.src).toBe('asset:sha256-9f2c1a7b');
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
    // Long enough to follow (not a pop), and at rest well inside a second and a half.
    expect(frames).toBeGreaterThan(30);
    expect(frames).toBeLessThan(80);
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

  test('the capture holds, then dissolves before the opening is two-thirds grown; the plan stands back with depth', () => {
    expect(ghostOpacity(0)).toBe(1);
    expect(ghostOpacity(0.08)).toBe(1);
    expect(ghostOpacity(0.35)).toBeGreaterThan(0.3);
    expect(ghostOpacity(0.35)).toBeLessThan(0.8);
    expect(ghostOpacity(0.62)).toBe(0);
    expect(ghostOpacity(1)).toBe(0);
    for (let p = 0; p < 1; p += 0.05) expect(ghostOpacity(p + 0.05)).toBeLessThanOrEqual(ghostOpacity(p));
    expect(recedeAt(0)).toEqual({ scale: 1, opacity: 1, blur: 0 });
    const away = recedeAt(1);
    expect(away.scale).toBeGreaterThan(0.9);
    expect(away.scale).toBeLessThan(0.97);
    expect(away.blur).toBeGreaterThan(1);
    expect(away.opacity).toBeGreaterThan(0.3);
    // Most of the going-away happens early, while there is still plan to see around the opening.
    expect(1 - recedeAt(0.3).scale).toBeGreaterThan((1 - away.scale) * 0.6);
    expect(rimOpacity(0)).toBe(0);
    expect(rimOpacity(0.3)).toBe(1);
    expect(rimOpacity(1)).toBe(0);
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
