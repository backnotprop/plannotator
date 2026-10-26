import { Fragment, useId } from 'react';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { plural } from '../format';
import { Icon } from '../icons';
import { pickWords, type JumpTarget } from './ReplacedQuestion';
import { Tip } from './Tip';
import { sentAnswersHeading, type SentAnswer, type SentAnswerGroup } from '../sentReply';

/** One answer the reply carries: a pick saved (or being saved) on a card. */
export interface DraftAnswer {
  /** `<message id>/<key>`. */
  id: string;
  messageId: string;
  key: string;
  /** The question's number in its message (Q1, Q2…), as the reply's answers section numbers it. */
  number: number;
  prompt: string;
  /** The answer's words: the pick, Other, the text, a note. */
  answer: string;
  /** The asking message as a group heading shows it ("Claude Code's message, 2:58 PM"): used when answers span several messages. */
  messageName: string;
}

/** The answer's words as the reply box lists them: the card's "Your pick" words, then a note. */
export function draftAnswerWords(answer: QuestionAnswer): string {
  const words = pickWords(answer);
  const note = answer.note?.trim();
  if (!note) return words;
  return words ? `${words} · Note: ${note}` : `Note: ${note}`;
}

/**
 * What the reply carries besides the words (the owner: "When i edit a reply,
 * and then add new answers... do they get added to the reply? Because I dont
 * see them"): every answer picked on the cards, listed live inside the reply
 * box, one row each ("Q2 Should overdue invoices sort to the top? → Yes").
 * A pick made while the box is open shows at once. A row takes the person to
 * its card. The answers are never written into the words: the Send carries
 * them under "Answers to your questions".
 */
export function ReplyAnswers({ answers, onJump }: { answers: readonly DraftAnswer[]; onJump: (target: JumpTarget) => void }) {
  const headingId = useId();
  // Answers to several messages go as one reply each, and each message numbers its own
  // questions (Q1 twice): the rows are grouped under the message they answer.
  const groups: { messageId: string; name: string; rows: DraftAnswer[] }[] = [];
  for (const a of answers) {
    const last = groups.at(-1);
    if (last && last.messageId === a.messageId) last.rows.push(a);
    else groups.push({ messageId: a.messageId, name: a.messageName, rows: [a] });
  }
  const several = groups.length > 1;
  const where = several ? 'your replies' : 'this reply';
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
              <Fragment key={g.messageId}>
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

/**
 * The answers a sent reply carried, under the person's own words (display
 * only: the agent got them as "Answers to your questions" in the body). One
 * row each, "Q1 <prompt> → <answer>", a skip marked as one; grouped under the
 * message that asked when the reply answered several. A row takes the person
 * to its card. The prompt and answer are cut with an ellipsis and shown whole
 * in a tooltip.
 */
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
              <Fragment key={g.messageId}>
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
