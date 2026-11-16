/**
 * Combine… (approval "inbox-multi-select", 4A "One agent writes a new thread"): the person picks who writes it, may
 * say what it should be about, and presses Combine. Nothing is archived now: the picked threads go to the archive once
 * the new thread arrives (inbox-combine.ts), and the toast's Undo stops it until then (useCombines.ts).
 *
 * Who can be asked: a running session that wrote in a picked thread, on the machine that holds them, since an agent
 * reads only its own machine's threads. Threads on two machines, or on a machine that cannot be asked now, are said so
 * and nobody is offered.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { InboxCombineAgent, InboxCombineRecord, InboxListRow } from '@plannotator/core/inbox-types';
import { INBOX_COMBINE_WORDS_MAX, inboxCombineAgentApart, inboxCombineAgentLabel, inboxTidyWords } from '@plannotator/core/inbox-types';
import { formatCount, plural, whenTime } from '@plannotator/core/inbox-format';
import { combineApi } from '../combineApi';
import { PressKeys } from '../pressKeys';
import { HostMark } from '../icons';
import { isAway, rowMachine, type MachinesModel } from '../machines';
import { Modal } from './Updates';

/** Agents listed before "Show N more": the top writers, and room for the field and buttons on a phone. */
const FIRST = 4;
const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };

/** Why nobody can be asked about these threads, or null when their machine can be. */
export function combineBlocked(rows: readonly InboxListRow[], machines: MachinesModel): string | null {
  const held = [...new Set(rows.map((row) => rowMachine(row, machines)))];
  const nameOf = (id: string | null) => (id === null ? (machines.all.find((m) => m.self)?.name ?? 'this computer') : (machines.names.get(id) ?? 'another machine'));
  if (held.length > 1) {
    const names = held.map(nameOf);
    return `These threads are on ${names.length === 2 ? 'two' : names.length} machines, ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. An agent reads only the threads on its own machine: pick threads from one machine to combine them.`;
  }
  const machine = held[0] ?? null;
  const view = machine ? machines.linked.find((m) => m.id === machine) : null;
  if (machine && (!view || isAway(view))) return `${nameOf(machine)} can’t be asked now: it is away.`;
  if (machine && !(view!.marks ?? []).includes('combine')) return `${nameOf(machine)} runs an older Plannotator: update it to combine its threads.`;
  return null;
}

