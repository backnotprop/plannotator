import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HostMark, Icon } from '../icons';
import { hostLabel, type ComposeTarget } from '../compose/model';
import { ToPicker } from '../compose/ToPicker';
import { PhoneToSheet } from '../compose/PhoneToSheet';
import type { ToMachine } from '../compose/toMachines';
import type { StartThreadInput } from '../api';
import { SwarmBadge } from './SwarmBadge';
import { carriesSwarm, swarmWordsFor } from './swarmSkillWords';
import { useSwarmTip } from './useSwarmTip';

/** One more agent in New message's To: the session and the computer it is on (To's machine key). */
export interface SwarmPick {
  target: ComposeTarget;
  machineKey: string;
}

/** New message's other agents as Send carries them: each `{ host, session }`, with `machine` when it runs on another computer than the thread's. */
export function swarmPickTags(picks: readonly SwarmPick[], machines: readonly ToMachine[], threadMachine: string | null, selfId: string | null): NonNullable<StartThreadInput['tags']> {
  return picks.map((p) => {
    const on = machines.find((m) => m.key === p.machineKey)?.machine ?? null;
    // The thread's own computer needs no `machine`; this computer, seen from a linked one, is named by its id.
    const machine = on === threadMachine ? null : (on ?? selfId);
    return { host: p.target.host, session: p.target.session, ...(machine ? { machine } : {}) };
  });
}

/**
 * New message's other agents and the Swarm badge (docs/agent-guides/inbox-swarm.md, "Starting a swarm"), while Swarm
 * is on (swarmOn.ts; off, ComposeDialog draws none of this). After the first pick a `+` (Add an agent) opens the same
 * picker over every computer To reaches (an agent on a linked computer works in the thread too), each picked row
 * checked; a pick adds or removes an agent, and the chip of one opens the picker again. Send carries `tags`: one thread
 * with every agent in it, each handed it with its own delivery.
 *
 * The badge is there, quiet, once To has an agent. A second agent added, or a new agent being started, plays its
 * Gather once; then it rests off. Its state IS "the words carry the `/swarm` skill": a press puts `/swarm` in the words
 * or takes it out, and typing `/swarm` turns it on the same way (swarmSkillWords.ts). The Send pastes the approved
 * skill text, and the server makes the thread a swarm from it.
 */
export function useSwarmPicks(input: {
  /** Swarm is on (swarmOn.ts); off, nothing is drawn and Send adds nothing. */
  on: boolean;
  /** The first pick in To, if it is a running session. */
  first: { session: string; machineKey: string } | null;
  /** A new session To starts at Send, on that computer. */
  starting: { machineKey: string } | null;
  machines: readonly ToMachine[];
  /** The computer the thread is made on (a linked computer's id; null: this one), and this computer's id. */
  threadMachine: string | null;
  selfId: string | null;
  home: string | null;
  phone: boolean;
  host: HTMLElement | null;
  /** Back to the words after a pick. */
  after: () => void;
  /** The words being written, and how to change them (the badge's press). */
  words: string;
  setWords: (change: (words: string) => string) => void;
}) {
  const [picks, setPicks] = useState<SwarmPick[]>([]);
  const [open, setOpen] = useState(false);
  const firstSession = input.first?.session ?? null;
  const anchor = input.on && (!!input.first || !!input.starting);
  const on = carriesSwarm(input.words);

  // To emptied, or its pick is one of the others now: that one leaves the others.
  useEffect(() => {
    setPicks((had) => {
      const kept = anchor ? had.filter((p) => p.target.session !== firstSession) : [];
      return kept.length === had.length ? had : kept;
    });
  }, [firstSession, anchor]);

  // The Gather once for a second agent added, and once for a new agent being started; then the badge rests.
  const [highlight, setHighlight] = useState(0);
  const had = useRef({ several: false, starting: false });
  const several = picks.length > 0;
  const starting = anchor && !!input.starting;
  // Before paint, so the badge never shows a frame of rest before its Gather.
  useLayoutEffect(() => {
    const before = had.current;
    had.current = { several, starting };
    if ((several && !before.several) || (starting && !before.starting)) setHighlight((n) => n + 1);
  }, [several, starting]);

  // The picker lists running agents only: nothing starts from Add an agent.
  const machines = useMemo(() => input.machines.map((m) => ({ ...m, launch: null })), [input.machines]);
  const checked = useMemo(() => new Set(picks.map((p) => p.target.session)), [picks]);

  const toggle = (target: ComposeTarget, machine: string | null) => {
    const machineKey = input.machines.find((m) => (m.machine ?? null) === (machine ?? null))?.key ?? input.first?.machineKey ?? '';
    // The first pick is To's own: picking it here changes nothing.
    if (target.session !== firstSession) setPicks((was) => (was.some((p) => p.target.session === target.session) ? was.filter((p) => p.target.session !== target.session) : [...was, { target, machineKey }]));
    setOpen(false);
    input.after();
  };

  const tip = useSwarmTip(anchor && highlight > 0, on);
  if (!anchor) return { row: null, phoneLine: null, picker: null, send: {}, picks, on: false };

  const chips = picks.map((p) => (
    <button key={p.target.session} type="button" className="ib-cp-tobtn ib-swarm-also" data-compose-also={p.target.session} aria-label={`${hostLabel(p.target.host)}, ${p.target.project.name}. Change the other agents`} onClick={() => setOpen(true)}>
      <HostMark host={p.target.host} agent={p.target.session} />
      {/* A phone: the mark alone, beside To's pill in the foot's row (its name is the button's label). */}
      {!input.phone && <b>{hostLabel(p.target.host)}</b>}
      {!input.phone && <span className="ib-cp-tod">· {p.target.label ?? p.target.project.name}</span>}
    </button>
  ));
  const add = (
    <button type="button" className="ib-swarm-add" data-compose-add-agent="" aria-label="Add an agent" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
      <Icon name="plus" size={16} />
    </button>
  );
  const badge = (
    <span className="ib-swarm-end">
      <SwarmBadge
        on={on}
        appear={false}
        highlight={highlight}
        onToggle={(next) => {
          tip.close();
          input.setWords((words) => swarmWordsFor(words, next));
        }}
        tip={tip.node}
      />
    </span>
  );

  /** A computer: after To's button, in To's row. */
  const row: ReactNode = input.phone ? null : (
    <>
      {chips}
      {add}
      {badge}
    </>
  );
  /** A phone: inline after To's pill in the foot's row, never a row of buttons of its own. */
  const phoneLine: ReactNode = input.phone ? (
    <span className="ib-swarm-phoneline" data-compose-swarm-line="">
      {chips}
      {add}
      {badge}
    </span>
  ) : null;
  const opensOn = input.first?.machineKey ?? input.starting?.machineKey ?? machines[0]?.key;
  const picker: ReactNode = input.phone ? (
    <PhoneToSheet open={open} host={input.host} groups={[]} selected={firstSession} checked={checked} onPick={toggle} onClose={() => setOpen(false)} machines={machines} opensOn={opensOn} />
  ) : (
    open && <ToPicker groups={[]} selected={firstSession} checked={checked} home={input.home} phone={false} onPick={toggle} onClose={() => setOpen(false)} machines={machines} opensOn={opensOn} />
  );
  /** What Send adds to the new thread. */
  const send: Pick<StartThreadInput, 'tags'> = picks.length > 0 ? { tags: swarmPickTags(picks, input.machines, input.threadMachine, input.selfId) } : {};
  return { row, phoneLine, picker, send, picks, on };
}
