import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';

export const PULL_RISK_POLL_MS = 4_000;

export function usePullRisk(listVersion: unknown): { answer: InboxPullRiskAnswer | null; setAnswer: (answer: InboxPullRiskAnswer) => void } {
  const [answer, setAnswer] = useState<InboxPullRiskAnswer | null>(null);
  const controller = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    inboxApi
      .pullRisk(mine.signal)
      .then((next) => {
        if (!mine.signal.aborted && next?.judgments) setAnswer(next);
      })
      .catch(() => {});
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
