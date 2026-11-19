import { describe, expect, test } from 'bun:test';
import { createDocument } from '../model/document';
import { parseDocument, serializeDocument } from '../model/codec';
import { applyEvents } from './reduce';
import { CanvasStore } from './store';
import { type SyncPort, connectSync } from './sync';
import type { Actor } from '../model/types';
import type { Envelope } from './types';
import { decodeCommand, decodeDelivery, decodeEnvelope } from './wire';

const AGENT = { kind: 'agent', id: 'agent-1' } as const;

/** Send a command the way an agent does: as JSON text through the decoder. */
function agentSends(store: CanvasStore, json: string) {
  const command = decodeCommand(json);
  if (!command.ok) return command;
  return store.dispatch(command.value, { actor: AGENT });
}

describe('an agent speaks the same commands as a person', () => {
  test('an agent adds an image, a sprite and an HTML item, then recolours and moves them', () => {
    const store = new CanvasStore(createDocument('board'));
    const added = agentSends(
      store,
      JSON.stringify({
        type: 'add',
        objects: [
          { id: 'pic', type: 'image', x: 0, y: 0, w: 200, h: 100, src: 'asset:sha256-9f2c1a', alt: 'A chart' },
          { id: 'spin', type: 'sprite', x: 0, y: 120, w: 24, h: 24, src: 'sprites/spin.png', alt: 'Working', frames: 8, fps: 12 },
          { id: 'table', type: 'html', x: 0, y: 160, w: 300, h: 80, html: '<table><tr><td>1</td></tr></table>' },
        ],
      }),
    );
    expect(added.ok).toBe(true);
    expect(agentSends(store, '{"type":"recolor","ids":["pic","spin","table"],"color":"#ff8800"}').ok).toBe(true);
    expect(agentSends(store, '{"type":"move","ids":["pic"],"dx":40,"dy":0}').ok).toBe(true);
    const doc = store.getDocument();
    expect(doc.objects.pic).toMatchObject({ x: 40, by: AGENT, color: { custom: '#ff8800' } });
    expect(doc.objects.table.color).toEqual({ custom: '#ff8800' });
    // None of it is the person's to undo.
    expect(store.canUndo).toBe(false);
  });

  test('what an agent may not send is refused before it touches the document', () => {
    const store = new CanvasStore(createDocument('board'));
    const before = store.getDocument();
    for (const json of [
      'not json',
      '{"type":"teleport"}',
      '{"type":"move","ids":"a","dx":1,"dy":1}',
      '{"type":"move","ids":["a"],"dx":"1","dy":1}',
      '{"type":"add","objects":[{"id":"x","type":"image","x":0,"y":0,"w":10,"h":10,"src":"javascript:alert(1)","alt":""}]}',
      '{"type":"add","objects":[{"id":"x","type":"note","x":0,"y":0,"w":10,"h":10,"text":"","color":"url(https://example.test)"}]}',
      '{"type":"add","objects":[{"id":"../x","type":"note","x":0,"y":0,"w":10,"h":10,"text":""}]}',
      '{"type":"add-snapshot","snapshot":{"id":"s","title":"","source":{"kind":"objects","objects":[]}}}',
    ]) {
      expect(agentSends(store, json).ok).toBe(false);
    }
    expect(store.getDocument()).toBe(before);
  });
});

