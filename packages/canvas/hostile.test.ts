/**
 * Input that tries to break the model: arrows and groups that go round in a
 * circle, and ids that are also names on Object.prototype. Each must be
 * refused at the door it came through and must never hang or throw.
 */
import { describe, expect, test } from 'bun:test';
import { applyEvents } from './events/reduce';
import { CanvasStore } from './events/store';
import { decodeCommand, decodeEnvelope } from './events/wire';
import { parseSnapshotBlock } from './snapshot/block';
import { resolveSnapshot } from './snapshot/resolve';
import { hitTest } from './view/hit-test';
import { routesFor } from './view/routes';
import { indexFor } from './view/document-index';
import { captureOf } from './model/capture';
import { parseDocument, serializeDocument } from './model/codec';
import { createDocument, objectBounds, resolveArrow } from './model/document';
import type { ArrowObject, CanvasDocument, CanvasObject } from './model/types';

const AGENT = { kind: 'agent', id: 'agent-1' } as const;
const box = (id: string, extra: object = {}): CanvasObject => ({ id, type: 'box', x: 0, y: 0, w: 100, h: 40, text: id, ...extra }) as CanvasObject;
const arrow = (id: string, from: string, to: string, extra: object = {}): CanvasObject => ({ id, type: 'arrow', from: { object: from }, to: { object: to }, ...extra }) as CanvasObject;

function board(): CanvasStore {
  const store = new CanvasStore(createDocument('board'));
  store.dispatch({ type: 'add', objects: [box('a'), box('b', { x: 300 }), { id: 'g', type: 'group' }, box('m', { y: 200, group: 'g' }), box('n', { x: 300, y: 200, group: 'g' })] });
  return store;
}

