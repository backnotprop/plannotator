import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxDecision, InboxDecisionDraft, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import type { IndexedQuestion, QuestionAnswer } from '@plannotator/core/question-block';
import { inboxDecisionWords } from '@plannotator/core/inbox-questions';
import { InboxApiError, inboxApi } from '../api';
import { agentName, clockTime, plural } from '../format';
import { AuthorMark, DecisionDiamond, Icon } from '../icons';
import { DecisionCard } from './DecisionCard';

const noop = () => {};
const NO_ANNOTATIONS: never[] = [];

/** The words an answer reads as in a reply draft: "Retry with the same idempotency key". */
function answerWords(answer: QuestionAnswer): string {
  if (answer.skipped) return 'skipped';
  const parts = [...answer.selected];
  if (answer.other) parts.push(answer.other);
  if (answer.text) parts.push(answer.text);
  return parts.join(', ');
}

function MessageBody({
  message,
  readOnly,
  answers,
  onPick,
  footerFor,
  recordingOf,
  onToggleDecision,
  onOpenDecision,
}: {
  message: InboxMessageWire;
  readOnly: boolean;
  answers: ReadonlyMap<string, QuestionAnswer>;
  onPick: (key: string, answer: QuestionAnswer | null) => void;
  footerFor: (key: string) => string | null;
  /** The switch's state per question key (the stored one, or a click not yet saved). */
  recordingOf: (key: string) => boolean | undefined;
  onToggleDecision: (key: string, next: boolean) => void;
  onOpenDecision: (key: string, anchor: HTMLElement) => void;
}) {
  const blocks = useMemo(() => parseMarkdownToBlocks(message.body, { frontmatter: false }), [message.body]);
  const renderFooter = useCallback(
    (question: IndexedQuestion) => {
      const text = footerFor(question.question.key);
      return text ? <span className="ib-qfoot-st">{text}</span> : null;
    },
    [footerFor],
  );
  // Every question carries the tag (the record's 3.1): its switch is kept on
  // the question record (on by default where the block says `Decision: when
  // answered`, off elsewhere); a linked decision (`Decision: [statement](url)`)
  // is already recorded and keeps its own tag.
  const recording = useCallback(
    (question: IndexedQuestion) => (question.question.decision ? undefined : recordingOf(question.question.key)),
    [recordingOf],
  );
  // Read-only per question: a sent answer's tag is a plain tag while an open
  // question in the same message keeps its switch and card.
  const locked = useCallback(
    (question: IndexedQuestion) => {
      const wire = message.questions?.find((q) => q.key === question.question.key);
      return wire !== undefined && (wire.state === 'sent' || wire.decision_id !== null);
    },
    [message.questions],
  );

  return (
    <div className="ib-body" data-message-id={message.id}>
      <Viewer
        blocks={blocks}
        markdown={message.body}
        annotations={NO_ANNOTATIONS}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        answerOnly
        readOnly={readOnly}
        questionAnswers={answers}
        onAnswerQuestion={(_blockId, answer, key) => onPick(key, answer)}
        renderQuestionFooter={renderFooter}
        questionDecisionScope="any"
        questionDecisionRecording={recording}
        onToggleQuestionDecisionRecording={onToggleDecision}
        onOpenQuestionDecision={onOpenDecision}
        questionDecisionLocked={locked}
      />
    </div>
  );
}

export interface ThreadPaneProps {
  thread: InboxThread;
  /**
   * The thread's list row's `sent`: the person's reply is the last message,
   * and when the agent read it (by the store's seq, so a reply the agent was
   * not given still reads as unread), or null.
   */
  sent: { at: string; checked_at: string | null } | null;
  /** The thread's questions changed through a pick (the response's questions for that message). */
  onQuestions: (messageId: string, questions: InboxQuestion[]) => void;
  /** Something was written (a Send, resolve): read the thread and the list again. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  /** The decisions this thread's questions recorded (the "Settled: ..." lines). */
  decisions: readonly InboxDecision[];
  /** Open a recorded decision on the Decisions page. */
  onOpenDecisionPage: (decision: InboxDecision) => void;
}

