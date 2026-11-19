/**
 * The one place a canvas document changes.
 *
 *   command ──plan──▶ events ──reduce──▶ document
 *                        │
 *                        └──▶ envelope ──▶ listeners (renderer, index, agent, sync)
 *
 * Undo and redo fall out of that: every commit keeps the events that reverse
 * it, and undoing is committing those. An undo is therefore an ordinary
 * envelope: a peer and an agent see it like any other change. Because a
 * change names only the fields it touched, so does its reversal: undoing a
 * move does not take back what someone else did to the same object since.
 *
 * Only the local person's own commands are undoable here. An agent's change
 * and a peer's change go through the same store but never onto this stack,
 * so "undo" never takes back something the person did not do.
 *
 * With a sync backend (`beginSync`), the store keeps two documents: the one
 * every peer agrees on (changes in the backend's order) and the one on
 * screen (that, plus this store's own changes still on their way out). See
 * `receive`.
 */
import { withIdMaps } from '../model/document';
import { createId } from '../model/ids';
import type { Actor, CanvasDocument } from '../model/types';
import { planCommand } from './plan';
import { applyEvents, compactSets } from './reduce';
import type { CanvasEvent, Command, Envelope, EnvelopeOrigin } from './types';
import { decodeActor } from './wire';

export type DispatchResult = { ok: true; envelope: Envelope | null } | { ok: false; error: string };

export interface DispatchOptions {
  /** Who is asking. Defaults to the store's local person. */
  actor?: Actor;
  /**
   * Commands sharing a gesture id fold into one undo step and one entry in
   * the log: a drag is many `move` commands, one undo and one line of the
   * hand-over.
   */
  gesture?: string;
  /**
   * Fold this change into the undo step of `gesture` wherever that step now
   * is, and leave redo alone. For something that finishes an earlier action
   * of the person's by itself, later (a link's preview arriving): it must
   * not become a step of its own, and must not wipe a redo they still have.
   * When that step is gone, the change is made with no history at all.
   */
  amend?: boolean;
}

interface UndoEntry {
  undo: CanvasEvent[];
  redo: CanvasEvent[];
  gesture?: string;
}

/** A place in one store's history. See `CanvasStore.cursor`. */
export interface Cursor {
  epoch: string;
  seq: number;
}

export type Since =
  | { kind: 'events'; envelopes: Envelope[]; cursor: Cursor }
  | { kind: 'resync'; document: CanvasDocument; cursor: Cursor };

export interface CanvasStoreOptions {
  /** The person at this screen. */
  actor?: Actor;
  /** How many undo steps to keep. */
  undoLimit?: number;
  /** How many envelopes `since` can look back over. */
  logLimit?: number;
}

/** What `receive` takes: a change made elsewhere, already decoded (`decodeEnvelope`, `decodeDelivery`). */
export type RemoteEnvelope = Pick<Envelope, 'id' | 'actor' | 'events'> & Partial<Pick<Envelope, 'command' | 'gesture'>>;

const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && a.id === b.id;

/**
 * How many envelope ids a store that is NOT syncing remembers to spot a
 * repeat. A syncing store does not use it: there a repeat is told by the
 * backend's own count (`receive`), which has no window to fall out of.
 */
const SEEN_LIMIT = 5000;

/**
 * How many of its own unconfirmed changes a syncing store keeps. Past this the oldest are let go: the
 * screen falls back to what all peers agree on for them, and should one still come back from the backend
 * it is applied like anyone's. Letting go is always safe; holding on for ever to a change the backend will
 * never hand back (lost on the way, or stamped with another name) is what parts a store from its peers.
 */
const PENDING_LIMIT = 1000;

/** How many removed objects a syncing store remembers the author of, so that putting one back keeps the name. */
const REMOVED_LIMIT = 5000;

/** A backend's count of an envelope: a whole number from 1. */
const isOrder = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Two commits of one gesture as one: the same effect, the newest's number. */
function foldEnvelope(into: Envelope, next: Envelope): Envelope {
  let command = next.command ?? into.command;
  const a = into.command;
  const b = next.command;
  if (a?.type === 'move' && b?.type === 'move') command = { type: 'move', ids: b.ids, dx: a.dx + b.dx, dy: a.dy + b.dy };
  return { ...next, events: compactSets([...into.events, ...next.events]), ...(command ? { command } : {}) };
}

