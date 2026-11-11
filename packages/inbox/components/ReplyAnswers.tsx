import { Fragment, useId } from 'react';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { plural } from '../format';
import { Icon } from '../icons';
import { pickWords, type JumpTarget } from './ReplacedQuestion';
import { Tip } from './Tip';
import { sentAnswersHeading, type SentAnswer, type SentAnswerGroup } from '../sentReply';

export interface DraftAnswer {
  id: string;
  messageId: string;
  key: string;
  number: number;
  prompt: string;
  answer: string;
  messageName: string;
  fileId?: string;
}

export function draftAnswerWords(answer: QuestionAnswer): string {
  const words = pickWords(answer);
  const note = answer.note?.trim();
  if (!note) return words;
  return words ? `${words} · Note: ${note}` : `Note: ${note}`;
}

export function ReplyAnswers({ answers, onJump }: { answers: readonly DraftAnswer[]; onJump: (target: JumpTarget) => void }) {
  const headingId = useId();
  // Each message numbers its own questions (Q1 twice), so rows are grouped under the message they answer.
  const groups: { id: string; messageId: string; name: string; rows: DraftAnswer[] }[] = [];
  for (const a of answers) {
    const last = groups.at(-1);
    const id = `${a.messageId}/${a.fileId ?? ''}`;
    if (last && last.id === id) last.rows.push(a);
    else groups.push({ id, messageId: a.messageId, name: a.messageName, rows: [a] });
  }
  const several = groups.length > 1;
  const where = new Set(groups.map((g) => g.messageId)).size > 1 ? 'your replies' : 'this reply';
  const heading = answers.length === 1 ? `Your answer goes with ${where}` : `Your ${plural(answers.length, 'answer')} go with ${where}`;
  const row = (a: DraftAnswer) => (
    <li key={a.id}>
      <button
        type="button"
        className="ib-ranswer"
        data-reply-answer={a.id}
        aria-label={`Q${a.number}, ${a.prompt}: ${a.answer}.${several ? ` ${a.messageName}.` : ''} Show the question.`}
        onClick={() => onJump({ kind: 'question', messageId: a.messageId, key: a.key })}
      >
        <span className="ib-ranswer-n">Q{a.number}</span>{' '}
        <Tip content={a.prompt} cut>
          <span className="ib-ranswer-p">{a.prompt}</span>
        </Tip>{' '}
        <Tip content={a.answer} cut>
          <span className="ib-ranswer-a">{a.answer}</span>
        </Tip>
      </button>
    </li>
  );
  return (
    <div className="ib-ranswers" data-reply-answers="" role="group" aria-labelledby={headingId}>
      <p className="ib-ranswers-h" id={headingId}>
        <Icon name="check" size={13} />
        {heading}
      </p>
      <ul className="ib-ranswers-l">
        {several
          ? groups.map((g) => (
              <Fragment key={g.id}>
                <li className="ib-ranswers-g" data-reply-answers-group={g.messageId} aria-hidden="true">
                  {g.name}
                </li>
                {g.rows.map(row)}
              </Fragment>
            ))
          : answers.map(row)}
      </ul>
    </div>
  );
}