describe('an agent hears what a person does', () => {
  test("a person's drag reaches a listener as JSON that rebuilds the same canvas elsewhere", () => {
    const person = new CanvasStore(createDocument('board'));
    const mirror = new CanvasStore(createDocument('board'));
    const outbox: string[] = [];
    person.onCommit((envelope) => outbox.push(JSON.stringify(envelope)));

    person.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    for (let i = 0; i < 5; i++) person.dispatch({ type: 'move', ids: ['a'], dx: 3, dy: 1 }, { gesture: 'drag' });
    person.dispatch({ type: 'add-snapshot', snapshot: { id: 's', title: 'A', source: { kind: 'objects', objects: ['a'] } } });
    person.undo();
    person.redo();

    for (const json of outbox) {
      const envelope = decodeEnvelope(json);
      expect(envelope.ok).toBe(true);
      if (envelope.ok) mirror.receive(envelope.value);
    }
    expect(mirror.getDocument()).toEqual(person.getDocument());
    // The listener was told who and what, not just the result.
    const first = JSON.parse(outbox[1]) as Envelope;
    expect(first.actor.kind).toBe('person');
    expect(first.command).toMatchObject({ type: 'move', ids: ['a'] });
  });

  test('an envelope carrying something unsafe is refused whole', () => {
    const bad = {
      id: 'e1',
      actor: AGENT,
      events: [{ type: 'object-added', object: { id: 'h', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:1', alt: '' } }],
    };
    expect(decodeEnvelope(bad).ok).toBe(false);
    expect(decodeEnvelope({ ...bad, events: [{ type: 'explode' }] }).ok).toBe(false);
    expect(decodeEnvelope({ ...bad, actor: { kind: 'root', id: 'x' }, events: [] }).ok).toBe(false);
  });
});

describe('the sync seam', () => {
  /**
   * A backend as the seam asks for one: it puts every envelope in one
   * order, counts them from 1, says who sent each from the connection it
   * came in on (never from what the envelope claims), and hands each, as
   * JSON, to every peer, the sender included. `flush` delivers what has
   * been published; until then peers have not heard each other, which is
   * how two people change something "at the same moment".
   */
  function backend() {
    const peers: ((delivery: unknown) => void)[] = [];
    const queue: { actor: Actor; envelope: unknown }[] = [];
    /** Every delivery made so far, in order: what a backend replays from. */
    const log: string[] = [];
    const deliver = (actor: Actor, envelope: unknown, twice = false) => {
      const json = JSON.stringify({ order: log.length + 1, actor, envelope });
      log.push(json);
      for (const peer of [...peers]) {
        peer(json);
        if (twice) peer(JSON.parse(json));
      }
    };
    return {
      log,
      port: (actor: Actor): SyncPort => ({
        publish: (envelope) => void queue.push({ actor, envelope: JSON.parse(JSON.stringify(envelope)) }),
        subscribe: (onDelivery, after) => {
          for (const json of log.slice(after)) onDelivery(json);
          peers.push(onDelivery);
          return () => void peers.splice(peers.indexOf(onDelivery), 1);
        },
      }),
      /** Deliver everything published so far. `twice`: each envelope is handed over two times. */
      flush(twice = false) {
        while (queue.length) {
          const { actor, envelope } = queue.shift()!;
          deliver(actor, envelope, twice);
        }
      },
      /** Something a peer signed in as `actor` sent: ordered, counted and delivered like anything else. */
      inject: (envelope: unknown, actor: Actor = MALLORY) => deliver(actor, envelope),
      /** Hand every peer the whole history again, from the first envelope. */
      replay: () => log.forEach((json) => [...peers].forEach((peer) => peer(json))),
      /** Hand a peer something as it is, outside the order (a broken or lying backend). */
      raw: (delivery: unknown) => [...peers].forEach((peer) => peer(delivery)),
    };
  }

  const ONE = { kind: 'person', id: 'one' } as const;
  const TWO = { kind: 'person', id: 'two' } as const;
  const MALLORY = { kind: 'person', id: 'mallory' } as const;

  const pair = () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: ONE });
    const two = new CanvasStore(createDocument('board'), { actor: TWO });
    const stopOne = connectSync(one, net.port(ONE));
    connectSync(two, net.port(TWO));
    one.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    net.flush();
    return { net, one, two, stopOne };
  };

  const reloads = (store: CanvasStore) => parseDocument(JSON.parse(serializeDocument(store.getDocument()))).ok;

  test('a group undone after someone else put an object in it lets go of that object, and every canvas still loads', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'add', objects: [{ id: 'x', type: 'box', x: 0, y: 100, w: 100, h: 40, text: 'X' }, { id: 'y', type: 'box', x: 0, y: 200, w: 100, h: 40, text: 'Y' }] });
    one.dispatch({ type: 'group', id: 'g', ids: ['x', 'y'] });
    net.flush();
    // The other one adds an object straight into that group.
    expect(two.dispatch({ type: 'add', objects: [{ id: 'z', type: 'box', x: 0, y: 300, w: 100, h: 40, text: 'Z', group: 'g' }] }).ok).toBe(true);
    net.flush();
    expect(one.getDocument().objects.z.group).toBe('g');
    // The first takes the grouping back.
    one.undo();
    net.flush();
    for (const store of [one, two]) {
      expect(store.getDocument().objects.g).toBeUndefined();
      expect(store.getDocument().objects.z.group).toBeUndefined();
      expect(reloads(store)).toBe(true);
    }
    expect(two.getDocument()).toEqual(one.getDocument());
    // Putting the group back puts everything that was in it back.
    one.redo();
    net.flush();
    expect(one.getDocument().objects.z.group).toBe('g');
    expect(two.getDocument()).toEqual(one.getDocument());
    expect(reloads(two)).toBe(true);
  });

  test('a change whose field is named __proto__, constructor or prototype sets nothing, and every canvas still loads', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'add', objects: [{ id: 'n1', type: 'note', x: 0, y: 100, w: 100, h: 60, text: 'N' }, { id: 'a1', type: 'arrow', from: { object: 'a' }, to: { object: 'n1' } }] });
    net.flush();
    const before = one.getDocument();
    // As text, the way it comes off a wire: parsed, `__proto__` is a field of its own.
    for (const set of ['{"__proto__":{"group":"a1"}}', '{"constructor":{"prototype":{"group":"a1"}}}', '{"prototype":{"group":"a1"}}', '{"__proto__":{"group":"a1"},"text":"kept"}']) {
      net.inject(`{"id":"evil-${set.length}","events":[{"type":"object-set","id":"n1","set":${set}}]}`);
    }
    for (const store of [one, two]) {
      const note = store.getDocument().objects.n1 as unknown as Record<string, unknown>;
      expect(note.group).toBeUndefined();
      expect(Object.getPrototypeOf(note)).toBe(Object.prototype);
      expect(Object.keys(note).sort()).toEqual(Object.keys(before.objects.n1).sort());
      // The honest field beside the hostile one was applied.
      expect(note.text).toBe('kept');
      expect(reloads(store)).toBe(true);
    }
    expect(two.getDocument()).toEqual(one.getDocument());
    expect(({} as Record<string, unknown>).group).toBeUndefined();
  });

  test('two people setting the same field at the same moment both end on the one the backend ordered last', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    two.dispatch({ type: 'move', ids: ['a'], dx: 2, dy: 0 });
    // Each sees its own change at once.
    expect(one.getDocument().objects.a).toMatchObject({ x: 1 });
    expect(two.getDocument().objects.a).toMatchObject({ x: 2 });
    net.flush();
    expect(one.getDocument().objects.a).toMatchObject({ x: 2 });
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  test('two people changing different fields of one object both keep their change', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'move', ids: ['a'], dx: 40, dy: 0 });
    two.dispatch({ type: 'edit', id: 'a', patch: { text: 'Renamed' } });
    two.dispatch({ type: 'recolor', ids: ['a'], color: 'red' });
    net.flush();
    expect(one.getDocument().objects.a).toMatchObject({ x: 40, text: 'Renamed', color: 'red' });
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  test('two people reordering different objects at the same moment both keep what they did', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'add', objects: [{ id: 'b', type: 'note', x: 0, y: 100, w: 100, h: 40, text: 'B' }, { id: 'c', type: 'note', x: 0, y: 200, w: 100, h: 40, text: 'C' }] });
    net.flush();
    expect(two.getDocument().order).toEqual(['a', 'b', 'c']);
    one.dispatch({ type: 'reorder', ids: ['a'], to: 'front' });
    two.dispatch({ type: 'reorder', ids: ['c'], to: 'back' });
    net.flush();
    expect(one.getDocument().order).toEqual(['c', 'b', 'a']);
    expect(two.getDocument().order).toEqual(['c', 'b', 'a']);
  });

  test('a change to something another person deleted at the same moment is dropped, everywhere the same', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'delete', ids: ['a'] });
    two.dispatch({ type: 'move', ids: ['a'], dx: 5, dy: 0 });
    two.dispatch({ type: 'add', objects: [{ id: 'b', type: 'note', x: 0, y: 100, w: 100, h: 40, text: 'B' }] });
    net.flush();
    expect(one.getDocument().objects.a).toBeUndefined();
    expect(Object.keys(two.getDocument().objects)).toEqual(['b']);
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  test('many interleaved changes, delivered twice over, leave every peer with the same document', () => {
    const { net, one, two } = pair();
    let seed = 5;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
    let made = 0;
    for (let round = 0; round < 60; round++) {
      for (const store of [one, two]) {
        const ids = Object.keys(store.getDocument().objects);
        const pick = () => ids[Math.floor(random() * ids.length)];
        const roll = random();
        if (roll < 0.3 || ids.length < 2) store.dispatch({ type: 'add', objects: [{ id: `n${made++}`, type: 'note', x: random() * 500, y: random() * 500, w: 80, h: 40, text: '' }] });
        else if (roll < 0.6) store.dispatch({ type: 'move', ids: [pick(), pick()], dx: random() * 20, dy: random() * 20 });
        else if (roll < 0.75) store.dispatch({ type: 'recolor', ids: [pick()], color: random() < 0.5 ? 'blue' : null });
        else if (roll < 0.85) store.dispatch({ type: 'delete', ids: [pick()] });
        else if (roll < 0.95) store.dispatch({ type: 'reorder', ids: [pick()], to: random() < 0.5 ? 'front' : 'back' });
        else store.undo();
      }
      if (random() < 0.4) net.flush(true);
    }
    net.flush(true);
    expect(two.getDocument()).toEqual(one.getDocument());
    expect(Object.keys(one.getDocument().objects).length).toBeGreaterThan(5);
  });

  test("a change from the other side is never mine to undo, and after disconnecting nothing more arrives", () => {
    const { net, one, two, stopOne } = pair();
    two.dispatch({ type: 'move', ids: ['a'], dx: 50, dy: 0 });
    net.flush();
    expect(one.canUndo).toBe(true);
    one.undo();
    net.flush();
    expect(one.canUndo).toBe(false);
    expect(two.getDocument().objects.a).toBeUndefined();
    stopOne();
    two.dispatch({ type: 'add', objects: [{ id: 'c', type: 'note', x: 0, y: 0, w: 10, h: 10, text: '' }] });
    net.flush();
    expect(one.getDocument().objects.c).toBeUndefined();
  });

  test('what comes off the wire is decoded: an envelope that does not pass is dropped whole, and what follows it still arrives', () => {
    const { net, one, two } = pair();
    const before = one.getDocument();
    net.inject('not json');
    net.inject({ id: 'x1', events: [{ type: 'object-added', object: { id: 'p', type: 'image', x: 0, y: 0, w: 9, h: 9, src: 'javascript:1', alt: '' } }] });
    net.inject({ events: [] });
    // Passes the decoder, but the field is not one a box can hold: dropped when applied.
    net.inject({ id: 'x3', events: [{ type: 'object-set', id: 'a', set: { w: -5 } }, { type: 'object-set', id: 'a', set: { html: '<script>' } }] });
    expect(one.getDocument()).toBe(before);
    // The backend counted each of those. Every peer counted them too, so the next change is the next in line, not a gap.
    net.inject({ id: 'x4', events: [{ type: 'object-set', id: 'a', set: { text: 'ok' } }] });
    expect(one.getDocument().objects.a).toMatchObject({ text: 'ok' });
    expect(two.getDocument()).toEqual(one.getDocument());
    expect(one.syncedTo).toBe(net.log.length);
  });

  test('a deleted object does not come back when the backend delivers again from the very beginning', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'delete', ids: ['a'] });
    net.flush();
    // More envelopes than any window of remembered ids would hold, then the whole history again.
    for (let i = 0; i < 5200; i++) two.dispatch({ type: 'retitle', title: `t${i}` });
    net.flush();
    const settled = one.getDocument();
    net.replay();
    expect(one.getDocument()).toBe(settled);
    expect(one.getDocument().objects.a).toBeUndefined();
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  test('a delivery that skips ahead is not applied: the host is told once per hole, and nothing later is applied on top of it', () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: ONE });
    const gaps: { have: number; got: number }[] = [];
    connectSync(one, net.port(ONE), { onGap: (gap) => gaps.push(gap) });
    const add = (id: string) => ({ id: `e-${id}`, events: [{ type: 'object-added', object: { id, type: 'note', x: 0, y: 0, w: 10, h: 10, text: '' } }] });
    net.raw({ order: 1, actor: TWO, envelope: add('first') });
    net.raw({ order: 3, actor: TWO, envelope: add('third') });
    net.raw({ order: 4, actor: TWO, envelope: add('fourth') });
    expect(Object.keys(one.getDocument().objects)).toEqual(['first']);
    expect(gaps).toEqual([{ have: 1, got: 3 }]);
    expect(one.syncedTo).toBe(1);
    // The missing one arriving late puts things right, and what follows is taken again.
    net.raw({ order: 2, actor: TWO, envelope: add('second') });
    net.raw({ order: 3, actor: TWO, envelope: add('third') });
    expect(Object.keys(one.getDocument().objects)).toEqual(['first', 'second', 'third']);
    // A second hole is told of too.
    net.raw({ order: 9, actor: TWO, envelope: add('ninth') });
    expect(gaps).toEqual([{ have: 1, got: 3 }, { have: 3, got: 9 }]);
    // No count, or one that is not a whole number from 1, is not a delivery at all.
    for (const order of [undefined, 0, -1, 4.5, '4', Number.MAX_SAFE_INTEGER + 1]) net.raw({ order, actor: TWO, envelope: add('never') });
    expect(one.getDocument().objects.never).toBeUndefined();
  });

  test('a store that connects later catches up from the count that came with its document', () => {
    const { net, one } = pair();
    one.dispatch({ type: 'move', ids: ['a'], dx: 30, dy: 0 });
    net.flush();
    // A copy of the canvas as saved now, with the backend's count for it.
    const saved = parseDocument(JSON.parse(serializeDocument(one.getDocument())));
    if (!saved.ok) throw new Error(saved.error);
    const at = net.log.length;
    one.dispatch({ type: 'recolor', ids: ['a'], color: 'green' });
    net.flush();
    const late = new CanvasStore(saved.value, { actor: { kind: 'person', id: 'late' } });
    connectSync(late, net.port({ kind: 'person', id: 'late' }), { at });
    expect(late.getDocument()).toEqual(one.getDocument());
    // And one that starts from nothing takes the whole history.
    const fresh = new CanvasStore(createDocument('board'), { actor: { kind: 'person', id: 'fresh' } });
    connectSync(fresh, net.port({ kind: 'person', id: 'fresh' }));
    expect(fresh.getDocument()).toEqual(one.getDocument());
  });

  test('who sent a change is what the backend says, whatever the envelope claims', () => {
    const { net, one } = pair();
    const heard: Envelope[] = [];
    one.onCommit((envelope) => heard.push(envelope));
    net.inject({ id: 'liar', actor: ONE, events: [{ type: 'object-set', id: 'a', set: { text: 'Not by one' } }] }, MALLORY);
    expect(heard).toHaveLength(1);
    expect(heard[0].actor).toEqual(MALLORY);
    // A delivery the backend did not sign is not one.
    expect(decodeDelivery({ order: 1, envelope: { id: 'e', actor: ONE, events: [] } }).ok).toBe(false);
    expect(decodeDelivery({ order: 1, actor: { kind: 'root', id: 'x' }, envelope: { id: 'e', events: [] } }).ok).toBe(false);
  });

  test('who added an object cannot be rewritten by a later change, from a peer or from anywhere', () => {
    const { net, one, two } = pair();
    expect(one.getDocument().objects.a.by).toEqual(ONE);
    net.inject({ id: 'f1', events: [{ type: 'object-set', id: 'a', set: { by: { kind: 'person', id: 'mallory' } } }] });
    net.inject({ id: 'f2', events: [{ type: 'object-set', id: 'a', set: {}, unset: ['by'] }] });
    // An honest field in the same envelope does not carry the forged one through.
    net.inject({ id: 'f3', events: [{ type: 'object-set', id: 'a', set: { text: 'kept?', by: { kind: 'agent', id: 'x' } } }] });
    for (const store of [one, two]) expect(store.getDocument().objects.a).toMatchObject({ by: ONE, text: 'A' });
    // The reducer holds it too, for events that never crossed the wire's decoder.
    const direct = applyEvents(one.getDocument(), [{ type: 'object-set', id: 'a', set: { by: { kind: 'agent', id: 'x' }, text: 'B' }, unset: ['by'] }]);
    expect(direct.doc.objects.a).toMatchObject({ by: ONE, text: 'B' });
  });

  test("a peer cannot confirm away a change made here by sending something under that change's id", () => {
    const { net, one, two } = pair();
    const mine = one.dispatch({ type: 'move', ids: ['a'], dx: 70, dy: 0 });
    if (!mine.ok || !mine.envelope) throw new Error('no envelope');
    // Before the backend hands it back, someone else sends an envelope with the same id.
    net.inject({ id: mine.envelope.id, events: [{ type: 'object-set', id: 'a', set: { text: 'hijack' } }] });
    expect(one.getDocument().objects.a).toMatchObject({ x: 70, text: 'hijack' });
    net.flush();
    expect(one.getDocument().objects.a).toMatchObject({ x: 70, text: 'hijack' });
    expect(two.getDocument()).toEqual(one.getDocument());
  });
});
