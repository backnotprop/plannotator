/**
 * The window's list reads (#2593), behind `inboxApi.list()`.
 *
 * Only what changed: every read names the list this window holds
 * (`since=<list_version>`), and an answer with `delta` carries only the rows
 * that changed since; `applyInboxListDelta` (core) puts them together with
 * that list into the model a full read gives. The first read, one after a
 * restart of the Inbox, and one the server cannot answer as a change get the
 * whole list. A change that does not fit the list it names (it never should)
 * is dropped and the whole list read instead.
 *
 * Calls in the same tick share one read: a burst of events (a message, its
 * question, a delivery, a draft) is one read, not one each. A call while a
 * read is out starts its own, as before: the one out may predate what the
 * caller just did, and a slow answer never holds a newer one back (the window
 * keeps the newest by cursor). Each answer is put together with the list it
 * was asked against, so two reads out at once land right in either order.
 */

import { applyInboxListDelta, type InboxListDelta, type InboxListDeltaModel } from '@plannotator/core/inbox-list-delta';

/** What a list read answers: the whole model, or (`delta`) the model without its rows and what changed. */
export type ListReadAnswer<M> = M | (Omit<M, keyof InboxListDeltaModel> & { delta: InboxListDelta });

export interface ListReader<M> {
  /** The list as it is now: a read that starts after this call (shared with the other calls of this tick). */
  read: () => Promise<M>;
  /** Forget the lists held: the next read is a whole one. */
  reset: () => void;
}

/** Lists kept to put a change together with: the newest few, for reads that were out at once. */
const KEPT_LISTS = 4;

export function createListReader<M extends InboxListDeltaModel & { list_version?: string }>(fetchList: (since: string) => Promise<ListReadAnswer<M>>): ListReader<M> {
  /** Lists by version, oldest first. */
  const kept = new Map<string, M>();
  /** The version the next read names: the list of the latest read to start that has landed. */
  let held: { version: string; started: number } | null = null;
  let started = 0;
  /** The read this tick's calls join: not started yet. */
  let next: Promise<M> | null = null;

  const keep = (version: string, model: M) => {
    kept.delete(version);
    kept.set(version, model);
    while (kept.size > KEPT_LISTS) kept.delete(kept.keys().next().value!);
  };

  const once = async (): Promise<M> => {
    const mine = ++started;
    const answer = await fetchList(held?.version ?? '');
    let model: M | null;
    if ('delta' in answer && answer.delta) {
      const base = kept.get(answer.delta.since);
      model = base ? applyInboxListDelta<M>(base, answer) : null;
      if (!model) {
        kept.clear();
        held = null;
        return once();
      }
    } else model = answer as M;
    if (typeof model.list_version === 'string') {
      keep(model.list_version, model);
      if (!held || mine > held.started) held = { version: model.list_version, started: mine };
    }
    return model;
  };

  const read = (): Promise<M> => {
    if (next) return next;
    // A macrotask later, so every call of this tick joins it.
    const mine: Promise<M> = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      if (next === mine) next = null;
      return once();
    });
    next = mine;
    return mine;
  };

  return {
    read,
    reset: () => {
      kept.clear();
      held = null;
    },
  };
}
