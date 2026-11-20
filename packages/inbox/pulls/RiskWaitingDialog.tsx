import { useEffect, useId, useState } from 'react';
import type { InboxPull, InboxPullRiskAnswer, InboxPullRiskAuto } from '@plannotator/core/inbox-types';
import { Modal } from '../components/Updates';
import { dismissRanked, riskRankPhrase, riskTurnedOnWords, useRankedChoice } from './RiskAlreadyRanked';

export const RISK_WAITING_LISTED = 5;
const LISTED_BEFORE_MORE = 4;

export function riskWaitingKeys(answer: InboxPullRiskAnswer | null): string[] {
  if (!answer?.auto || !answer.auto_agent) return [];
  const dismissed = new Set(answer.auto_dismissed ?? []);
  return (answer.auto_waiting ?? []).filter((key) => !dismissed.has(key));
}

interface Shown {
  keys: string[];
  auto: InboxPullRiskAuto;
  lines: { key: string; title: string | null; ref: string }[];
}

function lineOf(key: string, pull: InboxPull | undefined): Shown['lines'][number] {
  if (!pull) return { key, title: null, ref: key.replace(/^[^/]+\//, '').replace(/:pull$/, '') };
  return { key, title: pull.title, ref: `${pull.repo} ${pull.platform === 'gitlab' ? '!' : '#'}${pull.number}` };
}

export function RiskWaitingDialog({
  answer,
  pulls,
  blocked,
  asked,
  onAnswer,
}: {
  answer: InboxPullRiskAnswer | null;
  pulls: readonly InboxPull[];
  blocked: boolean;
  asked: Set<string>;
  onAnswer: (next: InboxPullRiskAnswer) => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const waiting = riskWaitingKeys(answer).filter((key) => !asked.has(key));
  const ready = !blocked && !shown && waiting.length > 0 && !!answer?.auto;
  const waitingId = waiting.join('\n');
  useEffect(() => {
    if (!ready || !answer?.auto) return;
    const byKey = new Map(pulls.map((pull) => [pull.key, pull]));
    for (const key of waiting) asked.add(key);
    setShown({ keys: waiting, auto: answer.auto, lines: waiting.map((key) => lineOf(key, byKey.get(key))) });
  }, [ready, waitingId]);
  if (!shown) return null;
  return <RiskWaitingAsk shown={shown} onAnswer={onAnswer} onClose={() => setShown(null)} />;
}

function RiskWaitingAsk({ shown, onAnswer, onClose }: { shown: Shown; onAnswer: (next: InboxPullRiskAnswer) => void; onClose: () => void }) {
  const titleId = useId();
  const choice = useRankedChoice(shown.keys, (next) => {
    onAnswer(next);
    onClose();
  });
  const notNow = () => {
    if (choice.busy) return;
    onClose();
    void dismissRanked(shown.keys).then(onAnswer, () => {});
  };
  const count = shown.keys.length;
  const listed = count <= RISK_WAITING_LISTED ? shown.lines : shown.lines.slice(0, LISTED_BEFORE_MORE);
  return (
    <Modal labelledBy={titleId} onClose={notNow} testId="pull-risk-waiting" className="ib-riskd" ownKeys initialFocus="[data-pull-risk-waiting-not-now]">
      <div data-pull-risk-waiting={count}>
        <h2 id={titleId}>{riskRankPhrase(count, shown.auto.level, true)}</h2>
        <p className="ib-sub ib-riskd-l">{riskTurnedOnWords(shown.auto, count)}</p>
        <ul className="ib-riskq-list">
          {listed.map((line) => (
            <li key={line.key} data-pull-risk-waiting-pull={line.key}>
              {line.title && <span dir="auto">{line.title} </span>}
              <span className="ib-riskq-ref">{line.ref}</span>
            </li>
          ))}
          {listed.length < count && <li className="ib-riskq-ref">+{count - listed.length} more</li>}
        </ul>
        {choice.error && (
          <p className="ib-error" role="alert">
            {choice.error}
          </p>
        )}
        <div className="ib-acts-row ib-riskd-acts">
          <button type="button" className="ib-btn" onClick={notNow} disabled={choice.busy} data-pull-risk-waiting-not-now="">
            Not now
          </button>
          <button type="button" className="ib-btn ib-pri" onClick={() => void choice.makeNow()} disabled={choice.busy} data-pull-risk-waiting-make-now="">
            Make them now
          </button>
        </div>
      </div>
    </Modal>
  );
}
