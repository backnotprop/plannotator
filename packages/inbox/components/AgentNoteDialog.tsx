import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { InboxAgentRow, InboxAgentsModel, InboxNoteAgentId } from '@plannotator/core/inbox-types';
import { INBOX_AGENT_LABELS } from '@plannotator/core/inbox-types';
import { inboxApi, type InboxNoteResult } from '../api';
import { CURSOR_RULES_PLACE, defaultPicks, joinNames, noteCopiedByHand, notePrimaryAction, noteResultLabel, noteWithoutMarkers, sentence, splitPath, tidyReason, whoLabel } from '../agents';
import { HostMark, Icon } from '../icons';
import { Modal } from './Updates';
import { isTextCut, Tip } from './Tip';

export interface AgentNoteDialogProps {
  rows: InboxAgentRow[];
  noteText: string;
  onModel: (next: InboxAgentsModel) => void;
  onClosed: () => void;
}

type RowStatus = { kind: 'busy' } | { kind: 'done'; result: InboxNoteResult };

export function AgentNoteDialog({ rows, noteText, onModel, onClosed }: AgentNoteDialogProps) {
  const id = useId();
  const doneRef = useRef<HTMLButtonElement>(null);
  const [picks, setPicks] = useState<Record<string, boolean>>(() => defaultPicks(rows));
  const [preview, setPreview] = useState(false);
  const [phase, setPhase] = useState<'ask' | 'busy' | 'done'>('ask');
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [live, setLive] = useState('');
  const closed = useRef(false);
  const [focusDone, setFocusDone] = useState(0);
  useEffect(() => {
    if (phase === 'done') doneRef.current?.focus();
  }, [phase, focusDone]);

  const single = rows.length === 1;
  const handRows = rows.filter(noteCopiedByHand);
  const handOnly = handRows.length === rows.length;
  const handNames = joinNames(handRows.map((row) => row.label));
  const copyText = noteWithoutMarkers(noteText);
  const isManual = (agent: string) => {
    const result = status[agent];
    return result?.kind === 'done' && result.result.ok && result.result.action === 'manual';
  };
  const asked = rows.map((row) => row.id as InboxNoteAgentId);
  const picked = rows.filter((row) => picks[row.id]);
  const pickedWritten = picked.filter((row) => !noteCopiedByHand(row));
  const primary = notePrimaryAction(picked);
  const busy = phase === 'busy';

  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClosed();
  };
  const decline = () => {
    if (busy) return;
    close();
    inboxApi
      .answerNotes([], asked, false)
      .then(onModel)
      .catch(() => {});
  };
  const settle = (results: InboxNoteResult[]) => {
    setStatus((current) => {
      const next = { ...current };
      for (const result of results) next[result.agent] = { kind: 'done', result };
      return next;
    });
    const ok = results.filter((result) => result.ok && result.action !== 'manual').map((result) => INBOX_AGENT_LABELS[result.agent]);
    const manual = results.filter((result) => result.ok && result.action === 'manual').map((result) => INBOX_AGENT_LABELS[result.agent]);
    const bad = results.filter((result) => !result.ok).map((result) => INBOX_AGENT_LABELS[result.agent]);
    setLive(
      [
        ok.length ? `Added the note to ${joinNames(ok)}.` : '',
        manual.length ? `The note for ${joinNames(manual)} is shown below, to copy into ${CURSOR_RULES_PLACE} yourself.` : '',
        bad.length ? `Couldn't add the note to ${joinNames(bad)}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
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
      const next = await inboxApi.answerNotes(agents, asked, false);
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

  const writtenOk = okRows.filter((row) => !isManual(row.id));
  const manualRows = okRows.filter((row) => isManual(row.id));
  const hasManual = manualRows.length > 0;
  const manualNames = joinNames(manualRows.map((row) => row.label));
  const title = done
    ? writtenOk.length > 0
      ? `Added the note to ${whoLabel(writtenOk.map((row) => row.label))}`
      : hasManual && !anyFailed
        ? `Copy the note into ${manualNames}`
        : 'The note was not added'
    : single
      ? handOnly
        ? `Copy the note into ${rows[0]!.label}?`
        : `Add the note to ${rows[0]!.label}?`
      : 'Tell your agents about the Inbox';
  const handLine = `${handNames} ${handRows.length === 1 ? 'keeps its' : 'keep their'} rules in the app, so you copy the note into ${CURSOR_RULES_PLACE} yourself; Plannotator can't see, update or remove that copy.`;
  const desc = done
    ? null
    : single && handOnly
      ? `A short note in its rules tells it to send you decisions and finished work here while you're away. ${handLine}`
      : single
        ? "A short note in its instructions tells it to send you decisions and finished work here while you're away. Plain text you can edit or delete."
        : `Plannotator can add a short note to each agent's instructions, so they send you decisions and finished work here while you're away. Plain text you can edit or delete.${handRows.length > 0 ? ` ${handLine}` : ''}`;

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
                          <span className={`ib-anote-res ${!s.result.ok ? 'ib-anote-bad' : s.result.action === 'manual' ? 'ib-anote-hand' : 'ib-anote-good'}`}>
                            <Icon name={!s.result.ok ? 'warn' : s.result.action === 'manual' ? 'copy' : 'check'} />
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
              {[
                writtenOk.length > 0 ? 'Each agent reads it from its next session.' : '',
                hasManual ? `Copy the note below into ${CURSOR_RULES_PLACE} in ${manualNames}. Plannotator can't see, update or remove that copy.` : '',
                anyFailed ? 'Fix the file, then try again here or in Settings → Agents.' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            </p>
            {hasManual && (
              <div className="ib-anote-note" data-anote-copy="">
                <pre tabIndex={0} aria-label={`The note to copy into ${manualNames}`}>
                  <NoteText text={copyText} />
                </pre>
              </div>
            )}
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
                <pre tabIndex={0} aria-label={handOnly ? 'The note to copy' : 'The note Plannotator adds'}>
                  <NoteText text={handOnly ? copyText : noteText} />
                </pre>
              </div>
            )}
          </>
        )}
      </div>
      <div className="ib-anote-foot" data-busy={busy || undefined}>
        {done ? (
          <>
            <span className="ib-anote-later">
              {writtenOk.length === 0 && hasManual
                ? `Remove the copy in ${manualNames} yourself when you no longer want it.`
                : hasManual
                  ? `Remove the added notes any time in Settings → Agents; the copy in ${manualNames} is yours to remove.`
                  : 'Remove it any time in Settings → Agents.'}
            </span>
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
              {busy ? (pickedWritten.length > 0 ? 'Adding…' : 'Preparing…') : primary.label}
            </button>
          </>
        )}
      </div>
      <div className="ib-sr" aria-live="polite">
        {live}
      </div>
    </Modal>
  );
}

