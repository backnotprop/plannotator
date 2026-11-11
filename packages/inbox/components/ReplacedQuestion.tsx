import { useEffect, useId, useRef, useState } from 'react';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { QuestionContext } from '@plannotator/ui/components/blocks/QuestionContext';
import type { InboxAuthor, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { agentName, whenTime } from '../format';
import { plainLabel } from '../folding';
import { Icon } from '../icons';

export interface Replacement {
  by: InboxQuestion | null;
  message: Pick<InboxMessageWire, 'id' | 'created_at'> & { author: InboxAuthor };
}

export type JumpTarget = { kind: 'question' | 'action'; messageId: string; key: string } | { kind: 'message'; messageId: string };

export function pickWords(answer: QuestionAnswer): string {
  if (answer.skipped) return 'Skipped';
  const parts = answer.selected.map(plainLabel);
  if (answer.other) parts.push(answer.other);
  if (answer.text) parts.push(answer.text);
  return parts.join(', ');
}

export function replacementOf(messages: readonly InboxMessageWire[], question: InboxQuestion): Replacement | null {
  const by = question.superseded_by;
  if (!by) return null;
  const message = messages.find((m) => m.id === by.message_id);
  if (!message) return null;
  const replacing = by.key ? (message.questions ?? []).find((q) => q.key === by.key) ?? null : null;
  return { by: replacing, message };
}

export function replacedBy(messages: readonly InboxMessageWire[], question: InboxQuestion): InboxQuestion[] {
  const out: InboxQuestion[] = [];
  for (const message of messages) {
    for (const q of message.questions ?? []) {
      if (q.superseded_by?.message_id === question.message_id && q.superseded_by.key === question.key) out.push(q);
    }
  }
  return out;
}

function JumpLink({ children, arrow, onJump, label }: { children: React.ReactNode; arrow: '↑' | '↓'; onJump: () => void; label?: string }) {
  // An inline element with the button role, not a <button>: a button lays out
  // as one box, so a long prompt broke the sentence around it and left its
  // period alone on a line. This one wraps with the text like a link.
  return (
    <span
      role="button"
      tabIndex={0}
      className="ib-q-link"
      onClick={onJump}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onJump();
      }}
      aria-label={label}
    >
      {children}
      <span className="ib-q-arrow" aria-hidden="true">
        {arrow}
      </span>
    </span>
  );
}

export function ReplacedTag({ replaced }: { replaced: boolean }) {
  return (
    <span className="ib-tag ib-t-repl" data-replaced-tag="">
      <Icon name="turnDown" size={10} />
      {replaced ? 'Replaced' : 'No longer applies'}
    </span>
  );
}

