/**
 * A launched Claude Code session's permission prompt, drawn as its own framed
 * object in the thread (approval "inbox-permission-prompt", .product/approved/):
 * a header naming the runtime and its live status with Stop (it replaces the
 * run line while the session waits), the action, the exact request, and the
 * answers in its own footer. Answered, it shrinks in place to one framed line.
 *
 * Every answer is the question's own choice label, picked and sent as a reply
 * (the Inbox reads it by exact label and hands the hook only the choice; the
 * hook builds the decision from its own event). Nothing here decides anything.
 * No keyboard shortcuts: Allow once takes focus when the prompt is the newest
 * item and nothing else has focus, so Enter answers it; the answers ignore any
 * activation for `ARM_MS` after the card appears or takes focus (a browser
 * security dialog's delay), so a stray or second Enter never allows a prompt
 * the person has not seen.
 *
 * The record states the person's click ("You chose Allow once"), never what
 * the agent did with it: the run line says that. Approve in Terminal answers
 * with no decision, so the host's own dialog comes up, and opens Terminal
 * attached on a computer: a quiet link under the answers on every card that
 * offers it, and with Deny the only answers where the host takes no allow
 * from here (no Allow once), with the host's note.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  INBOX_PERMISSION_ALLOW_ONCE,
  INBOX_PERMISSION_AUTO,
  INBOX_PERMISSION_DENY,
  INBOX_PERMISSION_FULL,
  INBOX_PERMISSION_TERMINAL,
  inboxPermissionCodeSpans,
  readInboxPermissionBody,
  type InboxPermissionBody,
} from '@plannotator/core/inbox-permission';
import type { InboxMessageWire, InboxQuestion, InboxRun } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, inboxApi } from '../api';
import { AuthorMark, Icon } from '../icons';
import { useMinuteClock } from './Undelivered';

/** How long the answers ignore activation after the card appears or takes focus (not from a pointer). */
export const ARM_MS = 600;

type Outcome = 'once' | 'session' | 'auto' | 'full' | 'deny' | 'terminal' | 'withdrawn' | 'closed';
/** The thread's ways to the session in a terminal (its ⋯ menu's): Open in Terminal on a computer, Copy everywhere. */
export type PermissionTerminal = { open: (() => void) | null; copyAttach: (() => void) | null };
type Kind = 'bash' | 'file' | 'fetch' | 'search' | 'other';

/** A label with its inline code as code, read exactly as Markdown reads it (``echo `id` `` stays "echo `id`"). */
function Ticks({ text }: { text: string }) {
  return <>{inboxPermissionCodeSpans(text).map((part, i) => (part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>))}</>;
}

const upFirst = (text: string) => (text.startsWith('`') ? text : text.charAt(0).toUpperCase() + text.slice(1));
/** "Claude Code wants to write a file" → "write a file". */
const wantsOf = (prompt: string) => prompt.replace(/^.*? wants to /, '');
/** The agent that asks, as the question was written (its author's name: "Claude Code", "Codex"). */
const agentNameOf = (author: { kind: string; name?: string | null }) => (author.kind === 'agent' && author.name ? author.name : 'Claude Code');
function kindOf(prompt: string): Kind {
  const wants = wantsOf(prompt);
  if (wants === 'run a command') return 'bash';
  if (/^(write|create|overwrite|edit|read) a file$|^edit a notebook$/.test(wants)) return 'file';
  if (wants === 'open a web page') return 'fetch';
  if (wants === 'search the web') return 'search';
  return 'other';
}
/** A path inside the session's folder, as the folder sees it. */
const rel = (path: string, folder: string | null) => (folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path);

/** The session choice: the one label that is none of the fixed ones. */
const sessionLabelOf = (labels: string[]) =>
  labels.find((l) => l !== INBOX_PERMISSION_ALLOW_ONCE && l !== INBOX_PERMISSION_DENY && l !== INBOX_PERMISSION_AUTO && l !== INBOX_PERMISSION_FULL && l !== INBOX_PERMISSION_TERMINAL) ?? null;

