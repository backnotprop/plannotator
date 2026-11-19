import { describe, expect, test } from 'bun:test';
import { createDocument } from '../model/document';
import { parseDocument, serializeDocument } from '../model/codec';
import { applyEvents, setEvent } from './reduce';
import { CanvasStore } from './store';
import { SYNC_HOLD_LIMIT, type SyncGap, type SyncPort, connectSync } from './sync';
import type { Actor } from '../model/types';
import type { Envelope } from './types';
import { decodeCommand, decodeEnvelope } from './wire';

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
   * order under one name (`stream`), counts them from 1, says who sent each
   * from the connection it came in on (never from what the envelope
   * claims), orders an envelope it has already ordered only once, and hands
   * each, as JSON, to every peer, the sender included. `flush` delivers
   * what has been published; until then peers have not heard each other,
   * which is how two people change something "at the same moment".
   */
  function backend() {
    const peers: ((delivery: unknown) => void)[] = [];
    const queue: { actor: unknown; envelope: unknown }[] = [];
    /** Every delivery made so far, in order: what a backend replays from. */
    let log: string[] = [];
    let stream = 'stream-1';
    const ordered = new Set<string>();
    const resends: number[] = [];
    const count = (actor: unknown, envelope: unknown): string | null => {
      const id = (envelope as { id?: unknown } | null)?.id;
      const key = typeof id === 'string' ? `${JSON.stringify(actor)} ${id}` : null;
      if (key && ordered.has(key)) return null;
      if (key) ordered.add(key);
      const json = JSON.stringify({ stream, order: log.length + 1, actor, envelope });
      log.push(json);
      return json;
    };
    const deliver = (actor: unknown, envelope: unknown, twice = false) => {
      const json = count(actor, envelope);
      if (!json) return;
      for (const peer of [...peers]) {
        peer(json);
        if (twice) peer(JSON.parse(json));
      }
    };
    return {
      get log() {
        return log;
      },
      resends,
      port: (actor: unknown, quiet = false): SyncPort => ({
        publish: (envelope) => void queue.push({ actor, envelope: JSON.parse(JSON.stringify(envelope)) }),
        subscribe: (onDelivery, after) => {
          if (!quiet) for (const json of log.slice(after)) onDelivery(json);
          peers.push(onDelivery);
          return () => void peers.splice(peers.indexOf(onDelivery), 1);
        },
        resend: (after) => {
          resends.push(after);
          for (const json of log.slice(after)) onDeliveryOf(peers, json);
        },
      }),
      /** Deliver everything published so far. `twice`: each envelope is handed over two times. */
      flush(twice = false) {
        while (queue.length) {
          const { actor, envelope } = queue.shift()!;
          deliver(actor, envelope, twice);
        }
      },
      /** Order and count what has been published, and hand it to nobody: for a test that delivers by hand. */
      order() {
        while (queue.length) {
          const { actor, envelope } = queue.shift()!;
          count(actor, envelope);
        }
      },
      /** What was published and never reached the backend: a connection that dropped. */
      lose: () => void (queue.length = 0),
      /** Something a peer signed in as `actor` sent: ordered, counted and delivered like anything else. */
      inject: (envelope: unknown, actor: unknown = MALLORY) => deliver(actor, envelope),
      /** Hand every peer the whole history again, from the first envelope. */
      replay: () => log.forEach((json) => [...peers].forEach((peer) => peer(json))),
      /** Hand every peer one delivery of the history again (by its count). */
      again: (order: number) => [...peers].forEach((peer) => peer(log[order - 1])),
      /** Hand a peer something as it is, outside the order (a broken or lying backend). */
      raw: (delivery: unknown) => [...peers].forEach((peer) => peer(delivery)),
      /** The backend lost its count and starts again from 1, as it must: under a new name. */
      restart() {
        log = [];
        ordered.clear();
        stream = 'stream-2';
      },
    };
  }
  const onDeliveryOf = (peers: ((delivery: unknown) => void)[], json: string) => [...peers].forEach((peer) => peer(json));

  const ONE = { kind: 'person', id: 'one' } as const;
  const TWO = { kind: 'person', id: 'two' } as const;
  const MALLORY = { kind: 'person', id: 'mallory' } as const;
  const S = 'stream-1';

  const pair = () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: ONE });
    const two = new CanvasStore(createDocument('board'), { actor: TWO });
    const stopOne = connectSync(one, net.port(ONE)).stop;
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

  test('a deleted object does not come back when the backend delivers its adding again, however long ago that was', () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'delete', ids: ['a'] });
    net.flush();
    // More envelopes than any window of remembered ids would hold.
    for (let i = 0; i < 5200; i++) two.dispatch({ type: 'retitle', title: `t${i}` });
    net.flush();
    const settled = one.getDocument();
    // The very first delivery, the one that added `a`, alone and out of nowhere; then the whole history.
    net.again(1);
    expect(one.getDocument()).toBe(settled);
    expect(one.getDocument().objects.a).toBeUndefined();
    net.replay();
    expect(one.getDocument()).toBe(settled);
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  const adding = (id: string) => ({ id: `e-${id}`, events: [{ type: 'object-added', object: { id, type: 'note', x: 0, y: 0, w: 10, h: 10, text: '' } }] });

  test('deliveries that arrive out of order are held and applied in order; the host is told while the board is not live', () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: ONE });
    const told: string[] = [];
    const link = connectSync(one, net.port(ONE), { onGap: (gap) => told.push(`${gap.reason} ${gap.have}>${gap.got}`), onCaughtUp: () => told.push('live') });
    const at = (order: number, id: string) => ({ stream: S, order, actor: TWO, envelope: adding(id) });
    net.raw(at(1, 'first'));
    expect(link.stalled).toBeNull();
    // 3, 5 and 4 before 2: a replay and live delivery crossing.
    net.raw(at(3, 'third'));
    net.raw(at(5, 'fifth'));
    net.raw(at(4, 'fourth'));
    expect(Object.keys(one.getDocument().objects)).toEqual(['first']);
    expect(link.stalled).toEqual({ reason: 'gap', have: 1, got: 3, asked: true });
    expect(told).toEqual(['gap 1>3']);
    net.raw(at(2, 'second'));
    expect(Object.keys(one.getDocument().objects)).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    expect(one.syncedTo).toBe(5);
    expect(link.stalled).toBeNull();
    expect(told).toEqual(['gap 1>3', 'live']);
    // Two holes: filling the first tells of the second.
    net.raw(at(7, 'seventh'));
    net.raw(at(9, 'ninth'));
    net.raw(at(6, 'sixth'));
    expect(one.syncedTo).toBe(7);
    expect(link.stalled).toEqual({ reason: 'gap', have: 7, got: 9, asked: true });
    expect(told).toEqual(['gap 1>3', 'live', 'gap 5>7', 'gap 7>9']);
    // No count, or one that is not a whole number from 1, is not a delivery at all; nor is one with no stream.
    for (const order of [undefined, 0, -1, 8.5, '8', Number.MAX_SAFE_INTEGER + 1]) net.raw({ stream: S, order, actor: TWO, envelope: adding('never') });
    net.raw({ order: 8, actor: TWO, envelope: adding('never') });
    expect(one.getDocument().objects.never).toBeUndefined();
    expect(one.syncedTo).toBe(7);
  });

  test('what is held while a hole is filled is bounded; what was let go of is asked for again, and the board is not called live until it has come', () => {
    const titled = (order: number) => ({ stream: S, order, actor: TWO, envelope: { id: `e${order}`, events: [{ type: 'title-set', title: `t${order}` }] } });
    const last = SYNC_HOLD_LIMIT * 3;
    for (const canResend of [true, false]) {
      const one = new CanvasStore(createDocument('board'), { actor: ONE });
      const asked: number[] = [];
      const told: string[] = [];
      let hand: (delivery: unknown) => void = () => {};
      const port: SyncPort = {
        publish: () => {},
        subscribe: (onDelivery) => ((hand = onDelivery), () => {}),
        ...(canResend ? { resend: (after: number) => void asked.push(after) } : {}),
      };
      const link = connectSync(one, port, { onGap: (gap) => told.push(`gap ${gap.have}>${gap.got} asked=${gap.asked}`), onCaughtUp: () => told.push('live') });
      // Far more than is held, furthest first, then the one that was missing.
      for (let order = last; order >= 2; order--) hand(titled(order));
      hand(titled(1));
      // Everything next to the hole was kept and applied.
      expect(one.syncedTo).toBe(SYNC_HOLD_LIMIT + 1);
      expect(one.getDocument().title).toBe(`t${SYNC_HOLD_LIMIT + 1}`);
      // The rest was let go of. The store knows it, says so, and asks again from where it now is.
      expect(link.stalled).toEqual({ reason: 'gap', have: SYNC_HOLD_LIMIT + 1, got: last, asked: canResend });
      expect(told).toEqual([`gap 0>${last} asked=${canResend}`, `gap ${SYNC_HOLD_LIMIT + 1}>${last} asked=${canResend}`]);
      expect(asked).toEqual(canResend ? [0, SYNC_HOLD_LIMIT + 1] : []);
      // In order now, as a backend sends again: not live until the last one that was dropped is in.
      for (let order = SYNC_HOLD_LIMIT + 2; order < last; order++) hand(titled(order));
      expect(link.stalled).not.toBeNull();
      expect(told).toHaveLength(2);
      hand(titled(last));
      expect(link.stalled).toBeNull();
      expect(told[2]).toBe('live');
      expect(one.syncedTo).toBe(last);
      expect(asked).toHaveLength(canResend ? 2 : 0);
    }
  });

  test('a store that starts from a count must name the stream the count belongs to', () => {
    const net = backend();
    const store = () => new CanvasStore(createDocument('board'), { actor: ONE });
    expect(() => connectSync(store(), net.port(ONE), { at: 500 } as never)).toThrow(/stream/);
    expect(() => connectSync(store(), net.port(ONE), { at: 500, stream: '' })).toThrow(/stream/);
    expect(() => connectSync(store(), net.port(ONE), { at: 0 })).not.toThrow();
    expect(() => connectSync(store(), net.port(ONE))).not.toThrow();
    // With it, a backend that started again is noticed at its very first delivery, though that count is far below the store's.
    const late = store();
    const link = connectSync(late, net.port(ONE), { at: 500, stream: 'an-older-stream' });
    net.inject({ id: 'n', events: [{ type: 'title-set', title: 'new count' }] }, TWO);
    expect(link.stalled).toMatchObject({ reason: 'restarted', have: 500, got: 1, asked: false });
    expect(late.getDocument().title).toBe('');
    // A store already syncing is connected again without either: it has both.
    const again = store();
    connectSync(again, net.port(ONE), { at: 1, stream: S }).stop();
    expect(() => connectSync(again, net.port(ONE))).not.toThrow();
  });

  test('a delivery lost on the way is asked for again and the board catches up', () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: ONE });
    const told: string[] = [];
    const link = connectSync(one, net.port(ONE), { onGap: (gap) => told.push(`${gap.reason} ${gap.have}>${gap.got}`), onCaughtUp: () => told.push('live') });
    // Someone else's changes, as they reach the backend.
    const sender = net.port(TWO);
    const send = (id: string, set: Record<string, unknown>) => sender.publish({ id, events: [{ type: 'object-set', id: 'a', set }] } as never);
    sender.publish({ id: 'add', events: [{ type: 'object-added', object: { id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' } }] } as never);
    net.flush();
    expect(one.syncedTo).toBe(1);
    // The backend orders two more and they are lost on the way to this store.
    send('move', { x: 10 });
    send('colour', { color: 'green' });
    net.order();
    // The next one arrives, ahead of its count. The store asks once, the backend sends again, and it is whole.
    send('words', { text: 'Later' });
    net.order();
    net.raw(net.log[3]);
    expect(net.resends).toEqual([1]);
    expect(told).toEqual(['gap 1>4', 'live']);
    expect(link.stalled).toBeNull();
    expect(one.getDocument().objects.a).toMatchObject({ x: 10, color: 'green', text: 'Later' });
    expect(one.syncedTo).toBe(4);
  });

  test('a connection made again sends what was not confirmed, once, and loses nothing: sent before the drop, lost on the way, or made while down', () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: ONE });
    const two = new CanvasStore(createDocument('board'), { actor: TWO });
    connectSync(two, net.port(TWO));
    let link = connectSync(one, net.port(ONE));
    one.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    net.flush();
    // Reached the backend, but the connection dropped before it came back.
    one.dispatch({ type: 'move', ids: ['a'], dx: 10, dy: 0 });
    net.order();
    link.stop();
    // Sent into a dead connection: never reached the backend.
    link = connectSync(one, net.port(ONE, true));
    one.dispatch({ type: 'recolor', ids: ['a'], color: 'red' });
    net.lose();
    link.stop();
    // Made while down.
    one.dispatch({ type: 'edit', id: 'a', patch: { text: 'Offline' } });
    two.dispatch({ type: 'edit', id: 'a', patch: { detail: 'Meanwhile' } });
    net.flush();
    expect(one.unconfirmed).toHaveLength(3);
    expect(one.getDocument().objects.a).toMatchObject({ x: 10, color: 'red', text: 'Offline' });
    // Back.
    connectSync(one, net.port(ONE));
    net.flush();
    expect(one.unconfirmed).toHaveLength(0);
    expect(one.getDocument().objects.a).toMatchObject({ x: 10, color: 'red', text: 'Offline', detail: 'Meanwhile' });
    expect(two.getDocument()).toEqual(one.getDocument());
    // The move that had already been ordered was not ordered a second time.
    expect(net.log.filter((json) => json.includes('"dx":10'))).toHaveLength(1);
    // And what the person did is still theirs to undo.
    one.undo();
    net.flush();
    expect(one.getDocument().objects.a).toMatchObject({ text: 'A' });
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  test('a backend whose count starts again is noticed: nothing of the new count is taken for an old repeat or applied', () => {
    const { net, one, two } = pair();
    two.dispatch({ type: 'move', ids: ['a'], dx: 5, dy: 0 });
    net.flush();
    const gaps: SyncGap[] = [];
    const three = new CanvasStore(one.getDocument(), { actor: { kind: 'person', id: 'three' } });
    const link = connectSync(three, net.port({ kind: 'person', id: 'three' }, true), { at: 2, stream: S, onGap: (gap) => gaps.push(gap) });
    const before = three.getDocument();
    net.restart();
    // The new count's 1 and 2 are at or below where the store is; its 3 is the very next number.
    for (const title of ['x', 'y', 'z']) net.inject({ id: `r-${title}`, events: [{ type: 'title-set', title }] }, TWO);
    expect(three.getDocument()).toBe(before);
    expect(gaps).toEqual([{ reason: 'restarted', have: 2, got: 1, asked: false }]);
    expect(link.stalled?.reason).toBe('restarted');
    // The old stream turning up again does not un-stall it: the host loads the canvas again.
    net.raw({ stream: S, order: 3, actor: TWO, envelope: { id: 'late', events: [{ type: 'title-set', title: 'late' }] } });
    expect(three.getDocument()).toBe(before);
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
    connectSync(late, net.port({ kind: 'person', id: 'late' }), { at, stream: S });
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
  });

  test('a stamp the backend got wrong is counted and skipped: it does not stop the board for everyone', () => {
    const { net, one, two } = pair();
    const before = one.getDocument();
    const change = { id: 'c', events: [{ type: 'object-set', id: 'a', set: { text: 'unsigned' } }] };
    // A kind this package does not know, an id too long, no stamp at all.
    net.inject(change, { kind: 'system', id: 'cron' });
    net.inject({ ...change, id: 'c2' }, { kind: 'person', id: 'x'.repeat(129) });
    net.inject({ ...change, id: 'c3' }, null);
    expect(one.getDocument()).toBe(before);
    expect(one.syncedTo).toBe(net.log.length);
    two.dispatch({ type: 'edit', id: 'a', patch: { text: 'still live' } });
    net.flush();
    expect(one.getDocument().objects.a).toMatchObject({ text: 'still live' });
    expect(two.getDocument()).toEqual(one.getDocument());
  });

  test('who added an object cannot be rewritten by a later change, and an honest change that names it is not thrown away with it', () => {
    const { net, one, two } = pair();
    expect(one.getDocument().objects.a.by).toEqual(ONE);
    net.inject({ id: 'f1', events: [{ type: 'object-set', id: 'a', set: { by: { kind: 'person', id: 'mallory' } } }] });
    net.inject({ id: 'f2', events: [{ type: 'object-set', id: 'a', set: {}, unset: ['by'] }] });
    for (const store of [one, two]) expect(store.getDocument().objects.a).toMatchObject({ by: ONE, text: 'A' });
    // The field beside it in the same change is taken; only `by` is dropped.
    net.inject({ id: 'f3', events: [{ type: 'object-set', id: 'a', set: { text: 'kept', by: { kind: 'agent', id: 'x' } } }] });
    for (const store of [one, two]) expect(store.getDocument().objects.a).toMatchObject({ by: ONE, text: 'kept' });
    // The reducer holds it too, for events that never crossed the wire's decoder.
    const direct = applyEvents(one.getDocument(), [{ type: 'object-set', id: 'a', set: { by: { kind: 'agent', id: 'x' }, text: 'B' }, unset: ['by'] }]);
    expect(direct.doc.objects.a).toMatchObject({ by: ONE, text: 'B' });
  });

  test("a host's own object for a person, with more on it than an actor has, does not leave that person out of step", () => {
    const net = backend();
    // As a host would: the session's user, passed straight in.
    const user = { kind: 'person' as const, id: 'ana', name: 'Ana', avatar: 'https://example.test/a.png' };
    const ana = new CanvasStore(createDocument('board'), { actor: user });
    const two = new CanvasStore(createDocument('board'), { actor: TWO });
    connectSync(ana, net.port({ kind: 'person', id: 'ana' }));
    connectSync(two, net.port(TWO));
    expect(ana.actor).toEqual({ kind: 'person', id: 'ana' });
    ana.dispatch({ type: 'add', objects: [{ id: 'n', type: 'note', x: 0, y: 0, w: 100, h: 60, text: 'N' }] });
    ana.dispatch({ type: 'group', id: 'g', ids: ['n', 'n'] });
    net.flush();
    expect(ana.getDocument().objects.n.by).toEqual({ kind: 'person', id: 'ana' });
    // A drag, an edit and a resize: each rebuilds the object, and none of them names `by`.
    const sent: Envelope[] = [];
    ana.onCommit((envelope) => sent.push(envelope));
    ana.dispatch({ type: 'move', ids: ['n'], dx: 25, dy: 5 });
    ana.dispatch({ type: 'edit', id: 'n', patch: { text: 'Dragged' } }, { actor: user });
    ana.dispatch({ type: 'resize', id: 'n', rect: { x: 25, y: 5, w: 120, h: 80 } });
    expect(JSON.stringify(sent)).not.toContain('"by"');
    net.flush();
    expect(two.getDocument().objects.n).toMatchObject({ x: 25, y: 5, w: 120, text: 'Dragged' });
    expect(two.getDocument()).toEqual(ana.getDocument());
    expect(ana.unconfirmed).toHaveLength(0);
    // Peers move it afterwards and she sees it: nothing of hers is still laid over theirs.
    two.dispatch({ type: 'move', ids: ['n'], dx: 100, dy: 0 });
    net.flush();
    expect(ana.getDocument().objects.n).toMatchObject({ x: 125 });
    // Whatever two objects differ in, the change between them never names who added it.
    const note = ana.getDocument().objects.n;
    expect(setEvent({ ...note, by: user } as never, { ...note, x: 500 } as never)).toEqual({ type: 'object-set', id: 'n', set: { x: 500 } });
    expect(setEvent({ ...note, by: user } as never, note)).toBeNull();
    const { by: _by, ...unsigned } = note;
    expect(setEvent(note, unsigned as never)).toBeNull();
    // An actor that is not one is refused when the store is made, not found out later.
    expect(() => new CanvasStore(createDocument('board'), { actor: { kind: 'root', id: 'x' } as never })).toThrow();
  });

  test('a change of its own that never comes back is let go of, not laid over every later change for ever', () => {
    const net = backend();
    // The store was made with another name than the backend stamps on its connection: none of its own
    // changes will ever be known as its own.
    const one = new CanvasStore(createDocument('board'), { actor: { kind: 'person', id: 'local' } });
    const two = new CanvasStore(createDocument('board'), { actor: TWO });
    connectSync(one, net.port(ONE));
    connectSync(two, net.port(TWO));
    one.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    for (let i = 0; i < 1500; i++) one.dispatch({ type: 'move', ids: ['a'], dx: 1, dy: 0 });
    net.flush();
    // What it holds on to is bounded.
    expect(one.unconfirmed.length).toBeLessThanOrEqual(1000);
    expect(two.getDocument().objects.a).toMatchObject({ x: 1500 });
    // One of its own that is confirmed lets go of everything older: here, sent under the right name.
    const lost = new CanvasStore(createDocument('board'), { actor: ONE });
    const net2 = backend();
    connectSync(lost, net2.port(ONE));
    lost.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    net2.flush();
    lost.dispatch({ type: 'move', ids: ['a'], dx: 50, dy: 0 });
    net2.lose();
    lost.dispatch({ type: 'recolor', ids: ['a'], color: 'blue' });
    net2.flush();
    expect(lost.unconfirmed).toHaveLength(0);
    // The move never reached anyone, so it is not what the board says, here or anywhere.
    expect(lost.getDocument().objects.a).toMatchObject({ x: 0, color: 'blue' });
    net2.inject({ id: 'peer-move', events: [{ type: 'object-set', id: 'a', set: { x: 7 } }] }, TWO);
    expect(lost.getDocument().objects.a).toMatchObject({ x: 7 });
  });

  test('a peer cannot add an object signed as someone else; an undo of a delete still puts the name back', () => {
    const { net, one, two } = pair();
    // Signed as the other person, as an agent, and not at all.
    net.inject({ id: 'forge', events: [
      { type: 'object-added', object: { id: 'f1', type: 'note', x: 0, y: 0, w: 100, h: 60, text: 'Approved, ship it', by: ONE } },
      { type: 'object-added', object: { id: 'f2', type: 'note', x: 0, y: 0, w: 100, h: 60, text: 'x', by: { kind: 'agent', id: 'planner' } } },
      { type: 'object-added', object: { id: 'f3', type: 'note', x: 0, y: 0, w: 100, h: 60, text: 'x' } },
    ] });
    for (const store of [one, two]) for (const id of ['f1', 'f2', 'f3']) expect(store.getDocument().objects[id].by).toEqual(MALLORY);
    // Deleting someone's object and adding it again under another name, in one envelope or in two: it keeps the name it had.
    net.inject({ id: 'swap', events: [{ type: 'object-removed', id: 'a' }, { type: 'object-added', object: { id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A', by: MALLORY } }] });
    for (const store of [one, two]) expect(store.getDocument().objects.a.by).toEqual(ONE);
    // An honest undo: two deletes what one made, then takes it back. It is still one's.
    two.dispatch({ type: 'delete', ids: ['a'] });
    net.flush();
    expect(one.getDocument().objects.a).toBeUndefined();
    two.undo();
    net.flush();
    for (const store of [one, two]) expect(store.getDocument().objects.a).toMatchObject({ by: ONE, text: 'A' });
    expect(two.getDocument()).toEqual(one.getDocument());
    expect(reloads(one)).toBe(true);
  });

  test("an agent's change sent over a person's connection is that person's to every peer, and to the sender once confirmed", () => {
    const { net, one, two } = pair();
    one.dispatch({ type: 'add', objects: [{ id: 'by-agent', type: 'note', x: 0, y: 0, w: 100, h: 60, text: 'x' }] }, { actor: { kind: 'agent', id: 'planner' } });
    expect(one.getDocument().objects['by-agent'].by).toEqual({ kind: 'agent', id: 'planner' });
    net.flush();
    expect(two.getDocument().objects['by-agent'].by).toEqual(ONE);
    expect(one.getDocument()).toEqual(two.getDocument());
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