function Pill({ row }: { row: InboxAgentRow }) {
  return <span className="ib-anote-pill">{noteCopiedByHand(row) ? 'Copy yourself' : row.note?.create ? 'New file' : 'Adds to end'}</span>;
}

function RowMain({ row, failure, onRetry }: { row: InboxAgentRow; failure?: string | null; onRetry?: () => void }) {
  const note = row.note;
  return (
    <span className="ib-anote-main">
      <Tip content={row.label} cut>
        <span className="ib-anote-name" dir="auto">
          {row.label}
        </span>
      </Tip>
      {note?.path && <NotePath path={note.path} />}
      {!failure && noteCopiedByHand(row) && <span className="ib-anote-sub">Nothing is written here: you paste the note into {CURSOR_RULES_PLACE}.</span>}
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
    <Tip content={path} when={(trigger) => isTextCut(trigger.querySelector('.ib-anote-ph')) || isTextCut(trigger.querySelector('.ib-anote-pt')) || isTextCut(trigger)}>
      <span className="ib-anote-path" dir="ltr">
        <span className="ib-anote-ph">{segments(head)}</span>
        <span className="ib-anote-pt">{segments(tail)}</span>
      </span>
    </Tip>
  );
}

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

function pageHeading(): HTMLElement | null {
  const heading = document.querySelector<HTMLElement>('.ib-main h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}