export function ThreadPane({ thread, sent, onQuestions, onChanged, onClose, decisions, onOpenDecisionPage }: ThreadPaneProps) {
  const root = thread.messages[0]!;
  const asker = agentName(root.author);
  const resolved = thread.resolved_at !== null;
  const agentMessages = thread.messages.filter((m) => m.author.kind === 'agent');
  const lastAgent = agentMessages[agentMessages.length - 1] ?? root;

  // Picks saved at once; shown before the server answers, then from the server.
  const [pending, setPending] = useState<ReadonlyMap<string, QuestionAnswer | null>>(new Map());
  const pickChain = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map<string, number>());
  const threadRef = useRef(thread);
  threadRef.current = thread;

  /** Switch clicks shown before the server answers, `<message id>/<key>` to on or off. */
  const [switching, setSwitching] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** The decision card open on one question, under the tag's words. */
  const [card, setCard] = useState<{ messageId: string; key: string; anchor: HTMLElement } | null>(null);
  /** Decisions a Send could not record (the answers stay sent). */
  const [refused, setRefused] = useState<{ key: string; message: string }[]>([]);
  const [box, setBox] = useState<{ open: boolean; text: string }>({ open: false, text: '' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendKeys = useRef<Map<string, string> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Another thread: nothing of the last one carries over.
    setPending(new Map());
    setBox({ open: false, text: '' });
    setError(null);
    setSwitching(new Map());
    setCard(null);
    setRefused([]);
    sendKeys.current = null;
    revisions.current.clear();
    bodyRef.current?.scrollTo({ top: 0 });
  }, [thread.thread_id]);

  useEffect(() => {
    if (box.open) textRef.current?.focus();
  }, [box.open]);

  const questionById = (id: string): InboxQuestion | undefined => {
    for (const message of threadRef.current.messages) {
      for (const q of message.questions ?? []) if (`${q.message_id}/${q.key}` === id) return q;
    }
    return undefined;
  };

  const pick = (messageId: string, key: string, answer: QuestionAnswer | null) => {
    const id = `${messageId}/${key}`;
    setPending((current) => new Map(current).set(id, answer));
    setError(null);
    pickChain.current = pickChain.current.then(async () => {
      const known = questionById(id);
      const revision = Math.max(revisions.current.get(id) ?? 0, known?.revision ?? 0);
      try {
        const result = await inboxApi.pick(messageId, key, revision, answer);
        for (const q of result.questions) revisions.current.set(`${q.message_id}/${q.key}`, q.revision);
        onQuestions(messageId, result.questions);
      } catch (cause) {
        setError(cause instanceof InboxApiError ? cause.message : 'The pick was not saved.');
        await onChanged();
      } finally {
        setPending((current) => {
          if (!current.has(id) || current.get(id) !== answer) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }
    });
  };

  const answersOf = (message: InboxMessageWire): Map<string, QuestionAnswer> => {
    const out = new Map<string, QuestionAnswer>();
    for (const q of message.questions ?? []) {
      const id = `${message.id}/${q.key}`;
      const answer = pending.has(id) ? pending.get(id)! : q.answer;
      if (answer) out.set(q.key, answer);
    }
    return out;
  };

  const sentAt = (replyId: string | null): string | null => {
    const reply = replyId ? thread.messages.find((m) => m.id === replyId) : undefined;
    return reply ? reply.created_at : null;
  };

  const footerFor = (message: InboxMessageWire) => (key: string): string | null => {
    const q = message.questions?.find((x) => x.key === key);
    if (!q) return null;
    if (q.state === 'sent') {
      const at = sentAt(q.sent_reply_id);
      return at ? `Sent ${clockTime(at)}` : 'Sent';
    }
    if (q.state === 'picked' && q.picked_at) return `Picked ${clockTime(q.picked_at)}, not sent`;
    return null;
  };

  /** The question as the server last answered, with one question replaced. */
  const patchQuestion = (question: InboxQuestion) => {
    const message = threadRef.current.messages.find((m) => m.id === question.message_id);
    if (!message) return;
    onQuestions(message.id, (message.questions ?? []).map((q) => (q.key === question.key ? question : q)));
  };

  const recordingOf = (message: InboxMessageWire) => (key: string): boolean | undefined => {
    const id = `${message.id}/${key}`;
    if (switching.has(id)) return switching.get(id);
    return message.questions?.find((q) => q.key === key)?.decision_recording;
  };

  /** The tag's diamond: saved on the question at once, like a pick. */
  const toggleDecision = (messageId: string) => (key: string, next: boolean) => {
    const id = `${messageId}/${key}`;
    setSwitching((current) => new Map(current).set(id, next));
    setError(null);
    void inboxApi
      .setDecision(messageId, key, { recording: next })
      .then((result) => patchQuestion(result.question))
      .catch(async (cause) => {
        setError(cause instanceof InboxApiError ? cause.message : 'The switch was not saved.');
        await onChanged();
      })
      .finally(() =>
        setSwitching((current) => {
          if (current.get(id) !== next) return current;
          const updated = new Map(current);
          updated.delete(id);
          return updated;
        }),
      );
  };

  const openDecision = (messageId: string) => (key: string, anchor: HTMLElement) => setCard({ messageId, key, anchor });

  /** Done on the card: keep its words on the question and turn recording on. */
  const keepDecision = async (messageId: string, key: string, draft: InboxDecisionDraft | null) => {
    try {
      const result = await inboxApi.setDecision(messageId, key, { recording: true, draft });
      patchQuestion(result.question);
      setCard(null);
    } catch (cause) {
      throw new Error(cause instanceof InboxApiError ? cause.message : 'The decision was not kept.');
    }
  };

  // What a Send carries: every picked, unsent answer, per message.
  const picked = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === 'picked'));
  const picksCount = picked.length;

  const openBox = (withDraft: boolean) => {
    const draft = withDraft ? picked.map((q) => (q.answer ? `${q.prompt.replace(/[?.!]\s*$/, '')}: ${answerWords(q.answer)}.` : '')).filter(Boolean).join(' ') : '';
    setBox({ open: true, text: draft });
    setError(null);
  };

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await pickChain.current;
      const current = threadRef.current;
      const words = box.open ? box.text.trim() : '';
      const targets = current.messages
        .filter((m) => m.author.kind === 'agent' && (m.questions ?? []).some((q) => q.state === 'picked'))
        .map((m) => ({
          message: m,
          questions: (m.questions ?? []).filter((q) => q.state === 'picked').map((q) => ({ key: q.key, revision: q.revision })),
        }));
      if (targets.length === 0) {
        if (!words) {
          setError('Write a reply or pick an answer first.');
          return;
        }
        const last = current.messages.filter((m) => m.author.kind === 'agent').at(-1) ?? current.messages[0]!;
        targets.push({ message: last, questions: [] });
      }
      if (!sendKeys.current) sendKeys.current = new Map(targets.map((t) => [t.message.id, crypto.randomUUID()]));
      const notRecorded: { key: string; message: string }[] = [];
      for (const [index, target] of targets.entries()) {
        const result = await inboxApi.reply(target.message.id, {
          idempotency_key: sendKeys.current.get(target.message.id) ?? crypto.randomUUID(),
          words: index === targets.length - 1 ? words : '',
          questions: target.questions,
        });
        notRecorded.push(...result.decisions_refused);
      }
      setRefused(notRecorded);
      sendKeys.current = null;
      setBox({ open: false, text: '' });
      await onChanged();
      // The reply and where it is now sit at the foot of the thread.
      requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }));
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The reply was not sent. Send again to retry.');
    } finally {
      setSending(false);
    }
  };

  const resolve = async (next: boolean) => {
    setError(null);
    try {
      await inboxApi.resolve(root.id, next);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The thread did not change.');
    }
  };

  // The last message is the person's: say where it is.
  const last = thread.messages[thread.messages.length - 1]!;
  const delivered =
    last.author.kind === 'person'
      ? sent?.checked_at
        ? `Delivered to ${asker}, ${clockTime(sent.checked_at)}`
        : `Saved for ${asker}. It sees it when it checks.`
      : null;

  const waitingHoldsUp = [...new Set(lastAgent.questions?.filter((q) => q.state === 'open').flatMap((q) => q.holds_up) ?? [])];
  const [holdsOpen, setHoldsOpen] = useState(false);

  return (
    <section className="ib-pane" aria-label={thread.subject ?? 'Thread'} data-thread-id={thread.thread_id}>
      <div className="ib-phead">
        <button
          type="button"
          className="ib-iconbtn"
          onClick={() => void resolve(!resolved)}
          title={resolved ? 'Reopen the thread' : 'Resolve the thread'}
          aria-label={resolved ? 'Reopen the thread' : 'Resolve the thread'}
        >
          <Icon name="archive" />
        </button>
        <span className="ib-sp" />
        <button type="button" className="ib-iconbtn" onClick={onClose} title="Close" aria-label="Close the thread">
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-pbody" ref={bodyRef}>
        <h2 className="ib-subject">{thread.subject ?? '(no subject)'}</h2>
        {thread.messages.map((message) => {
          const isAgent = message.author.kind === 'agent';
          const questions = message.questions ?? [];
          const allSent = questions.length > 0 && questions.every((q) => q.state === 'sent');
          return (
            <article className="ib-message" key={message.id} data-author={message.author.kind}>
              <div className="ib-sender">
                {isAgent ? (
                  <AuthorMark author={message.author} big />
                ) : (
                  <span className="ib-mk ib-big">
                    <Icon name="reply" />
                  </span>
                )}
                <div>
                  <div className="ib-who">
                    {isAgent ? agentName(message.author) : 'You'} <span>in {thread.project.name}</span>
                  </div>
                  <div className="ib-to">to {isAgent ? 'you' : asker}</div>
                </div>
                <div className="ib-tm">
                  {clockTime(message.created_at)}
                  {isAgent && !resolved && (
                    <button type="button" className="ib-mut" onClick={() => openBox(picksCount > 0)} title="Reply" aria-label="Reply">
                      <Icon name="reply" size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="ib-msg">
                <MessageBody
                  message={message}
                  readOnly={!isAgent || resolved || questions.length === 0 || allSent}
                  answers={answersOf(message)}
                  onPick={(key, answer) => pick(message.id, key, answer)}
                  footerFor={footerFor(message)}
                  recordingOf={recordingOf(message)}
                  onToggleDecision={toggleDecision(message.id)}
                  onOpenDecision={openDecision(message.id)}
                />
                {questions.map((q) => {
                  const decision = q.decision_id ? decisions.find((d) => d.id === q.decision_id) : undefined;
                  if (!decision) return null;
                  return (
                    <p className="ib-settled" key={q.key} data-question-settled={q.key}>
                      <DecisionDiamond />
                      <span>
                        Settled:{' '}
                        <a
                          href={`#decisions=${decision.project_id}&decision=${decision.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            onOpenDecisionPage(decision);
                          }}
                        >
                          {decision.text}
                        </a>
                      </span>
                    </p>
                  );
                })}
                {message === lastAgent && !resolved && waitingHoldsUp.length > 0 && (
                  <div className="ib-waitfoot">
                    <b>Waiting on this answer</b>
                    <span className="ib-badge">Holds up {waitingHoldsUp.length}</span>
                    <span className="ib-sp" />
                    <button type="button" className="ib-mut" onClick={() => setHoldsOpen((v) => !v)} aria-expanded={holdsOpen}>
                      {holdsOpen ? 'Hide' : 'Show'} <Icon name={holdsOpen ? 'chevR' : 'chevD'} size={14} />
                    </button>
                  </div>
                )}
                {message === lastAgent && holdsOpen && waitingHoldsUp.length > 0 && (
                  <ul className="ib-holds">
                    {waitingHoldsUp.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                )}
                {message === last && delivered && (
                  <div className="ib-delivered" data-delivery={delivered.startsWith('Delivered') ? 'delivered' : 'saved'}>
                    <Icon name="check" size={14} />
                    {delivered}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <div className="ib-pfoot">
        {resolved ? (
          <div className="ib-acts">
            <span className="ib-st">Resolved</span>
            <button type="button" className="ib-btn" onClick={() => void resolve(false)}>
              Reopen
            </button>
          </div>
        ) : box.open ? (
          <>
            <div className="ib-reply-l">
              Reply to {asker} in {thread.project.name}
            </div>
            <div className="ib-rbox">
              <textarea
                ref={textRef}
                className="ib-rtext"
                aria-label={`Reply to ${asker}`}
                placeholder="Write a reply"
                value={box.text}
                rows={2}
                onChange={(event) => setBox({ open: true, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  } else if (event.key === 'Escape') {
                    event.stopPropagation();
                    setBox({ open: false, text: '' });
                  }
                }}
              />
              {picksCount > 0 && (
                <div className="ib-rfoot">
                  <span className="ib-rchip" data-picks-chip="">
                    <Icon name="check" size={13} />
                    {plural(picksCount, 'pick')}
                  </span>
                </div>
              )}
            </div>
            <div className="ib-acts">
              <button type="button" className="ib-btn ib-pri" onClick={() => void send()} disabled={sending}>
                <Icon name="send" size={15} />
                Send
              </button>
              <button type="button" className="ib-btn ib-ghost" onClick={() => setBox({ open: false, text: '' })}>
                Cancel
              </button>
              <span className="ib-sp" />
              <NewMessageButton />
            </div>
          </>
        ) : (
          <div className="ib-acts">
            {picksCount > 0 && <span className="ib-st">Not sent</span>}
            {picksCount > 0 && (
              <button type="button" className="ib-btn ib-pri" onClick={() => void send()} disabled={sending}>
                <Icon name="send" size={15} />
                Send
              </button>
            )}
            <button type="button" className="ib-btn" onClick={() => openBox(picksCount > 0)}>
              <Icon name="reply" size={15} />
              {picksCount > 0 ? 'Edit the reply' : 'Reply'}
            </button>
            <NewMessageButton />
          </div>
        )}
        {error && (
          <div className="ib-error" role="alert">
            {error}
          </div>
        )}
        {refused.map((entry) => (
          <div className="ib-error" role="status" key={entry.key} data-question-decision-refused={entry.key}>
            Not recorded as a decision: {entry.message.replace(/\.$/, '')}. The answer was sent.
          </div>
        ))}
      </div>
      {card && <ThreadDecisionCard thread={thread} card={card} answersOf={answersOf} onCancel={() => setCard(null)} onDone={keepDecision} />}
    </section>
  );
}

/** The decision card for one question, drafted from its answer as it is now (a pick not yet saved included). */
function ThreadDecisionCard({
  thread,
  card,
  answersOf,
  onCancel,
  onDone,
}: {
  thread: InboxThread;
  card: { messageId: string; key: string; anchor: HTMLElement };
  answersOf: (message: InboxMessageWire) => Map<string, QuestionAnswer>;
  onCancel: () => void;
  onDone: (messageId: string, key: string, draft: InboxDecisionDraft | null) => Promise<void>;
}) {
  const message = thread.messages.find((m) => m.id === card.messageId);
  const question = message?.questions?.find((q) => q.key === card.key);
  if (!message || !question) return null;
  const drafted = inboxDecisionWords({
    answer: answersOf(message).get(card.key) ?? null,
    prompt: question.prompt,
    askerName: agentName(message.author),
    draft: null,
  });
  return (
    <DecisionCard
      key={`${card.messageId}/${card.key}`}
      anchor={card.anchor}
      drafted={drafted}
      draft={question.decision_draft}
      projectName={thread.project.name}
      onCancel={onCancel}
      onDone={(draft) => onDone(card.messageId, card.key, draft)}
    />
  );
}

/** New message (record 5.x) is a later step (PLAN step 8): drawn beside Reply, not yet live. */
function NewMessageButton() {
  return (
    <button type="button" className="ib-btn" disabled title="New message: coming next">
      <Icon name="compose" size={15} />
      New message
    </button>
  );
}