export function ReplacedQuestionCard({
  question,
  number,
  total,
  replacement,
  answer,
  onJump,
  refRepo,
}: {
  question: InboxQuestion;
  number: number;
  total: number;
  replacement: Replacement;
  answer: QuestionAnswer | null;
  onJump: (target: JumpTarget) => void;
  refRepo?: { display: string; host?: string } | null;
}) {
  const id = useId();
  const repo = { githubRepo: refRepo?.display, repoHost: refRepo?.host };
  const [open, setOpen] = useState(false);
  const promptId = `${id}-p`;
  const newsId = `${id}-news`;
  const panelId = `${id}-old`;
  const at = whenTime(replacement.message.created_at);
  const picked = answer && !answer.skipped ? new Set(answer.selected) : new Set<string>();
  return (
    <fieldset
      className="ib-q ib-q-sup"
      tabIndex={-1}
      aria-labelledby={promptId}
      aria-describedby={newsId}
      data-question-state="superseded"
      data-question-key={question.key}
      data-message-id={question.message_id}
    >
      <div className="ib-q-top">
        <span className="ib-q-eye">
          Question {number} of {total}
        </span>
        <span className="ib-q-tags">
          <ReplacedTag replaced={replacement.by !== null} />
        </span>
      </div>
      <p className="ib-q-prompt" id={promptId}>
        <InlineMarkdown text={question.prompt} {...repo} />
      </p>
      <div className="ib-q-repl" id={newsId} data-replaced-row="">
        <Icon name="turnDown" size={14} />
        {replacement.by ? (
          <span>
            Replaced at {at} by{' '}
            <JumpLink arrow="↓" onJump={() => onJump({ kind: 'question', messageId: replacement.by!.message_id, key: replacement.by!.key })}>
              {replacement.by.prompt}
            </JumpLink>
          </span>
        ) : (
          <span>
            {agentName(replacement.message.author)} said at {at} that this no longer applies.{' '}
            <JumpLink arrow="↓" onJump={() => onJump({ kind: 'message', messageId: replacement.message.id })}>
              Read why
            </JumpLink>
          </span>
        )}
      </div>
      {answer && (
        <p className="ib-q-unsent" data-unsent-pick="">
          Your pick: <b>{pickWords(answer)}</b>
          <span className="ib-tag ib-t-notsent">Not sent</span>
        </p>
      )}
      <button type="button" className="ib-q-disclose" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevD' : 'chevR'} size={13} />
        {open ? 'Hide the old options' : 'Show the old options'}
      </button>
      <div id={panelId} hidden={!open} data-old-options="">
        {question.context && <QuestionContext id={`${id}-ctx`} markdown={question.context} />}
        {question.choices.length > 0 ? (
          <div className="ib-q-opts" role={question.kind === 'multi' ? 'group' : 'radiogroup'} aria-labelledby={promptId} aria-disabled="true">
            {question.choices.map((choice) => {
              const on = picked.has(choice.label);
              return (
                <label className={`ib-q-opt${on ? ' ib-on' : ''}`} key={choice.label}>
                  <input type={question.kind === 'multi' ? 'checkbox' : 'radio'} disabled checked={on} readOnly name={`${id}-old`} />
                  <span className="ib-q-lbl">
                    <b>
                      <InlineMarkdown text={choice.label} {...repo} />
                    </b>
                    {choice.description && (
                      <span className="ib-q-desc">
                        {' '}
                        — <InlineMarkdown text={choice.description} {...repo} />
                      </span>
                    )}
                    {on && <span className="ib-tag ib-t-notsent">Not sent</span>}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

export function ReplacesLine({ old, onJump }: { old: readonly InboxQuestion[]; onJump: (target: JumpTarget) => void }) {
  if (old.length === 0) return null;
  const dropped = old.filter((q) => q.answer !== null).length;
  return (
    <p className="ib-q-replaces annotation-exclude" data-replaces-line="" data-pinpoint-ignore="">
      <Icon name="reply" size={13} />
      <span>
        Replaces{' '}
        {old.map((q, index) => (
          <span key={`${q.message_id}/${q.key}`}>
            {index > 0 && (index === old.length - 1 ? ' and ' : ', ')}
            <JumpLink arrow="↑" onJump={() => onJump({ kind: 'question', messageId: q.message_id, key: q.key })}>
              {q.prompt}
            </JumpLink>
          </span>
        ))}
        {dropped > 0 ? (dropped === 1 && old.length === 1 ? '. Your pick there was not sent.' : `. Your ${dropped === 1 ? 'pick' : 'picks'} there ${dropped === 1 ? 'was' : 'were'} not sent.`) : '.'}
      </span>
    </p>
  );
}

function questionName(question: InboxQuestion, capital = true): string {
  return `${capital ? 'Question' : 'question'} ${question.position + 1}`;
}

export function ChangedNotice({
  questions,
  thread,
  onJump,
}: {
  questions: readonly InboxQuestion[];
  thread: { messages: readonly InboxMessageWire[] };
  onJump: (target: JumpTarget) => void;
}) {
  const first = questions[0];
  const replacement = first ? replacementOf(thread.messages, first) : null;
  if (!first || !replacement) return null;
  const agent = agentName(replacement.message.author);
  const at = whenTime(replacement.message.created_at);
  const many = questions.length > 1;
  const which = many ? `${questions.length} questions you picked on` : questionName(first, false);
  return (
    <div className="ib-q-changed" role="status" data-replaced-notice="">
      <Icon name="warn" size={15} />
      <span>
        {replacement.by ? `${agent} replaced ${which} at ${at}. ` : `${agent} said at ${at} that ${which} no longer ${many ? 'apply' : 'applies'}. `}
        {many ? "Your picks on them won't be sent. " : "Your pick on it won't be sent. "}
        {replacement.by ? (
          <button type="button" className="ib-vlink" onClick={() => onJump({ kind: 'question', messageId: replacement.by!.message_id, key: replacement.by!.key })}>
            See the new question
          </button>
        ) : (
          <button type="button" className="ib-vlink" onClick={() => onJump({ kind: 'message', messageId: replacement.message.id })}>
            Read why
          </button>
        )}
      </span>
    </div>
  );
}

export function StaleGuard({
  ref,
  questions,
  thread,
  words,
  otherPicks,
  annotations,
  onAnswerNew,
  onSendAnyway,
  onKeepEditing,
}: {
  ref?: React.Ref<HTMLDivElement>;
  questions: readonly InboxQuestion[];
  thread: { messages: readonly InboxMessageWire[] };
  words: string;
  otherPicks: number;
  annotations: number;
  onAnswerNew: (target: JumpTarget) => void;
  onSendAnyway: () => void;
  onKeepEditing: () => void;
}) {
  const id = useId();
  const own = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    own.current?.focus();
  }, []);
  const first = questions[0]!;
  const firstReplacement = replacementOf(thread.messages, first);
  const rest = [
    words ? 'your words' : '',
    otherPicks > 0 ? `${otherPicks} other ${otherPicks === 1 ? 'pick' : 'picks'}` : '',
    annotations > 0 ? `${annotations} ${annotations === 1 ? 'comment' : 'comments'}` : '',
  ].filter(Boolean);
  const restText = rest.length > 1 ? `${rest.slice(0, -1).join(', ')} and ${rest.at(-1)}` : (rest[0] ?? '');
  const heading = questions.length === 1 ? `${questionName(first)} changed before you sent` : `${questions.length} questions changed before you sent`;
  return (
    <div
      className="ib-guard"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`${id}-h`}
      aria-describedby={`${id}-d`}
      tabIndex={-1}
      data-stale-guard=""
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = node;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onKeepEditing();
        }
      }}
    >
      <h3 id={`${id}-h`}>
        <Icon name="warn" />
        {heading}
      </h3>
      <div id={`${id}-d`}>
        {questions.map((q) => {
          const replacement = replacementOf(thread.messages, q);
          if (!replacement) return null;
          const agent = agentName(replacement.message.author);
          const at = whenTime(replacement.message.created_at);
          return (
            <p key={`${q.message_id}/${q.key}`}>
              {replacement.by ? (
                <>
                  {agent} replaced <b>{q.prompt}</b> at {at}.
                </>
              ) : (
                <>
                  {agent} said at {at} that <b>{q.prompt}</b> no longer applies.
                </>
              )}{' '}
              {q.answer ? (
                <>
                  Your pick, <b>{pickWords(q.answer)}</b>, will not be sent.
                </>
              ) : (
                'Your pick on it will not be sent.'
              )}
            </p>
          );
        })}
        <p className="ib-mut">
          {words
            ? 'Your words still go if you send. They were written for the old question, so check they still fit.'
            : rest.length > 0
              ? 'The rest of this reply still goes if you send.'
              : 'Nothing else is in this reply yet.'}
        </p>
      </div>
      <div className="ib-acts">
        {firstReplacement?.by ? (
          <button
            type="button"
            className="ib-btn ib-pri"
            data-guard-answer-new=""
            onClick={() => onAnswerNew({ kind: 'question', messageId: firstReplacement.by!.message_id, key: firstReplacement.by!.key })}
          >
            <Icon name="arrowDown" size={15} />
            Answer the new question
          </button>
        ) : firstReplacement ? (
          <button type="button" className="ib-btn ib-pri" data-guard-answer-new="" onClick={() => onAnswerNew({ kind: 'message', messageId: firstReplacement.message.id })}>
            <Icon name="arrowDown" size={15} />
            Read why
          </button>
        ) : null}
        {rest.length > 0 && (
          <button type="button" className="ib-btn" data-guard-send-rest="" onClick={onSendAnyway}>
            Send {restText} only
          </button>
        )}
        <button type="button" className="ib-btn ib-ghost" data-guard-keep-editing="" onClick={onKeepEditing}>
          Keep editing
        </button>
      </div>
    </div>
  );
}
