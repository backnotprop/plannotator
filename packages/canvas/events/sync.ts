/**
 * The seam for collaboration. No backend is built behind it yet.
 *
 * A backend (a relay, a server) implements `SyncPort`; `connectSync` wires a
 * store to it. What the backend must do is stated here, because convergence
 * depends on every line of it and nothing in this package can check it:
 *
 * 1. Put every envelope it is given for one canvas into ONE order, and count
 *    them: the first is 1, the next 2, with no gaps (`order`). The count
 *    belongs to the canvas, is kept as long as the canvas is, and never
 *    starts again. It has a name (`stream`); a backend that has lost its
 *    count and must start again does so under a NEW name, so that every
 *    store hears of it instead of taking the new 1, 2, 3 for old repeats.
 * 2. Say who sent each one (`actor`) from what it knows of the connection
 *    itself: the session, the token. Never from what the envelope claims.
 *    The stamp is `{ kind: 'person' | 'agent', id }` with an id of 1 to 128
 *    characters, and it is the very actor the store on that connection was
 *    made with: a store knows its own changes coming back by that. An agent
 *    that should be signed as itself has a connection of its own.
 * 3. Keep the envelopes of one connection in the order they were sent.
 * 4. Order an envelope once: the same id from the same actor, sent again
 *    after a reconnect, is the same envelope and is not counted twice.
 * 5. Deliver every envelope, in order, with its stream, count and actor, to
 *    every peer: the peer that sent it included.
 *
 * Given that, peers converge (see `CanvasStore.receive`): each applies the
 * same envelopes in the same order to the document they all agree on, and
 * shows its own unconfirmed changes on top. Changes are field-level, so two
 * people changing different fields of one object both keep their change;
 * two changing the same field end on the one the backend ordered last. An
 * event about an object that is gone does nothing.
 *
 * Delivery may be at-least-once, out of order, and may start again from any
 * point. A store knows the count it has reached and ignores anything at or
 * below it, so there is no window of remembered ids for a late repeat to
 * fall out of. A delivery that is ahead is held (a bounded few) until what
 * is missing arrives; meanwhile the connection is `stalled`, the backend is
 * asked once to send again (`resend`), and the host is told (`onGap`) so it
 * can say the board is not live. A delivery from another stream stalls the
 * connection for good: the host loads the canvas again.
 *
 * A connection that drops is made again with `connectSync` on the same
 * store. The store has kept the document all peers agree on, the count it
 * reached and its own changes not yet confirmed; those are sent again
 * (rule 4 is what makes that safe) and delivery resumes after the count.
 *
 * What arrives is untrusted: `connectSync` decodes every delivery
 * (`decodeDelivery`). A delivery whose envelope does not pass, or whose
 * stamp is not an actor, changes nothing but is still counted, by every
 * peer alike. The actor an envelope names for itself is never read. Who
 * ADDED an object (`by`) is the backend's stamp too (see `CanvasStore`),
 * and no later event can change it.
 *
 * Not here: presence (cursors, selections, cameras) is not document state
 * and would travel beside this port.
 */
import type { CanvasStore } from './store';
import type { Envelope } from './types';
import { decodeDelivery } from './wire';

/** One envelope as the backend hands it over. `stream`, `order` and `actor` are the backend's own; `envelope` is what a peer sent. */
export interface SyncDelivery {
  /** The name of the backend's count for this canvas. It changes only when the count has had to start again. */
  stream: string;
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
  /**
   * Deliver again everything counted after `after`: called once when a
   * delivery arrives ahead of the count. A backend without it is relied on
   * to deliver what is missing by itself.
   */
  resend?(after: number): void;
}

/** Why a connection is not applying what it is handed. */
export interface SyncGap {
  /**
   * `gap`: a delivery arrived ahead of the count; what lies between is
   * awaited. `restarted`: a delivery came from another stream than the one
   * the store follows; nothing of it can be applied to this store.
   */
  reason: 'gap' | 'restarted';
  /** The count the store has reached. */
  have: number;
  /** The count of the delivery that could not be applied. */
  got: number;
}