export function SentAnswers({ groups, onJump }: { groups: readonly SentAnswerGroup[]; onJump?: (target: JumpTarget) => void }) {
  const headingId = useId();
  if (groups.length === 0) return null;
  const several = groups.length > 1;
  const row = (a: SentAnswer, group: SentAnswerGroup) => {
    const inner = (
      <>
        <span className="ib-ranswer-n">Q{a.number}</span>{' '}
        <Tip content={a.prompt} cut>
          <span className="ib-ranswer-p">{a.prompt}</span>
        </Tip>{' '}
        <Tip content={a.answer} cut>
          <span className={a.skipped ? 'ib-ranswer-a ib-ranswer-skip' : 'ib-ranswer-a'} data-sent-skipped={a.skipped ? '' : undefined}>
            {a.answer}
          </span>
        </Tip>
      </>
    );
    const label = `Q${a.number}, ${a.prompt}: ${a.answer}.${several ? ` ${group.name}.` : ''}`;
    return (
      <li key={a.id}>
        {onJump ? (
          <button
            type="button"
            className="ib-ranswer"
            data-sent-answer={a.id}
            aria-label={`${label} Show the question.`}
            onClick={() => onJump({ kind: 'question', messageId: a.messageId, key: a.key })}
          >
            {inner}
          </button>
        ) : (
          <div className="ib-ranswer" data-sent-answer={a.id} aria-label={label} role="group">
            {inner}
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="ib-ranswers ib-sentanswers" data-sent-answers="" role="group" aria-labelledby={headingId}>
      <p className="ib-ranswers-h" id={headingId}>
        <Icon name="check" size={13} />
        {sentAnswersHeading(groups)}
      </p>
      <ul className="ib-ranswers-l">
        {several
          ? groups.map((g) => (
              <Fragment key={`${g.messageId}/${g.file?.id ?? ''}`}>
                <li className="ib-ranswers-g" data-sent-answers-group={g.messageId} aria-hidden="true">
                  {g.name}
                </li>
                {g.answers.map((a) => row(a, g))}
              </Fragment>
            ))
          : groups[0]!.answers.map((a) => row(a, groups[0]!))}
      </ul>
    </div>
  );
}

export interface ActionRow {
  id: string;
  messageId: string;
  number: number;
  prompt: string;
  outcome: 'done' | 'cant';
  note: string | null;
  seen?: boolean;
}

export function actionRowWords(a: Pick<ActionRow, 'outcome' | 'note' | 'seen'>): string {
  if (a.seen) return a.note ? `Seen done · ${a.outcome === 'cant' ? 'Your reason' : 'Note'}: ${a.note}` : 'Seen done';
  if (a.outcome === 'cant') return `Can't do it${a.note ? `: ${a.note}` : ''}`;
  return a.note ? `Done · Note: ${a.note}` : 'Done';
}

export function ReplyActions({ actions, sent = false, onJump }: { actions: readonly ActionRow[]; sent?: boolean; onJump?: (target: JumpTarget) => void }) {
  const headingId = useId();
  if (actions.length === 0) return null;
  // Counted by the person's own mark: a Can't do it the agent then saw done is one they couldn't do.
  const done = actions.filter((a) => a.outcome === 'done').length;
  const cant = actions.length - done;
  const heading = sent
    ? done > 0 && cant > 0
      ? `You did ${plural(done, 'action item')}, couldn't do ${cant}`
      : done > 0
        ? `You did ${plural(done, 'action item')}`
        : `You couldn't do ${plural(cant, 'action item')}`
    : actions.length === 1
      ? 'Your action item goes with this reply'
      : `Your ${plural(actions.length, 'action item')} go with this reply`;
  const inner = (a: ActionRow) => (
    <>
      <span className="ib-ranswer-n">A{a.number}</span>{' '}
      <Tip content={a.prompt} cut>
        <span className="ib-ranswer-p">{a.prompt}</span>
      </Tip>{' '}
      <Tip content={actionRowWords(a)} cut>
        <span className="ib-ranswer-a" data-action-row-outcome={a.outcome}>
          {actionRowWords(a)}
        </span>
      </Tip>
    </>
  );
  return (
    <div className={sent ? 'ib-ranswers ib-sentanswers' : 'ib-ranswers'} data-reply-actions={sent ? 'sent' : 'draft'} role="group" aria-labelledby={headingId}>
      <p className="ib-ranswers-h" id={headingId}>
        <Icon name="check" size={13} />
        {heading}
      </p>
      <ul className="ib-ranswers-l">
        {actions.map((a) => (
          <li key={a.id}>
            {onJump ? (
              <button
                type="button"
                className="ib-ranswer"
                aria-label={`A${a.number}, ${a.prompt}: ${actionRowWords(a)}. Show the action item.`}
                onClick={() => onJump({ kind: 'message', messageId: a.messageId })}
              >
                {inner(a)}
              </button>
            ) : (
              <div className="ib-ranswer" role="group" aria-label={`A${a.number}, ${a.prompt}: ${actionRowWords(a)}.`}>
                {inner(a)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
