/**
 * Combine… (approval "inbox-multi-select", 4A "One agent writes a new thread"): the person picks who writes it, may
 * say what it should be about, and presses Combine. Nothing is archived now: the picked threads go to the archive once
 * the new thread arrives (inbox-combine.ts), and the toast's Undo stops it until then (useCombines.ts).
 *
 * Who can be asked (approval "inbox-combine-across-computers": "Any running agent on either computer, always"): every
 * running session on this computer and on a linked one, those that wrote in a picked thread first, each with its
 * computer while one is linked; the chosen agent's computer runs the Combine and keeps the new thread, and reads and
 * archives the other's picked threads there (combineAcross.ts). A machine holding picks that cannot be asked now, or
 * runs an older Plannotator, is said so and nobody is offered; one holding none is left out quietly.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { InboxCombineRecord, InboxListRow } from '@plannotator/core/inbox-types';
import { INBOX_COMBINE_WORDS_MAX, inboxCombineAgentApart, inboxCombineAgentLabel, inboxRowArchived, inboxTidyWords } from '@plannotator/core/inbox-types';
import { formatCount, plural, whenTime } from '@plannotator/core/inbox-format';
import { combineApi } from '../combineApi';
import { combineAgentKey, combineAsks, combineAwayLine, combineFailure, combineGroups, combineMachineName, combineOlderLine, combineSpread, mergeCombineAgents, type CombineAgent } from '../combineAcross';
import { PressKeys } from '../pressKeys';
import { HostMark } from '../icons';
import { isAway, rowMachine, type MachinesModel } from '../machines';
import { Modal } from './Updates';

/** Agents listed before "Show N more": the top writers, and room for the field and buttons on a phone. */
const FIRST = 4;
const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };

/**
 * Why nobody can be asked about these threads, or null when their machines can be: the picks are on one computer, or on
 * this one and one linked one; each linked machine that holds a pick must be there and take Combines, and, with picks on
 * two computers, take them across computers.
 */
export function combineBlocked(rows: readonly InboxListRow[], machines: MachinesModel): string | null {
  const held = [...new Set(rows.map((row) => rowMachine(row, machines)))];
  const spread = combineSpread(held, machines);
  if (spread) return spread;
  for (const machine of held) {
    if (machine === null) continue;
    const view = machines.linked.find((m) => m.id === machine);
    if (!view || isAway(view)) return combineAwayLine(combineMachineName(machine, machines));
    const marks = view.marks ?? [];
    if (!marks.includes('combine') || (held.length > 1 && !marks.includes('combine-across'))) return combineOlderLine(combineMachineName(machine, machines));
  }
  return null;
}

