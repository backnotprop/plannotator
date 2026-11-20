import { useLayoutEffect, useRef, useState } from 'react';
import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';
import { riskMakeWords, riskRankWords, useRankedChoice } from './RiskAlreadyRanked';

export function riskLineKeys(answer: InboxPullRiskAnswer | null): string[] {
  if (!answer?.auto || !answer.auto_agent) return [];
  const dismissed = new Set(answer.auto_dismissed ?? []);
  return (answer.auto_waiting ?? []).filter((key) => !dismissed.has(key));
}

export const RISK_LINE_SETTLE_MS = 500;

function useSettling(shown: boolean) {
  const shownAt = useRef(0);
  const [settling, setSettling] = useState(false);
  useLayoutEffect(() => {
    if (!shown) return;
    shownAt.current = Date.now();
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), RISK_LINE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return { settling, ready: () => Date.now() - shownAt.current >= RISK_LINE_SETTLE_MS };
}

export function RiskWaitingLine({ answer, onAnswer }: { answer: InboxPullRiskAnswer | null; onAnswer: (next: InboxPullRiskAnswer) => void }) {
  const keys = riskLineKeys(answer);
  const choice = useRankedChoice(keys, onAnswer);
  const settle = useSettling(keys.length > 0 && !!answer?.auto);
  return (
    <div role="status" className="ib-riskw-live">
      {keys.length > 0 && answer?.auto && (
        <div className="ib-riskw" data-pull-risk-waiting={keys.length}>
          <span className="ib-riskw-t">
            {riskRankWords(keys.length, answer.auto.level, false)} {riskMakeWords(answer.auto.make)}?
          </span>
          <span className="ib-riskw-acts">
            <button type="button" className="ib-btn" onClick={() => settle.ready() && void choice.notNow()} disabled={choice.busy} aria-disabled={settle.settling || undefined} data-pull-risk-waiting-not-now="">
              Not now
            </button>
            <button type="button" className="ib-btn ib-pri" onClick={() => settle.ready() && void choice.makeNow()} disabled={choice.busy} aria-disabled={settle.settling || undefined} data-pull-risk-waiting-make-now="">
              Make them now
            </button>
          </span>
          {choice.error && <span className="ib-riskw-err">{choice.error}</span>}
        </div>
      )}
    </div>
  );
}
