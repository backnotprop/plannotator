/**
 * The seam for collaboration. No backend is built behind it yet.
 *
 * A backend (a relay, a server) implements `SyncPort`; `connectSync` wires a
 * store to it. What the backend must do is small and stated here, because
 * convergence depends on it:
 *
 * 1. Put every envelope it is given into ONE order, and count them: the
 *    first is 1, the next 2, with no gaps (`order`).
 * 2. Say who sent each one (`actor`) from what it knows of the connection
 *    itself: the session, the token. Never from what the envelope claims.
 * 3. Deliver every envelope, in that order, with its count and its actor,
 *    to every peer: the peer that sent it included.
 *
 * Given that, peers converge (see `CanvasStore.receive`): each applies the
 * same envelopes in the same order to the document they all agree on, and
 * shows its own unconfirmed changes on top. Changes are field-level, so two
 * people changing different fields of one object both keep their change;
 * two changing the same field end on the one the backend ordered last. An
 * event about an object that is gone does nothing.
 *
 * Delivery may be at-least-once, and may start again from any point: a
 * store knows the count it has reached and ignores anything at or below it,
 * so there is no window of remembered ids for a late repeat to fall out of.
 * A count that skips ahead means something was lost on the way; it is not
 * applied and `onGap` is called. The host then asks the backend to deliver
 * again from the count the store has reached, or loads the document again
 * and connects from the count that came with it.
 *
 * What arrives is untrusted: `connectSync` decodes every delivery
 * (`decodeDelivery`). An envelope that does not pass changes nothing, but
 * is still counted, by every peer alike. The actor an envelope
 * names for itself is never read: the backend's is used. Who ADDED an
 * object (`by`) cannot be changed by any later event; on an object a peer
 * adds it is that peer's word (an undo puts back an object someone else
 * made, with their name on it), so it says less than the envelope's actor.
 *
 * Not here: presence (cursors, selections, cameras) is not document state
 * and would travel beside this port.
 */
import type { CanvasStore } from './store';
import type { Envelope } from './types';
import { decodeDelivery } from './wire';

/** One envelope as the backend hands it over. `order` and `actor` are the backend's own; `envelope` is what a peer sent. */
export interface SyncDelivery {
  /** The backend's count of this envelope in its one order, from 1. */
  order: number;
  /** Who sent it, as the backend knows from the connection. */
  actor: unknown;
  /** The envelope as it came off the wire: JSON text or a parsed value. */
  envelope: unknown;
}

export interface SyncPort {
  /** Send a change made here. The backend orders it, counts it and stamps who sent it. */
  publish(envelope: Envelope): void;
  /**
   * Hear every change counted after `after`, this store's own included, in
   * the backend's order, each as a `SyncDelivery` (JSON text or a parsed
   * value). Starting earlier than `after` does no harm. Returns how to stop.
   */
  subscribe(onDelivery: (delivery: unknown) => void, after: number): () => void;
}

export interface SyncOptions {
  /** The backend's count for the document the store holds now. Absent: 0, a canvas nobody has changed. */
  at?: number;
  /**
   * A delivery skipped ahead: the store has applied up to `have` and was
   * handed `got`. Nothing is applied until what is missing arrives (a
   * backend asked to deliver again from `have`) or the host loads the
   * document again (a new store, connected at the count that came with it).
   * Called once per gap, not once per delivery beyond it.
   */
  onGap?: (gap: { have: number; got: number }) => void;
}

/** Connect a store to a backend. Returns how to disconnect. */
export function connectSync(store: CanvasStore, port: SyncPort, options: SyncOptions = {}): () => void {
  store.beginSync(options.at);
  let lost = false;
  const stopOut = store.onCommit((envelope) => {
    if (envelope.origin !== 'remote') port.publish(envelope);
  });
  const stopIn = port.subscribe((raw) => {
    const delivery = decodeDelivery(raw);
    if (!delivery.ok) return;
    const have = store.syncedTo ?? 0;
    if (delivery.value.order > have + 1) {
      if (!lost) options.onGap?.({ have, got: delivery.value.order });
      lost = true;
      return;
    }
    if (delivery.value.order === have + 1) lost = false;
    // What a peer sent did not pass: it is counted, as every peer counts it, and changes nothing.
    const { order, actor, envelope } = delivery.value;
    store.receive(envelope ?? { id: `refused-${order}`, actor, events: [] }, order);
  }, store.syncedTo ?? 0);
  return () => {
    stopOut();
    stopIn();
    store.endSync();
  };
}
