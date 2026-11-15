import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { INBOX_HOST_NAMES, type InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type LiveSession, type LiveSessionsModel } from '../api';
import { useAgentNames, withGivenLabels } from '../agents/agentNames';
import { whenTime, tildePath } from '../format';
import { HostMark, Icon } from '../icons';
import { INBOX_MESSAGE_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { InboxComposerField } from './ComposerField';
import { VoiceFootRow } from './VoiceMic';
import { usePhone } from '../phone';
import { useVoiceSession } from '../voice';
import { newUuid } from '../uuid';

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
export function sessionWords(session: LiveSession): string {
  const parts: string[] = [];
  if (session.wrote_thread) parts.push('Wrote this thread.');
  if (session.busy === true) parts.push('Working now; takes it when the turn ends.');
  else if (session.busy === false && session.idle_since) parts.push(`Idle since ${whenTime(session.idle_since)}.`);
  else if (!session.wrote_thread) parts.push(`Seen ${whenTime(session.last_seen_at)}.`);
  return parts.join(' ');
}

/** What type-ahead in the session picker matches: the host's name, then "started" and the time ("pi started 10:05 am"). */
function typeaheadLabel(session: LiveSession): string {
  return `${hostName(session.host)} started ${whenTime(session.started_at)}`.toLowerCase();
}

export type NewMessageMode = { kind: 'pick' } | { kind: 'none' } | { kind: 'compose'; target: LiveSession } | null;

/**
 * The project's live sessions, read when the thread opens, every few seconds
 * while it stays open, and on demand. With `asker` (the session that asked,
 * for a host whose sessions poll), also whether that session is still there.
 */
export function useLiveSessions(threadId: string, asker: string | null = null, enabled = true, refreshMs = REFRESH_MS) {
  const [model, setModel] = useState<LiveSessionsModel | null>(null);
  const load = useCallback(async (): Promise<LiveSessionsModel | null> => {
    try {
      const next = await inboxApi.sessions(threadId, asker);
      setModel(next);
      return next;
    } catch {
      return null;
    }
  }, [threadId, asker]);
  useEffect(() => {
    setModel(null);
    // `enabled` false: nothing to watch (compose's "Not delivered" asks only while a message waits).
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => clearInterval(timer);
  }, [load, enabled, refreshMs]);
  // A session the person named (Rename… in the sidebar) reads by that name; only its id is ever sent.
  const names = useAgentNames();
  const named = useMemo(() => {
    if (!model) return model;
    const sessions = withGivenLabels(model.sessions, names);
    return sessions === model.sessions ? model : { ...model, sessions: [...sessions] };
  }, [model, names]);
  return { model: named, load };
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
      aria-label="New message"
      onClick={onClick}
    >
      <Icon name="compose" size={15} />
      {/* A phone's reply foot keeps only the icon (inbox.css); the name stays on the button. */}
      <span className="ib-btn-l">New message</span>
    </button>
  );
}

