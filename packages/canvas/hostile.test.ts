/**
 * Input that tries to break the model: arrows and groups that go round in a
 * circle, and ids that are also names on Object.prototype. Each must be
 * refused at the door it came through and must never hang or throw.
 */
import { describe, expect, test } from 'bun:test';
import { applyEvents } from './events/reduce';
import { CanvasStore } from './events/store';
import { decodeCommand } from './events/wire';
import { parseSnapshotBlock } from './snapshot/block';
import { resolveSnapshot } from './snapshot/resolve';
import { hitTest } from './view/hit-test';
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

  test('a saved file may not list an id it does not hold', () => {
    const doc = JSON.parse(serializeDocument(board().getDocument()));
    for (const name of ['constructor', 'toString']) {
      expect(parseDocument({ ...doc, order: [...doc.order, name] }).ok).toBe(false);
      expect(parseDocument({ ...doc, order: [name, ...doc.order.slice(1)] }).ok).toBe(false);
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
