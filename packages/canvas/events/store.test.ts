import { describe, expect, test } from 'bun:test';
import { parseDocument, serializeDocument } from '../model/codec';
import { createDocument } from '../model/document';
import { isOrderKey, keyBetween } from '../model/order-key';
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
    expect(result.ok && result.envelope?.events).toEqual([{ type: 'object-set', id: 'a', set: { x: 10, y: 5 } }]);
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

  test("undoing a move leaves alone what an agent changed on the same object in between", () => {
    const store = seeded();
    store.dispatch({ type: 'move', ids: ['a'], dx: 50, dy: 0 });
    store.dispatch({ type: 'edit', id: 'a', patch: { text: 'Rewritten by the agent' } }, { actor: AGENT });
    store.dispatch({ type: 'recolor', ids: ['a'], color: 'green' }, { actor: AGENT });
    const undone = store.undo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 0, text: 'Rewritten by the agent', color: 'green' });
    // What goes out to peers and the agent is the move coming back, nothing else.
    expect(undone?.events).toEqual([{ type: 'object-set', id: 'a', set: { x: 0 } }]);
    store.redo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 50, text: 'Rewritten by the agent', color: 'green' });
  });

  test('undoing a recolour after an agent moved the object keeps the move', () => {
    const store = seeded();
    store.dispatch({ type: 'recolor', ids: ['a'], color: 'red' });
    store.dispatch({ type: 'move', ids: ['a'], dx: 0, dy: 90 }, { actor: AGENT });
    store.undo();
    expect(store.getDocument().objects.a).toMatchObject({ y: 90 });
    expect('color' in store.getDocument().objects.a).toBe(false);
  });

  test('something that finishes an earlier action later joins that step and leaves redo alone', () => {
    const store = seeded();
    store.dispatch({ type: 'add', objects: [{ id: 'card', type: 'reference', x: 0, y: 300, w: 280, h: 84, target: { kind: 'web', url: 'https://example.test/' } }] }, { gesture: 'paste-1' });
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.undo();
    expect(store.canRedo).toBe(true);
    // The preview lands now.
    store.dispatch({ type: 'edit', id: 'card', patch: { title: 'Filled in' } }, { gesture: 'paste-1', amend: true });
    expect(store.canRedo).toBe(true);
    store.redo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 10 });
    store.undo();
    // One more undo takes the whole paste away, title and all; redo brings it back whole.
    store.undo();
    expect(store.getDocument().objects.card).toBeUndefined();
    store.redo();
    expect(store.getDocument().objects.card).toMatchObject({ title: 'Filled in' });
    // With its step gone, an amendment still applies, with no history of its own.
    const fresh = seeded();
    while (fresh.canUndo) fresh.undo();
    fresh.redo();
    const steps = () => { let n = 0; while (fresh.canUndo) { fresh.undo(); n++; } return n; };
    fresh.dispatch({ type: 'edit', id: 'a', patch: { text: 'late' } }, { gesture: 'gone', amend: true });
    expect(fresh.getDocument().objects.a).toMatchObject({ text: 'late' });
    expect(steps()).toBe(1);
  });

  test("an agent's change is not on the person's undo stack", () => {
    const store = seeded();
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.dispatch({ type: 'add', objects: [box('from-agent', 0, 200)] }, { actor: AGENT });
    store.undo();
    expect(store.getDocument().objects.a).toMatchObject({ x: 0 });
    expect(store.getDocument().objects['from-agent']).toBeDefined();
    expect(store.getDocument().objects['from-agent'].by).toEqual(AGENT);
  });

  test('undoing a move after someone else deleted the object does not bring it back', () => {
    const store = seeded();
    store.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    store.dispatch({ type: 'delete', ids: ['a'] }, { actor: AGENT });
    expect(store.undo()).toBeNull();
    expect(store.getDocument().objects.a).toBeUndefined();
    expect(store.canRedo).toBe(false);
  });

  test('an abandoned step can be taken back and forgotten: no undo, no redo left of it', () => {
    const store = seeded();
    while (store.canUndo) store.undo();
    store.redo();
    store.dispatch({ type: 'add', objects: [box('empty', 0, 300)] }, { gesture: 'first-empty' });
    expect(store.revert('some-other')).toBeNull();
    expect(store.revert('first-empty')).not.toBeNull();
    expect(store.getDocument().objects.empty).toBeUndefined();
    expect(store.canRedo).toBe(false);
    store.undo();
    expect(store.canUndo).toBe(false);
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
      else if (roll < 0.97) command = { type: 'add', objects: [{ id: `ar${made++}`, type: 'arrow', from: { object: pick() }, to: { x: 5, y: 5 } }] };
      else command = { type: 'move', ids: [pick()], dx: random() < 0.5 ? 1e12 : -3e7, dy: 0 };
      const result = store.dispatch(command);
      if (result.ok && result.envelope) steps++;
      expectSound(store.getDocument());
    }
    expect(steps).toBeGreaterThan(100);
    const end = store.getDocument();
    // Whatever the planner made, a saved file of it opens again.
    const reloaded = parseDocument(serializeDocument(end));
    expect(reloaded.ok && reloaded.value).toEqual(end);
    for (let i = 0; i < steps; i++) {
      store.undo();
      expectSound(store.getDocument());
    }
    expect(store.getDocument()).toEqual(start);
    for (let i = 0; i < steps; i++) store.redo();
    expect(store.getDocument()).toEqual(end);
  });
});

