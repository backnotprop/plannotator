import { describe, expect, test } from 'bun:test';
import { createDocument } from '../model/document';
import type { CanvasDocument, CanvasObject } from '../model/types';
import { CanvasStore } from './store';
import type { Command } from './types';

const AGENT = { kind: 'agent', id: 'agent-1' } as const;

const box = (id: string, x = 0, y = 0): CanvasObject => ({ id, type: 'box', x, y, w: 100, h: 40, text: id });

function seeded(): CanvasStore {
  const store = new CanvasStore(createDocument('board', 'Board'));
  store.dispatch({
    type: 'add',
    objects: [box('a'), box('b', 300), box('c', 600), { id: 'ab', type: 'arrow', from: { object: 'a' }, to: { object: 'b' } }],
  });
  return store;
}

/** The rules every document must keep, whatever happened to it. */
function expectSound(doc: CanvasDocument): void {
  const ids = Object.keys(doc.objects);
  expect([...doc.order].sort()).toEqual(ids.sort());
  expect(new Set(doc.order).size).toBe(doc.order.length);
  for (const [key, object] of Object.entries(doc.objects)) {
    expect(object.id).toBe(key);
    if (object.group) expect(doc.objects[object.group]?.type).toBe('group');
  }
}

describe('commands become events and state', () => {
  test('a move changes only the objects named and leaves the rest untouched by identity', () => {
    const store = seeded();
    const before = store.getDocument();
    const result = store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 5 });
    const after = store.getDocument();
    expect(result.ok && result.envelope?.events.map((event) => event.type)).toEqual(['object-changed']);
    expect(after.objects.a).toMatchObject({ x: 10, y: 5 });
    expect(after.objects.b).toBe(before.objects.b);
    expect(after.order).toBe(before.order);
  });

  test('a command that cannot be done changes nothing and says why', () => {
    const store = seeded();
    const before = store.getDocument();
    for (const command of [
      { type: 'add', objects: [box('a')] },
      { type: 'add', objects: [{ id: 'z', type: 'arrow', from: { object: 'ghost' }, to: { object: 'a' } }] },
      { type: 'resize', id: 'ab', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { type: 'edit', id: 'a', patch: { html: '<b>x</b>' } },
      { type: 'recolor', ids: ['a'], color: { custom: 'url(x)' } },
      { type: 'group', id: 'g', ids: ['a'] },
      { type: 'add-snapshot', snapshot: { id: 's', title: '', source: { kind: 'frame', frame: 'a' } } },
    ] as Command[]) {
      const result = store.dispatch(command);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.length).toBeGreaterThan(0);
    }
    expect(store.getDocument()).toBe(before);
    expect(store.canUndo).toBe(true);
  });

  test('deleting an object keeps an arrow that was stuck to it, where it was', () => {
    const store = seeded();
    store.dispatch({ type: 'delete', ids: ['b'] });
    const arrow = store.getDocument().objects.ab;
    expect(arrow).toMatchObject({ from: { object: 'a' }, to: { x: 300, y: 20 } });
    expectSound(store.getDocument());
  });

  test('deleting the last members of a group removes the group; ungroup lifts members out', () => {
    const store = seeded();
    store.dispatch({ type: 'group', id: 'g', ids: ['a', 'b'] });
    store.dispatch({ type: 'group', id: 'outer', ids: ['g', 'c'] });
    store.dispatch({ type: 'ungroup', ids: ['g'] });
    expect(store.getDocument().objects.a.group).toBe('outer');
    expect(store.getDocument().objects.g).toBeUndefined();
    store.dispatch({ type: 'delete', ids: ['a', 'b', 'c'] });
    expect(store.getDocument().objects.outer).toBeUndefined();
    expectSound(store.getDocument());
  });

  test('any object takes any colour, named or custom, and null puts its own back', () => {
    const store = seeded();
    store.dispatch({ type: 'recolor', ids: ['a', 'ab'], color: { custom: 'oklch(0.7 0.15 250)' } });
    expect(store.getDocument().objects.a.color).toEqual({ custom: 'oklch(0.7 0.15 250)' });
    expect(store.getDocument().objects.ab.color).toEqual({ custom: 'oklch(0.7 0.15 250)' });
    store.dispatch({ type: 'recolor', ids: ['a'], color: null });
    expect('color' in store.getDocument().objects.a).toBe(false);
  });

  test('bring to front keeps the moved objects in their own order', () => {
    const store = seeded();
    store.dispatch({ type: 'reorder', ids: ['a', 'b'], to: 'front' });
    expect(store.getDocument().order).toEqual(['c', 'ab', 'a', 'b']);
    store.dispatch({ type: 'reorder', ids: ['ab', 'b'], to: 'back' });
    expect(store.getDocument().order).toEqual(['ab', 'b', 'c', 'a']);
  });
});

