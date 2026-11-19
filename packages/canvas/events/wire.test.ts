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
  /** A backend that delivers every envelope to every other peer, twice, to prove repeats are harmless. */
  function loopback(): () => SyncPort {
    const peers: ((envelope: Envelope) => void)[] = [];
    return () => {
      let mine: ((envelope: Envelope) => void) | null = null;
      return {
        publish: (envelope) => {
          for (const peer of peers) {
            if (peer === mine) continue;
            peer(JSON.parse(JSON.stringify(envelope)));
            peer(JSON.parse(JSON.stringify(envelope)));
          }
        },
        subscribe: (onRemote) => {
          mine = onRemote;
          peers.push(onRemote);
          return () => peers.splice(peers.indexOf(onRemote), 1);
        },
      };
    };
  }

  test('two stores joined through a port end up with the same document, undo included', () => {
    const port = loopback();
    const one = new CanvasStore(createDocument('board'), { actor: { kind: 'person', id: 'one' } });
    const two = new CanvasStore(createDocument('board'), { actor: { kind: 'person', id: 'two' } });
    const stopOne = connectSync(one, port());
    connectSync(two, port());

    one.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }] });
    two.dispatch({ type: 'move', ids: ['a'], dx: 50, dy: 0 });
    two.dispatch({ type: 'add', objects: [{ id: 'b', type: 'note', x: 0, y: 100, w: 100, h: 40, text: 'B' }] });
    one.dispatch({ type: 'recolor', ids: ['b'], color: 'green' });
    two.undo();
    expect(two.getDocument().objects.b).toBeUndefined();
    expect(one.getDocument()).toEqual(two.getDocument());
    // A change from the other side never becomes mine to undo.
    expect(one.canUndo).toBe(true);
    one.undo();
    one.undo();
    expect(one.canUndo).toBe(false);
    expect(one.getDocument().objects.a).toBeUndefined();

    stopOne();
    two.dispatch({ type: 'add', objects: [{ id: 'c', type: 'note', x: 0, y: 0, w: 10, h: 10, text: '' }] });
    expect(one.getDocument().objects.c).toBeUndefined();
  });
});
