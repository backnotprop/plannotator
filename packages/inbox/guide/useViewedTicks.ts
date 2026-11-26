/**
 * A review's Viewed ticks in its pane: what its Inbox last said, the held ones (its machine away) laid over
 * (`viewedWithHeld`), and this window's ticks not confirmed yet on top, the newest per file. A tick is never kept
 * unconfirmed: one that failed goes back at once; one held goes back when its outbox entry settles as anything but
 * delivered (refused there, dropped with its link).
 *
 * What the Inbox said: the kept list (`guide_viewed`) whenever it changes; a save's answer for its own file (the
 * newest tick's answer wins per file); a held tick, here or from another window, once delivered. A review's answers
 * reach only that review: switching reviews starts over.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OutboxView } from '@plannotator/core/inbox-wire-models';
import { InboxHeldError, inboxApi } from '../api';
import { viewedWithHeld } from './heldViewed';

type Save = (messageId: string, path: string, viewed: boolean) => Promise<{ viewed: string[] }>;
type Tick = { path: string; on: boolean; seq: number };
type Ticks = {
  id: string;
  /** The kept list it last took, as one string: a new array with the same files is no change. */
  keptKey: string;
  /** What the Inbox last said. */
  confirmed: string[];
  /** This window's ticks not confirmed yet, the newest per file. */
  pending: ReadonlyMap<string, Tick>;
};
/** One review's bookkeeping: a new one per review, so an old review's answers find theirs gone. */
type Books = {
  id: string;
  seq: number;
  /** Each file's newest answered tick. */
  answered: Map<string, number>;
  /** This window's held ticks by their outbox entry's key. */
  held: Map<string, Tick>;
  /** Held entries seen waiting (any window's): their tick is taken once delivered. */
  waiting: Set<string>;
};

const keyOf = (kept: readonly string[] | null | undefined) => (kept ?? []).join('\n');
const fresh = (id: string, kept: readonly string[] | null | undefined): Ticks => ({ id, keptKey: keyOf(kept), confirmed: [...(kept ?? [])], pending: new Map() });
const books = (id: string): Books => ({ id, seq: 0, answered: new Map(), held: new Map(), waiting: new Set() });
/** One file ticked or not: a tick goes to the end, the order it was made. */
const put = (list: readonly string[], path: string, on: boolean) => (on ? [...list.filter((p) => p !== path), path] : list.filter((p) => p !== path));
/** The tick no longer waits, unless a newer one of its file does. */
const done = (pending: ReadonlyMap<string, Tick>, tick: Tick) => {
  if (pending.get(tick.path)?.seq !== tick.seq) return pending;
  const next = new Map(pending);
  next.delete(tick.path);
  return next;
};

export function useViewedTicks(
  messageId: string,
  kept: readonly string[] | null | undefined,
  outbox: ReadonlyMap<string, OutboxView> | null | undefined,
  onError: (words: string) => void,
  save: Save = inboxApi.saveGuideViewed,
): { shown: string[]; toggle: (path: string) => void } {
  const [stored, setTicks] = useState<Ticks>(() => fresh(messageId, kept));
  // Another review, or a new kept list: taken while drawing, so no frame shows the old one.
  let ticks = stored;
  if (ticks.id !== messageId) ticks = fresh(messageId, kept);
  else if (ticks.keptKey !== keyOf(kept)) ticks = { ...ticks, keptKey: keyOf(kept), confirmed: [...(kept ?? [])] };
  if (ticks !== stored) setTicks(ticks);
  const booksRef = useRef<Books>(books(messageId));
  if (booksRef.current.id !== messageId) booksRef.current = books(messageId);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  /** Changes this review's ticks, never another's. */
  const change = useCallback((mine: Books, next: (now: Ticks) => Ticks) => {
    if (booksRef.current === mine) setTicks((now) => (now.id === mine.id ? next(now) : now));
  }, []);
  /** Held entries that settled: delivered ones are what the Inbox keeps; this window's others go back. */
  const settle = useCallback(() => {
    const mine = booksRef.current;
    const route = `messages/${mine.id}/guide/viewed`;
    const said: { path: string; on: boolean }[] = [];
    const settled: Tick[] = [];
    for (const entry of outboxRef.current?.values() ?? []) {
      if (entry.route !== route) continue;
      const own = mine.held.get(entry.key);
      if (entry.state === 'queued' || entry.state === 'sending') {
        mine.waiting.add(entry.key);
        continue;
      }
      if (!own && !mine.waiting.has(entry.key)) continue;
      mine.waiting.delete(entry.key);
      mine.held.delete(entry.key);
      if (own) settled.push(own);
      if (entry.state !== 'delivered') continue;
      if (own && own.seq >= (mine.answered.get(own.path) ?? 0)) {
        mine.answered.set(own.path, own.seq);
        said.push(own);
      } else if (!own && entry.viewed) said.push({ path: entry.viewed.path, on: entry.viewed.viewed });
    }
    // An entry seen waiting that left the outbox unseen settled while the event stream was down (a reread keeps only
    // what waits and undismissed notices): delivered, or refused with its notice dismissed. Which one, the kept list
    // says: it is the truth, so this window's tick stops covering it. (A held tick not seen waiting yet stays.)
    for (const key of mine.waiting) {
      if (outboxRef.current?.has(key)) continue;
      mine.waiting.delete(key);
      const own = mine.held.get(key);
      mine.held.delete(key);
      if (own) settled.push(own);
    }
    if (said.length || settled.length)
      change(mine, (now) => ({
        ...now,
        confirmed: said.reduce((list, one) => put(list, one.path, one.on), now.confirmed),
        pending: settled.reduce(done, now.pending),
      }));
  }, [change]);
  useEffect(settle, [outbox, messageId, settle]);

  const shown = useMemo(() => {
    const mine = [...ticks.pending.values()].sort((a, b) => a.seq - b.seq);
    return mine.reduce((list, tick) => put(list, tick.path, tick.on), viewedWithHeld(ticks.confirmed, outbox, messageId));
  }, [ticks, outbox, messageId]);
  const toggle = useCallback(
    (path: string) => {
      // One file's change, never the whole list: a tick that waits never undoes another made since.
      const mine = booksRef.current;
      const tick = { path, on: !shown.includes(path), seq: ++mine.seq };
      change(mine, (now) => ({ ...now, pending: new Map(now.pending).set(path, tick) }));
      save(mine.id, path, tick.on).then(
        (saved) => {
          const newest = tick.seq >= (mine.answered.get(path) ?? 0);
          if (newest) mine.answered.set(path, tick.seq);
          change(mine, (now) => ({ ...now, confirmed: newest ? put(now.confirmed, path, saved.viewed.includes(path)) : now.confirmed, pending: done(now.pending, tick) }));
        },
        (cause: unknown) => {
          if (booksRef.current !== mine) return;
          // Held for a machine that is away: not a failure. It shows until its outbox entry settles.
          if (cause instanceof InboxHeldError) {
            mine.held.set(cause.outbox.key, tick);
            settle();
            return;
          }
          change(mine, (now) => ({ ...now, pending: done(now.pending, tick) }));
          onError(cause instanceof Error ? cause.message : 'The Viewed tick was not saved.');
        },
      );
    },
    [shown, save, onError, settle, change],
  );
  return { shown, toggle };
}
