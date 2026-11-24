/**
 * Decision mode's frame (approval "inbox-decision-mode-one-send", 2026-11-24; the mock's src/app/dm.css): the bar,
 * the steps (one per agent message, then Send), the Send step and the foot. The message itself is the thread's own
 * (Thread.tsx draws it with every card feature); this only frames it.
 *
 * Nothing here sends on its own: Send is the thread's own Send, pressed by the person, one reply per agent session.
 * No keyboard shortcut of its own (Tab, Enter and Space only).
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { agentName, plural, whenTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { ReplyActions, ReplyAnswers, type ActionRow, type DraftAnswer } from '../components/ReplyAnswers';
import type { JumpTarget } from '../components/ReplacedQuestion';
import { useReplyHasWords, useReplyText, type ReplyText } from '../replyText';
import { laterOffered, stepIndex } from './queue';
import type { Decide } from './useDecide';

export { useDecide } from './useDecide';

export interface DecideFrameProps {
  dm: Decide;
  messages: readonly InboxMessageWire[];
  subject: string;
  /** A linked computer's thread: its name ("On Mac mini"). */
  machine: string | null;
  phone: boolean;
  body: RefObject<HTMLElement | null>;
  /** What the thread's Send carries now (its reply box's lists). */
  answers: readonly DraftAnswer[];
  actions: readonly ActionRow[];
  /** The thread's reply box words, and its change (saved as the thread's draft). */
  words: ReplyText;
  onWords: (text: string) => void;
  /** The thread's own Send. */
  send: () => void;
}

const where = (p: DecideFrameProps) => `${p.subject}${p.machine ? ` · On ${p.machine}` : ''}`;

/** Every agent the sitting's messages came from, by name: "Claude Code and Codex". */
function agentsOf(p: DecideFrameProps): string[] {
  const names: string[] = [];
  for (const id of p.dm.sitting?.order ?? []) {
    const m = p.messages.find((x) => x.id === id);
    if (m?.author.kind === 'agent' && !names.includes(agentName(m.author))) names.push(agentName(m.author));
  }
  return names;
}
const andList = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? 'the agent') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Back to the thread: focus goes to its open questions (the way in), else the thread. */
function leaveFrom(el: HTMLElement | null, dm: Decide) {
  const pane = el?.closest('section');
  dm.leave();
  requestAnimationFrame(() => (pane?.querySelector<HTMLElement>('[data-open-questions]') ?? pane?.querySelector<HTMLElement>('.ib-pbody'))?.focus({ preventScroll: true }));
}

