/**
 * Decision mode's sitting (approval "inbox-decision-mode"; Settings → Capabilities, on unless turned off): read when it
 * turns on and cleared when it turns off; a thread's "Decide these N", the sitting's queue, and opening and ending
 * one (focus back on what opened it). App holds the state.
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { InboxDecision } from '@plannotator/core/inbox-types';
import type { SettingsModel } from '../api';
import type { Route } from './route';
import { decideEntryShown } from '../decisions/entry';
import { batchTouches, threadDecisions } from '../decisions/model';

/** The sitting: its thread, open or tucked into its pill; `startNonce`: a new start while it is open moves it to that card. */
export interface DecideSitting {
  thread: string;
  title: string | null;
  tucked: boolean;
  /** Tucked to show a file beside the thread (a card's attached file, or a file its message names): back once it closes. */
  file?: boolean;
  start: string | null;
  startNonce: number;
}

export function useDecideSitting({
  settings,
  decisions,
  setDecisions,
  decide,
  setDecide,
  decideOpener,
  decisionModeOnRef,
  refreshDecisions,
  refreshList,
  route,
}: {
  route: Pick<Route, 'page' | 'thread' | 'file' | 'ref'>;
  settings: SettingsModel | null;
  decisions: InboxDecision[] | null;
  setDecisions: Dispatch<SetStateAction<InboxDecision[] | null>>;
  decide: DecideSitting | null;
  setDecide: Dispatch<SetStateAction<DecideSitting | null>>;
  decideOpener: { current: HTMLElement | null };
  decisionModeOnRef: { current: boolean };
  refreshDecisions: () => Promise<unknown>;
  refreshList: (adopt: boolean) => Promise<unknown>;
}) {
  // Decision mode is on unless Settings → Capabilities turned it off; with it off, nothing of it renders and nothing is read.
  const decisionModeOn = settings?.decision_mode?.on === true;
  decisionModeOnRef.current = decisionModeOn;
  useEffect(() => {
    if (decisionModeOn) void refreshDecisions();
    else {
      setDecisions(null);
      setDecide(null);
    }
  }, [decisionModeOn, refreshDecisions]);
  // A file a card opened beside the thread: once it closes (the thread on screen, no file), the dialog is back on the
  // same card. Opened elsewhere since (another thread), the pill's Resume is the way back.
  const fileSeen = useRef(false);
  const fileOpen = route.page === 'inbox' && route.thread === decide?.thread && (!!route.file || !!route.ref);
  useEffect(() => {
    if (!decide?.tucked || !decide.file) {
      fileSeen.current = false;
      return;
    }
    if (fileOpen) fileSeen.current = true;
    else if (fileSeen.current) {
      fileSeen.current = false;
      if (route.page === 'inbox' && route.thread === decide.thread) setDecide((current) => (current ? { ...current, tucked: false, file: false } : current));
    }
  }, [decide?.tucked, decide?.file, decide?.thread, fileOpen, route.page, route.thread]);
  /**
   * The threads whose decisions this window draws (a pane asked for its "Decide these N", or the sitting's). A batch of
   * records reads the decisions (a scan of every open one) only when it touched one of them (`decisionsTouched`); a
   * thread asked for the first time reads them once, so its count is never one the window did not keep up with.
   */
  const watched = useRef(new Set<string>());
  const watch = (threadId: string) => {
    if (watched.current.has(threadId)) return;
    // Bounded: past 64 the set starts over, and the threads still on screen join again (one read each).
    if (watched.current.size >= 64) watched.current.clear();
    watched.current.add(threadId);
    queueMicrotask(() => void refreshDecisions());
  };
  const decisionsTouched = useCallback((records: { any: boolean; threads: ReadonlySet<string>; applied: ReadonlySet<string>; own: ReadonlySet<string> }) => {
    return decisionModeOnRef.current && batchTouches(records, watched.current);
  }, [decisionModeOnRef]);
  // The sitting's thread is always one of them.
  if (decisionModeOn && decide) watch(decide.thread);
  /** A thread's "Decide these N": decision mode on, no sitting going, and two or more of its decisions waiting. */
  const decideInThread = (threadId: string) => {
    if (decisionModeOn) watch(threadId);
    if (!decisionModeOn || !decisions || decide) return null;
    const count = threadDecisions(decisions, threadId).length;
    return decideEntryShown(count) ? { count, onDecide: () => openDecide(threadId) } : null;
  };
  /** The sitting's queue: its thread's decisions only. */
  const sittingDecisions = useMemo(() => (decisions && decide ? threadDecisions(decisions, decide.thread) : null), [decisions, decide?.thread]);
  const openDecide = (threadId: string) => {
    // Opened from the open-questions list, whose row goes with the list: focus comes back to its button.
    decideOpener.current = document.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
    const first = decisions ? threadDecisions(decisions, threadId)[0] : undefined;
    setDecide((current) => ({ thread: threadId, title: first ? (first.thread.subject ?? first.thread.thread_name) : null, tucked: false, start: null, startNonce: (current?.startNonce ?? 0) + 1 }));
    void refreshDecisions();
  };
  /** The sitting ended: focus back on what opened it, else on the thread's open-questions button. */
  const closeDecide = () => {
    setDecide(null);
    void refreshList(true);
    const opener = decideOpener.current;
    decideOpener.current = null;
    requestAnimationFrame(() => {
      const target = (opener?.isConnected ? opener : null) ?? document.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
      target?.focus({ preventScroll: true });
    });
  };
  return { decisionModeOn, decideInThread, sittingDecisions, closeDecide, decisionsTouched };
}
