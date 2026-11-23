import { useCallback, useEffect, useRef } from 'react';
import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { InboxApiError } from '../apiError';
import { useKeptState } from '../data/keptState';

/** While judgments run in the background, they are read this often. */
export const PULL_RISK_POLL_MS = 4_000;

/**
 * The rules, the agent and the judgments of the listed PRs. Read when the list
 * changes (`listVersion`: a list read is what starts new judgments), then again
 * while some are still running. A failed read leaves what is on screen.
 */
export function usePullRisk(listVersion: unknown): { answer: InboxPullRiskAnswer | null; setAnswer: (answer: InboxPullRiskAnswer) => void } {
  const [answer, keepAnswer, setAnswer] = useKeptState<InboxPullRiskAnswer | null>(null);
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    inboxApi
      .pullRisk(mine.signal)
      .then((next) => {
        // An answer without judgments isn't one: it never takes the review down with it.
        // The same answer keeps the held one: a poll while judgments run draws nothing new until one lands.
        if (!mine.signal.aborted && next?.judgments) keepAnswer(next);
      })
      .catch((cause) => {
        if (!mine.signal.aborted && cause instanceof InboxApiError && cause.code === 'code_review_off') setAnswer(null);
      });
  }, []);
  useEffect(() => {
    read();
    return () => controller.current?.abort();
  }, [listVersion, read]);
  const pending = (answer?.pending ?? 0) > 0;
  useEffect(() => {
    if (!pending) return;
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, PULL_RISK_POLL_MS);
    return () => clearInterval(tick);
  }, [pending, read]);
  return { answer, setAnswer };
}
