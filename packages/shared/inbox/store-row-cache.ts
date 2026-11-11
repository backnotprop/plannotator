/**
 * The list rows, kept per thread (stage 3, PR 3): a write rebuilds the rows of the threads it touched, not every row.
 *
 * What a row reads (spike X2, measured by running `listRow` over generated Inboxes with every field and map key it
 * touched recorded): its own thread's messages, questions, seqs and archive line, its own reply draft and unsent
 * comments, the projects (its project's label is worked out against every project's name, and a combine moves it),
 * and the live sessions' answers. Nothing of another thread. So:
 * - a store line, a question or annotation put back, a draft saved or dropped: that thread's row;
 * - a project line, a start, a re-read (a deletion), another live-sessions object: every row;
 * - the live sessions moving with no line (a session ending, a connection busy): each row keeps the answers its
 *   build was given (`recordingPresence`), and a read asks each distinct call again; a changed answer drops the rows
 *   that read it.
 * Pins, snoozes, launches, checklists, PRs and the clock are not in a store row (the server decorates rows per read),
 * so nothing here follows them.
 *
 * `rows()` keeps the whole list in order and moves only the rows that changed. Its order is the store's
 * (`last_at` newest first, then the thread id Z→A), the order every caller had.
 */
import type { InboxListRow } from "@plannotator/core/inbox-types";

/** A live-session call a row's build made, and its answer then (`inboxRowAnswer`). */
export interface InboxRowCall {
  ask: () => unknown;
  answer: unknown;
}

export interface InboxRowCacheHost {
  /** Every thread the list holds (its root is there), in the store's order of first lines. */
  threadIds(): Iterable<string>;
  /** `id` is a thread the list holds. */
  isThread(id: string): boolean;
  /** The row as `listRow` works it out now; `calls` (when the live sessions are known) gets each answer it read. */
  build(threadId: string, calls: Map<string, InboxRowCall> | null): InboxListRow | null;
  /** The live-sessions object rows are built against (null: none). Another object drops every row. */
  presence(): unknown;
}

/** The store's list order: newest activity first, ties on the thread id (Z→A). */
export function inboxRowOrder(a: InboxListRow, b: InboxListRow): number {
  return b.last_at.localeCompare(a.last_at) || b.thread_id.localeCompare(a.thread_id);
}

/** An answer as kept: a primitive as it is, anything else (an object from `connection`, `waitOf`) as its JSON then. */
export function inboxRowAnswer(answer: unknown): unknown {
  return typeof answer === "object" && answer !== null ? { json: JSON.stringify(answer) } : answer;
}

/** The call answers now what it answered when kept. */
function same(kept: unknown, now: unknown): boolean {
  if (typeof kept === "object" && kept !== null) return typeof now === "object" && now !== null && (kept as { json: string }).json === JSON.stringify(now);
  return kept === now;
}

export class InboxRowCache {
  private readonly host: InboxRowCacheHost;
  /** Every row built since it last changed, by thread (null: no row). */
  private readonly cached = new Map<string, InboxListRow | null>();
  /** Every live-session call a cached row's build made, its first answer, and the rows that read it. */
  private readonly calls = new Map<string, InboxRowCall & { threads: Set<string> }>();
  private readonly callsOf = new Map<string, string[]>();
  /** Threads written to since the last read. */
  private readonly dirty = new Set<string>();
  private all = true;
  private presence: unknown = null;
  /** The whole list in order (`rows()`), the row each thread has in it, and the threads whose place may have moved. */
  private order: InboxListRow[] | null = null;
  private readonly inOrder = new Map<string, InboxListRow>();
  private readonly moved = new Set<string>();

  constructor(host: InboxRowCacheHost) {
    this.host = host;
  }

  /** A thread's row may read differently now. */
  changed(threadId: string): void {
    if (!this.all) this.dirty.add(threadId);
  }

  /** Every row may read differently now (a project line, a start, a re-read, new live sessions). */
  changedAll(): void {
    this.all = true;
    this.dirty.clear();
  }