/** The list of live sessions (5.2) or the "not running" state (5.3), above the button. */
export function NewMessagePopover({
  thread,
  asker,
  askerHost,
  replyTo = asker,
  live,
  mode,
  onPick,
  onReplyInstead,
  onClose,
}: {
  thread: InboxThread;
  asker: string;
  askerHost: string | null;
  /** Whom "Reply instead" goes to (the session the box's words answer): `asker` in a thread with one agent. */
  replyTo?: string;
  live: LiveSessionsModel | null;
  mode: NewMessageMode;
  onPick: (session: LiveSession) => void;
  onReplyInstead: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  // The menu keeps one item in the Tab order and moves focus between items itself (APG menu pattern).
  const [active, setActive] = useState(0);
  const typed = useRef({ text: '', at: 0 });
  const picking = mode?.kind === 'pick' && live !== null;
  // Opened, focus goes into the menu, on the first item (the thread's own writers are first).
  useEffect(() => {
    if (!picking) return;
    setActive(0);
    typed.current = { text: '', at: 0 };
    items.current[0]?.focus();
  }, [picking]);
  const focusItem = (index: number) => {
    const el = items.current[index];
    if (!el) return;
    setActive(index);
    el.focus();
  };
  /** Up / Down (wrapping), Home / End and type-ahead on the host and start time, inside the open menu. */
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!live) return;
    const count = live.sessions.length;
    if (count === 0) return;
    const at = Math.max(0, items.current.findIndex((el) => el === document.activeElement));
    if (event.key === 'Escape') {
      // One layer: the menu closes, focus goes back to New message, and the key stops here.
      event.preventDefault();
      event.stopPropagation();
      const opener = ref.current?.closest('section')?.querySelector<HTMLElement>('[data-new-message]');
      onClose();
      opener?.focus();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (at + 1) % count;
    else if (event.key === 'ArrowUp') next = (at - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (event.key.length === 1 && event.key.trim() !== '') {
      const now = Date.now();
      const key = event.key.toLowerCase();
      const text = now - typed.current.at > 500 ? key : typed.current.text + key;
      typed.current = { text, at: now };
      // The same letter pressed again cycles through the items it starts; more letters narrow from the current item.
      const query = [...text].every((c) => c === key) ? key : text;
      const from = query === text && text.length > 1 ? at : at + 1;
      for (let step = 0; step < count; step += 1) {
        const index = (from + step) % count;
        if (typeaheadLabel(live.sessions[index]!).startsWith(query)) {
          next = index;
          break;
        }
      }
      if (next === null) return;
    } else return;
    event.preventDefault();
    focusItem(next);
  };
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
    // A refresh can take sessions away: the Tab stop stays on an item that is still there.
    const current = Math.min(active, live.sessions.length - 1);
    return (
      <div
        className="ib-menu ib-nmpop"
        ref={ref}
        role="menu"
        aria-label={pickerHeading(live.sessions, thread.project.name)}
        data-session-picker=""
        onKeyDown={onMenuKey}
      >
        <div className="ib-mh" aria-hidden="true">{pickerHeading(live.sessions, thread.project.name)}</div>
        {live.sessions.map((session, index) => (
          <button
            type="button"
            role="menuitem"
            ref={(el) => {
              items.current[index] = el;
            }}
            tabIndex={index === current ? 0 : -1}
            className={`ib-mi${index === current ? ' ib-on' : ''}`}
            key={session.session}
            data-session={session.session}
            onFocus={() => setActive(index)}
            onClick={() => onPick(session)}
          >
            <HostMark host={session.host} agent={session.session} />
            <span>
              <span className="ib-t">Started {whenTime(session.started_at)}</span>
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
            ? `A new message goes to a live session. Start ${asker} in ${path} and press New message again, or reply here: ${replyTo} reads replies when it next checks the Inbox.`
            : `A new message goes to a live Claude Code, Pi or OpenCode session with Plannotator. Start one in ${path} and press New message again, or reply here: ${replyTo} reads replies when it next checks the Inbox.`}
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
  const key = useRef(newUuid());
  const textRef = useRef<HTMLTextAreaElement>(null);
  const name = hostName(target.host);
  const phone = usePhone();
  const voice = useVoiceSession();
  useEffect(() => textRef.current?.focus(), []);

  const send = async () => {
    if (sending || voice.busy) return;
    const body = text.trim();
    if (!body) {
      setError('Write a message first.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      // The skills the words reference ride at the end, as one block (skills.ts).
      const skills = await inboxSkillsBlock([body], INBOX_MESSAGE_SKILL_AUDIENCE);
      await inboxApi.newMessage(thread.thread_id, { session: target.session, body: withSkillsBlock(body, skills), idempotency_key: key.current });
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
        <InboxComposerField
          textareaRef={textRef}
          voice={voice}
          ariaLabel={`New message to ${name}`}
          placeholder="Write a message"
          destination="your message"
          value={text}
          onChange={setText}
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
        <VoiceFootRow voice={voice} phone={phone} />
      </div>
      <div className="ib-acts">
        <button type="button" className="ib-btn ib-pri" onClick={() => void send()} disabled={sending || voice.busy}>
          <Icon name="send" size={15} />
          Send
        </button>
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