export function DecideHead(p: DecideFrameProps) {
  const { dm, phone } = p;
  const sitting = dm.sitting!;
  const at = stepIndex(sitting);
  const atSend = dm.current === null;
  const ref = useRef<HTMLDivElement>(null);
  // Each step starts at its top, with focus on what it shows (the message, or Send's heading).
  useLayoutEffect(() => {
    p.body.current?.scrollTo({ top: 0 });
    const target = atSend ? p.body.current?.querySelector<HTMLElement>('[data-decide-send-heading]') : p.body.current?.querySelector<HTMLElement>(`[data-message-article="${dm.current}"]`);
    target?.focus({ preventScroll: true });
  }, [dm.current, atSend]);
  const done = sitting.order.filter((id) => dm.tally(id).answered === dm.tally(id).total).length;
  const count = atSend ? `${done} of ${sitting.order.length} messages answered` : phone ? `${at + 1} of ${sitting.order.length}` : `Message ${at + 1} of ${sitting.order.length}`;
  return (
    <>
      <div className="ib-phead dm-head" ref={ref} data-decide-head="">
        <button type="button" className="ib-pback" onClick={() => leaveFrom(ref.current, dm)} data-decide-leave="">
          <Icon name="chevL" size={phone ? 18 : 16} />
          <span className="ib-pback-l">Thread</span>
        </button>
        {!phone && <span className="ib-vsep" aria-hidden="true" />}
        <h2 className="dm-title">
          <span>Decide</span>
          {!phone && (
            <span className="dm-title-s" dir="auto">
              {where(p)}
            </span>
          )}
        </h2>
        <span className="dm-count" aria-live="polite" data-decide-count="">
          {count}
        </span>
      </div>
      <ol className="dm-steps" aria-label="Messages" data-decide-steps="">
        {sitting.order.map((id, i) => {
          const m = p.messages.find((x) => x.id === id);
          const t = dm.tally(id);
          const state = t.answered === t.total ? 'done' : t.answered > 0 ? 'part' : 'none';
          const name = m?.author.kind === 'agent' ? agentName(m.author) : 'Agent';
          const time = m ? whenTime(m.created_at) : '';
          const later = sitting.later.includes(id) && t.answered < t.total;
          return (
            <li key={id}>
              <button
                type="button"
                className="dm-step"
                data-state={state}
                data-decide-step={id}
                aria-current={i === at ? 'step' : undefined}
                aria-label={`${name}'s message, ${time}: ${t.answered} of ${t.total} answered${later ? ', put off' : ''}`}
                onClick={() => dm.go(i)}
              >
                <span className="dm-bar">
                  <span className="dm-fill" style={{ width: `${t.total ? Math.round((t.answered / t.total) * 100) : 0}%` }} />
                </span>
                {!phone && (
                  <span className="dm-step-l">
                    {m?.author.kind === 'agent' && (
                      <span className="dm-step-mk">
                        <AuthorMark author={m.author} />
                      </span>
                    )}
                    <span>{time}</span>
                    {later && <span className="dm-step-later">· later</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="dm-step dm-step-send" data-decide-step="send" aria-current={atSend ? 'step' : undefined} onClick={() => dm.go(sitting.order.length)} aria-label="Send">
            <span className="dm-bar" />
            {!phone && (
              <span className="dm-step-l">
                <Icon name="send" size={12} />
                <span>Send</span>
              </span>
            )}
          </button>
        </li>
      </ol>
    </>
  );
}

/** The words box on the Send step: the thread's reply words (its draft), so leaving keeps them in the thread. */
function DecideWords({ words, onWords }: { words: ReplyText; onWords: (text: string) => void }) {
  const text = useReplyText(words);
  return (
    <div className="ib-rbox dm-rbox">
      <textarea className="dm-words" rows={2} placeholder="Add a few words to your reply" aria-label="Your words" value={text} onChange={(event) => onWords(event.target.value)} data-decide-words="" />
    </div>
  );
}

/** Above the message: on a phone the thread's name, and a note on a message put off that came back last. */
export function DecideBody(p: DecideFrameProps) {
  const { dm } = p;
  const sitting = dm.sitting!;
  const id = dm.current;
  const t = id ? dm.tally(id) : null;
  const jump = (target: JumpTarget) => {
    const i = sitting.order.indexOf(target.messageId);
    if (i >= 0) dm.go(i, true);
  };
  const open = sitting.order.flatMap((mid) => {
    const m = p.messages.find((x) => x.id === mid);
    const left = dm.tally(mid);
    return m && left.answered < left.total ? [{ id: mid, prompt: firstOpenPrompt(m, p) }] : [];
  });
  const names = agentsOf(p);
  return (
    <div className="dm-top" data-decide-body="">
      {p.phone && <p className="dm-phone-sub">{where(p)}</p>}
      {id && t && sitting.later.includes(id) && stepIndex(sitting) === sitting.order.length - 1 && t.answered < t.total && (
        <p className="dm-note">You put this one off. It is the last before Send.</p>
      )}
      {id === null && (
        <div className="dm-send" data-decide-send="">
          <h3 className="dm-send-h" tabIndex={-1} data-decide-send-heading="">
            Send your answers
          </h3>
          <p className="dm-send-p">
            {names.length > 1 ? 'They go' : 'It goes'} to {andList(names)}
            {p.machine ? ` on ${p.machine}` : ''}, in one reply{names.length > 1 ? ' to each' : ''}. Nothing has been sent yet. Press a row to change its answer.
          </p>
          {p.answers.length > 0 && <ReplyAnswers answers={p.answers} onJump={jump} />}
          {p.actions.length > 0 && <ReplyActions actions={p.actions} onJump={jump} />}
          {open.length > 0 && (
            <div className="dm-open" data-decide-open="">
              <span className="dm-open-l">
                {open.length === 1 ? '1 message stays open' : `${open.length} messages stay open`}: {open.map((o) => o.prompt).join(' · ')}
              </span>
              <button type="button" className="ib-btn ib-sm" onClick={() => jump({ kind: 'message', messageId: open[0]!.id })}>
                Answer
              </button>
            </div>
          )}
          <DecideWords words={p.words} onWords={p.onWords} />
        </div>
      )}
    </div>
  );
}

/** The first prompt still unanswered in a message (a question, else an action item). */
function firstOpenPrompt(m: InboxMessageWire, p: DecideFrameProps): string {
  const answered = new Set(p.answers.map((a) => a.id));
  const marked = new Set(p.actions.map((a) => a.id));
  const q = (m.questions ?? []).find((x) => (x.state === 'open' || x.state === 'picked') && x.kind !== 'action' && !answered.has(`${m.id}/${x.key}`));
  if (q) return q.prompt;
  return [...(m.questions ?? []), ...(m.actions ?? [])].find((x) => x.kind === 'action' && x.state === 'open' && !marked.has(`${m.id}/${x.key}`))?.prompt ?? '';
}

export function DecideFoot(p: DecideFrameProps) {
  const { dm, phone } = p;
  const sitting = dm.sitting!;
  const at = stepIndex(sitting);
  const atSend = dm.current === null;
  const t = dm.current ? dm.tally(dm.current) : null;
  const hasWords = useReplyHasWords(p.words);
  const nothing = p.answers.length === 0 && p.actions.length === 0 && !hasWords;
  const status = atSend
    ? p.actions.length > 0
      ? `${plural(p.answers.length, 'answer')}, ${plural(p.actions.length, 'action item')}`
      : plural(p.answers.length, 'answer')
    : `${t?.answered ?? 0} of ${t?.total ?? 0} answered · all go together at Send`;
  return (
    <div className="ib-pfoot dm-foot" data-decide-foot="">
      <div className="dm-acts">
        {at > 0 && (
          <button type="button" className="ib-btn ib-ghost dm-back" onClick={dm.back} aria-label="Back" data-decide-back="">
            <Icon name="chevL" size={15} />
            {!phone && 'Back'}
          </button>
        )}
        {!phone && (
          <span className="dm-st" data-decide-status="">
            {status}
          </span>
        )}
        <span className="dm-sp" />
        {laterOffered(sitting) && (
          <button type="button" className="ib-btn" onClick={dm.later} data-decide-later="">
            Later
          </button>
        )}
        {atSend ? (
          <button
            type="button"
            className="ib-btn ib-pri dm-next"
            disabled={nothing}
            data-decide-send-button=""
            onClick={() => {
              dm.finish();
              p.send();
            }}
          >
            <Icon name="send" size={15} /> Send
          </button>
        ) : sitting.fromSend ? (
          <button type="button" className="ib-btn ib-pri dm-next" onClick={() => dm.go(sitting.order.length)} data-decide-back-to-send="">
            Back to Send
          </button>
        ) : (
          <button type="button" className={t && t.answered === t.total ? 'ib-btn ib-pri dm-next' : 'ib-btn dm-next'} onClick={dm.next} data-decide-next="">
            {at === sitting.order.length - 1 ? 'Review' : 'Next'}
            <Icon name="chevR" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
