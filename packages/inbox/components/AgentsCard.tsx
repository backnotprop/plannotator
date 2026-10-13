import { useId, useState } from 'react';
import type { InboxAgentsModel, InboxNoteAgentId } from '@plannotator/core/inbox-types';
import { INBOX_AGENT_LABELS } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { addLabel, cardReport, defaultPicks, headLines, noteCandidates, noteQuestionOpen, noteResultLine } from '../agents';
import { HostMark, Icon } from '../icons';

type NoteResult = { ok: true; agent: InboxNoteAgentId; action: string; path: string } | { ok: false; agent: InboxNoteAgentId; reason: string; path: string | null };

/**
 * The first-open card (the approved "inbox-agent-awareness" design, 01-07):
 * one line saying which agents `plannotator inbox` connected, a failure in
 * amber inside it, and the one-time question "Tell them when to use it?"
 * with a checkbox and the exact file per agent. After Add or Not now only
 * the head stays, until ×.
 */
export function AgentsCard({
  model,
  onModel,
  onSettings,
  variant,
}: {
  model: InboxAgentsModel;
  onModel: (next: InboxAgentsModel) => void;
  onSettings: () => void;
  /** `empty`: under "No agent has written yet"; `list`: above the list, where the notification ask sits. */
  variant: 'empty' | 'list';
}) {
  const id = useId();
  const report = cardReport(model);
  const asking = noteQuestionOpen(model);
  // The ticks follow the model (the window can open before connecting is done) until the person touches one.
  const [touched, setTouched] = useState<Record<string, boolean> | null>(null);
  const picks: Record<string, boolean> = touched ?? defaultPicks(model);
  const [preview, setPreview] = useState(false);
  const [results, setResults] = useState<NoteResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  if (!report && !asking && !results) return null;
  const candidates = noteCandidates(model);
  const count = candidates.filter((row) => picks[row.id]).length;
  const head = report ? headLines(report) : null;

  const answer = async (add: InboxNoteAgentId[]) => {
    setBusy(true);
    setError(null);
    try {
      const next = await inboxApi.answerNotes(add);
      if (add.length > 0) setResults(next.results);
      onModel(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    try {
      // × closes the card for good: the news is seen, and an open question counts as answered.
      if (asking) await inboxApi.answerNotes([]);
      onModel(await inboxApi.agentsSeen());
      setResults(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const retry = async (agent: (typeof model.agents)[number]['id']) => {
    setRetrying(agent);
    try {
      const next = await inboxApi.saveAgent(agent, { reach: true });
      onModel(next);
      if (next.error) setError(next.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <section className={`ib-conn${variant === 'list' ? ' ib-conn-list' : ''}`} aria-label="Agents connected to the Inbox" data-agents-card="">
      {(head || results) && (
        <div className="ib-conn-head">
          {head?.bold ? <Icon name="checkCircle" /> : <Icon name="info" />}
          <div className="ib-grow">
            {head?.bold && <b>{head.bold}</b>} {head?.rest && <span className="ib-mut">{head.rest}</span>}
            {!head && <b>Your agents reach the Inbox.</b>}
          </div>
          <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onSettings}>
            Settings
          </button>
          <button type="button" className="ib-conn-x" aria-label="Close this notice" onClick={() => void close()}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {report?.failed.map((failure) => (
        <div className="ib-conn-fail" role="status" key={failure.agent}>
          <Icon name="warn" />
          <span className="ib-grow">
            Couldn't connect {INBOX_AGENT_LABELS[failure.agent]}: {failure.reason}. Plannotator left it as it was.
            <button type="button" className="ib-lnk" disabled={retrying === failure.agent} onClick={() => void retry(failure.agent)}>
              {retrying === failure.agent ? 'Trying…' : 'Try again'}
            </button>
            <button type="button" className="ib-lnk" onClick={onSettings}>
              Settings
            </button>
          </span>
        </div>
      ))}
      {error && !(asking && !results) && (
        <p className="ib-error ib-conn-err" role="alert">
          {error}
        </p>
      )}
      {report?.foreign.map((foreign) => (
        <div className="ib-conn-fail ib-conn-quiet" role="status" key={foreign.agent}>
          <Icon name="info" />
          <span className="ib-grow">
            {INBOX_AGENT_LABELS[foreign.agent]} has its own plannotator-inbox entry{foreign.path ? <> in <code>{foreign.path}</code></> : null}; Plannotator left it alone.
          </span>
        </div>
      ))}
      {results && (
        <ul className="ib-conn-done" aria-label="Notes added">
          {results.map((result) => (
            <li key={result.agent}>
              <Icon name={result.ok ? 'check' : 'warn'} />
              <span>
                {INBOX_AGENT_LABELS[result.agent]}: {noteResultLine(result)}
              </span>
            </li>
          ))}
          <li className="ib-mut ib-conn-small">Each agent reads its note from its next session. Remove a note any time in Settings.</li>
        </ul>
      )}
      {asking && !results && (
        <div className="ib-conn-offer" role="group" aria-labelledby={`${id}-h`}>
          <h3 id={`${id}-h`}>Tell them when to use it?</h3>
          <p>
            Plannotator can add a short note to each agent's own instructions, so they send you decisions and finished work here while you're away. It's
            plain text you can read, edit or delete.
          </p>
          <ul className="ib-conn-picks">
            {candidates.map((row) => (
              <li key={row.id} className={picks[row.id] ? undefined : 'ib-conn-unpicked'}>
                <label className="ib-conn-pick">
                  <input
                    type="checkbox"
                    checked={picks[row.id] === true}
                    onChange={(event) => setTouched({ ...picks, [row.id]: event.target.checked })}
                  />
                  <HostMark host={row.id} />
                  {row.label}
                </label>
                <span className="ib-conn-path">
                  <code>{row.note?.path}</code>
                </span>
                <span className="ib-conn-what">{row.note?.create ? 'will create' : 'adds a marked section'}</span>
                {row.id === 'pi' && (
                  <span className="ib-conn-why">
                    <Icon name="info" />
                    <span>Pi reads only one of its instruction files; this is the one.</span>
                  </span>
                )}
                {row.note?.shared_with && row.note.shared_with.length > 0 && (
                  <span className="ib-conn-why">
                    <Icon name="info" />
                    <span>This file is shared with {row.note.shared_with.map((id) => INBOX_AGENT_LABELS[id]).join(' and ')}: one section serves both.</span>
                  </span>
                )}
                {row.note?.target && (
                  <span className="ib-conn-why">
                    <Icon name="info" />
                    <span>
                      This file is a link to <code>{row.note.target}</code>; the note goes there.
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="ib-conn-fold" aria-expanded={preview} aria-controls={`${id}-note`} onClick={() => setPreview((open) => !open)}>
            <Icon name="chevR" />
            {preview ? 'Hide the note' : 'Show the note'}
          </button>
          {preview && (
            <div className="ib-conn-note ib-cbox" id={`${id}-note`}>
              <pre>{model.note_text}</pre>
            </div>
          )}
          {error && (
            <p className="ib-error" role="alert">
              {error}
            </p>
          )}
          <div className="ib-conn-acts" data-busy={busy || undefined}>
            <button
              type="button"
              className="ib-btn ib-pri ib-sm"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                if (count === 0) {
                  setError('Tick at least one agent, or choose Not now.');
                  return;
                }
                void answer(candidates.filter((row) => picks[row.id]).map((row) => row.id as InboxNoteAgentId));
              }}
            >
              {busy ? 'Adding…' : addLabel(count)}
            </button>
            <button type="button" className="ib-btn ib-ghost ib-sm" aria-disabled={busy || undefined} onClick={() => !busy && void answer([])}>
              Not now
            </button>
            <span className="ib-conn-small">Asked once. Change it later in Settings.</span>
          </div>
        </div>
      )}
    </section>
  );
}