export class CanvasStore {
  readonly actor: Actor;
  /** Names this store's history. A new store, even of the same document, has a new one. */
  readonly epoch: string = createId('epoch');
  private doc: CanvasDocument;
  private seq = 0;
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private readonly log: Envelope[] = [];
  /** The seq before the oldest thing the log still tells of. */
  private logFloor = 0;
  private readonly seen = new Set<string>();
  private readonly stateListeners = new Set<() => void>();
  private readonly commitListeners = new Set<(envelope: Envelope, doc: CanvasDocument, before: CanvasDocument) => void>();
  private readonly undoLimit: number;
  private readonly logLimit: number;
  /** While syncing: the document all peers agree on. Null: not syncing. */
  private agreed: CanvasDocument | null = null;
  /** While syncing: this store's own commits the backend has not yet handed back, oldest first. */
  private readonly pending: Envelope[] = [];
  /** While syncing: the backend's count of the last envelope applied to `agreed`. */
  private agreedAt = 0;
  /** While syncing: the name of the backend's count (`SyncDelivery.stream`), once known. */
  private stream: string | null = null;
  /** While syncing: who had added each object the agreed document has seen removed. */
  private readonly removedBy = new Map<string, Actor | undefined>();

  constructor(doc: CanvasDocument, options: CanvasStoreOptions = {}) {
    this.doc = withIdMaps(doc);
    // Exactly an actor: a kind and an id. A host's own object for a person may carry more (a name, a
    // picture); none of it belongs in a document or on the wire, where it would not compare equal.
    const actor = decodeActor(options.actor ?? { kind: 'person', id: 'local' });
    if (!actor) throw new Error('CanvasStore: actor must be { kind: "person" or "agent", id } with an id of 1 to 128 characters');
    this.actor = actor;
    this.undoLimit = options.undoLimit ?? 500;
    this.logLimit = options.logLimit ?? 2000;
  }

  getDocument = (): CanvasDocument => this.doc;

  /** Called after every change to the document or to what undo and redo can do. */
  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  /** The event stream: one call per commit, with the document before and after. */
  onCommit(listener: (envelope: Envelope, doc: CanvasDocument, before: CanvasDocument) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Where this store is now. Keep it, and hand it back to `since` later to
   * hear what happened in between. It names the store as well as the place:
   * commit numbers start again with every store (a reload, another tab), so
   * a number alone would mean something else to the next one.
   */
  cursor(): Cursor {
    return { epoch: this.epoch, seq: this.seq };
  }

  /**
   * What happened after `cursor`: what a hand-over tells the agent.
   * - `events`: every change since, oldest first (none when nothing
   *   changed). A gesture is one envelope, however many commits it took.
   * - `resync`: the cursor is from another store, is ahead of this one, is
   *   older than the log reaches, falls inside a gesture that has since
   *   been folded, or was never given. The answer is then the whole
   *   document and a fresh cursor, never "nothing changed".
   */
  since(cursor: Cursor | null | undefined): Since {
    const known = !!cursor && cursor.epoch === this.epoch && Number.isInteger(cursor.seq) && cursor.seq >= this.logFloor && cursor.seq <= this.seq;
    if (!known) return { kind: 'resync', document: this.doc, cursor: this.cursor() };
    const envelopes = this.log.filter((envelope) => envelope.seq > cursor.seq);
    // A cursor taken in the middle of a gesture: the log holds the gesture whole, which would tell its first part twice.
    const first = envelopes[0];
    const whole = !first || first.seq === cursor.seq + 1 || this.firstSeq.get(first) === cursor.seq + 1;
    if (!whole) return { kind: 'resync', document: this.doc, cursor: this.cursor() };
    return { kind: 'events', envelopes, cursor: this.cursor() };
  }

  /** The seq of the first commit folded into a log entry. */
  private readonly firstSeq = new WeakMap<Envelope, number>();

  dispatch(command: Command, options: DispatchOptions = {}): DispatchResult {
    const actor = options.actor ? decodeActor(options.actor) : this.actor;
    if (!actor) return { ok: false, error: 'actor must be { kind: "person" or "agent", id }' };
    const planned = planCommand(this.doc, command, actor);
    if (!planned.ok) return planned;
    if (planned.value.length === 0) return { ok: true, envelope: null };
    const result = applyEvents(this.doc, planned.value);
    if (result.applied.length === 0) return { ok: true, envelope: null };
    if (options.amend) this.amend(result.inverse, result.applied, options.gesture);
    else if (sameActor(actor, this.actor)) this.remember(result.inverse, result.applied, options.gesture);
    return { ok: true, envelope: this.commit(result.doc, actor, 'local', result.applied, command, options.gesture) };
  }

  /**
   * Take back the newest step when it is this gesture's, and forget it: no
   * redo. For an action the person abandoned (an object placed and left
   * empty), which should leave no trace in history.
   */
  revert(gesture: string): Envelope | null {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry || entry.gesture !== gesture) return null;
    this.undoStack.pop();
    const result = applyEvents(this.doc, entry.undo, { check: true });
    if (result.applied.length === 0) {
      this.notify();
      return null;
    }
    return this.commit(result.doc, this.actor, 'undo', result.applied);
  }