  /** One thread's row, as `listRow` would build it now. */
  row(threadId: string): InboxListRow | null {
    if (!this.host.isThread(threadId)) return this.host.build(threadId, null);
    this.settle();
    // Only this row's own calls are asked again: one read of one row costs a few calls, not the whole list's.
    for (const key of this.callsOf.get(threadId) ?? []) {
      const call = this.calls.get(key);
      if (call && !same(call.answer, call.ask())) this.dropCall(key);
    }
    return this.built(threadId);
  }

  /** Ready for many `rowNow` reads (a filtered list): every change taken, every live-session call asked again. */
  prepare(): void {
    this.settle();
    for (const [key, call] of this.calls) if (!same(call.answer, call.ask())) this.dropCall(key);
  }

  /** A row after `prepare()`, with nothing changed since. */
  rowNow(threadId: string): InboxListRow | null {
    return this.host.isThread(threadId) ? this.built(threadId) : this.host.build(threadId, null);
  }

  /** Every row, in the store's order. A copy: a caller may sort or trim it. */
  rows(): InboxListRow[] {
    this.prepare();
    const order = this.order;
    if (order === null || this.moved.size > order.length / 4) return this.rebuildOrder().slice();
    for (const id of this.moved) {
      const before = this.inOrder.get(id);
      if (before) {
        const at = this.indexOf(order, before);
        if (at < 0) return this.rebuildOrder().slice();
        order.splice(at, 1);
        this.inOrder.delete(id);
      }
      const row = this.host.isThread(id) ? this.built(id) : null;
      if (!row) continue;
      order.splice(this.insertAt(order, row), 0, row);
      this.inOrder.set(id, row);
    }
    this.moved.clear();
    return order.slice();
  }

  private settle(): void {
    const presence = this.host.presence();
    if (presence !== this.presence) {
      this.presence = presence;
      this.all = true;
    }
    if (this.all) {
      this.all = false;
      this.dirty.clear();
      this.cached.clear();
      this.calls.clear();
      this.callsOf.clear();
      this.order = null;
      this.inOrder.clear();
      this.moved.clear();
      return;
    }
    for (const id of this.dirty) this.drop(id);
    this.dirty.clear();
  }

  private built(threadId: string): InboxListRow | null {
    const hit = this.cached.get(threadId);
    if (hit !== undefined) return hit;
    const calls = this.presence ? new Map<string, InboxRowCall>() : null;
    const row = this.host.build(threadId, calls);
    this.cached.set(threadId, row);
    if (calls && calls.size > 0) {
      const keys = [...calls.keys()];
      this.callsOf.set(threadId, keys);
      for (const key of keys) {
        // A call another row made already keeps its first answer: that row was built with it, and a later read
        // that finds it changed must drop that row too.
        const known = this.calls.get(key);
        if (known) known.threads.add(threadId);
        else this.calls.set(key, { ...calls.get(key)!, threads: new Set([threadId]) });
      }
    }
    return row;
  }

  private drop(threadId: string): void {
    this.cached.delete(threadId);
    for (const key of this.callsOf.get(threadId) ?? []) {
      const call = this.calls.get(key);
      if (!call) continue;
      call.threads.delete(threadId);
      if (call.threads.size === 0) this.calls.delete(key);
    }
    this.callsOf.delete(threadId);
    if (this.order) this.moved.add(threadId);
  }

  /** A call answers differently: every row that read it is built again. */
  private dropCall(key: string): void {
    const call = this.calls.get(key);
    if (!call) return;
    this.calls.delete(key);
    for (const threadId of [...call.threads]) this.drop(threadId);
  }

  private rebuildOrder(): InboxListRow[] {
    const order: InboxListRow[] = [];
    this.inOrder.clear();
    for (const id of this.host.threadIds()) {
      const row = this.built(id);
      if (!row) continue;
      order.push(row);
      this.inOrder.set(id, row);
    }
    order.sort(inboxRowOrder);
    this.order = order;
    this.moved.clear();
    return order;
  }

  /** Where `row` would go in `order` (the first place it sorts before). */
  private insertAt(order: readonly InboxListRow[], row: InboxListRow): number {
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (inboxRowOrder(order[mid]!, row) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexOf(order: readonly InboxListRow[], row: InboxListRow): number {
    const at = this.insertAt(order, row);
    return order[at] === row ? at : -1;
  }
}
