/**
 * The seam for collaboration. Nothing is built behind it yet.
 *
 * A backend (a relay, a CRDT, a server that orders changes) implements
 * `SyncPort`; `connectSync` wires a store to it. The store already does what
 * a backend needs from it: every change is an envelope with an id unique
 * across peers, events apply without planning again, an event about an
 * object that is gone does nothing, and a repeated envelope is ignored.
 *
 * What a backend must bring: one order of envelopes that all peers see.
 * Events replace whole objects, so two peers changing one object at once is
 * last-writer-wins by that order. Presence (cursors, selections, cameras) is
 * not document state and would travel beside this port, not through it.
 */
import type { CanvasStore } from './store';
import type { Envelope } from './types';

export interface SyncPort {
  /** Send a change made here. */
  publish(envelope: Envelope): void;
  /** Hear changes made elsewhere. Returns how to stop. */
  subscribe(onRemote: (envelope: Envelope) => void): () => void;
}

/** Connect a store to a backend. Returns how to disconnect. */
export function connectSync(store: CanvasStore, port: SyncPort): () => void {
  const stopOut = store.onCommit((envelope) => {
    if (envelope.origin !== 'remote') port.publish(envelope);
  });
  const stopIn = port.subscribe((envelope) => {
    store.receive(envelope);
  });
  return () => {
    stopOut();
    stopIn();
  };
}
