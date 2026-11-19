import { describe, expect, test } from 'bun:test';
import { createDocument } from '../model/document';
import { CanvasStore } from './store';
import { type SyncPort, connectSync } from './sync';
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
          { id: 'pic', type: 'image', x: 0, y: 0, w: 200, h: 100, src: 'data:image/png;base64,AAAA', alt: 'A chart' },
          { id: 'spin', type: 'sprite', x: 0, y: 120, w: 24, h: 24, src: 'sprites/spin.png', alt: 'Working', frames: 8, fps: 12 },
          { id: 'table', type: 'html', x: 0, y: 160, w: 300, h: 80, html: '<table><tr><td>1</td></tr></table>' },
        ],
      }),
    );
    expect(added.ok).toBe(true);
    expect(agentSends(store, '{"type":"recolor","ids":["pic","spin","table"],"color":"#ff8800"}').ok).toBe(true);
    expect(agentSends(store, '{"type":"move","ids":["pic"],"dx":40,"dy":0}').ok).toBe(true);
    const doc = store.getDocument();
    expect(doc.objects.pic).toMatchObject({ x: 40, by: 'agent', color: { custom: '#ff8800' } });
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
   * A backend as the seam asks for one: it puts every envelope in one order
   * and hands each, as JSON, to every peer, the sender included. `flush`
   * delivers what has been published; until then peers have not heard each
   * other, which is how two people change something "at the same moment".
   */
  function backend() {
    const peers: ((envelope: unknown) => void)[] = [];
    const queue: string[] = [];
    return {
      port: (): SyncPort => ({
        publish: (envelope) => void queue.push(JSON.stringify(envelope)),
        subscribe: (onEnvelope) => {
          peers.push(onEnvelope);
          return () => void peers.splice(peers.indexOf(onEnvelope), 1);
        },
      }),
      /** Deliver everything published so far. `twice`: each envelope is handed over two times. */
      flush(twice = false) {
        while (queue.length) {
          const json = queue.shift()!;
          for (const peer of [...peers]) {
            peer(json);
            if (twice) peer(JSON.parse(json));
          }
        }
      },
      inject: (raw: unknown) => peers.forEach((peer) => peer(raw)),
    };
  }

  const pair = () => {
    const net = backend();
    const one = new CanvasStore(createDocument('board'), { actor: { kind: 'person', id: 'one' } });
    const two = new CanvasStore(createDocument('board'), { actor: { kind: 'person', id: 'two' } });
    const stopOne = connectSync(one, net.port());
    connectSync(two, net.port());
    one.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    net.flush();
    return { net, one, two, stopOne };
  };

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

  test('what comes off the wire is decoded: an envelope that does not pass is dropped whole', () => {
    const { net, one } = pair();
    const before = one.getDocument();
    net.inject('not json');
    net.inject({ id: 'x1', actor: { kind: 'agent', id: 'z' }, events: [{ type: 'object-added', object: { id: 'p', type: 'image', x: 0, y: 0, w: 9, h: 9, src: 'javascript:1', alt: '' } }] });
    net.inject({ id: 'x2', actor: { kind: 'root', id: 'z' }, events: [] });
    // Passes the decoder, but the field is not one a box can hold: dropped when applied.
    net.inject({ id: 'x3', actor: { kind: 'agent', id: 'z' }, events: [{ type: 'object-set', id: 'a', set: { w: -5 } }, { type: 'object-set', id: 'a', set: { html: '<script>' } }] });
    expect(one.getDocument()).toBe(before);
    net.inject({ id: 'x4', actor: { kind: 'agent', id: 'z' }, events: [{ type: 'object-set', id: 'a', set: { text: 'ok' } }] });
    expect(one.getDocument().objects.a).toMatchObject({ text: 'ok' });
  });
});
