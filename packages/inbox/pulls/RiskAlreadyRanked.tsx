import { useEffect, useRef, useState } from 'react';
import type { InboxPullRiskAnswer, InboxPullRiskAuto } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { riskFilterWords } from './risk';

const MADE: Record<InboxPullRiskAuto['make'], string> = { guide: 'a guided review', picture_it: 'a Picture page' };
const MADE_MANY: Record<InboxPullRiskAuto['make'], string> = { guide: 'guided reviews', picture_it: 'Picture pages' };

export function riskAlreadyRanked(answer: InboxPullRiskAnswer): number {
  return answer.auto ? (answer.auto_waiting?.length ?? answer.auto_would_start?.[answer.auto.level] ?? 0) : 0;
}

export function riskRankPhrase(count: number, level: InboxPullRiskAuto['level'], already: boolean): string {
  return `${count}${already ? ' already' : ''} ${count === 1 ? 'ranks' : 'rank'} ${riskFilterWords[level]}`;
}

export function riskRankWords(count: number, level: InboxPullRiskAuto['level'], already: boolean): string {
  return `${riskRankPhrase(count, level, already)}.`;
}

export function riskTurnedOnWords(auto: InboxPullRiskAuto, count: number): string {
  return `You turned on ${MADE_MANY[auto.make]} for ${riskFilterWords[auto.level]}. ${count === 1 ? 'Make one now?' : 'Make one for each now?'}`;
}

export function riskMakeWords(make: InboxPullRiskAuto['make']): string {
  return `Make ${MADE[make]} for each`;
}

export function dismissRanked(keys: readonly string[]): Promise<InboxPullRiskAnswer> {
  return inboxApi.savePullRisk({ not_now: true, keys: [...keys] });
}

export function useRankedChoice(keys: readonly string[], onDone: (next: InboxPullRiskAnswer) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (ask: () => Promise<InboxPullRiskAnswer>, fallback: string): Promise<{ failed: unknown } | null> => {
    setBusy(true);
    setError(null);
    try {
      onDone(await ask());
      setBusy(false);
      return null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      setBusy(false);
      return { failed: cause };
    }
  };
  return {
    busy,
    error,
    makeNow: () => run(() => inboxApi.savePullRisk({ make_now: true, keys: [...keys] }), 'Nothing was started.'),
    notNow: () => run(() => dismissRanked(keys), 'That could not be saved.'),
  };
}

export function RiskAlreadyRanked({ titleId, saved, onDone }: { titleId: string; saved: InboxPullRiskAnswer; onDone: (next: InboxPullRiskAnswer) => void }) {
  const choice = useRankedChoice(saved.auto_waiting ?? [], onDone);
  const notNow = useRef<HTMLButtonElement>(null);
  useEffect(() => notNow.current?.focus(), []);
  const count = riskAlreadyRanked(saved);
  const auto = saved.auto!;
  return (
    <div data-pull-risk-ranked={count}>
      <h2 id={titleId}>{riskRankWords(count, auto.level, true)}</h2>
      <p className="ib-sub ib-riskd-l">{riskMakeWords(auto.make)} now?</p>
      {choice.error && (
        <p className="ib-error" role="alert">
          {choice.error}
        </p>
      )}
      <div className="ib-acts-row ib-riskd-acts">
        <button ref={notNow} type="button" className="ib-btn" onClick={() => void choice.notNow()} disabled={choice.busy} data-pull-risk-not-now="">
          Not now
        </button>
        <button type="button" className="ib-btn ib-pri" onClick={() => void choice.makeNow()} disabled={choice.busy} data-pull-risk-make-now="">
          Make them now
        </button>
      </div>
    </div>
  );
}
