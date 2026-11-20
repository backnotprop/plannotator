import type { InboxPullRiskAnswer } from '@plannotator/core/inbox-types';
import { riskRankWords, useRankedChoice } from './RiskAlreadyRanked';

export function riskLineKeys(answer: InboxPullRiskAnswer | null): string[] {
  if (!answer?.auto || !answer.auto_agent) return [];
  const dismissed = new Set(answer.auto_dismissed ?? []);
  return (answer.auto_waiting ?? []).filter((key) => !dismissed.has(key));
}

export function RiskWaitingLine({ answer, onAnswer }: { answer: InboxPullRiskAnswer | null; onAnswer: (next: InboxPullRiskAnswer) => void }) {
  const keys = riskLineKeys(answer);
  const choice = useRankedChoice(keys, onAnswer);
  return (
    <div role="status" className="ib-riskw-live">
      {keys.length > 0 && answer?.auto && (
        <div className="ib-riskw" data-pull-risk-waiting={keys.length}>
          <span className="ib-riskw-t">{riskRankWords(keys.length, answer.auto.level, false)}</span>
          <span className="ib-riskw-acts">
            <button type="button" className="ib-btn" onClick={() => void choice.notNow()} disabled={choice.busy} data-pull-risk-waiting-not-now="">
              Not now
            </button>
            <button type="button" className="ib-btn ib-pri" onClick={() => void choice.makeNow()} disabled={choice.busy} data-pull-risk-waiting-make-now="">
              Make them now
            </button>
          </span>
          {choice.error && <span className="ib-riskw-err">{choice.error}</span>}
        </div>
      )}
    </div>
  );
}
