import { useEffect, useRef, useState } from 'react';
import type { InboxPullRiskAnswer, InboxPullRiskAuto } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { riskFilterWords } from './risk';

const MADE: Record<InboxPullRiskAuto['make'], string> = { guide: 'a guided review', picture_it: 'a Picture page' };

export function riskAlreadyRanked(answer: InboxPullRiskAnswer): number {
  return answer.auto ? (answer.auto_would_start?.[answer.auto.level] ?? 0) : 0;
}

export function RiskAlreadyRanked({ titleId, saved, onDone }: { titleId: string; saved: InboxPullRiskAnswer; onDone: (next: InboxPullRiskAnswer) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notNow = useRef<HTMLButtonElement>(null);
  useEffect(() => notNow.current?.focus(), []);
  const count = riskAlreadyRanked(saved);
  const auto = saved.auto!;
  const makeNow = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await inboxApi.savePullRisk({ make_now: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nothing was started.');
      setBusy(false);
    }
  };
  return (
    <div data-pull-risk-ranked={count}>
      <h2 id={titleId}>
        {count} already {count === 1 ? 'ranks' : 'rank'} {riskFilterWords[auto.level]}.
      </h2>
      <p className="ib-sub ib-riskd-l">Make {MADE[auto.make]} for each now?</p>
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
      <div className="ib-acts-row ib-riskd-acts">
        <button ref={notNow} type="button" className="ib-btn" onClick={() => onDone(saved)} disabled={busy} data-pull-risk-not-now="">
          Not now
        </button>
        <button type="button" className="ib-btn ib-pri" onClick={() => void makeNow()} disabled={busy} data-pull-risk-make-now="">
          Make them now
        </button>
      </div>
    </div>
  );
}