export function CombineDialog({ rows, machines = NO_MACHINES, onClose, onStarted }: { rows: readonly InboxListRow[]; machines?: MachinesModel; onClose: () => void; onStarted: (record: InboxCombineRecord, machine: string | null) => void }) {
  const id = useId();
  const n = rows.length;
  const blocked = combineBlocked(rows, machines);
  const machine = rows[0] ? rowMachine(rows[0], machines) : null;
  const machineName = machine ? machines.names.get(machine) : null;
  const [agents, setAgents] = useState<InboxCombineAgent[] | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A double press or a retry after a lost answer starts one Combine; a refusal frees the key for a changed pick.
  const [keys] = useState(() => new PressKeys('combine'));
  // Two presses before the button greys out read the same `sending`: this one is set at once.
  const pressed = useRef(false);
  const ids = rows.map((row) => row.thread_id).join(',');
  useEffect(() => {
    if (blocked) return;
    let live = true;
    combineApi
      .plan(ids.split(','), machine)
      .then((plan) => {
        if (!live) return;
        setAgents(plan.agents ?? []);
        setWho((current) => current ?? plan.agents?.[0]?.session ?? null);
      })
      .catch((cause) => live && (setAgents([]), setError(cause instanceof Error ? cause.message : 'Who can be asked could not be read.')));
    return () => {
      live = false;
    };
  }, [ids, machine, blocked]);
  const [shown, setShown] = useState(FIRST);
  const chosen = agents?.find((a) => a.session === who) ?? null;
  // Down from the last row shown shows them all and moves on, so the arrows reach every agent.
  const focusAgent = (session: string) => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-combine-agent="${CSS.escape(session)}"] input`)?.focus());
  const onArrow = (event: KeyboardEvent) => {
    if (!agents || shown >= agents.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowRight')) return;
    if (agents.findIndex((a) => a.session === who) !== shown - 1) return;
    event.preventDefault();
    const next = agents[shown]!.session;
    setShown(agents.length);
    setWho(next);
    focusAgent(next);
  };
  const nameOf = (agent: InboxCombineAgent) => inboxCombineAgentLabel(agent, agents ?? []);
  const combine = async () => {
    if (!chosen || pressed.current) return;
    pressed.current = true;
    setSending(true);
    setError(null);
    try {
      const words1 = inboxTidyWords(words);
      const { combine: record } = await combineApi.start({ thread_ids: rows.map((row) => row.thread_id), session: chosen.session, idempotency_key: keys.for(), ...(words1 ? { words: words1 } : {}) }, machine);
      onStarted(record, machine);
      onClose();
    } catch (cause) {
      keys.failed(null, cause);
      pressed.current = false;
      setSending(false);
      setError(cause instanceof Error ? cause.message : 'The Combine did not start.');
    }
  };
  // Cancel takes the focus: Combine is greyed until the agents are read, and a focused field would open a phone's keyboard.
  return (
    <Modal labelledBy={`${id}-title`} describedBy={`${id}-lede`} testId="combine" onClose={onClose} ownKeys className="ib-cmb" initialFocus=".ib-btn">
      <div className="ib-dlg-in">
        <h2 id={`${id}-title`}>Combine {plural(n, 'thread')}</h2>
        <p className="ib-sub" id={`${id}-lede`}>
          One agent reads them and starts one new thread with where everything stands. Once it arrives, these go to the archive.
        </p>
        {blocked ? (
          <p className="ib-cmb-why" role="note">
            {blocked}
          </p>
        ) : (
          <>
            <fieldset className="ib-cmb-who">
              <legend>Who writes it</legend>
              {agents === null && <p className="ib-cmb-why">Finding the agents of these threads…</p>}
              {agents?.length === 0 && !error && <p className="ib-cmb-why">No agent that wrote in these threads is running. Combine needs one to read them and write the new thread.</p>}
              <div className="ib-cmb-list" data-all={shown === agents?.length && (agents?.length ?? 0) > FIRST ? '' : undefined} onKeyDown={onArrow}>
              {agents?.slice(0, shown).map((agent) => (
                <label key={agent.session} className="ib-cmb-opt" data-on={agent.session === who ? '' : undefined} data-combine-agent={agent.session}>
                  <input type="radio" name={`${id}-who`} checked={agent.session === who} onChange={() => setWho(agent.session)} />
                  <HostMark host={agent.host} agent={agent.session} />
                  <span className="ib-cmb-nm">
                    <b dir="auto">{nameOf(agent)}</b>
                    <small>
                      {agent.threads} of these
                      {inboxCombineAgentApart(agent, agents, (iso) => whenTime(iso)).map((part) => ` · ${part}`).join('')}
                      {machineName ? ` · ${machineName}` : ''}
                    </small>
                  </span>
                </label>
              ))}
              </div>
              {agents && shown < agents.length && (
                <button type="button" className="ib-cmb-more" onClick={() => {
                    // The button goes: the focus moves to the first agent it showed.
                    focusAgent(agents[shown]!.session);
                    setShown(agents.length);
                  }} data-combine-more="">
                  Show {formatCount(agents.length - shown)} more
                </button>
              )}
            </fieldset>
            <label className="ib-cmb-lbl" htmlFor={`${id}-words`}>
              What should it be about? (optional)
            </label>
            <textarea id={`${id}-words`} className="ib-cmb-words" rows={3} maxLength={INBOX_COMBINE_WORDS_MAX} placeholder="For example: just the billing release work, drop the CSV details" value={words} onChange={(event) => setWords(event.target.value)} data-combine-words="" />
            {chosen && (
              <p className="ib-cmb-what">
                <b dir="auto">{nameOf(chosen)}</b> gets one prompt with the {plural(n, 'thread')}. Open questions are asked again in the new thread. Undo brings the {formatCount(n)} back.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="ib-cmb-err" role="alert">
            {error}
          </p>
        )}
        <div className="ib-cmb-btns">
          <button type="button" className="ib-btn" onClick={onClose} data-combine-cancel="">
            Cancel
          </button>
          <button type="button" className="ib-btn ib-pri" disabled={!chosen || sending || !!blocked} onClick={() => void combine()} data-combine-go="">
            Combine
          </button>
        </div>
      </div>
    </Modal>
  );
}
