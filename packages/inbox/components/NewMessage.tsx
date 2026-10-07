import { useCallback, useEffect, useRef, useState } from 'react';
import { INBOX_HOST_NAMES, type InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type LiveSession, type LiveSessionsModel } from '../api';
import { clockTime, tildePath } from '../format';
import { HostMark, Icon } from '../icons';

/**
 * New message (record 5.x, PLAN step 8; owner Q4: "just another button next
 * to reply", built as a try). The person writes to a live session of the
 * thread's project; it reaches the session through the same wake path as a
 * reply. One live session: the box opens addressed to it (5.1). Several: a
 * small list to pick from, the thread's own writers first (5.2). None: the
 * button says why instead of failing silently (5.3).
 */

/** The hosts whose Plannotator connection can wake a session (the mod, the extension, the plugin). */
const CONNECTED_HOSTS = new Set(['claude-code', 'claude', 'pi', 'opencode']);
/** How often the open thread re-reads its project's live sessions, so the button greys when none is left. */
const REFRESH_MS = 10_000;
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

export const hostName = (host: string): string => INBOX_HOST_NAMES[host] ?? host;

/** "Two Pi sessions are live in ledger", or "Three sessions are live in ledger" when the hosts differ. */
function pickerHeading(sessions: readonly LiveSession[], project: string): string {
  const count = COUNT_WORDS[sessions.length] ?? String(sessions.length);
  const hosts = new Set(sessions.map((s) => hostName(s.host)));
  const which = hosts.size === 1 ? `${[...hosts][0]} sessions` : 'sessions';
  return `${count} ${which} are live in ${project}`;
}

/** "Wrote this thread. Idle since 10:05 AM." / "Working now; takes it when the turn ends." */
function sessionWords(session: LiveSession): string {
  const parts: string[] = [];
  if (session.wrote_thread) parts.push('Wrote this thread.');
  if (session.busy === true) parts.push('Working now; takes it when the turn ends.');
  else if (session.busy === false && session.idle_since) parts.push(`Idle since ${clockTime(session.idle_since)}.`);
  else if (!session.wrote_thread) parts.push(`Seen ${clockTime(session.last_seen_at)}.`);
  return parts.join(' ');
}

export type NewMessageMode = { kind: 'pick' } | { kind: 'none' } | { kind: 'compose'; target: LiveSession } | null;

/** The project's live sessions, read when the thread opens, every few seconds while it stays open, and on demand. */
export function useLiveSessions(threadId: string) {
  const [model, setModel] = useState<LiveSessionsModel | null>(null);
  const load = useCallback(async (): Promise<LiveSessionsModel | null> => {
    try {
      const next = await inboxApi.sessions(threadId);
      setModel(next);
      return next;
    } catch {
      return null;
    }
  }, [threadId]);
  useEffect(() => {
    setModel(null);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { model, load };
}

export function NewMessageButton({ live, mode, onClick }: { live: LiveSessionsModel | null; mode: NewMessageMode; onClick: () => void }) {
  // Greyed when no session is live, yet still pressable (not disabled): pressing it says why (5.3).
  const none = mode?.kind === 'none' || (live !== null && live.sessions.length === 0);
  return (
    <button
      type="button"
      className={`ib-btn${mode?.kind === 'pick' ? ' ib-on' : ''}${none ? ' ib-dis' : ''}`}
      data-live={none ? 'none' : live ? 'some' : undefined}
      aria-expanded={mode?.kind === 'pick' || mode?.kind === 'none'}
      data-new-message=""
      onClick={onClick}
    >
      <Icon name="compose" size={15} />
      New message
    </button>
  );
}

/** The list of live sessions (5.2) or the "not running" state (5.3), above the button. */
export function NewMessagePopover({
  thread,
  asker,
  askerHost,
  live,
  mode,
  onPick,
  onReplyInstead,
  onClose,
}: {
  thread: InboxThread;
  asker: string;
  askerHost: string | null;
  live: LiveSessionsModel | null;
  mode: NewMessageMode;
  onPick: (session: LiveSession) => void;
  onReplyInstead: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode?.kind !== 'pick' && mode?.kind !== 'none') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !ref.current?.contains(target) && !target.closest('[data-new-message]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [mode, onClose]);

  if (mode?.kind === 'pick' && live) {
    return (
      <div className="ib-menu ib-nmpop" ref={ref} role="menu" aria-label={pickerHeading(live.sessions, thread.project.name)} data-session-picker="">
        <div className="ib-mh">{pickerHeading(live.sessions, thread.project.name)}</div>
        {live.sessions.map((session, index) => (
          <button
            type="button"
            role="menuitem"
            className={`ib-mi${index === 0 ? ' ib-on' : ''}`}
            key={session.session}
            data-session={session.session}
            onClick={() => onPick(session)}
          >
            <HostMark host={session.host} />
            <span>
              <span className="ib-t">Started {clockTime(session.started_at)}</span>
              <span className="ib-d">{sessionWords(session)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  if (mode?.kind === 'none') {
    const path = tildePath(thread.project.root, live?.home);
    const connected = askerHost !== null && CONNECTED_HOSTS.has(askerHost);
    return (
      <div className="ib-state ib-nmpop" ref={ref} role="dialog" aria-label="No live session" data-not-running="">
        <h5>{connected ? `${asker} is not running in ${thread.project.name}` : `No agent is running in ${thread.project.name}`}</h5>
        <p>
          {connected
            ? `A new message goes to a live session. Start ${asker} in ${path} and press New message again, or reply here: ${asker} reads replies when it next checks the Inbox.`
            : `A new message goes to a live Claude Code, Pi or OpenCode session with Plannotator. Start one in ${path} and press New message again, or reply here: ${asker} reads replies when it next checks the Inbox.`}
        </p>
        <div className="ib-acts">
          <button type="button" className="ib-btn ib-sm" onClick={onReplyInstead}>
            <Icon name="reply" size={14} />
            Reply instead
          </button>
        </div>
      </div>
    );
  }
  return null;
}

/** The box addressed to one live session (5.1): the footer while it is open. */
export function NewMessageComposer({
  thread,
  target,
  onCancel,
  onSent,
}: {
  thread: InboxThread;
  target: LiveSession;
  onCancel: () => void;
  onSent: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const textRef = useRef<HTMLTextAreaElement>(null);
  const name = hostName(target.host);
  useEffect(() => textRef.current?.focus(), []);

  const send = async () => {
    if (sending) return;
    const body = text.trim();
    if (!body) {
      setError('Write a message first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await inboxApi.newMessage(thread.thread_id, { session: target.session, body, idempotency_key: key.current });
      await onSent();
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The message was not sent. Send again to retry.');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="ib-reply-l" data-new-message-to={target.session}>
        New message to {name} in {thread.project.name}{' '}
        <span className="ib-mut">(live session, {target.busy ? 'working' : 'idle'})</span>
      </div>
      <div className="ib-rbox">
        <textarea
          ref={textRef}
          className="ib-rtext"
          aria-label={`New message to ${name}`}
          placeholder="Write a message"
          value={text}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              onCancel();
            }
          }}
        />
      </div>
      <div className="ib-acts">
        <button type="button" className="ib-btn ib-pri" onClick={() => void send()} disabled={sending}>
          <Icon name="send" size={15} />
          Send
        </button>
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
          Cancel
        </button>
        <span className="ib-sp" />
        <span className="ib-st">{target.busy ? `${name} takes it when its turn ends.` : `${name} takes it as its next turn.`}</span>
      </div>
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