describe('what a move may do', () => {
  test('a move that would put an object off the board is refused, so every document still saves and loads', () => {
    const store = seeded();
    const before = store.getDocument();
    expect(store.dispatch({ type: 'move', ids: ['a'], dx: 1e9, dy: 0 }, { actor: AGENT }).ok).toBe(false);
    expect(store.dispatch({ type: 'move', ids: ['a', 'b'], dx: 0, dy: -2e7 }).ok).toBe(false);
    expect(store.getDocument()).toBe(before);
    expect(parseDocument(serializeDocument(store.getDocument())).ok).toBe(true);
  });

  test('an agent cannot pass its work off as a person\'s', () => {
    const store = seeded();
    store.dispatch({ type: 'add', objects: [{ ...box('claimed', 0, 400), by: { kind: 'person', id: 'ana' } }] }, { actor: AGENT });
    expect(store.getDocument().objects.claimed.by).toEqual(AGENT);
  });

  test('a shape, a routing and a style are words from short lists, kept through edits, saves and undo', () => {
    const store = seeded();
    expect(store.dispatch({ type: 'edit', id: 'a', patch: { shape: 'database', style: { look: 'sketch', fill: 'hachure', rough: 2, seed: 7 } } }).ok).toBe(true);
    expect(store.dispatch({ type: 'edit', id: 'ab', patch: { routing: 'elbow', style: { dash: true, fromSide: 'n', toSide: 'w', labelAt: 0.25, ends: 'dot' } } }).ok).toBe(true);
    const loaded = parseDocument(serializeDocument(store.getDocument()));
    expect(loaded.ok && loaded.value.objects.a).toMatchObject({ shape: 'database', style: { look: 'sketch', fill: 'hachure', rough: 2, seed: 7 } });
    expect(loaded.ok && loaded.value.objects.ab).toMatchObject({ routing: 'elbow', style: { dash: true, fromSide: 'n', toSide: 'w', labelAt: 0.25, ends: 'dot' } });
    // Not on the lists, or on the wrong kind of object: refused.
    for (const patch of [
      { shape: 'hexagon' },
      { routing: 'elbow' },
      { style: { look: 'neon' } },
      { style: { rough: 5 } },
      { style: { glow: true } },
      { style: { fromSide: 'n' } },
      { lanes: ['a', 'b'] },
    ]) {
      expect(store.dispatch({ type: 'edit', id: 'a', patch: patch as never }).ok).toBe(false);
    }
    expect(store.dispatch({ type: 'edit', id: 'ab', patch: { shape: 'cloud' } as never }).ok).toBe(false);
    expect(store.dispatch({ type: 'edit', id: 'ab', patch: { routing: 'zigzag' } as never }).ok).toBe(false);
    expect(store.dispatch({ type: 'edit', id: 'b', patch: { shape: 'container', lanes: ['urgent', 'bulk'] } }).ok).toBe(true);
    store.undo();
    store.undo();
    store.undo();
    expect('shape' in store.getDocument().objects.a).toBe(false);
  });
});