describe('undo and redo', () => {
  test('undo puts back exactly what was there, redo does it again', () => {
    const store = seeded();
    const before = store.getDocument();
    store.dispatch({ type: 'delete', ids: ['b'] });
    const deleted = store.getDocument();
    store.undo();
    expect(store.getDocument()).toEqual(before);
    store.redo();
    expect(store.getDocument()).toEqual(deleted);
  });

  test('a drag of many small moves is one undo step', () => {
    const store = seeded();
    const start = store.getDocument();
    for (let i = 0; i < 40; i++) store.dispatch({ type: 'move', ids: ['a', 'b'], dx: 1, dy: 2 }, { gesture: 'drag-1' });
    store.dispatch({ type: 'move', ids: ['c'], dx: 5, dy: 0 }, { gesture: 'drag-2' });
    store.undo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 40, y: 80 });
    store.undo();
    expect(store.getDocument()).toEqual(start);
    store.redo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 40, y: 80 });
    expect(store.getDocument().objects.b).toMatchObject({ x: 340, y: 80 });
  });

  test("an agent's change is not on the person's undo stack", () => {
    const store = seeded();
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.dispatch({ type: 'add', objects: [box('from-agent', 0, 200)] }, { actor: AGENT });
    store.undo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 0 });
    expect(store.getDocument().objects['from-agent']).toBeDefined();
    expect(store.getDocument().objects['from-agent'].by).toBe('agent');
  });

  test('undoing a move after someone else deleted the object does not bring it back', () => {
    const store = seeded();
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.dispatch({ type: 'delete', ids: ['a'] }, { actor: AGENT });
    expect(store.undo()).toBeNull();
    expect(store.getDocument().objects.a).toBeUndefined();
    expect(store.canRedo).toBe(false);
  });

  test('a new change after an undo drops the redo', () => {
    const store = seeded();
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.undo();
    store.dispatch({ type: 'move', ids: ['b'], dx: 1, dy: 0 });
    expect(store.canRedo).toBe(false);
  });

  test('random commands, then undoing them all, lands on the first document with its rules intact', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const store = seeded();
    const start = store.getDocument();
    let made = 0;
    let steps = 0;
    for (let i = 0; i < 400; i++) {
      const ids = Object.keys(store.getDocument().objects);
      const pick = () => ids[Math.floor(random() * ids.length)];
      const roll = random();
      let command: Command;
      if (roll < 0.25 || ids.length < 3) command = { type: 'add', objects: [box(`n${made++}`, random() * 900, random() * 900)] };
      else if (roll < 0.5) command = { type: 'move', ids: [pick(), pick()], dx: random() * 20 - 10, dy: random() * 20 - 10 };
      else if (roll < 0.6) command = { type: 'delete', ids: [pick()] };
      else if (roll < 0.7) command = { type: 'group', id: `g${made++}`, ids: [pick(), pick(), pick()] };
      else if (roll < 0.78) command = { type: 'ungroup', ids: [pick()] };
      else if (roll < 0.88) command = { type: 'recolor', ids: [pick()], color: random() < 0.5 ? 'blue' : null };
      else if (roll < 0.94) command = { type: 'reorder', ids: [pick()], to: random() < 0.5 ? 'front' : 'back' };
      else command = { type: 'add', objects: [{ id: `ar${made++}`, type: 'arrow', from: { object: pick() }, to: { x: 5, y: 5 } }] };
      const result = store.dispatch(command);
      if (result.ok && result.envelope) steps++;
      expectSound(store.getDocument());
    }
    expect(steps).toBeGreaterThan(100);
    const end = store.getDocument();
    for (let i = 0; i < steps; i++) {
      store.undo();
      expectSound(store.getDocument());
    }
    expect(store.getDocument()).toEqual(start);
    for (let i = 0; i < steps; i++) store.redo();
    expect(store.getDocument()).toEqual(end);
  });
});

describe('the event stream', () => {
  test('every commit is told once, with who did it and what they asked', () => {
    const store = seeded();
    const heard: string[] = [];
    store.onCommit((envelope) => heard.push(`${envelope.actor.kind}:${envelope.origin}:${envelope.command?.type ?? '-'}`));
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    store.dispatch({ type: 'move', ids: ['a'], dx: 0, dy: 0 });
    store.dispatch({ type: 'recolor', ids: ['a'], color: 'red' }, { actor: AGENT });
    store.undo();
    expect(heard).toEqual(['person:local:move', 'agent:local:recolor', 'person:undo:-']);
  });

  test('since() hands over everything after a point, and says when it can no longer', () => {
    const store = new CanvasStore(createDocument('board'), { logLimit: 3 });
    store.dispatch({ type: 'add', objects: [box('a')] });
    const mark = store.head;
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    expect(store.since(mark)?.map((envelope) => envelope.command?.type)).toEqual(['move', 'move']);
    expect(store.since(store.head)).toEqual([]);
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    expect(store.since(0)).toBeNull();
  });
});