  undo(): Envelope | null {
    return this.step(this.undoStack, this.redoStack, 'undo');
  }

  redo(): Envelope | null {
    return this.step(this.redoStack, this.undoStack, 'redo');
  }

  /**
   * Start keeping in step with a backend (`connectSync` calls this). From
   * here on `receive` expects every envelope in the backend's one order,
   * this store's own included, each with the backend's count of it. `at` is
   * that count for the document this store holds now: 0 for a canvas nobody
   * has changed yet, otherwise the number the backend gave with the
   * document; `stream` is the name of that count, when the host knows it.
   *
   * A store that is already syncing (a connection dropped and is being made
   * again) is left exactly as it is: the document all peers agree on, the
   * count reached, and its own changes still waiting to be confirmed
   * (`unconfirmed`) all carry over, and `at` is not read. Starting again
   * from what is on screen would take changes no peer has for agreed.
   */
  beginSync(at = 0, stream?: string): void {
    if (this.agreed) return;
    this.agreed = this.doc;
    this.agreedAt = isOrder(at) ? at : 0;
    this.stream = stream ?? null;
    this.pending.length = 0;
    this.removedBy.clear();
  }

  /** Stop syncing for good: the document on screen is kept, and what was waiting to be confirmed is forgotten. */
  endSync(): void {
    this.agreed = null;
    this.agreedAt = 0;
    this.stream = null;
    this.pending.length = 0;
    this.removedBy.clear();
  }

  /**
   * While syncing: the backend's count of the last envelope this store has
   * applied, so the next one it can take is this plus one. Null when not
   * syncing.
   */
  get syncedTo(): number | null {
    return this.agreed ? this.agreedAt : null;
  }

  /** While syncing: the name of the backend's count this store is following, once it has heard it. */
  get syncStream(): string | null {
    return this.stream;
  }

  /** While syncing: this store's own changes the backend has not handed back yet, oldest first. Sent again when a connection is made again. */
  get unconfirmed(): readonly Envelope[] {
    return this.pending;
  }

