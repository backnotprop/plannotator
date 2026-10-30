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
 * item, so Enter answers it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  INBOX_PERMISSION_ALLOW_ONCE,
  INBOX_PERMISSION_AUTO,
  INBOX_PERMISSION_DENY,
  INBOX_PERMISSION_FULL,
  readInboxPermissionBody,
  type InboxPermissionBody,
} from '@plannotator/core/inbox-permission';
import type { InboxMessageWire, InboxQuestion, InboxRun } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, inboxApi } from '../api';
import { AuthorMark, Icon } from '../icons';
import { useMinuteClock } from './Undelivered';

/** Why Full permissions is off: the session did not start with them allowed. */
export const FULL_PERMISSIONS_OFF = 'Start the session with full permissions allowed to use this';

/** The sessions where the person already confirmed Full permissions once (until the window reloads). */
const fullConfirmed = new Set<string>();

type Outcome = 'once' | 'session' | 'auto' | 'full' | 'deny' | 'withdrawn' | 'closed';
type Kind = 'bash' | 'file' | 'fetch' | 'search' | 'other';

/** "Allow `bun run` for this session" with its backticked parts as code. */
function Ticks({ text }: { text: string }) {
  const parts = text.split('`');
  return <>{parts.map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}</>;
}

const upFirst = (text: string) => (text.startsWith('`') ? text : text.charAt(0).toUpperCase() + text.slice(1));
/** "Claude Code wants to write a file" → "write a file". */
const wantsOf = (prompt: string) => prompt.replace(/^.*? wants to /, '');
function kindOf(prompt: string): Kind {
  const wants = wantsOf(prompt);
  if (wants === 'run a command') return 'bash';
  if (/^(write|edit|read) a file$|^edit a notebook$/.test(wants)) return 'file';
  if (wants === 'open a web page') return 'fetch';
  if (wants === 'search the web') return 'search';
  return 'other';
}
/** A path inside the session's folder, as the folder sees it. */
const rel = (path: string, folder: string | null) => (folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path);
/** "Allow `bun run` for this session" → "`bun run`". */
const scopeOf = (label: string) => label.replace(/^Allow /, '').replace(/ for this session$/, '');

/** The session choice: the one label that is none of the fixed ones. */
const sessionLabelOf = (labels: string[]) =>
  labels.find((l) => l !== INBOX_PERMISSION_ALLOW_ONCE && l !== INBOX_PERMISSION_DENY && l !== INBOX_PERMISSION_AUTO && l !== INBOX_PERMISSION_FULL) ?? null;

function outcomeOf(q: InboxQuestion, labels: string[]): Outcome | null {
  if (q.state === 'superseded') return 'withdrawn';
  if (q.state === 'closed') return 'closed';
  if (q.state !== 'sent') return null;
  const picked = q.answer && !q.answer.skipped && q.answer.selected.length === 1 ? q.answer.selected[0] : undefined;
  if (picked === INBOX_PERMISSION_ALLOW_ONCE) return 'once';
  if (picked === INBOX_PERMISSION_AUTO) return 'auto';
  if (picked === INBOX_PERMISSION_FULL) return 'full';
  if (picked && picked === sessionLabelOf(labels)) return 'session';
  return 'deny';
}

/** The request in one line, for the answered record: the command's first line, the path, the link. */
function whatOf(read: InboxPermissionBody, title: string): string {
  if (!read.detail) return title;
  if (read.detail.on === 'line') return rel(read.detail.text, read.folder);
  return read.detail.text.split('\n')[0] ?? title;
}

