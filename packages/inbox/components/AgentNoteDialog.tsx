import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { InboxAgentRow, InboxAgentsModel, InboxConnectReport, InboxNoteAgentId } from '@plannotator/core/inbox-types';
import { INBOX_AGENT_LABELS } from '@plannotator/core/inbox-types';
import { inboxApi, type InboxNoteResult } from '../api';
import { bandLines, defaultPicks, joinNames, noteResultLabel, primaryAction, sentence, splitPath, tidyReason, whoLabel } from '../agents';
import { HostMark, Icon } from '../icons';
import { Modal } from './Updates';

export interface AgentNoteDialogProps {
  /** The agents asked about (fixed when the dialog opens): the candidates not asked yet. */
  rows: InboxAgentRow[];
  /** The last run's unseen news, shown as the quiet band at the top (option A); null for none. */
  report: InboxConnectReport | null;
  /** The exact block a note writes (Show the note). */
  noteText: string;
  onModel: (next: InboxAgentsModel) => void;
  /** Settings → Agents. */
  onSettings: () => void;
  onClosed: () => void;
}

type RowStatus = { kind: 'busy' } | { kind: 'done'; result: InboxNoteResult };

/**
 * The note in each agent's instructions, asked once per agent in a one-time
 * dialog (the approved "inbox-agent-note-dialog" design, Checklist, with the
 * "Connected …" band at the top). One row per agent, all ticked; with one
 * agent no checkbox. The primary names who it adds to ("Don't add a note"
 * with nothing ticked: never disabled, never an error). Results show in the
 * same rows. Not now, Escape and the backdrop answer for these agents only;
 * nothing is written without the person's yes. On the sound dialog's shell,
 * no entrance motion.
 */