describe('arrows and groups that go round in a circle', () => {
  test('the planner refuses an arrow stuck to an arrow, to itself, or to a group it is inside', () => {
    const store = board();
    const before = store.getDocument();
    for (const objects of [
      [arrow('x', 'y', 'a'), arrow('y', 'x', 'a')],
      [arrow('x', 'x', 'a')],
      [arrow('x', 'g', 'a', { group: 'g' })],
      [{ id: 'g2', type: 'group', group: 'g3' }, { id: 'g3', type: 'group', group: 'g2' }],
      [{ id: 'g2', type: 'group', group: 'g2' }],
    ]) {
      const result = store.dispatch({ type: 'add', objects: objects as CanvasObject[] }, { actor: AGENT });
      expect(result.ok).toBe(false);
    }
    store.dispatch({ type: 'add', objects: [arrow('ab', 'a', 'b'), arrow('in', 'm', 'a', { group: 'g' })] });
    expect(store.dispatch({ type: 'edit', id: 'ab', patch: { from: { object: 'in' } } }).ok).toBe(false);
    expect(store.dispatch({ type: 'edit', id: 'ab', patch: { from: { object: 'ab' } } }).ok).toBe(false);
    expect(store.dispatch({ type: 'edit', id: 'in', patch: { to: { object: 'g' } } }).ok).toBe(false);
    // An arrow outside a group may be stuck to it, and lands on its placed members.
    expect(store.dispatch({ type: 'add', objects: [arrow('to-group', 'a', 'g')] }).ok).toBe(true);
    expect(resolveArrow(store.getDocument(), store.getDocument().objects['to-group'] as ArrowObject)).not.toBeNull();
    expect(Object.keys(store.getDocument().objects).length).toBe(Object.keys(before.objects).length + 3);
  });

  test('a saved file holding a circle is refused, not opened', () => {
    const doc = board().getDocument();
    const withObjects = (extra: CanvasObject[]) => {
      const objects = { ...doc.objects } as Record<string, CanvasObject>;
      for (const object of extra) objects[object.id] = object;
      return JSON.parse(JSON.stringify({ ...doc, objects, order: Object.keys(objects) }));
    };
    expect(parseDocument(withObjects([])).ok).toBe(true);
    expect(parseDocument(withObjects([arrow('x', 'y', 'a'), arrow('y', 'x', 'a')])).ok).toBe(false);
    expect(parseDocument(withObjects([arrow('x', 'g', 'a', { group: 'g' })])).ok).toBe(false);
    // Stuck to an object that is not there: not a circle. It loads, and simply cannot be drawn.
    const dangling = parseDocument(withObjects([arrow('x', 'ghost', 'a')]));
    expect(dangling.ok && resolveArrow(dangling.value, dangling.value.objects.x as ArrowObject)).toBeNull();
    expect(parseDocument(withObjects([box('z', { group: 'a' })])).ok).toBe(false);
    expect(parseDocument(withObjects([{ id: 'g2', type: 'group', group: 'g3' }, { id: 'g3', type: 'group', group: 'g2' }])).ok).toBe(false);
  });

  test("a peer's event that would close a circle is dropped, and the rest of the batch applies", () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [arrow('ab', 'a', 'b')] });
    const doc = store.getDocument();
    const result = applyEvents(
      doc,
      [
      { type: 'object-added', object: arrow('bad', 'ab', 'a') },
      { type: 'object-set', id: 'ab', set: { from: { object: 'ab' } } },
      { type: 'object-set', id: 'g', set: { group: 'g' } },
      { type: 'object-set', id: 'a', set: { x: 'far' } },
      { type: 'object-set', id: 'a', set: { type: 'html', html: '<b>' } },
      { type: 'object-added', object: box('fine', { y: 500 }) },
      ],
      { check: true },
    );
    expect(result.applied.map((event) => event.type)).toEqual(['object-added']);
    expect(result.doc.objects.fine).toBeDefined();
    expect(result.doc.objects.bad).toBeUndefined();
    expect(result.doc.objects.a).toBe(doc.objects.a);
  });

  test('a document that holds a circle anyway is still read without hanging', () => {
    // Built by hand, past every door: what a bug elsewhere might leave behind.
    const objects = {
      x: arrow('x', 'y', 'g', { group: 'g' }),
      y: arrow('y', 'x', 'x'),
      g: { id: 'g', type: 'group', group: 'h' },
      h: { id: 'h', type: 'group', group: 'g' },
      m: box('m', { group: 'g' }),
    } as unknown as CanvasDocument['objects'];
    const doc: CanvasDocument = { version: 1, id: 'd', title: '', objects, order: ['x', 'y', 'g', 'h', 'm'], snapshots: {} };
    expect(resolveArrow(doc, doc.objects.y as ArrowObject)).toBeNull();
    expect(objectBounds(doc, 'g')).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(objectBounds(doc, 'x')).toBeNull();
    const store = new CanvasStore(doc);
    expect(hitTest(store.getDocument(), indexFor(store), { x: 10, y: 10 })).toBe('m');
    expect(captureOf(doc, { kind: 'region', rect: { x: -50, y: -50, w: 500, h: 500 } })?.objects.map((object) => object.id)).toEqual(['m']);
    expect(store.dispatch({ type: 'delete', ids: ['g'] }).ok).toBe(true);
  });
});

