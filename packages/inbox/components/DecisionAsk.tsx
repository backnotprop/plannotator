/**
 * Settings -> Decision data's Ask (approval `.product/approved/decision-data/`, 2026-11-05). The box sends the same
 * New message Compose sends, to a running agent, marked `decision_ask`, so the agent also receives how to answer
 * (`INBOX_DECISION_ASK_BLOCK`). The answer comes back as an ordinary thread. With no agent running there is nothing to
 * ask: it says so, and Copy keeps the question for later.
 */
import { useRef, useState } from 'react';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InboxApiError, inboxApi } from '../api';
import { sendThreadName, suggestThreadName } from '../compose/model';
import { useComposeSessions } from '../compose/useComposeSessions';
import { HostMark, Icon } from '../icons';
import { newUuid } from '../uuid';

export function DecisionAsk() {
  const { model, load } = useComposeSessions(true);
  const [text, setText] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // One key per question, so a retry after a lost answer is the same Send and never a second thread.
  const sendKey = useRef(newUuid());

  const sessions = model
    ? model.projects.flatMap((group) =>
        group.sessions.map((session) => ({
          host: session.host,
          session: session.session,
          name: INBOX_HOST_NAMES[session.host] ?? 'An agent',
          project: group.project.name,
          label: session.label ?? null,
        })),
      )
    : null;
  // Sessions come and go while this is open: the choice holds by its session, and falls to the most recent.
  const agent = sessions ? (sessions.find((session) => session.session === chosen) ?? sessions[0] ?? null) : null;
  const question = text.trim();

  const change = (next: string) => {
    setText(next);
    setCopied(false);
    setError(null);
    sendKey.current = newUuid();
  };

  const ask = async () => {
    if (!agent || !question || busy) return;
    setBusy(true);
    setError(null);
    try {
      const named = sendThreadName({ edited: false, typed: '' }, suggestThreadName(question));
      const sent = await inboxApi.startThread({
        to: { host: agent.host, session: agent.session },
        body: question,
        idempotency_key: sendKey.current,
        ...('error' in named ? {} : named),
        decision_ask: true,
      });
      window.location.hash = `thread=${sent.thread_id}`;
    } catch (cause) {
      // The agent went while this was open: nothing was sent, and the box reads the sessions there are now.
      if (cause instanceof InboxApiError && cause.code === 'session_not_live') await load();
      else setError(cause instanceof InboxApiError && cause.code !== 'project_unresolved' ? cause.message : 'The message was not sent. Send again to retry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ib-sgroup ib-dd-ask" data-decision-ask="">
      <h2>Ask</h2>
      <p>
        Forgot why or when something was decided? Ask here.
        {agent ? ` ${agent.name} reads your threads in every project and answers in a new thread.` : ''}
      </p>
      <form
        className="ib-dd-box"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input aria-label="Ask about a decision" placeholder="Why did we drop DockView?" value={text} onChange={(event) => change(event.target.value)} />
        {agent ? (
          <button type="submit" className="ib-btn ib-sm" disabled={!question || busy} data-ask-go="">
            <HostMark host={agent.host} />
            <span>Ask {agent.name}</span>
          </button>
        ) : sessions ? (
          <button
            type="button"
            className="ib-btn ib-sm"
            disabled={!question}
            data-ask-copy=""
            onClick={() => {
              void copyTextToClipboard(question).then((ok) => setCopied(ok));
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        ) : null}
      </form>
      {sessions && sessions.length > 1 && (
        <div className="ib-dd-who">
          <select aria-label="Which agent" value={agent?.session ?? ''} onChange={(event) => setChosen(event.target.value)} data-ask-who="">
            {sessions.map((session) => (
              <option key={session.session} value={session.session}>
                {session.label ? `${session.label} · ` : ''}
                {session.name} in {session.project}
              </option>
            ))}
          </select>
        </div>
      )}
      {sessions && sessions.length === 0 && (
        <p className="ib-dd-note" data-ask-none="">
          No agent is running
        </p>
      )}
      {error && (
        <p className="ib-error" role="alert" data-ask-error="">
          {error}
        </p>
      )}
    </section>
  );
}
