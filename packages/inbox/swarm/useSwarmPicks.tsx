import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HostMark, Icon } from '../icons';
import { hostLabel, type ComposeTarget } from '../compose/model';
import { ToPicker } from '../compose/ToPicker';
import { PhoneToSheet } from '../compose/PhoneToSheet';
import type { ToMachine } from '../compose/toMachines';
import { SwarmBadge } from './SwarmBadge';
import { SWARM_ACROSS_COMPUTERS, swarmCanJoin } from './model';
import { useSwarmTip } from './useSwarmTip';

/** One more agent in New message's To: the session and the computer it is on (To's machine key). */
export interface SwarmPick {
  target: ComposeTarget;
  machineKey: string;
}

/**
 * The other picks in New message's To (docs/agent-guides/inbox-compose.md, "Swarm"). After the first pick a `+` (Add an
 * agent) opens the same picker over the computers whose agents can work in the thread (`swarmCanJoin`), each picked
 * row checked; a pick adds or removes an agent. With a second agent the Swarm badge appears (its entrance), then rests
 * off; a press turns Swarm on, another turns it off. Send carries `tags` (each `{ host, session }`) and `swarm`: one
 * thread with every agent in it, a swarm only while the badge is on.
 *
 * Which computers: `swarmCanJoin` alone says (today the first pick's own: an agent cannot yet be woken for, or reply
 * into, a thread another computer holds; inbox-mcp-far-read.ts `farReplyRefusal`).
 */
export function useSwarmPicks(input: {
  /** The first pick in To, if it is a running session; a new session's start counts too (`starting`). */
  first: { session: string; machineKey: string } | null;
  starting: boolean;
  machines: readonly ToMachine[];
  home: string | null;
  phone: boolean;
  host: HTMLElement | null;
  /** Back to the words after a pick. */
  after: () => void;
  /** Agents on other computers can work in the thread (`SWARM_ACROSS_COMPUTERS`; a test sets it). */
  across?: boolean;
}) {
  const [picks, setPicks] = useState<SwarmPick[]>([]);
  const [on, setOn] = useState(false);
  const [open, setOpen] = useState(false);
  const firstSession = input.first?.session ?? null;
  const key = input.first?.machineKey ?? null;
  const anchor = !!input.first || input.starting;
  const across = input.across ?? SWARM_ACROSS_COMPUTERS;

  // The first pick moved (another agent, another computer, or To emptied): picks that can't work in its thread go.
  useEffect(() => {
    setPicks((had) => {
      const kept = anchor ? had.filter((p) => p.target.session !== firstSession && swarmCanJoin(key, p.machineKey, across)) : [];
      return kept.length === had.length ? had : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSession, key, anchor, across]);
  // Every second agent that arrives again finds the badge resting off.
  useEffect(() => {
    if (picks.length === 0) setOn(false);
  }, [picks.length]);

  const machines = useMemo(() => {
    const can = input.machines.filter((m) => swarmCanJoin(key, m.key, across));
    return (can.length > 0 ? can : input.machines.slice(0, 1)).map((m) => ({ ...m, launch: null }));
  }, [input.machines, key, across]);
  const checked = useMemo(() => new Set(picks.map((p) => p.target.session)), [picks]);

  const toggle = (target: ComposeTarget, machine: string | null) => {
    const machineKey = input.machines.find((m) => (m.machine ?? null) === (machine ?? null))?.key ?? key ?? '';
    // The first pick is To's own: picking it here changes nothing.
    if (target.session !== firstSession) setPicks((had) => (had.some((p) => p.target.session === target.session) ? had.filter((p) => p.target.session !== target.session) : [...had, { target, machineKey }]));
    setOpen(false);
    input.after();
  };

  const chips = picks.map((p) => (
    <button key={p.target.session} type="button" className="ib-cp-tobtn ib-swarm-also" data-compose-also={p.target.session} aria-label={`${hostLabel(p.target.host)}, ${p.target.project.name}`} onClick={() => setOpen(true)}>
      <HostMark host={p.target.host} agent={p.target.session} />
      <b>{hostLabel(p.target.host)}</b>
      <span className="ib-cp-tod">· {p.target.label ?? p.target.project.name}</span>
    </button>
  ));
  const add = anchor && (
    <button type="button" className="ib-swarm-add" data-compose-add-agent="" aria-label="Add an agent" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
      <Icon name="plus" size={16} />
      {input.phone && <span>Add an agent</span>}
    </button>
  );
  const tip = useSwarmTip(picks.length > 0);
  const badge = picks.length > 0 && (
    <span className="ib-swarm-end">
      <SwarmBadge
        on={on}
        onToggle={(next) => {
          tip.close();
          setOn(next);
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
  /** A phone: a line over the foot's row (To is the pill there). */
  const phoneLine: ReactNode =
    input.phone && anchor ? (
      <div className="ib-swarm-phoneline" data-compose-swarm-line="">
        {chips}
        {add}
        {badge}
      </div>
    ) : null;
  const picker: ReactNode = input.phone ? (
    <PhoneToSheet open={open} host={input.host} groups={[]} selected={firstSession} checked={checked} onPick={toggle} onClose={() => setOpen(false)} machines={machines} opensOn={machines[0]?.key} />
  ) : (
    open && <ToPicker groups={[]} selected={firstSession} checked={checked} home={input.home} phone={false} onPick={toggle} onClose={() => setOpen(false)} machines={machines} opensOn={machines[0]?.key} />
  );
  /** What Send adds to the new thread. */
  const send = picks.length > 0 ? { tags: picks.map((p) => ({ host: p.target.host, session: p.target.session })), swarm: on } : {};
  return { row, phoneLine, picker, send, picks, on, machines };
}