describe('ids that are also names on Object.prototype', () => {
  const NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

  test('they are ordinary ids: nothing exists under them until something is put there', () => {
    const store = board();
    const before = store.getDocument();
    for (const name of NAMES.filter((id) => id !== '__proto__')) {
      for (const json of [
        `{"type":"edit","id":"${name}","patch":{"text":"x"}}`,
        `{"type":"move","ids":["${name}"],"dx":1,"dy":1}`,
        `{"type":"delete","ids":["${name}"]}`,
        `{"type":"resize","id":"${name}","rect":{"x":0,"y":0,"w":50,"h":50}}`,
        `{"type":"update-snapshot","id":"${name}"}`,
        `{"type":"add","objects":[{"id":"z","type":"arrow","from":{"object":"${name}"},"to":{"object":"a"}}]}`,
        `{"type":"add","objects":[{"id":"z","type":"note","x":0,"y":0,"w":10,"h":10,"text":"","group":"${name}"}]}`,
        `{"type":"add-snapshot","snapshot":{"id":"s","title":"","source":{"kind":"frame","frame":"${name}"}}}`,
      ]) {
        const command = decodeCommand(json);
        expect(command.ok && store.dispatch(command.value, { actor: AGENT }).ok).toBe(false);
      }
    }
    expect(store.getDocument()).toBe(before);
  });

  test('an object may be called constructor, and is stored, saved, loaded and removed like any other', () => {
    const store = board();
    expect(store.dispatch({ type: 'add', objects: [box('constructor', { y: 400 }), box('tostring', { y: 500 })] }).ok).toBe(true);
    expect(store.dispatch({ type: 'add-snapshot', snapshot: { id: 'constructor', title: 'T', source: { kind: 'objects', objects: ['constructor'] } } }).ok).toBe(true);
    const loaded = parseDocument(serializeDocument(store.getDocument()));
    expect(loaded.ok && loaded.value.objects['constructor' as string]).toMatchObject({ type: 'box', y: 400 });
    expect(loaded.ok && loaded.value.snapshots['constructor' as string].title).toBe('T');
    store.dispatch({ type: 'delete', ids: ['constructor'] });
    expect(store.getDocument().objects.constructor).toBeUndefined();
    expect(store.getDocument().order).not.toContain('constructor');
  });

  test('a file that lists an order may not list an id it does not hold', () => {
    const doc = JSON.parse(serializeDocument(board().getDocument()));
    const order = Object.keys(doc.objects);
    expect(parseDocument({ ...doc, order }).ok).toBe(true);
    for (const name of ['constructor', 'toString']) {
      expect(parseDocument({ ...doc, order: [...order, name] }).ok).toBe(false);
      expect(parseDocument({ ...doc, order: [name, ...order.slice(1)] }).ok).toBe(false);
    }
  });

  test('a plan block naming such a snapshot is "not there", never a throw', () => {
    const store = board();
    for (const name of NAMES) {
      const ref = parseSnapshotBlock(`canvas: board\nsnapshot: ${name}`);
      if (name !== name.toLowerCase() || name.startsWith('_')) {
        // Not an id at all (ids are lower case and start with a letter or digit): the block is no snapshot.
        expect(ref).toBeNull();
        continue;
      }
      expect(ref).toEqual({ canvas: 'board', snapshot: name });
      expect(resolveSnapshot(store.getDocument(), indexFor(store), name)).toEqual({ found: false, problem: 'no-snapshot' });
    }
    // A document handed over as a plain object is made safe by the store that takes it.
    const plain = new CanvasStore({ version: 1, id: 'p', title: '', objects: {}, order: [], snapshots: {} });
    expect(plain.getDocument().objects.constructor).toBeUndefined();
    expect(resolveSnapshot(plain.getDocument(), null, 'constructor')).toEqual({ found: false, problem: 'no-snapshot' });
  });
});

