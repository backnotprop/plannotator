/**
 * Decision mode in a thread (approval "inbox-decision-mode-one-send", 2026-11-24): the sitting of the thread pane it
 * is called from. Everything it shows and changes is the thread's own (its messages, its picks and draft, its Send);
 * this holds only where the person is: the order, what was put off, the message on screen.
 *
 * A sitting is kept for the window's life per thread (`kept`), so leaving with "‹ Thread", Escape, another thread or
 * the list and coming back offers "Resume" where the person stopped. A reload starts again from "Decide": the answers
 * themselves are the thread's draft and stay either way.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { OpenQuestionsDecide } from '../components/OpenQuestions';
import { DECIDE_ENTRY_MIN, back, decideEntryLabel, decideQueue, decideReasked, decideTally, goToStep, next, putOff, startSitting, stepIndex, syncSitting, type DecideTally, type PendingAnswers, type Sitting } from './queue';

const kept = new Map<string, Sitting>();

/** Which way the person moved last: the message coming in slides from that side (none with reduced motion). */
export type DecideMove = 'next' | 'back';

export interface Decide {
  /** Decision mode is showing in this pane. */
  deciding: boolean;
  sitting: Sitting | null;
  /** The message on screen (null: the Send step, or not deciding). */
  current: string | null;
  move: DecideMove;
  tally: (messageId: string) => DecideTally;
  /** The way in for the open questions' first row, or null when it is not offered. */
  entry: OpenQuestionsDecide | null;
  go: (index: number, fromSend?: boolean) => void;
  next: () => void;
  back: () => void;
  later: () => void;
  /** "‹ Thread": nothing is sent; the answers stay in the thread's draft and the way in reads Resume. */
  leave: () => void;
  /** The thread's Send went: the sitting ends (the thread's own Send carried the answers). */
  finish: () => void;
  /**
   * The Send step's Send: the thread's own `send`; the sitting ends only when its replies went (`sent`). A Send that
   * stopped or failed keeps the sitting, on the Send step, with the thread's error shown.
   */
  sendAll: (send: () => Promise<void>) => Promise<void>;
  /** The thread's Send went (its replies are in): called by the thread. */
  sent: () => void;
}

