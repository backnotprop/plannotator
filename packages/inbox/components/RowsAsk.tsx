/**
 * Settings → Rows' ask box (approval "inbox-rows-settings-page"): one quiet line under "Your list", "Or tell your
 * agent how you want your rows…". On focus the agent picker and Send appear. Send starts a thread to a running agent
 * on this computer, marked `rows_ask`, so the agent also receives how to change the rows (core
 * `INBOX_ROWS_ASK_BLOCK`), and the person stays on the page: "Sent to <agent>. Open thread", then the agent's own
 * line as it replies. The change itself arrives as any rows save does, and the page says who made it, with Undo
 * (RowsSettings.tsx). With no agent running there is nothing to send to: Copy keeps the words. No example chips (the
 * owner: "quiet that down").
 */
import { useEffect, useRef, useState } from 'react';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InboxApiError, inboxApi } from '../api';
import { sendThreadName, suggestThreadName } from '../compose/model';
import { useComposeSessions } from '../compose/useComposeSessions';
import { HostMark, Icon } from '../icons';
import { newUuid } from '../uuid';

/** How often the sent thread is read for the agent's line, and for how long. */
const REPLY_POLL_MS = 2500;
const REPLY_WAIT_MS = 5 * 60_000;

interface Sent {
  thread: string;
  host: string;
  name: string;
  /** The agent's newest line in the thread, once it has replied. */
  reply: string | null;
}

/** A message's first line, short enough for the page. */
function firstLine(body: string): string {
  const line = body.split('\n').find((part) => part.trim() !== '') ?? '';
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

export function RowsAsk() {
  const { model, load } = useComposeSessions(true);
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  // One key per ask, so a retry after a lost answer is the same Send and never a second thread.
  const sendKey = useRef(newUuid());

  const sessions = model
    ? model.projects.flatMap((group) => group.sessions.map((session) => ({ host: session.host, session: session.session, name: INBOX_HOST_NAMES[session.host] ?? 'An agent', project: group.project.name, label: session.label ?? null })))
    : null;
  // Sessions come and go while this is open: the choice holds by its session, and falls to the most recent.
  const agent = sessions ? (sessions.find((session) => session.session === chosen) ?? sessions[0] ?? null) : null;
  const ask = text.trim();
  const shown = open || ask !== '' || busy;

  // The agent's line: the sent thread is read until it has replied, then for its newest line while the page is open.
  const thread = sent?.thread ?? null;
  useEffect(() => {
    if (!thread) return;
    let gone = false;
    const started = Date.now();
    const read = async () => {
      try {
        const answer = await inboxApi.thread(thread);
        const last = [...answer.thread.messages].reverse().find((message) => message.author.kind === 'agent');
        if (!gone && last) setSent((now) => (now && now.thread === thread ? { ...now, reply: firstLine(last.body) } : now));
      } catch {
        // Not read this time: the next read tries again.
      }
    };
    const timer = setInterval(() => {
      if (Date.now() - started > REPLY_WAIT_MS) clearInterval(timer);
      else void read();
    }, REPLY_POLL_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [thread]);

  const change = (next: string) => {
    setText(next);
    setCopied(false);
    setError(null);
    sendKey.current = newUuid();
  };

  const send = async () => {
    if (!agent || !ask || busy) return;
    setBusy(true);
    setError(null);
    try {
      const named = sendThreadName({ edited: false, typed: '' }, suggestThreadName(ask));
      const answer = await inboxApi.startThread({ to: { host: agent.host, session: agent.session }, body: ask, idempotency_key: sendKey.current, ...('error' in named ? {} : named), rows_ask: true });
      setSent({ thread: answer.thread_id, host: agent.host, name: agent.name, reply: null });
      setText('');
      sendKey.current = newUuid();
    } catch (cause) {
      // The agent went while this was open: nothing was sent, and the box reads the sessions there are now.
      if (cause instanceof InboxApiError && cause.code === 'session_not_live') await load();
      else setError(cause instanceof InboxApiError && cause.code !== 'project_unresolved' ? cause.message : 'The message was not sent. Send again to retry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="ib-rws-ask"
      data-rows-ask=""
      data-open={shown ? '' : undefined}
      aria-label="Tell your agent"
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <form
        className="ib-rws-askrow"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input aria-label="Or tell your agent how you want your rows" placeholder="Or tell your agent how you want your rows…" autoComplete="off" value={text} disabled={busy} onChange={(event) => change(event.target.value)} />
        {shown && sessions && sessions.length > 1 && (
          <select aria-label="Which agent" value={agent?.session ?? ''} disabled={busy} onChange={(event) => setChosen(event.target.value)} data-rows-ask-who="">
            {sessions.map((session) => (
              <option key={session.session} value={session.session}>
                {session.label ? `${session.label} · ` : ''}
                {session.name} in {session.project}
              </option>
            ))}
          </select>
        )}
        {shown && agent && (
          <button type="submit" className="ib-btn ib-pri ib-sm" disabled={!ask || busy} data-rows-ask-send="" title={`Send to ${agent.name} in ${agent.project}`}>
            Send
          </button>
        )}
        {shown && sessions && !agent && (
          <button
            type="button"
            className="ib-btn ib-sm"
            disabled={!ask}
            data-rows-ask-copy=""
            onClick={() => {
              void copyTextToClipboard(ask).then((ok) => setCopied(ok));
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        )}
      </form>
      {shown && sessions && !agent && (
        <p className="ib-rws-asknote" data-rows-ask-none="">
          No agent is running
        </p>
      )}
      {error && (
        <p className="ib-error" role="alert" data-rows-ask-error="">
          {error}
        </p>
      )}
      {sent && (
        <div className="ib-rws-asklog" aria-live="polite" data-rows-ask-log="">
          <p data-rows-ask-sent="">
            Sent to {sent.name}.{' '}
            <a className="ib-lnk" href={`#thread=${sent.thread}`} data-rows-ask-thread="">
              Open thread
            </a>
          </p>
          {sent.reply && (
            <p data-rows-ask-reply="">
              <HostMark host={sent.host} /> <b>{sent.name}</b> {sent.reply}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
