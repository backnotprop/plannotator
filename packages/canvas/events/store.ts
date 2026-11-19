/**
 * The one place a canvas document changes.
 *
 *   command ──plan──▶ events ──reduce──▶ document
 *                        │
 *                        └──▶ envelope ──▶ listeners (renderer, index, agent, sync)
 *
 * Undo and redo fall out of that: every commit keeps the events that reverse
 * it, and undoing is committing those. An undo is therefore an ordinary
 * envelope: a peer and an agent see it like any other change.
 *
 * Only the local person's own commands are undoable here. An agent's change
 * and a peer's change go through the same store but never onto this stack,
 * so "undo" never takes back something the person did not do.
 */
import { createId } from '../model/ids';
import type { Actor, CanvasDocument } from '../model/types';
import { planCommand } from './plan';
import { applyEvents } from './reduce';
import type { CanvasEvent, Command, Envelope, EnvelopeOrigin } from './types';

export type DispatchResult = { ok: true; envelope: Envelope | null } | { ok: false; error: string };

export interface DispatchOptions {
  /** Who is asking. Defaults to the store's local person. */
  actor?: Actor;
  /**
   * Commands sharing a gesture id fold into one undo step: a drag is many
   * `move` commands and one undo.
   */
  gesture?: string;
}

interface UndoEntry {
  undo: CanvasEvent[];
  redo: CanvasEvent[];
  gesture?: string;
}

export interface CanvasStoreOptions {
  /** The person at this screen. */
  actor?: Actor;
  /** How many undo steps to keep. */
  undoLimit?: number;
  /** How many envelopes `since` can look back over. */
  logLimit?: number;
}

const sameActor = (a: Actor, b: Actor): boolean => a.kind === b.kind && a.id === b.id;

/**
 * Keep only the last change to each object. Safe only for a list made of
 * `object-changed` alone (a drag, a resize), which is the only list it is
 * given; anything else is returned as it came.
 */
function compactChanges(events: CanvasEvent[]): CanvasEvent[] {
  if (events.length < 2 || events.some((event) => event.type !== 'object-changed')) return events;
  const last = new Map<string, CanvasEvent>();
  for (const event of events) if (event.type === 'object-changed') last.set(event.object.id, event);
  return [...last.values()];
}

export class CanvasStore {
  readonly actor: Actor;
  private doc: CanvasDocument;
  private seq = 0;
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private readonly log: Envelope[] = [];
  private readonly seen = new Set<string>();
  private readonly stateListeners = new Set<() => void>();
  private readonly commitListeners = new Set<(envelope: Envelope, doc: CanvasDocument, before: CanvasDocument) => void>();
  private readonly undoLimit: number;
  private readonly logLimit: number;

  constructor(doc: CanvasDocument, options: CanvasStoreOptions = {}) {
    this.doc = doc;
    this.actor = options.actor ?? { kind: 'person', id: 'local' };
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

  /** The newest commit's number. Keep it to ask `since` for what came after. */
  get head(): number {
    return this.seq;
  }

  /**
   * Every commit after `seq`, oldest first: what a hand-over tells the agent.
   * Null when the log no longer reaches back that far; the caller then sends
   * the whole document instead.
   */
  since(seq: number): Envelope[] | null {
    if (seq >= this.seq) return [];
    const first = this.log[0];
    if (!first || first.seq > seq + 1) return null;
    return this.log.filter((envelope) => envelope.seq > seq);
  }

  dispatch(command: Command, options: DispatchOptions = {}): DispatchResult {
    const actor = options.actor ?? this.actor;
    const planned = planCommand(this.doc, command, actor);
    if (!planned.ok) return planned;
    if (planned.value.length === 0) return { ok: true, envelope: null };
    const result = applyEvents(this.doc, planned.value);
    if (result.applied.length === 0) return { ok: true, envelope: null };
    if (sameActor(actor, this.actor)) this.remember(result.inverse, result.applied, options.gesture);
    return { ok: true, envelope: this.commit(result.doc, actor, 'local', result.applied, command) };
  }

  undo(): Envelope | null {
    return this.step(this.undoStack, this.redoStack, 'undo');
  }

  redo(): Envelope | null {
    return this.step(this.redoStack, this.undoStack, 'redo');
  }

  /**
   * A change made elsewhere (a peer, through `SyncPort`). Its events are
   * applied as they are, never planned again, and never join the undo stack.
   * An envelope already applied is ignored, so a backend may deliver twice.
   */
  receive(envelope: Pick<Envelope, 'id' | 'actor' | 'events' | 'command'>): Envelope | null {
    if (this.seen.has(envelope.id)) return null;
    const result = applyEvents(this.doc, envelope.events);
    this.seen.add(envelope.id);
    if (result.applied.length === 0) return null;
    return this.commit(result.doc, envelope.actor, 'remote', result.applied, envelope.command, envelope.id);
  }

  private remember(undo: CanvasEvent[], redo: CanvasEvent[], gesture: string | undefined): void {
    this.redoStack.length = 0;
    const top = this.undoStack[this.undoStack.length - 1];
    if (gesture && top?.gesture === gesture) {
      // Undo runs newest first, so the oldest "before" of each object must
      // come last; redo runs oldest first, so its newest "after" comes last.
      top.undo = compactChanges([...undo, ...top.undo]);
      top.redo = compactChanges([...top.redo, ...redo]);
      return;
    }
    this.undoStack.push({ undo, redo, gesture });
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
  }

  private step(from: UndoEntry[], to: UndoEntry[], origin: 'undo' | 'redo'): Envelope | null {
    const entry = from.pop();
    if (!entry) return null;
    const events = origin === 'undo' ? entry.undo : entry.redo;
    const result = applyEvents(this.doc, events);
    if (result.applied.length === 0) {
      // Everything it touched is gone (someone else removed it). Nothing to
      // do, and nothing to offer the other way.
      this.notify();
      return null;
    }
    to.push(origin === 'undo' ? { undo: entry.undo, redo: result.inverse } : { undo: result.inverse, redo: entry.redo });
    return this.commit(result.doc, this.actor, origin, result.applied);
  }

  private commit(
    doc: CanvasDocument,
    actor: Actor,
    origin: EnvelopeOrigin,
    events: CanvasEvent[],
    command?: Command,
    id: string = createId('ev'),
  ): Envelope {
    const before = this.doc;
    this.doc = doc;
    this.seq += 1;
    const envelope: Envelope = { id, seq: this.seq, actor, origin, events, ...(command ? { command } : {}) };
    this.seen.add(id);
    this.log.push(envelope);
    if (this.log.length > this.logLimit) this.log.shift();
    for (const listener of [...this.commitListeners]) listener(envelope, doc, before);
    this.notify();
    return envelope;
  }

  private notify(): void {
    for (const listener of [...this.stateListeners]) listener();
  }
}