  /**
   * A change made elsewhere. Its events are applied as they are, never
   * planned again, each object checked, and never join the undo stack.
   *
   * `order` is the backend's count of this envelope in its one order (1, 2,
   * 3, with no gaps). While syncing it is required, and it is how a repeat
   * is told: an envelope at or below the count already reached has been
   * applied and is ignored, however long ago that was, so a backend may
   * deliver again from any point. One that skips ahead is not applied
   * either (what lies between is missing, and applying out of order would
   * part this store from its peers): `connectSync` holds it until the hole
   * is filled. `null` for the envelope is a delivery that is counted and
   * changes nothing (what a peer sent did not pass). `stream` names the
   * backend's count; a delivery from another stream than the one this store
   * follows is not applied. A store that is not syncing takes envelopes as
   * they come and spots a repeat by its id, among the last few thousand.
   *
   * While syncing, peers converge like this. The backend puts every
   * envelope in one order and hands all of them to every peer, the sender
   * included. Each store applies them, in that order, to the document all
   * peers agree on; every store therefore builds the same one. What is on
   * screen is that document with this store's own unconfirmed changes
   * applied again on top (they are field-level and tolerant, so they still
   * mean what the person meant). When a store's own envelope comes back, it
   * is simply confirmed. Two people who set one field at the same moment
   * both end on the value the backend ordered last.
   */
  receive(envelope: RemoteEnvelope | null, order?: number, stream?: string): Envelope | null {
    if (this.agreed) {
      if (!isOrder(order) || order !== this.agreedAt + 1) return null;
      if (stream !== undefined && this.stream !== null && stream !== this.stream) return null;
      if (stream !== undefined) this.stream = stream;
      return this.receiveOrdered(envelope ?? { id: `refused-${order}`, actor: { kind: 'agent', id: 'nobody' }, events: [] }, order);
    }
    if (!envelope || this.seen.has(envelope.id)) return null;
    const result = applyEvents(this.doc, envelope.events, { check: true });
    this.remembered(envelope.id);
    if (result.applied.length === 0) return null;
    return this.commit(result.doc, envelope.actor, 'remote', result.applied, envelope.command, envelope.gesture, envelope.id);
  }

  private receiveOrdered(envelope: RemoteEnvelope, order: number): Envelope | null {
    // One of this store's own, come back: the same id, from the same actor. The actor is the backend's word
    // (`connectSync`), so a peer cannot confirm away a change made here by sending something under its id.
    const mine = sameActor(envelope.actor, this.actor) ? this.pending.findIndex((own) => own.id === envelope.id) : -1;
    const before = this.agreed!;
    const events = this.signed(envelope, before);
    const agreedNow = applyEvents(before, events, { check: true });
    this.agreed = agreedNow.doc;
    this.agreedAt = order;
    // Own changes older than the one that has just come back never will: the backend keeps one connection's
    // changes in the order they were sent. They are let go of, and so are the oldest past the limit, so a
    // change that was lost or refused on the way is not laid over every later change for ever.
    // An own change the backend signed otherwise than this store did (an agent's, sent over a person's
    // connection, is that person's to every peer) is shown as all peers have it, not as it was sent.
    let letGo = mine > 0 || (mine !== -1 && events.some((event, i) => event !== envelope.events[i]));
    if (mine !== -1) this.pending.splice(0, mine + 1);
    if (this.pending.length > PENDING_LIMIT) {
      this.pending.splice(0, this.pending.length - PENDING_LIMIT);
      letGo = true;
    }
    if (!letGo) {
      // The common cases need no second look: an own envelope confirmed in turn, or a peer's with nothing of ours waiting.
      if (mine === 0) return null;
      if (this.pending.length === 0) {
        if (agreedNow.applied.length === 0) return null;
        return this.commit(this.agreed, envelope.actor, 'remote', agreedNow.applied, envelope.command, envelope.gesture, envelope.id);
      }
      // Nothing all peers agree on changed (a repeat of what is already so, or an envelope that was refused): neither did the screen.
      if (agreedNow.applied.length === 0) return null;
    }
    let doc = this.agreed;
    for (const own of this.pending) doc = applyEvents(doc, own.events, { check: true }).doc;
    if (doc === this.doc) return null;
    return this.commit(doc, envelope.actor, 'remote', agreedNow.applied, envelope.command, envelope.gesture, envelope.id, true);
  }

