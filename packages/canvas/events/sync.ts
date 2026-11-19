/**
 * The seam for collaboration. No backend is built behind it yet.
 *
 * A backend (a relay, a server) implements `SyncPort`; `connectSync` wires a
 * store to it. What the backend must do is small and stated here, because
 * convergence depends on it:
 *
 * 1. Put every envelope it is given into ONE order.
 * 2. Deliver every envelope, in that order, to every peer: the peer that
 *    sent it included.
 *
 * Given that, peers converge (see `CanvasStore.receive`): each applies the
 * same envelopes in the same order to the document they all agree on, and
 * shows its own unconfirmed changes on top. Changes are field-level, so two
 * people changing different fields of one object both keep their change;
 * two changing the same field end on the one the backend ordered last. An
 * event about an object that is gone does nothing, and a repeated envelope
 * is ignored, so delivery may be at-least-once.
 *
 * What arrives is untrusted: `connectSync` decodes every envelope
 * (`decodeEnvelope`) and drops what does not pass.
 *
 * Not here: presence (cursors, selections, cameras) is not document state
 * and would travel beside this port. Drawing order is still a list with
 * positions; it converges under the one order above, and a per-object order
 * key would let two reorders made at once both hold, which positions cannot.
 */
import type { CanvasStore } from './store';
import type { Envelope } from './types';
import { decodeEnvelope } from './wire';

export interface SyncPort {
  /** Send a change made here. */
  publish(envelope: Envelope): void;
  /**
   * Hear every change, this store's own included, in the backend's order,
   * as it came off the wire (JSON text or a parsed value). Returns how to stop.
   */
  subscribe(onEnvelope: (envelope: unknown) => void): () => void;
}

/** Connect a store to a backend. Returns how to disconnect. */
export function connectSync(store: CanvasStore, port: SyncPort): () => void {
  store.beginSync();
  const stopOut = store.onCommit((envelope) => {
    if (envelope.origin !== 'remote') port.publish(envelope);
  });
  const stopIn = port.subscribe((raw) => {
    const envelope = decodeEnvelope(raw);
    if (envelope.ok) store.receive(envelope.value);
  });
  return () => {
    stopOut();
    stopIn();
    store.endSync();
  };
}
