/**
 * Decision mode's sitting (experimental, approval "inbox-decision-mode"): on only while settings say so, read when it
 * turns on and cleared when it turns off; a thread's "Decide these N", the sitting's queue, and opening and ending
 * one (focus back on what opened it). App holds the state.
 */
import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { InboxDecision } from '@plannotator/core/inbox-types';
import type { SettingsModel } from '../api';
import { decideEntryShown } from '../decisions/entry';
import { threadDecisions } from '../decisions/model';

/** The sitting: its thread, open or tucked into its pill; `startNonce`: a new start while it is open moves it to that card. */
export interface DecideSitting {
  thread: string;
  title: string | null;
  tucked: boolean;
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
}: {
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
  // Decision mode is on only while settings say so; with it off, nothing of it renders and nothing is read.
  const decisionModeOn = settings?.experimental?.decision_mode.on === true;
  decisionModeOnRef.current = decisionModeOn;
  useEffect(() => {
    if (decisionModeOn) void refreshDecisions();
    else {
      setDecisions(null);
      setDecide(null);
    }
  }, [decisionModeOn, refreshDecisions]);
  /** A thread's "Decide these N": decision mode on, no sitting going, and two or more of its decisions waiting. */
  const decideInThread = (threadId: string) => {
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
  return { decisionModeOn, decideInThread, sittingDecisions, closeDecide };
}
