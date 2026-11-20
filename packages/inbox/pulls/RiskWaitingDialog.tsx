import { useEffect, useId, useRef, useState } from 'react';
import { forgePullRefShort } from '@plannotator/core/forge-ref-card';
import type { InboxPull, InboxPullRiskAnswer, InboxPullRiskAuto } from '@plannotator/core/inbox-types';
import { InboxApiError } from '../apiError';
import { Modal } from '../components/Updates';
import { riskRankPhrase, riskTurnedOnWords, useRankedChoice } from './RiskAlreadyRanked';
import { usePressGate, useSettled } from './riskAskGate';

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
}

function lineOf(key: string, pull: InboxPull | undefined): { title: string | null; ref: string } {
  const at = pull ? pull.repo.lastIndexOf('/') : -1;
  if (!pull || at <= 0) return { title: pull?.title ?? null, ref: key.replace(/^[^/]+\//, '').replace(/#(\d+):pull$/, '!$1') };
  return { title: pull.title, ref: forgePullRefShort({ platform: pull.platform, host: pull.host, owner: pull.repo.slice(0, at), repo: pull.repo.slice(at + 1), number: pull.number }) };
}

export function RiskWaitingDialog({
  answer,
  pulls,
  blocked,
  asked,
  onAnswer,
}: {
  answer: InboxPullRiskAnswer | null;
  pulls: readonly InboxPull[] | null;
  blocked: boolean;
  asked: Set<string>;
  onAnswer: (next: InboxPullRiskAnswer) => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const waiting = riskWaitingKeys(answer).filter((key) => !asked.has(key));
  const settled = useSettled(!blocked && !shown && !!pulls && waiting.length > 0 && !!answer?.auto);
  const waitingId = waiting.join('\n');
  useEffect(() => {
    if (!settled || !answer?.auto || waiting.length === 0) return;
    for (const key of waiting) asked.add(key);
    setShown({ keys: waiting, auto: answer.auto });
  }, [settled, waitingId]);
  const off = !answer?.auto;
  useEffect(() => {
    if (off) setShown(null);
  }, [off]);
  if (!shown || off) return null;
  return <RiskWaitingAsk shown={shown} pulls={pulls ?? []} onAnswer={onAnswer} onClose={() => setShown(null)} />;
}

function RiskWaitingAsk({ shown, pulls, onAnswer, onClose }: { shown: Shown; pulls: readonly InboxPull[]; onAnswer: (next: InboxPullRiskAnswer) => void; onClose: () => void }) {
  const titleId = useId();
  const host = useRef<HTMLDivElement>(null);
  const gate = usePressGate(host);
  const choice = useRankedChoice(shown.keys, (next) => {
    onAnswer(next);
    onClose();
  });
  const [stuck, setStuck] = useState(false);
  const reviewOff = (result: { failed: unknown } | null) => result?.failed instanceof InboxApiError && result.failed.code === 'code_review_off';
  const notNow = () => {
    if (choice.busy || !gate.ok()) return;
    if (stuck) return onClose();
    void choice.notNow().then((result) => {
      if (reviewOff(result)) onClose();
      else if (result) setStuck(true);
    });
  };
  const makeNow = () => {
    if (choice.busy || !gate.ok()) return;
    void choice.makeNow().then((result) => {
      if (reviewOff(result)) onClose();
    });
  };
  const count = shown.keys.length;
  const byKey = new Map(pulls.map((pull) => [pull.key, pull]));
  const listed = count <= RISK_WAITING_LISTED ? shown.keys : shown.keys.slice(0, LISTED_BEFORE_MORE);
  return (
    <Modal labelledBy={titleId} onClose={notNow} testId="pull-risk-waiting" className="ib-riskd" ownKeys initialFocus="[data-pull-risk-waiting-not-now]">
      <div ref={host} data-pull-risk-waiting={count} data-pull-risk-waiting-armed={gate.armed ? '' : undefined}>
        <h2 id={titleId}>{riskRankPhrase(count, shown.auto.level, true)}</h2>
        <p className="ib-sub ib-riskd-l">{riskTurnedOnWords(shown.auto, count)}</p>
        <ul className="ib-riskq-list">
          {listed.map((key) => {
            const line = lineOf(key, byKey.get(key));
            return (
              <li key={key} data-pull-risk-waiting-pull={key}>
                {line.title && <span dir="auto">{line.title} </span>}
                <span className="ib-riskq-ref">{line.ref}</span>
              </li>
            );
          })}
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
          <button type="button" className="ib-btn ib-pri" onClick={makeNow} disabled={choice.busy} data-pull-risk-waiting-make-now="">
            Make them now
          </button>
        </div>
      </div>
    </Modal>
  );
}