export function useDecide({
  on,
  threadId,
  messages,
  live,
  pending,
  body,
  kept: draftKept = false,
  openKept,
  stopped = false,
}: {
  on: boolean;
  threadId: string;
  messages: readonly InboxMessageWire[];
  live: (message: InboxMessageWire) => boolean;
  pending: PendingAnswers;
  /** The thread's scrolling body: its place is kept on the way in and given back on leaving. */
  body?: RefObject<HTMLElement | null>;
  /** The reply box is closed and its draft keeps words or files (Cancel or Escape on the box kept them). */
  kept?: boolean;
  /** Open the kept draft in the reply box, without focus (as Edit draft does): the Send step's words box shows it. */
  openKept?: () => void;
  /** The thread's Send stopped on something only the thread shows (a replaced question, where an ended session's reply goes, the recipient list). */
  stopped?: boolean;
}): Decide {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [openIn, setOpenIn] = useState<string | null>(null);
  const move = useRef<DecideMove>('next');
  /** The thread's Send went, since the Send step's Send was pressed. */
  const went = useRef(false);
  /** Where the thread was scrolled on the way in (`at`), and where it goes once decision mode is put away (`to`). */
  const place = useRef<{ thread: string; at: number; to: number | 'end' | null } | null>(null);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const reasked = decideReasked(messages);
  const tally = (id: string): DecideTally => {
    const m = byId.get(id);
    return m ? decideTally(m, pending, reasked) : { total: 0, answered: 0, actions: 0 };
  };
  const queue = on ? decideQueue(messages, live, pending) : [];
  const stored = kept.get(threadId) ?? null;
  const synced = stored ? syncSitting(stored, queue) : null;
  const sitting = synced && synced.order.length > 0 ? synced : null;
  // Everything it held was sent (from the thread too) or went: nothing to resume.
  useEffect(() => {
    if (on && stored && !sitting) kept.delete(threadId);
  });
  // Another thread in this pane: decision mode is put away (the sitting is kept), so coming back shows the thread
  // with its Resume row, never decision mode by itself.
  useEffect(
    () => () => {
      setOpenIn(null);
      place.current = null;
    },
    [threadId],
  );
  const deciding = on && sitting !== null && openIn === threadId;
  // Put away: the thread goes back where the person left it ("‹ Thread", Escape), or to its end after a Send.
  useLayoutEffect(() => {
    const was = place.current;
    if (deciding || !was || was.to === null) return;
    place.current = null;
    const el = body?.current;
    if (!el || was.thread !== threadId) return;
    el.scrollTop = was.to === 'end' ? el.scrollHeight : was.to;
  });
  const atSend = deciding && sitting?.current === null;
  // The Send step shows the words the Send carries: a draft kept with the box closed opens in it, files and all (the
  // step lists those under the words), so a word typed there never saves over it.
  useLayoutEffect(() => {
    if (atSend && draftKept) openKept?.();
  }, [atSend, draftKept]);
  // A Send that stopped on what only the thread shows: back to the thread, where it is (the sitting kept, Resume).
  // Every press that stops does, the stop already showing included (Resume, then Send again without resolving it).
  const stoppedBefore = useRef(stopped);
  const pressed = useRef(false);
  useEffect(() => {
    if (stopped && deciding && (!stoppedBefore.current || pressed.current)) putAway('back');
    stoppedBefore.current = stopped;
    pressed.current = false;
  });
  const write = (nextSitting: Sitting | null) => {
    if (nextSitting) kept.set(threadId, nextSitting);
    else kept.delete(threadId);
    redraw();
  };
  const step = (to: Sitting) => {
    if (!sitting) return;
    move.current = stepIndex(to) < stepIndex(sitting) ? 'back' : 'next';
    write(to);
  };
  const open = (from: Sitting) => {
    move.current = 'next';
    place.current = { thread: threadId, at: body?.current?.scrollTop ?? 0, to: null };
    write({ ...from, fromSend: false });
    setOpenIn(threadId);
  };
  /** Put away, the sitting kept or ended: the thread's scroll goes to `to` once it shows again. */
  const putAway = (to: 'back' | 'end') => {
    if (place.current) place.current = { ...place.current, to: to === 'end' ? 'end' : place.current.at };
    setOpenIn(null);
  };
  const finish = () => {
    write(null);
    putAway('end');
  };
  // Every decision the queue holds (permission prompts and questions about to be asked again are not in it), and how
  // many of them are questions, from the same set: "Decide these N" when no action item waits among them.
  const count = on ? queue.reduce((n, id) => n + tally(id).total, 0) : 0;
  const listed = count - (on ? queue.reduce((n, id) => n + tally(id).actions, 0) : 0);
  let entry: OpenQuestionsDecide | null = null;
  // A sitting kept and not on screen is one the person left before Send ("‹ Thread", Escape, another thread, the list).
  if (on && !deciding && sitting) {
    const left = sitting.order.filter((id) => tally(id).answered < tally(id).total).length;
    // All answered and not sent: it opens on the Send step.
    entry = { label: decideEntryLabel(count, listed, { left, messages: sitting.order.length }), onDecide: () => open(left === 0 ? goToStep(sitting, sitting.order.length) : sitting) };
  } else if (on && !deciding && queue.length > 0 && count >= DECIDE_ENTRY_MIN) {
    entry = { label: decideEntryLabel(count, listed), onDecide: () => open(startSitting(queue)) };
  }
  return {
    deciding,
    sitting,
    current: deciding ? (sitting?.current ?? null) : null,
    move: move.current,
    tally,
    entry,
    go: (index, fromSend = false) => sitting && step(goToStep(sitting, index, fromSend)),
    next: () => sitting && step(next(sitting)),
    back: () => sitting && step(back(sitting)),
    later: () => sitting && step(putOff(sitting)),
    leave: () => putAway('back'),
    finish,
    sendAll: async (send) => {
      went.current = false;
      await send();
      if (went.current) return finish();
      // Drawn again with the thread's state after this Send: a stop it hit, new or already showing, puts this away.
      pressed.current = true;
      redraw();
    },
    sent: () => {
      went.current = true;
    },
  };
}