export function AgentNoteDialog({ rows, report, noteText, onModel, onSettings, onClosed }: AgentNoteDialogProps) {
  const id = useId();
  const doneRef = useRef<HTMLButtonElement>(null);
  const [picks, setPicks] = useState<Record<string, boolean>>(() => defaultPicks(rows));
  const [preview, setPreview] = useState(false);
  const [phase, setPhase] = useState<'ask' | 'busy' | 'done'>('ask');
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [live, setLive] = useState('');
  const closed = useRef(false);
  // The results view takes focus on Done (the live region says what was written), and so does a
  // Try again that worked (its link is gone).
  const [focusDone, setFocusDone] = useState(0);
  useEffect(() => {
    if (phase === 'done') doneRef.current?.focus();
  }, [phase, focusDone]);

  const single = rows.length === 1;
  const asked = rows.map((row) => row.id as InboxNoteAgentId);
  const picked = rows.filter((row) => picks[row.id]);
  const primary = primaryAction(picked.map((row) => row.label));
  const band = report ? bandLines(report) : null;
  const busy = phase === 'busy';

  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClosed();
  };
  /** Not now, Don't add a note, Escape, the backdrop: nothing is written; these agents are not asked again. */
  const decline = () => {
    if (busy) return;
    close();
    inboxApi
      .answerNotes([], asked, report !== null)
      .then(onModel)
      .catch(() => {});
  };
  const settle = (results: InboxNoteResult[]) => {
    setStatus((current) => {
      const next = { ...current };
      for (const result of results) next[result.agent] = { kind: 'done', result };
      return next;
    });
    const ok = results.filter((result) => result.ok).map((result) => INBOX_AGENT_LABELS[result.agent]);
    const bad = results.filter((result) => !result.ok).map((result) => INBOX_AGENT_LABELS[result.agent]);
    setLive([ok.length ? `Added the note to ${joinNames(ok)}.` : '', bad.length ? `Couldn't add the note to ${joinNames(bad)}.` : ''].filter(Boolean).join(' '));
  };
  const failedAll = (agents: InboxNoteAgentId[], err: unknown): InboxNoteResult[] =>
    agents.map((agent) => ({ ok: false, agent, reason: err instanceof Error ? err.message : String(err), path: null }));
  const add = async () => {
    if (busy) return;
    if (!primary.add) return decline();
    const agents = picked.map((row) => row.id as InboxNoteAgentId);
    setPhase('busy');
    let results: InboxNoteResult[];
    try {
      const next = await inboxApi.answerNotes(agents, asked, report !== null);
      results = next.results;
      onModel(next);
    } catch (err) {
      results = failedAll(agents, err);
    }
    settle(results);
    setPhase('done');
  };
  const retry = async (agent: InboxNoteAgentId) => {
    setStatus((current) => ({ ...current, [agent]: { kind: 'busy' } }));
    let results: InboxNoteResult[];
    try {
      const next = await inboxApi.answerNotes([agent], [agent], false);
      results = next.results;
      onModel(next);
    } catch (err) {
      results = failedAll([agent], err);
    }
    settle(results);
    if (results.every((result) => result.ok)) setFocusDone((n) => n + 1);
  };

  const doneRows = rows.filter((row) => status[row.id]);
  const okRows = doneRows.filter((row) => { const s = status[row.id]; return s?.kind === 'done' && s.result.ok; });
  const anyFailed = doneRows.some((row) => { const s = status[row.id]; return s?.kind === 'done' && !s.result.ok; });
  const done = phase === 'done';

  const title = done
    ? okRows.length > 0
      ? `Added the note to ${whoLabel(okRows.map((row) => row.label))}`
      : 'The note was not added'
    : single
      ? `Add the note to ${rows[0]!.label}?`
      : 'Tell your agents about the Inbox';
  const desc = done
    ? null
    : single
      ? "A short note in its instructions tells it to send you decisions and finished work here while you're away. Plain text you can edit or delete."
      : "Plannotator can add a short note to each agent's instructions, so they send you decisions and finished work here while you're away. Plain text you can edit or delete.";

  return (
    <Modal
      labelledBy={`${id}-title`}
      describedBy={desc ? `${id}-desc` : undefined}
      testId="agent-note"
      onClose={() => (done ? close() : decline())}
      ownKeys
      fallbackFocus={pageHeading}
      className="ib-anote"
    >
      {/* The band is this run's news before the answer; the results view drops it, as in the approved mock. */}
      {!done && band && (band.connected || band.byHand || band.failed.length > 0 || band.foreign.length > 0) && (
        <div className="ib-anote-band" role="status" data-anote-band="">
          {band.connected && (
            <p className="ib-anote-ok">
              <Icon name="checkCircle" />
              <span dir="auto">{band.connected}</span>
            </p>
          )}
          {band.failed.map((line) => (
            <p className="ib-anote-warn" key={`f-${line.agent}`}>
              <Icon name="warn" />
              <span>
                {line.text}{' '}
                <button type="button" className="ib-lnk" onClick={() => toSettings()}>
                  Settings → Agents
                </button>
              </span>
            </p>
          ))}
          {band.byHand && (
            <p className="ib-anote-quiet">
              <Icon name="info" />
              <span>
                {band.byHand}{' '}
                <button type="button" className="ib-lnk" onClick={() => toSettings()}>
                  Settings → Agents
                </button>
              </span>
            </p>
          )}
          {band.foreign.map((line) => (
            <p className="ib-anote-quiet" key={`x-${line.agent}`}>
              <Icon name="info" />
              <span>{line.text}</span>
            </p>
          ))}
        </div>
      )}
      <div className="ib-anote-head">
        <h2 id={`${id}-title`} tabIndex={-1} dir="auto">
          {title}
        </h2>
        {desc && (
          <p className="ib-anote-desc" id={`${id}-desc`}>
            {desc}
          </p>
        )}
      </div>
      <div className="ib-anote-body">
        {done ? (
          <>
            <ul className="ib-anote-table" aria-label="What was written">
              {doneRows.map((row) => {
                const s = status[row.id]!;
                return (
                  <li key={row.id}>
                    <div className="ib-anote-r ib-anote-nobox" data-agent={row.id}>
                      <HostMark host={row.id} />
                      <RowMain row={row} failure={s.kind === 'done' && !s.result.ok ? s.result.reason : null} onRetry={() => void retry(row.id as InboxNoteAgentId)} />
                      <span className="ib-anote-st">
                        {s.kind === 'busy' ? (
                          <span className="ib-anote-pill">Adding…</span>
                        ) : (
                          <span className={`ib-anote-res ${s.result.ok ? 'ib-anote-good' : 'ib-anote-bad'}`}>
                            <Icon name={s.result.ok ? 'check' : 'warn'} />
                            {noteResultLabel(s.result)}
                          </span>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="ib-anote-doneline">
              {[okRows.length > 0 ? 'Each agent reads it from its next session.' : '', anyFailed ? 'Fix the file, then try again here or in Settings → Agents.' : ''].filter(Boolean).join(' ')}
            </p>
          </>
        ) : (
          <>
            <ul className="ib-anote-table" aria-label={single ? 'The note goes to' : 'Agents'}>
              {rows.map((row) =>
                single ? (
                  <li key={row.id}>
                    <div className="ib-anote-r ib-anote-nobox" data-agent={row.id}>
                      <HostMark host={row.id} />
                      <RowMain row={row} />
                      <span className="ib-anote-st">
                        <Pill row={row} />
                      </span>
                    </div>
                  </li>
                ) : (
                  <li key={row.id}>
                    <label className={`ib-anote-r${picks[row.id] ? '' : ' ib-anote-unpicked'}`} data-agent={row.id}>
                      <input
                        type="checkbox"
                        checked={picks[row.id] === true}
                        disabled={busy}
                        onChange={(event) => setPicks((current) => ({ ...current, [row.id]: event.target.checked }))}
                      />
                      <HostMark host={row.id} />
                      <RowMain row={row} />
                      <span className="ib-anote-st">
                        <Pill row={row} />
                      </span>
                    </label>
                  </li>
                ),
              )}
            </ul>
            <button type="button" className="ib-anote-fold" aria-expanded={preview} aria-controls={`${id}-note`} onClick={() => setPreview((open) => !open)}>
              <Icon name="chevR" />
              {preview ? 'Hide the note' : 'Show the note'}
            </button>
            {preview && (
              <div className="ib-anote-note" id={`${id}-note`}>
                <pre tabIndex={0} aria-label="The note Plannotator adds">
                  <NoteText text={noteText} />
                </pre>
              </div>
            )}
          </>
        )}
      </div>
      <div className="ib-anote-foot" data-busy={busy || undefined}>
        {done ? (
          <>
            <span className="ib-anote-later">Remove it any time in Settings → Agents.</span>
            <button type="button" className="ib-btn ib-pri" data-anote-done="" ref={doneRef} onClick={close}>
              Done
            </button>
          </>
        ) : (
          <>
            <span className="ib-anote-later">Change it later in Settings → Agents.</span>
            {primary.add && (
              <button type="button" className="ib-btn ib-ghost" data-anote-notnow="" aria-disabled={busy || undefined} onClick={decline}>
                Not now
              </button>
            )}
            <button type="button" className="ib-btn ib-pri" data-anote-primary="" aria-disabled={busy || undefined} onClick={() => void add()}>
              {busy ? 'Adding…' : primary.label}
            </button>
          </>
        )}
      </div>
      <div className="ib-sr" aria-live="polite">
        {live}
      </div>
    </Modal>
  );

  /** The band's link: Settings → Agents, where a note can still be added. The dialog closes as Not now (nothing written). */
  function toSettings() {
    if (done) close();
    else decline();
    onSettings();
  }
}

function Pill({ row }: { row: InboxAgentRow }) {
  return <span className="ib-anote-pill">{row.note?.create ? 'New file' : 'Adds to end'}</span>;
}

function RowMain({ row, failure, onRetry }: { row: InboxAgentRow; failure?: string | null; onRetry?: () => void }) {
  const note = row.note;
  return (
    <span className="ib-anote-main">
      <span className="ib-anote-name" dir="auto" title={row.label}>
        {row.label}
      </span>
      {note?.path && <NotePath path={note.path} />}
      {!failure && row.id === 'pi' && <span className="ib-anote-sub">Pi reads only one of its instruction files; this is the one.</span>}
      {!failure && note?.shared_with && note.shared_with.length > 0 && (
        <span className="ib-anote-sub">This file is shared with {joinNames(note.shared_with.map((other) => INBOX_AGENT_LABELS[other]))}: one section serves both.</span>
      )}
      {!failure && note?.target && (
        <span className="ib-anote-sub">
          This file is a link to <code dir="ltr">{note.target}</code>; the note goes there.
        </span>
      )}
      {failure && (
        <span className="ib-anote-err">
          <Icon name="warn" />
          <span>
            {sentence(tidyReason(failure))}
            {onRetry && (
              <>
                {' '}
                <button type="button" className="ib-lnk" onClick={onRetry}>
                  Try again
                </button>
              </>
            )}
          </span>
        </span>
      )}
    </span>
  );
}

/** A path on one line, cut in the middle; each folder name its own bidi isolate; the whole path in the DOM and in `title`. */
function NotePath({ path }: { path: string }) {
  const { head, tail } = splitPath(path);
  const segments = (part: string) =>
    part.split('/').map((name, index, all) => (
      <Fragment key={index}>
        {name && <bdi>{name}</bdi>}
        {index < all.length - 1 && (
          <>
            /<wbr />
          </>
        )}
      </Fragment>
    ));
  return (
    <span className="ib-anote-path" dir="ltr" title={path}>
      <span className="ib-anote-ph">{segments(head)}</span>
      <span className="ib-anote-pt">{segments(tail)}</span>
    </span>
  );
}

/** The note, its marker lines muted. */
function NoteText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {line.startsWith('<!-- plannotator-inbox:') ? <span className="ib-anote-marker">{line}</span> : line}
          {index < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </>
  );
}

/** Focus after the dialog when nothing focusable opened it: the page's heading. */
function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}