describe('a canvas at its limits saves and loads again', () => {
  const reload = (store: CanvasStore) => parseDocument(JSON.parse(serializeDocument(store.getDocument())));

  test('a snapshot of a frame at its widest, and of notes at the two ends of the board', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({
      type: 'add',
      objects: [
        { id: 'wide', type: 'frame', x: 0, y: 0, w: 20_000, h: 20_000, title: 'The whole year' },
        { id: 'west', type: 'note', x: -1_000_000, y: -1_000_000, w: 200, h: 120, text: 'west' },
        { id: 'east', type: 'note', x: 1_000_000, y: 1_000_000, w: 200, h: 120, text: 'east' },
        { id: 'first', type: 'note', x: -10_000_000, y: -10_000_000, w: 20_000, h: 20_000, text: 'first' },
        { id: 'last', type: 'note', x: 10_000_000, y: 10_000_000, w: 20_000, h: 20_000, text: 'last' },
      ] as CanvasObject[],
    });
    const taken = [
      store.dispatch({ type: 'add-snapshot', snapshot: { id: 'frame', title: '', source: { kind: 'frame', frame: 'wide' } } }),
      store.dispatch({ type: 'add-snapshot', snapshot: { id: 'far', title: '', source: { kind: 'objects', objects: ['west', 'east'] } } }),
      store.dispatch({ type: 'add-snapshot', snapshot: { id: 'ends', title: '', source: { kind: 'objects', objects: ['first', 'last'] } } }),
      store.dispatch({ type: 'add-snapshot', snapshot: { id: 'all', title: '', source: { kind: 'region', rect: { x: -10_000_000, y: -10_000_000, w: 20_020_000, h: 20_020_000 } } } }),
    ];
    expect(taken.map((result) => result.ok)).toEqual([true, true, true, true]);
    expect(store.getDocument().snapshots.far.capture.rect.w).toBeGreaterThan(2_000_000);
    const loaded = reload(store);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(Object.keys(loaded.value.snapshots).sort()).toEqual(['all', 'ends', 'far', 'frame']);
  });

  test('a rectangle no board could hold is still refused, when asked for and when loaded', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({ type: 'add', objects: [box('a')] });
    expect(store.dispatch({ type: 'add-snapshot', snapshot: { id: 's', title: '', source: { kind: 'region', rect: { x: 0, y: 0, w: 30_000_000, h: 10 } } } }).ok).toBe(false);
    store.dispatch({ type: 'add-snapshot', snapshot: { id: 's', title: '', source: { kind: 'objects', objects: ['a'] } } });
    const saved = JSON.parse(serializeDocument(store.getDocument()));
    saved.snapshots.s.capture.rect.w = 30_000_000;
    expect(parseDocument(saved).ok).toBe(false);
  });

  test('an HTML item with nothing in it is refused: it would be an object nobody can see', () => {
    const store = new CanvasStore(createDocument('board'));
    expect(store.dispatch({ type: 'add', objects: [{ id: 'h', type: 'html', x: 0, y: 0, w: 100, h: 60, html: '  \n' } as CanvasObject] }).ok).toBe(false);
  });
});

describe('an arrow from an object back to itself', () => {
  test('is a loop outside the object, not a point in the middle of its words', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({ type: 'add', objects: [box('a', { x: 100, y: 100, w: 170, h: 76 }), arrow('loop', 'a', 'a', { label: 'retry' })] });
    const doc = store.getDocument();
    const g = resolveArrow(doc, doc.objects.loop as ArrowObject)!;
    const points = [g.from, ...(g.via ?? []), g.to];
    expect(points.length).toBe(5);
    // It starts and ends on the object's edge, and every corner between is outside the object.
    expect(g.from.x).toBe(270);
    expect(g.to.y).toBe(100);
    for (const p of g.via!) expect(p.x > 270 || p.y < 100).toBe(true);
    // Each piece runs straight across or straight up and down.
    for (let i = 1; i < points.length; i++) expect(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y).toBe(true);
    const bounds = objectBounds(doc, 'loop')!;
    expect(bounds.w).toBeGreaterThan(20);
    expect(bounds.h).toBeGreaterThan(20);
    expect(routesFor(store).get('loop')!.points).toEqual(points);
    // It can be picked up by its line, outside the box.
    expect(hitTest(doc, indexFor(store), { x: g.via![1].x, y: g.via![0].y - 10 }, 6, routesFor(store))).toBe('loop');
  });
});

describe('a change whose field name is a name on every object', () => {
  test('__proto__, constructor and prototype set nothing in the reducer, with or without the check, and the canvas loads', () => {
    const store = board();
    store.dispatch({ type: 'add', objects: [arrow('link', 'a', 'b')] });
    const doc = store.getDocument();
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      // Parsed from text, the way a peer's change arrives: the name is a field of its own.
      const set = JSON.parse(`{"${name}":{"group":"link","from":{"object":"link"}}}`) as Record<string, unknown>;
      for (const check of [true, false]) {
        const applied = applyEvents(doc, [{ type: 'object-set', id: 'a', set }], { check });
        expect(applied.applied).toEqual([]);
        expect(applied.doc).toBe(doc);
      }
      // Beside an honest field, only the honest field lands.
      const mixed = applyEvents(doc, [{ type: 'object-set', id: 'a', set: { ...set, text: 'kept' } }], { check: true });
      const changed = mixed.doc.objects.a as unknown as Record<string, unknown>;
      expect(changed.text).toBe('kept');
      expect(changed.group).toBeUndefined();
      expect(Object.getPrototypeOf(changed)).toBe(Object.prototype);
      expect(parseDocument(JSON.parse(serializeDocument(mixed.doc))).ok).toBe(true);
    }
  });
});