function outcomeOf(q: InboxQuestion, labels: string[]): Outcome | null {
  if (q.state === 'superseded') return 'withdrawn';
  if (q.state === 'closed') return 'closed';
  if (q.state !== 'sent') return null;
  const picked = q.answer && !q.answer.skipped && q.answer.selected.length === 1 ? q.answer.selected[0] : undefined;
  if (picked === INBOX_PERMISSION_ALLOW_ONCE) return 'once';
  if (picked === INBOX_PERMISSION_AUTO) return 'auto';
  if (picked === INBOX_PERMISSION_FULL) return 'full';
  if (picked === INBOX_PERMISSION_TERMINAL) return 'terminal';
  if (picked && picked === sessionLabelOf(labels)) return 'session';
  return 'deny';
}

/** The request in one line, for the answered record: the command's first line, the path, the link. */
function whatOf(read: InboxPermissionBody, title: string): string {
  if (!read.detail) return title;
  if (read.detail.on === 'line') return rel(read.detail.text, read.folder);
  return read.detail.text.split('\n')[0] ?? title;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A file's facts over its lines: whether it is new or replaced, or what a change removes and adds. */
function factsOf(kind: NonNullable<InboxPermissionBody['preview']>['kind'], lines: string[]): string {
  const count = plural(lines.length, 'line', 'lines');
  if (kind === 'new') return `New file, ${count}`;
  if (kind === 'overwrite') return `Replaces the whole file, ${count}`;
  if (kind === 'write' || kind === 'cell') return count;
  const changes = `${lines.filter((l) => l.startsWith('-')).length} removed, ${lines.filter((l) => l.startsWith('+')).length} added`;
  return kind === 'diff-all' ? `${changes}, every occurrence` : changes;
}

/** A link exactly as sent, wrapped, never shortened or cleaned; its host stressed only when the text starts with it, and named on its own line when it does not. */
function Link({ text }: { text: string }) {
  let origin: string | null = null;
  let host: string | null = null;
  try {
    const url = new URL(text);
    origin = `${url.protocol}//${url.host}`;
    host = url.host;
  } catch {
    // Shown as it is.
  }
  const prefixed = origin !== null && text.startsWith(origin) && (text.length === origin.length || /[/?#]/.test(text.charAt(origin.length)));
  return (
    <>
      <div className="pc-code pc-url" data-perm-url="">
        {prefixed ? (
          <>
            <span className="pc-strong">{origin}</span>
            <span className="pc-dim">{text.slice(origin!.length)}</span>
          </>
        ) : (
          text
        )}
      </div>
      {!prefixed && host !== null && (
        <p className="pc-why" data-perm-host="">
          Host: <span className="pc-path pc-strong">{host}</span>
        </p>
      )}
    </>
  );
}

/** The exact request: a command with its purpose and folder, a file's content or change, a link and what Claude looks for, and anything else in the input. */
function RequestBody({ read, kind, phone }: { read: InboxPermissionBody; kind: Kind; phone: boolean }) {
  const [all, setAll] = useState(false);
  const { detail, preview, purpose, folder, leftover, unsandboxed, linksTo } = read;
  // The path is a symbolic link: the write goes where it points.
  const link = linksTo && (
    <p className="pc-links-to" data-perm-links-to="">
      Links to <span className="pc-path">{linksTo}</span>
    </p>
  );
  const rest = leftover && (
    <>
      <p className="pc-why">Also in the request:</p>
      <pre className="pc-code" data-perm-leftover="">
        <code>{leftover}</code>
      </pre>
    </>
  );
  if (preview && detail?.on === 'line') {
    const lines = preview.text.split('\n');
    const cap = phone ? 8 : 10;
    const diff = preview.kind === 'diff' || preview.kind === 'diff-all';
    const path = rel(detail.text, folder);
    const cut = path.lastIndexOf('/') + 1;
    let n = 0;
    return (
      <>
        <div className="pc-file" data-perm-file="">
          <div className="pc-file-head">
            <span className="pc-path">
              <span className="pc-dim">{path.slice(0, cut)}</span>
              <span className="pc-strong">{path.slice(cut)}</span>
            </span>
            <span className="pc-facts">{factsOf(preview.kind, lines)}</span>
          </div>
          {link}
          <pre className="pc-lines">
            {(all ? lines : lines.slice(0, cap)).map((line, i) =>
              diff && line.startsWith('@@ ') ? (
                <span key={i} className="pc-hunk" data-perm-hunk="">
                  {line.slice(3)}
                </span>
              ) : (
                <span key={i} className="pc-line" data-sign={diff ? line[0] : undefined}>
                  <span className="pc-ln" aria-hidden="true">
                    {++n}
                  </span>
                  <code>{(diff ? line.slice(1) : line) || ' '}</code>
                </span>
              ),
            )}
          </pre>
          {lines.length > cap && (
            <button type="button" className="pc-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
              {all ? 'Show less' : `Show ${plural(lines.length - cap, 'more line', 'more lines')}`}
            </button>
          )}
        </div>
        {rest}
      </>
    );
  }
  if (!detail) return rest || null;
  if (kind === 'fetch' && detail.on === 'line') {
    return (
      <>
        <Link text={detail.text} />
        {purpose && (
          <p className="pc-why">
            Looking for: <span className="pc-strong">{purpose}</span>
          </p>
        )}
        {rest}
      </>
    );
  }
  return (
    <>
      {unsandboxed && (
        <p className="pc-warn" data-perm-unsandboxed="">
          <Icon name="warn" size={14} /> Runs outside the sandbox
        </p>
      )}
      <pre className="pc-code" data-perm-detail="">
        <code>{detail.on === 'line' && kind === 'file' ? rel(detail.text, folder) : detail.text}</code>
      </pre>
      {link}
      {kind === 'bash' && (
        <p className="pc-why">
          {purpose && <span>{purpose.replace(/\.$/, '')}. </span>}
          {folder && (
            <span>
              Runs in <span className="pc-path">{folder}</span>
            </span>
          )}
        </p>
      )}
      {rest}
    </>
  );
}

/** Deny with a reason: a field in place; Enter or "Deny and send" sends it, Escape goes back. */
function Reason({ busy, onDeny, onCancel }: { busy: boolean; onDeny: (reason: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="pc-reason" data-perm-reason="">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder="Tell Claude what to do instead"
        aria-label="Why you deny this, for Claude"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
            e.preventDefault();
            onDeny(text.trim());
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="pc-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ib-btn" disabled={busy || !text.trim()} onClick={() => onDeny(text.trim())} data-perm-deny-send="">
          Deny and send
        </button>
      </div>
    </div>
  );
}

/** The answered (or withdrawn) prompt: one framed line in the same place; open it to see the request again. */
function Record({ message, q, outcome, read, title, time, kind, followUp, run, terminal }: { message: InboxMessageWire; q: InboxQuestion; outcome: Outcome; read: InboxPermissionBody; title: string; time: string; kind: Kind; followUp: string | null; run: InboxRun | null; terminal: PermissionTerminal | null }) {
  const [open, setOpen] = useState(false);
  const labels = q.choices.map((c) => c.label);
  // The person's click, as a fact (never a promise about the agent): the run line says what it did.
  const verb: ReactNode =
    outcome === 'once' ? 'You chose Allow once'
    : outcome === 'session' ? <>You chose <Ticks text={sessionLabelOf(labels) ?? ''} /></>
    : outcome === 'auto' ? 'You chose Allow and switch to Auto mode'
    : outcome === 'full' ? 'You chose Allow and switch to Full permissions'
    : outcome === 'deny' ? 'You chose Deny'
    : outcome === 'terminal' ? 'You chose Approve in Terminal'
    : outcome === 'closed' ? 'Not answered'
    : (followUp ?? 'No longer waiting').replace(/\.$/, '');
  // After Approve in Terminal: the host's line, and on a phone (no Open in Terminal) Copy attach command until the
  // run line, which carries the same command, shows the session on its dialog. One set of Terminal actions at a time.
  const copyHere = outcome === 'terminal' && !terminal?.open && terminal?.copyAttach && run?.state !== 'waiting_terminal' ? terminal.copyAttach : null;
  const reason = outcome === 'deny' ? (q.answer?.other?.trim() || q.answer?.note?.trim() || null) : null;
  const allowed = outcome === 'once' || outcome === 'session' || outcome === 'auto' || outcome === 'full';
  return (
    <section className="pc-card pc-rec" data-perm-record={outcome} aria-label={`${agentNameOf(message.author)}: ${title}`}>
      <button type="button" className="pc-rec-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <AuthorMark author={message.author} />
        <span className="pc-rec-icon" data-kind={allowed ? 'allow' : 'other'}>
          <Icon name={allowed ? 'check' : outcome === 'deny' ? 'x' : 'minus'} size={14} />
        </span>
        <span className="pc-rec-verb">{verb}</span>{' '}
        <span className="pc-rec-what">{whatOf(read, title)}</span>
        <span className="pc-sp" />
        <span className="pc-time">{time}</span>
      </button>
      {reason && <p className="pc-rec-reason">You said: “{reason}”</p>}
      {outcome === 'terminal' && (read.handoff || copyHere) && (
        <p className="pc-rec-reason pc-term" data-perm-handoff="">
          {read.handoff && <span>{read.handoff}</span>}
          {copyHere && (
            <button type="button" className="pc-link" onClick={copyHere} data-perm-attach="">
              Copy attach command
            </button>
          )}
        </p>
      )}
      {open && (
        <div className="pc-body">
          <p className="pc-title">{title}</p>
          <RequestBody read={read} kind={kind} phone={false} />
        </div>
      )}
    </section>
  );
}

export function PermissionCard({
  message,
  time,
  run,
  phone,
  newest,
  followUp,
  terminal,
  fullUsed,
  onChanged,
}: {
  message: InboxMessageWire;
  time: string;
  /** The launched thread's run line: the header's status and Stop while the session waits on this prompt. */
  run: InboxRun | null;
  phone: boolean;
  /** The prompt is the thread's newest item: Allow once takes focus. */
  newest: boolean;
  /** The follow-up that withdrew it ("Answered in Terminal."), or null. */
  followUp: string | null;
  /** Open in Terminal and Copy attach command, as the thread's ⋯ menu has them (Approve in Terminal opens it); null outside a launch. */
  terminal: PermissionTerminal | null;
  /** The session already switched to Full permissions from an earlier prompt: no confirm again. */
  fullUsed: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const q = message.questions?.[0] ?? null;
  const read = readInboxPermissionBody(message.body);
  const prompt = q?.prompt ?? '';
  const title = upFirst(wantsOf(prompt));
  const kind = kindOf(prompt);
  const labels = q?.choices.map((c) => c.label) ?? [];
  const session = sessionLabelOf(labels);
  const fullOn = labels.includes(INBOX_PERMISSION_FULL);
  // The host can take it in its own dialog (Approve in Terminal); with no Allow once, that and Deny are all.
  const toTerminal = labels.includes(INBOX_PERMISSION_TERMINAL);
  const terminalOnly = toTerminal && !labels.includes(INBOX_PERMISSION_ALLOW_ONCE);
  const waiting = q?.state === 'open' || q?.state === 'picked';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'answers' | 'reason' | 'confirmFull'>('answers');
  const [stopping, setStopping] = useState(false);
  const onceRef = useRef<HTMLButtonElement>(null);
  const live = waiting && run?.state === 'waiting_answer';
  const now = useMinuteClock(waiting);
  const since = live ? run?.since : message.created_at;
  // Nothing under a minute (never "1 min" a few seconds in).
  const minutes = since ? Math.floor((now - Date.parse(since)) / 60_000) : null;

  // The answers arm `ARM_MS` after the card appears, and again after it takes focus from anything but a pointer.
  const armedAt = useRef(Date.now());
  const pointerAt = useRef(0);
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arm = () => {
    armedAt.current = Date.now();
    setArmed(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(true), ARM_MS);
  };
  useEffect(() => {
    arm();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [message.id]);
  const ready = () => Date.now() - armedAt.current >= ARM_MS;

  // Newest and waiting, and nothing has focus: Allow once takes it, so Enter answers it, with the answers
  // brought into view (never a button out of sight). Never taken from a control the person is on.
  // One frame later than the thread's own: a card already there when the thread opens leaves Reply its focus.
  useEffect(() => {
    if (!newest || !waiting) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const button = onceRef.current;
        const active = document.activeElement;
        if (!button || (active && active !== document.body)) return;
        button.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
        (button.closest('footer') ?? button).scrollIntoView?.({ block: 'nearest' });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [newest, waiting, message.id]);

  if (!q) return null;
  const outcome = outcomeOf(q, labels);
  if (outcome) return <Record message={message} q={q} outcome={outcome} read={read} title={title} time={time} kind={kind} followUp={followUp} run={run} terminal={terminal} />;

  /** One answer: the question's own label (or a Deny with words), picked and sent. Unsent-only: a stale window never reopens it. */
  const answer = async (label: string | null, reason?: string, confirmFull = false): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const picked: QuestionAnswer = { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: label ? [label] : [], ...(reason ? { other: reason } : {}) };
    try {
      const saved = await inboxApi.pick(message.id, q.key, q.revision, picked, { unsentOnly: true, confirmFull });
      const revision = saved.questions.find((x) => x.key === q.key)?.revision ?? q.revision;
      await inboxApi.reply(message.id, { idempotency_key: crypto.randomUUID(), words: '', questions: [{ key: q.key, revision }] });
      await onChanged();
      return true;
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'Your answer was not sent. Try again.');
      setBusy(false);
      return false;
    }
  };
  /** An answer button's action, ignored while the card is not armed. */
  const act = (fn: () => void) => () => {
    if (ready()) fn();
  };
  /** A held key repeats its keydown, and a repeated Enter or Space on a focused button would click it: never. */
  const noRepeat = (e: KeyboardEvent) => {
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  };
  const full = () => (fullUsed ? void answer(INBOX_PERMISSION_FULL) : setMode('confirmFull'));
  /** No decision from here: the host's own dialog comes up; on a computer, Terminal opens attached to it. */
  const handOff = act(() => void answer(INBOX_PERMISSION_TERMINAL).then((sent) => sent && terminal?.open?.()));

  return (
    <section
      className="pc-card"
      data-permission=""
      data-perm-kind={kind}
      data-perm-armed={armed ? '' : undefined}
      aria-label={`${agentNameOf(message.author)} asks permission to ${wantsOf(prompt)}`}
      onPointerDownCapture={() => {
        pointerAt.current = Date.now();
      }}
      onFocusCapture={() => {
        // Focus from the keyboard or the window (not a click, which already aimed): the answers wait again.
        if (Date.now() - pointerAt.current > 500) arm();
      }}
      onKeyDownCapture={noRepeat}
    >
      <header className="pc-head" data-run={live ? 'waiting_answer' : undefined}>
        <AuthorMark author={message.author} />
        <span className="pc-app">{agentNameOf(message.author)}</span>{' '}
        <span className="pc-sub">
          {phone ? 'waiting' : terminalOnly ? 'is waiting on a safety check' : 'is waiting for your permission'}
          {minutes && minutes >= 1 ? ` · ${minutes} min` : ''}
        </span>
        <span className="pc-sp" />
        {run && run.state !== 'stopped' && run.state !== 'failed' && run.state !== 'missing' && (
          <button
            type="button"
            className="pc-stop"
            disabled={stopping}
            data-run-stop=""
            onClick={() => {
              setStopping(true);
              void inboxApi
                .launchStop(run.launch_id)
                .then(() => onChanged())
                .catch(() => setError('Stop did not work; try again.'))
                .finally(() => setStopping(false));
            }}
          >
            Stop
          </button>
        )}
      </header>
      <div className="pc-body" data-question-key={q.key}>
        <p className="pc-title">
          <Ticks text={title} />
        </p>
        <RequestBody read={read} kind={kind} phone={phone} />
      </div>
      <footer className="pc-foot">
        {mode === 'reason' ? (
          <Reason busy={busy} onDeny={(text) => void answer(null, text)} onCancel={() => setMode('answers')} />
        ) : mode === 'confirmFull' ? (
          <div className="pc-confirm" role="group" aria-label="Switch to Full permissions" data-perm-confirm-full="">
            <p>
              <span className="pc-strong">Switch this session to Full permissions?</span> Claude Code will run commands, edit files and open pages without asking, until this session ends.
            </p>
            <div className="pc-acts">
              <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={() => setMode('answers')}>
                Cancel
              </button>
              <button type="button" className="ib-btn" disabled={busy} onClick={act(() => void answer(INBOX_PERMISSION_FULL, undefined, true))} data-perm-full-confirm="">
                Allow and switch
              </button>
            </div>
          </div>
        ) : terminalOnly ? (
          <>
            <div className="pc-row">
              <button type="button" className="ib-btn" disabled={busy} onClick={act(() => void answer(INBOX_PERMISSION_DENY))} data-perm="deny">
                Deny
              </button>
              <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={act(() => setMode('reason'))} data-perm="reason">
                Deny with a reason
              </button>
              <button type="button" className="ib-btn" disabled={busy} onClick={handOff} data-perm="terminal">
                Approve in Terminal
              </button>
            </div>
            {read.note && (
              <p className="pc-modes" data-perm-note="">
                {read.note}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="pc-row">
              <button ref={onceRef} type="button" className="ib-btn ib-pri" disabled={busy} onClick={act(() => void answer(INBOX_PERMISSION_ALLOW_ONCE))} data-perm="once">
                Allow once
              </button>
              {session && (
                <button type="button" className="ib-btn pc-session" disabled={busy} onClick={act(() => void answer(session))} data-perm="session">
                  <span>
                    <Ticks text={session} />
                  </span>
                </button>
              )}
              <button type="button" className="ib-btn" disabled={busy} onClick={act(() => void answer(INBOX_PERMISSION_DENY))} data-perm="deny">
                Deny
              </button>
              <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={act(() => setMode('reason'))} data-perm="reason">
                Deny with a reason
              </button>
            </div>
            {labels.includes(INBOX_PERMISSION_AUTO) && (
              <p className="pc-modes">
                <span>{phone ? 'Or allow and switch to' : 'Or allow this and switch the session to'}</span>
                <button type="button" className="pc-link" disabled={busy} onClick={act(() => void answer(INBOX_PERMISSION_AUTO))} data-perm-mode="auto">
                  Auto mode
                </button>
                {/* Only a launch whose person accepted Claude Code's bypass notice offers Full (its choices say so). */}
                {fullOn && (
                  <button type="button" className="pc-link" disabled={busy} onClick={act(full)} data-perm-mode="full">
                    Full permissions
                  </button>
                )}
              </p>
            )}
            {toTerminal && (
              <p className="pc-modes">
                <button type="button" className="pc-link pc-quiet" disabled={busy} onClick={handOff} data-perm="terminal">
                  Approve in Terminal
                </button>
              </p>
            )}
          </>
        )}
        {error && (
          <p className="ib-error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </section>
  );
}