  /**
   * A peer's events with who added each new object said by the backend, not by the peer: `by` on an
   * object it adds is the actor the backend stamped the envelope with. The one exception is an object
   * the agreed document has seen removed: putting it back (an undo of a delete) keeps the name it had,
   * whoever puts it back. So nobody can add something signed as someone else, and an undo still
   * restores the author.
   */
  private signed(envelope: RemoteEnvelope, before: CanvasDocument): CanvasEvent[] {
    const by: Actor = { kind: envelope.actor.kind, id: envelope.actor.id };
    const added = new Map<string, Actor | undefined>();
    return envelope.events.map((event) => {
      if (event.type === 'object-removed') {
        const gone = added.has(event.id) ? { by: added.get(event.id) } : before.objects[event.id];
        if (gone) {
          this.removedBy.delete(event.id);
          this.removedBy.set(event.id, gone.by);
          if (this.removedBy.size > REMOVED_LIMIT) this.removedBy.delete(this.removedBy.keys().next().value as string);
        }
        return event;
      }
      if (event.type !== 'object-added') return event;
      const author = this.removedBy.has(event.object.id) ? this.removedBy.get(event.object.id) : by;
      added.set(event.object.id, author);
      if (author ? event.object.by && sameActor(event.object.by, author) : !event.object.by) return event;
      const { by: _claimed, ...rest } = event.object;
      return { type: 'object-added', object: (author ? { ...rest, by: author } : rest) as typeof event.object };
    });
  }

  private remembered(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
  }

  private remember(undo: CanvasEvent[], redo: CanvasEvent[], gesture: string | undefined): void {
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    if (gesture && top?.gesture === gesture) {
      // Undo runs newest first, so the oldest "before" of each field must
      // come last; redo runs oldest first, so its newest "after" comes last.
      top.undo = compactSets([...undo, ...top.undo]);
      top.redo = compactSets([...top.redo, ...redo]);
      return;
    }
    this.undoStack.push({ undo, redo, gesture });
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
  }

  private amend(undo: CanvasEvent[], redo: CanvasEvent[], gesture: string | undefined): void {
    const entry = gesture ? this.undoStack.find((candidate) => candidate.gesture === gesture) : undefined;
    if (!entry) return;
    // Undo runs down its list and the late change is the newest, so its reversal goes first: a field the
    // step and the late change both set ends on what it was before the step. Redo runs oldest first.
    entry.undo = [...undo, ...entry.undo];
    entry.redo = [...entry.redo, ...redo];
  }

  private step(from: UndoEntry[], to: UndoEntry[], origin: 'undo' | 'redo'): Envelope | null {
    const entry = from.pop();
    if (!entry) return null;
    const events = origin === 'undo' ? entry.undo : entry.redo;
    const result = applyEvents(this.doc, events, { check: true });
    if (result.applied.length === 0) {
      // Everything it touched is gone or already as it was. Nothing to do,
      // and nothing to offer the other way.
      this.notify();
      return null;
    }
    to.push(origin === 'undo' ? { undo: entry.undo, redo: result.inverse, gesture: entry.gesture } : { undo: result.inverse, redo: entry.redo, gesture: entry.gesture });
    return this.commit(result.doc, this.actor, origin, result.applied);
  }

  private commit(
    doc: CanvasDocument,
    actor: Actor,
    origin: EnvelopeOrigin,
    events: CanvasEvent[],
    command?: Command,
    gesture?: string,
    id: string = createId('ev'),
    rebased = false,
  ): Envelope {
    const before = this.doc;
    this.doc = doc;
    this.seq += 1;
    const envelope: Envelope = { id, seq: this.seq, actor, origin, events, ...(command ? { command } : {}), ...(gesture ? { gesture } : {}), ...(rebased ? { rebased } : {}) };
    if (this.agreed) {
      if (origin !== 'remote') this.pending.push(envelope);
    } else this.remembered(id);
    this.record(envelope);
    for (const listener of [...this.commitListeners]) listener(envelope, doc, before);
    this.notify();
    return envelope;
  }

  /** Keep the envelope for `since`, folding it into the one before when they are the same gesture. */
  private record(envelope: Envelope): void {
    const last = this.log[this.log.length - 1];
    if (last && envelope.gesture && last.gesture === envelope.gesture && last.origin === envelope.origin && sameActor(last.actor, envelope.actor)) {
      const folded = foldEnvelope(last, envelope);
      this.firstSeq.set(folded, this.firstSeq.get(last) ?? last.seq);
      this.log[this.log.length - 1] = folded;
      return;
    }
    this.log.push(envelope);
    if (this.log.length > this.logLimit) {
      const dropped = this.log.shift()!;
      this.logFloor = dropped.seq;
    }
  }

  private notify(): void {
    for (const listener of [...this.stateListeners]) listener();
  }
}