/** `onStarted`'s `label`: the chosen agent as the dialog named it, for the toasts that follow (useCombines.ts). */
export function CombineDialog({ rows, machines = NO_MACHINES, onClose, onStarted }: { rows: readonly InboxListRow[]; machines?: MachinesModel; onClose: () => void; onStarted: (record: InboxCombineRecord, machine: string | null, label: string) => void }) {
  const id = useId();
  const n = rows.length;
  const back = rows.filter((row) => !inboxRowArchived(row)).length;
  const undoLine = back === n ? `Undo brings the ${formatCount(n)} back.` : back === 0 ? 'They stay archived.' : `Undo brings back the ${formatCount(back)} not already archived.`;
  const blocked = combineBlocked(rows, machines);
  const groups = combineGroups(rows, machines);
  const across = groups.length > 1;
  // A computer linked: every agent says which it runs on. None: no computer names.
  const machineOf = (agent: CombineAgent) => (machines.linked.length > 0 || agent.machine !== null ? combineMachineName(agent.machine, machines) : null);
  const [agents, setAgents] = useState<CombineAgent[] | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // A double press or a retry after a lost answer starts one Combine; a refusal frees the key for a changed pick.
  const [keys] = useState(() => new PressKeys('combine'));
  // Two presses before the button greys out read the same `sending`: this one is set at once.
  const pressed = useRef(false);
  // Each computer is asked (`all`: every running agent there, any of which can write it); the answers make one list.
  const asks = JSON.stringify(combineAsks(groups, machines));
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  useEffect(() => {
    if (blocked) return;
    let live = true;
    const each = JSON.parse(asks) as ReturnType<typeof combineAsks>;
    const reads = each.map(({ machine, ids, holds }) =>
      combineApi.plan(ids, machine, true).then(
        (plan) => ({ machine, agents: plan.agents ?? [] }),
        // One that holds no pick and cannot be read now: its agents are left out, the Combine is not about it.
        (cause: unknown) => (holds ? Promise.reject({ machine, cause }) : { machine, agents: [] }),
      ),
    );
    void Promise.allSettled(reads).then((answers) => {
      if (!live) return;
      const failed = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected')?.reason as { machine: string | null; cause: unknown } | undefined;
      // One computer not read: nobody is offered, since the Combine reads both.
      const merged = failed ? [] : mergeCombineAgents(answers.flatMap((a) => (a.status === 'fulfilled' ? [a.value] : [])));
      setAgents(merged);
      setWho((current) => current ?? (merged[0] ? combineAgentKey(merged[0]) : null));
      if (failed) setError((each.length > 1 ? combineFailure(failed.cause, failed.machine, machinesRef.current) : null) ?? (failed.cause instanceof Error ? failed.cause.message : 'Who can be asked could not be read.'));
    });
    return () => {
      live = false;
    };
  }, [asks, blocked]);
  const [shown, setShown] = useState(FIRST);
  const chosen = agents?.find((a) => combineAgentKey(a) === who) ?? null;
  // Down from the last row shown shows them all and moves on, so the arrows reach every agent.
  const focusAgent = (session: string) => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-combine-agent="${CSS.escape(session)}"] input`)?.focus());
  const onArrow = (event: KeyboardEvent) => {
    if (!agents || shown >= agents.length || (event.key !== 'ArrowDown' && event.key !== 'ArrowRight')) return;
    if (agents.findIndex((a) => combineAgentKey(a) === who) !== shown - 1) return;
    event.preventDefault();
    const next = agents[shown]!;
    setShown(agents.length);
    setWho(combineAgentKey(next));
    focusAgent(next.session);
  };
  const nameOf = (agent: CombineAgent) => inboxCombineAgentLabel(agent, agents ?? []);
  const combine = async () => {
    if (!chosen || pressed.current) return;
    pressed.current = true;
    setSending(true);
    setError(null);
    try {
      const words1 = inboxTidyWords(words);
      // The chosen agent's computer runs it: the new thread lives there, and it reads and archives the others' picks.
      const { combine: record } = await combineApi.start({ thread_ids: rows.map((row) => row.thread_id), session: chosen.session, idempotency_key: keys.for(), ...(words1 ? { words: words1 } : {}) }, chosen.machine);
      onStarted(record, chosen.machine, nameOf(chosen));
      onClose();
    } catch (cause) {
      keys.failed(null, cause);
      pressed.current = false;
      setSending(false);
      setError((across || chosen.machine !== (groups[0]?.machine ?? null) ? combineFailure(cause, chosen.machine, machines) : null) ?? (cause instanceof Error ? cause.message : 'The Combine did not start.'));
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
              {agents?.length === 0 && !error && <p className="ib-cmb-why">No agent is running. Combine needs one to read them and write the new thread.</p>}
              <div className="ib-cmb-list" data-all={shown === agents?.length && (agents?.length ?? 0) > FIRST ? '' : undefined} onKeyDown={onArrow}>
              {agents?.slice(0, shown).map((agent) => (
                <label key={combineAgentKey(agent)} className="ib-cmb-opt" data-on={combineAgentKey(agent) === who ? '' : undefined} data-combine-agent={agent.session} data-combine-machine={agent.machine ?? undefined}>
                  <input type="radio" name={`${id}-who`} checked={combineAgentKey(agent) === who} onChange={() => setWho(combineAgentKey(agent))} />
                  <HostMark host={agent.host} agent={agent.session} />
                  <span className="ib-cmb-nm">
                    <b dir="auto">{nameOf(agent)}</b>
                    <small>
                      {agent.threads} of these
                      {inboxCombineAgentApart(agent, agents, (iso) => whenTime(iso)).map((part) => ` · ${part}`).join('')}
                      {machineOf(agent) ? ` · ${machineOf(agent)}` : ''}
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
                <b dir="auto">{nameOf(chosen)}</b> gets one prompt with the {plural(n, 'thread')}. Open questions are asked again in the new thread. {undoLine}
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