describe('a drawn line and a heading from a peer', () => {
  const PEER = { kind: 'person', id: 'peer' } as const;
  const ink = { id: 'ring', type: 'ink', x: 0, y: 0, w: 100, h: 100, points: [0, 0, 1, 1] };

  test('an envelope that adds a line with too many points, or points that are not numbers, is refused whole', () => {
    for (const points of [new Array(2002).fill(0.5), [0, 0, 'x', 1], [0, 0, 1e9, 1], { length: 4 }, null]) {
      const envelope = decodeEnvelope(JSON.stringify({ id: 'e1', actor: PEER, events: [{ type: 'object-added', object: { ...ink, points } }] }));
      expect(envelope.ok).toBe(false);
    }
    expect(decodeEnvelope({ id: 'e1', actor: PEER, events: [{ type: 'object-added', object: ink }] }).ok).toBe(true);
  });

  test('a change that would make a line no line, or put points on something else, does nothing', () => {
    const store = new CanvasStore(createDocument('board'));
    store.dispatch({ type: 'add', objects: [ink, box('a'), { id: 't', type: 'text', x: 0, y: 0, w: 100, h: 30, text: 'T' }] as CanvasObject[] });
    const before = store.getDocument();
    const sets: [string, Record<string, unknown>][] = [
      ['ring', { points: [0, 0, 5, 5] }],
      ['ring', { points: [0, 0, 1] }],
      ['ring', { points: 'M0 0L1 1' }],
      ['ring', { points: new Array(4000).fill(0) }],
      ['ring', { pen: 'constructor' }],
      ['a', { points: [0, 0, 1, 1] }],
      ['a', { pen: 'fine' }],
      ['a', { face: 'serif' }],
      ['t', { size: '__proto__' }],
      ['t', { face: 'hasOwnProperty' }],
    ];
    for (const [id, set] of sets) {
      const envelope = decodeEnvelope({ id: `e-${id}-${Object.keys(set)[0]}-${JSON.stringify(set).length}`, actor: PEER, events: [{ type: 'object-set', id, set }] });
      expect(envelope.ok).toBe(true);
      if (envelope.ok) store.receive(envelope.value);
      expect(applyEvents(before, [{ type: 'object-set', id, set }], { check: true }).applied).toEqual([]);
    }
    expect(store.getDocument()).toBe(before);
    // A good one goes through, field by field.
    const good = decodeEnvelope({ id: 'good', actor: PEER, events: [{ type: 'object-set', id: 'ring', set: { pen: 'fine', points: [0, 1, 1, 0] } }, { type: 'object-set', id: 't', set: { size: 'title', face: 'mono' } }] });
    expect(good.ok && store.receive(good.value)).toBeTruthy();
    expect(store.getDocument().objects.ring).toMatchObject({ pen: 'fine', points: [0, 1, 1, 0] });
    expect(store.getDocument().objects.t).toMatchObject({ size: 'title', face: 'mono' });
  });

  test('a board of lines at their longest saves, loads, is found by the pointer and is captured', () => {
    const store = new CanvasStore(createDocument('board'));
    const points = Array.from({ length: 2000 }, (_, i) => (i % 2 ? (i % 7) / 6 : i / 1999));
    const objects = Array.from({ length: 50 }, (_, i) => ({ id: `ink${i}`, type: 'ink', x: i * 10, y: i * 10, w: 400, h: 200, points, pen: i % 2 ? 'highlighter' : 'fine' }));
    expect(store.dispatch({ type: 'add', objects: objects as CanvasObject[] }, { actor: AGENT }).ok).toBe(true);
    const loaded = parseDocument(serializeDocument(store.getDocument()));
    expect(loaded.ok && Object.keys(loaded.value.objects).length).toBe(50);
    expect(hitTest(store.getDocument(), indexFor(store), { x: 0, y: 0 })).toBe('ink0');
    expect(captureOf(store.getDocument(), { kind: 'region', rect: { x: 0, y: 0, w: 2000, h: 2000 } })?.objects.length).toBe(50);
  });
});