export interface SyncOptions {
  /** For a store that has not synced before: the backend's count for the document it holds. Absent: 0, a canvas nobody has changed. */
  at?: number;
  /** For a store that has not synced before: the stream that count belongs to, when the host knows it. */
  stream?: string;
  /** The connection stalled. Called once per hole, not once per delivery beyond it. */
  onGap?: (gap: SyncGap) => void;
  /** What was missing arrived and everything held has been applied. */
  onCaughtUp?: () => void;
}

export interface SyncConnection {
  /** Not null while deliveries are arriving that cannot be applied: the board on screen is not live. */
  readonly stalled: SyncGap | null;
  /**
   * Disconnect. The store stays ready to be connected again (`connectSync`
   * with the same store), with its unconfirmed changes kept. Call
   * `store.endSync()` as well to stop syncing for good.
   */
  stop(): void;
}

/** How many deliveries ahead of a hole are held while it is filled. Past this the furthest are let go and asked for again later. */
export const SYNC_HOLD_LIMIT = 256;

/** Connect a store to a backend, or connect it again after a drop. */
export function connectSync(store: CanvasStore, port: SyncPort, options: SyncOptions = {}): SyncConnection {
  store.beginSync(options.at, options.stream);
  let stalled: SyncGap | null = null;
  type Decoded = Extract<ReturnType<typeof decodeDelivery>, { ok: true }>['value'];
  const held = new Map<number, Decoded>();

  const stall = (gap: SyncGap) => {
    // One hole is told of once, as it was first met: later deliveries beyond it add nothing to say.
    const fresh = !stalled || stalled.reason !== gap.reason;
    if (fresh) {
      stalled = gap;
      options.onGap?.(gap);
    }
    return fresh;
  };

  const take = (raw: unknown) => {
    const decoded = decodeDelivery(raw);
    if (!decoded.ok) return;
    const delivery = decoded.value;
    const have = store.syncedTo ?? 0;
    const following = store.syncStream;
    if (following !== null && delivery.stream !== following) {
      // The backend's count started again under another name: nothing of it lines up with this store.
      held.clear();
      stall({ reason: 'restarted', have, got: delivery.order });
      return;
    }
    if (stalled?.reason === 'restarted' || delivery.order <= have) return;
    if (delivery.order > have + 1) {
      // Ahead of the count: keep it for when the hole is filled, the nearest first when there is no more room.
      if (!held.has(delivery.order)) {
        if (held.size >= SYNC_HOLD_LIMIT) {
          const furthest = Math.max(...held.keys());
          if (delivery.order > furthest) return;
          held.delete(furthest);
        }
        held.set(delivery.order, delivery);
      }
      if (stall({ reason: 'gap', have, got: delivery.order })) port.resend?.(have);
      return;
    }
    // What a peer sent did not pass: it is counted, as every peer counts it, and changes nothing.
    store.receive(delivery.envelope, delivery.order, delivery.stream);
    let drained = false;
    for (let next = delivery.order + 1; held.has(next) && store.syncedTo === next - 1; next++) {
      const waiting = held.get(next)!;
      held.delete(next);
      store.receive(waiting.envelope, waiting.order, waiting.stream);
      drained = true;
    }
    if (!stalled) return;
    if (held.size === 0) {
      stalled = null;
      options.onCaughtUp?.();
      return;
    }
    // That hole is filled and there is another further on: it is told of, and asked for, in its turn.
    const reached = store.syncedTo ?? 0;
    if (drained) {
      stalled = { reason: 'gap', have: reached, got: Math.min(...held.keys()) };
      options.onGap?.(stalled);
      port.resend?.(reached);
    }
  };

  const stopOut = store.onCommit((envelope) => {
    if (envelope.origin !== 'remote') port.publish(envelope);
  });
  // Changes made here that the backend has not handed back (made while the connection was down, or sent
  // just before it dropped) go again, oldest first. The backend orders an envelope it already has once.
  for (const envelope of [...store.unconfirmed]) port.publish(envelope);
  const stopIn = port.subscribe(take, store.syncedTo ?? 0);
  return {
    get stalled() {
      return stalled;
    },
    stop() {
      stopOut();
      stopIn();
    },
  };
}