/** The exact request: a command with its purpose and folder, a file's content or change, a link and what Claude looks for. */
function RequestBody({ read, kind, phone }: { read: InboxPermissionBody; kind: Kind; phone: boolean }) {
  const [all, setAll] = useState(false);
  const { detail, preview, purpose, folder } = read;
  if (preview && detail?.on === 'line') {
    const lines = preview.text.split('\n');
    const cap = phone ? 8 : 10;
    const diff = preview.kind === 'diff';
    const path = rel(detail.text, folder);
    const cut = path.lastIndexOf('/') + 1;
    return (
      <div className="pc-file" data-perm-file="">
        <div className="pc-file-head">
          <span className="pc-path">
            <span className="pc-dim">{path.slice(0, cut)}</span>
            <span className="pc-strong">{path.slice(cut)}</span>
          </span>
          <span className="pc-facts">
            {diff ? `${lines.filter((l) => l.startsWith('-')).length} removed, ${lines.filter((l) => l.startsWith('+')).length} added` : `New file, ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
          </span>
        </div>
        <pre className="pc-lines">
          {(all ? lines : lines.slice(0, cap)).map((line, i) => (
            <span key={i} className="pc-line" data-sign={diff ? line[0] : undefined}>
              <span className="pc-ln" aria-hidden="true">
                {i + 1}
              </span>
              <code>{(diff ? line.slice(1) : line) || ' '}</code>
            </span>
          ))}
        </pre>
        {lines.length > cap && (
          <button type="button" className="pc-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
            {all ? 'Show less' : `Show ${lines.length - cap} more ${lines.length - cap === 1 ? 'line' : 'lines'}`}
          </button>
        )}
      </div>
    );
  }
  if (!detail) return null;
  if (kind === 'fetch' && detail.on === 'line') {
    let host = detail.text;
    try {
      const url = new URL(detail.text);
      host = `${url.protocol}//${url.host}`;
    } catch {
      // Shown as it is.
    }
    return (
      <>
        <div className="pc-code" data-perm-url="">
          <span className="pc-strong">{host}</span>
          <span className="pc-dim">{detail.text.slice(host.length)}</span>
        </div>
        {purpose && (
          <p className="pc-why">
            Looking for: <span className="pc-strong">{purpose}</span>
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <pre className="pc-code" data-perm-detail="">
        <code>{detail.on === 'line' && kind === 'file' ? rel(detail.text, folder) : detail.text}</code>
      </pre>
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
function Record({ message, q, outcome, read, title, time, kind, followUp }: { message: InboxMessageWire; q: InboxQuestion; outcome: Outcome; read: InboxPermissionBody; title: string; time: string; kind: Kind; followUp: string | null }) {
  const [open, setOpen] = useState(false);
  const labels = q.choices.map((c) => c.label);
  const verb: ReactNode =
    outcome === 'once' ? 'Allowed once'
    : outcome === 'session' ? <>Allowed <Ticks text={scopeOf(sessionLabelOf(labels) ?? '')} /> for this session</>
    : outcome === 'auto' ? 'Allowed and switched to Auto mode'
    : outcome === 'full' ? 'Allowed and switched to Full permissions'
    : outcome === 'deny' ? 'Denied'
    : outcome === 'closed' ? 'Not answered'
    : (followUp ?? 'No longer waiting').replace(/\.$/, '');
  const reason = outcome === 'deny' ? (q.answer?.other?.trim() || q.answer?.note?.trim() || null) : null;
  const allowed = outcome === 'once' || outcome === 'session' || outcome === 'auto' || outcome === 'full';
  return (
    <section className="pc-card pc-rec" data-perm-record={outcome} aria-label={`Claude Code: ${title}`}>
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
  const waiting = q?.state === 'open' || q?.state === 'picked';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'answers' | 'reason' | 'confirmFull'>('answers');
  const [why, setWhy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const onceRef = useRef<HTMLButtonElement>(null);
  const live = waiting && run?.state === 'waiting_answer';
  const now = useMinuteClock(waiting);
  const since = live ? run?.since : message.created_at;
  const minutes = since ? Math.max(1, Math.floor((now - Date.parse(since)) / 60_000)) : null;

  // Newest and waiting: Allow once takes focus, so Enter answers it. Never from a field the person types in,
  // nor from outside this thread (the list keeps its own focus). After the thread has placed itself (at the
  // "New since you looked" divider), the answers are brought into view: Enter never answers a button out of sight.
  useEffect(() => {
    if (!newest || !waiting) return;
    const frame = requestAnimationFrame(() => {
      const button = onceRef.current;
      const active = document.activeElement as HTMLElement | null;
      const pane = button?.closest('section.ib-pane');
      const editable = !!active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      if (!button || editable || !(!active || active === document.body || (pane && pane.contains(active)))) return;
      button.focus({ preventScroll: true });
      (button.closest('footer') ?? button).scrollIntoView?.({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [newest, waiting, message.id]);

  if (!q) return null;
  const outcome = outcomeOf(q, labels);
  if (outcome) return <Record message={message} q={q} outcome={outcome} read={read} title={title} time={time} kind={kind} followUp={followUp} />;

  /** One answer: the question's own label (or a Deny with words), picked and sent. */
  const answer = async (label: string | null, reason?: string) => {
    setBusy(true);
    setError(null);
    const picked: QuestionAnswer = { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: label ? [label] : [], ...(reason ? { other: reason } : {}) };
    try {
      const saved = await inboxApi.pick(message.id, q.key, q.revision, picked);
      const revision = saved.questions.find((x) => x.key === q.key)?.revision ?? q.revision;
      await inboxApi.reply(message.id, { idempotency_key: crypto.randomUUID(), words: '', questions: [{ key: q.key, revision }] });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'Your answer was not sent. Try again.');
      setBusy(false);
    }
  };
  const full = () => {
    const sessionKey = message.author.kind === 'agent' ? (message.author.session ?? message.id) : message.id;
    if (fullConfirmed.has(sessionKey)) void answer(INBOX_PERMISSION_FULL);
    else setMode('confirmFull');
  };
  const confirmFull = () => {
    const sessionKey = message.author.kind === 'agent' ? (message.author.session ?? message.id) : message.id;
    fullConfirmed.add(sessionKey);
    void answer(INBOX_PERMISSION_FULL);
  };

  return (
    <section className="pc-card" data-permission="" data-perm-kind={kind} aria-label={`Claude Code asks permission to ${wantsOf(prompt)}`}>
      <header className="pc-head" data-run={live ? 'waiting_answer' : undefined}>
        <AuthorMark author={message.author} />
        <span className="pc-app">Claude Code</span>{' '}
        <span className="pc-sub">
          is waiting for your permission{minutes ? ` · ${minutes} min` : ''}
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
              <button type="button" className="ib-btn" disabled={busy} onClick={confirmFull} data-perm-full-confirm="">
                Allow and switch
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="pc-row">
              <button ref={onceRef} type="button" className="ib-btn ib-pri" disabled={busy} onClick={() => void answer(INBOX_PERMISSION_ALLOW_ONCE)} data-perm="once">
                Allow once
              </button>
              {session && (
                <button type="button" className="ib-btn" disabled={busy} onClick={() => void answer(session)} data-perm="session">
                  <Ticks text={session} />
                </button>
              )}
              <button type="button" className="ib-btn" disabled={busy} onClick={() => void answer(INBOX_PERMISSION_DENY)} data-perm="deny">
                Deny
              </button>
              <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={() => setMode('reason')} data-perm="reason">
                Deny with a reason
              </button>
            </div>
            {labels.includes(INBOX_PERMISSION_AUTO) && (
              <p className="pc-modes">
                <span>{phone ? 'Or allow and switch to' : 'Or allow this and switch the session to'}</span>
                <button type="button" className="pc-link" disabled={busy} onClick={() => void answer(INBOX_PERMISSION_AUTO)} data-perm-mode="auto">
                  Auto mode
                </button>
                <span className="pc-full">
                  <button
                    type="button"
                    className="pc-link"
                    aria-disabled={fullOn ? undefined : true}
                    aria-describedby={fullOn ? undefined : `pc-why-${message.id}`}
                    disabled={busy}
                    onClick={() => (fullOn ? full() : setWhy((v) => !v))}
                    onMouseEnter={() => !fullOn && setWhy(true)}
                    onMouseLeave={() => setWhy(false)}
                    onFocus={() => !fullOn && setWhy(true)}
                    onBlur={() => setWhy(false)}
                    data-perm-mode="full"
                  >
                    Full permissions
                  </button>
                  {!fullOn && (
                    <span id={`pc-why-${message.id}`} role="note" className="pc-why-off" hidden={!why} data-perm-full-off="">
                      {FULL_PERMISSIONS_OFF}
                    </span>
                  )}
                </span>
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