describe('stamps', () => {
  test('a stamp is a kind from a short list, with a count when there is more than one', () => {
    const store = seeded();
    expect(store.dispatch({ type: 'add', objects: [{ id: 'ok', type: 'stamp', kind: 'check', x: 0, y: 300 }, { id: 'liked', type: 'stamp', kind: 'thumb', count: 2, x: 60, y: 300 }] as never }).ok).toBe(true);
    expect(store.getDocument().objects.ok).toMatchObject({ w: 34, h: 34 });
    expect(store.dispatch({ type: 'edit', id: 'liked', patch: { count: 3 } }).ok).toBe(true);
    expect(store.getDocument().objects.liked).toMatchObject({ count: 3 });
    expect(store.dispatch({ type: 'add', objects: [{ id: 'bad', type: 'stamp', kind: 'skull', x: 0, y: 0 }] as never }).ok).toBe(false);
    expect(store.dispatch({ type: 'edit', id: 'liked', patch: { count: 0 } }).ok).toBe(false);
  });
});

describe('drawing order', () => {
  test('a new object goes on top, and coming back from a delete it is where it was', () => {
    const store = seeded();
    expect(store.getDocument().order).toEqual(['a', 'b', 'c', 'ab']);
    store.dispatch({ type: 'reorder', ids: ['c'], to: 'back' });
    store.dispatch({ type: 'delete', ids: ['c'] });
    store.dispatch({ type: 'add', objects: [box('d', 0, 300)] });
    expect(store.getDocument().order).toEqual(['a', 'b', 'ab', 'd']);
    store.undo();
    store.undo();
    expect(store.getDocument().order).toEqual(['c', 'a', 'b', 'ab']);
  });

  test('a reorder changes one field of the object moved and nothing about any other', () => {
    const store = seeded();
    const before = store.getDocument();
    const result = store.dispatch({ type: 'reorder', ids: ['a'], to: 'front' });
    expect(result.ok && result.envelope?.events.map((event) => (event.type === 'object-set' ? [event.id, Object.keys(event.set)] : event.type))).toEqual([['a', ['z']]]);
    expect(store.getDocument().objects.b).toBe(before.objects.b);
  });

  test('whatever is put wherever, in any order, every new key lies strictly between its neighbours', () => {
    // A small generator with a fixed seed, so a failure can be run again.
    let seed = 0x2f6e2b1;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      // Some rounds start from keys another program made: one digit, low ones, long ones.
      const keys: string[] = round % 4 === 0 ? ['1', '2'] : round % 4 === 1 ? ['01', '1'] : round % 4 === 2 ? ['zzzzzy', 'zzzzzz'] : [keyBetween(null, null)];
      for (let i = 0; i < 400; i++) {
        const at = random(keys.length + 1);
        const below = at > 0 ? keys[at - 1] : null;
        const above = at < keys.length ? keys[at] : null;
        const key = keyBetween(below, above);
        if (below !== null && !(key > below)) throw new Error(`${key} is not above ${below} (under ${above})`);
        if (above !== null && !(key < above)) throw new Error(`${key} is not below ${above} (over ${below})`);
        if (!isOrderKey(key)) throw new Error(`${key} is not a key`);
        keys.splice(at, 0, key);
      }
    }
    // A key ending in the lowest digit is not a key: nothing could be put just under it.
    expect(isOrderKey('A0')).toBe(false);
    expect(isOrderKey('0')).toBe(false);
    expect(isOrderKey('A1')).toBe(true);
    // Two neighbours with the same key: the new one goes above both, and is a key.
    const twin = keyBetween('V', 'V');
    expect(twin > 'V' && isOrderKey(twin)).toBe(true);
  });

  test('there is always a key between two keys, and keys stay short for a board that is added to', () => {
    let low = keyBetween(null, null);
    let high = keyBetween(low, null);
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(low, high);
      expect(mid > low && mid < high).toBe(true);
      if (i % 2) low = mid;
      else high = mid;
    }
    let top: string | null = null;
    for (let i = 0; i < 10_000; i++) top = keyBetween(top, null);
    expect(top!.length).toBe(6);
    let bottom: string | null = keyBetween(null, null);
    for (let i = 0; i < 5000; i++) {
      const next: string = keyBetween(null, bottom);
      expect(next < bottom!).toBe(true);
      bottom = next;
    }
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

  test('a drag is one entry for the hand-over, with the whole distance, however many frames it took', () => {
    const store = seeded();
    const mark = store.cursor();
    for (let i = 0; i < 60; i++) store.dispatch({ type: 'move', ids: ['a', 'b'], dx: 2, dy: 1 }, { gesture: 'drag-9' });
    store.dispatch({ type: 'recolor', ids: ['c'], color: 'blue' });
    const heard = store.since(mark);
    expect(heard.kind).toBe('events');
    if (heard.kind !== 'events') return;
    expect(heard.envelopes).toHaveLength(2);
    expect(heard.envelopes[0]).toMatchObject({ gesture: 'drag-9', command: { type: 'move', dx: 120, dy: 60 } });
    expect(heard.envelopes[0].events).toEqual([
      { type: 'object-set', id: 'a', set: { x: 120, y: 60 } },
      { type: 'object-set', id: 'b', set: { x: 420, y: 60 } },
    ]);
    // A cursor taken half way through a gesture cannot be answered in events: the whole document, then.
    const other = seeded();
    for (let i = 0; i < 5; i++) other.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 }, { gesture: 'drag' });
    const midway = other.cursor();
    for (let i = 0; i < 5; i++) other.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 }, { gesture: 'drag' });
    expect(other.since(midway).kind).toBe('resync');
  });

  test('since() hands over everything after a cursor', () => {
    const store = new CanvasStore(createDocument('board'), { logLimit: 3 });
    store.dispatch({ type: 'add', objects: [box('a')] });
    const mark = store.cursor();
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    store.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    const heard = store.since(mark);
    expect(heard.kind === 'events' && heard.envelopes.map((envelope) => envelope.command?.type)).toEqual(['move', 'move']);
    const nothing = store.since(store.cursor());
    expect(nothing.kind === 'events' && nothing.envelopes).toEqual([]);
  });

  test('a cursor it cannot answer for gets the whole document, never "nothing changed"', () => {
    const earlier = new CanvasStore(createDocument('board'));
    for (let i = 0; i < 120; i++) earlier.dispatch({ type: 'add', objects: [box(`e${i}`)] });
    const stale = earlier.cursor();

    // The page reloads: a new store, whose numbering starts again below the old cursor.
    const store = new CanvasStore(createDocument('board'), { logLimit: 3 });
    for (let i = 0; i < 5; i++) store.dispatch({ type: 'add', objects: [box(`n${i}`)] });
    const first = store.cursor();
    for (const cursor of [stale, { epoch: store.epoch, seq: 999 }, { epoch: store.epoch, seq: -1 }, { epoch: store.epoch, seq: 0 }, null, undefined]) {
      const answer = store.since(cursor);
      expect(answer.kind).toBe('resync');
      expect(answer.kind === 'resync' && Object.keys(answer.document.objects)).toHaveLength(5);
      expect(answer.cursor).toEqual(first);
    }
  });
});
