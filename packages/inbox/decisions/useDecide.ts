/**
 * Decision mode in a thread (approval "inbox-decision-mode-one-send", 2026-11-24): the sitting of the thread pane it
 * is called from. Everything it shows and changes is the thread's own (its messages, its picks and draft, its Send);
 * this holds only where the person is: the order, what was put off, the message on screen.
 *
 * A sitting is kept for the window's life per thread (`kept`), so leaving with "‹ Thread", Escape, another thread or
 * the list and coming back offers "Resume" where the person stopped. A reload starts again from "Decide": the answers
 * themselves are the thread's draft and stay either way.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { threadOpenActions, threadOpenQuestions } from '@plannotator/core/inbox-open-questions';
import type { OpenQuestionsDecide } from '../components/OpenQuestions';
import { DECIDE_ENTRY_MIN, back, decideEntryLabel, decideQueue, decideTally, goToStep, next, putOff, startSitting, stepIndex, syncSitting, type DecideTally, type PendingAnswers, type Sitting } from './queue';

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
  /** Send was pressed: the sitting ends (the thread's own Send carries the answers). */
  finish: () => void;
}

export function useDecide({
  on,
  threadId,
  messages,
  live,
  pending,
}: {
  on: boolean;
  threadId: string;
  messages: readonly InboxMessageWire[];
  live: (message: InboxMessageWire) => boolean;
  pending: PendingAnswers;
}): Decide {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [openIn, setOpenIn] = useState<string | null>(null);
  const move = useRef<DecideMove>('next');
  const byId = new Map(messages.map((m) => [m.id, m]));
  const tally = (id: string): DecideTally => {
    const m = byId.get(id);
    return m ? decideTally(m, pending) : { total: 0, answered: 0 };
  };
  const queue = on ? decideQueue(messages, live, pending) : [];
  const stored = kept.get(threadId) ?? null;
  const synced = stored ? syncSitting(stored, queue) : null;
  const sitting = synced && synced.order.length > 0 ? synced : null;
  // Everything it held was sent (from the thread too) or went: nothing to resume.
  useEffect(() => {
    if (on && stored && !sitting) kept.delete(threadId);
  });
  const deciding = on && sitting !== null && openIn === threadId;
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
    write({ ...from, fromSend: false });
    setOpenIn(threadId);
  };
  const count = on ? threadOpenQuestions(messages, live).questions.length + threadOpenActions(messages, live).length : 0;
  const listed = on ? threadOpenQuestions(messages, live).questions.length : 0;
  let entry: OpenQuestionsDecide | null = null;
  // A sitting kept and not on screen is one the person left before Send ("‹ Thread", Escape, another thread, the list).
  if (on && !deciding && sitting) {
    const left = sitting.order.filter((id) => tally(id).answered < tally(id).total).length;
    entry = { label: decideEntryLabel(count, listed, { left, messages: sitting.order.length }), onDecide: () => open(sitting) };
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
    leave: () => setOpenIn(null),
    finish: () => {
      write(null);
      setOpenIn(null);
    },
  };
}
