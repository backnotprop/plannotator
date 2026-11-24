import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HostMark, Icon } from '../icons';
import { hostLabel, type ComposeTarget } from '../compose/model';
import { ToPicker } from '../compose/ToPicker';
import { PhoneToSheet } from '../compose/PhoneToSheet';
import type { ToMachine } from '../compose/toMachines';
import { SwarmBadge } from './SwarmBadge';
import { SWARM_ACROSS_COMPUTERS, swarmCanJoin } from './model';
import { carriesSwarm, swarmAgentKind, swarmAgentName, swarmWordsFor, type SwarmSkillContext } from './swarmSkillWords';
import { useSwarmTip } from './useSwarmTip';

/** One more agent in New message's To: the session and the computer it is on (To's machine key). */
export interface SwarmPick {
  target: ComposeTarget;
  machineKey: string;
}

/**
 * The other picks in New message's To, and the Swarm badge (docs/agent-guides/inbox-compose.md, "Swarm"). After the
 * first pick a `+` (Add an agent) opens the same picker over the computers whose agents can work in the thread
 * (`swarmCanJoin`), each picked row checked; a pick adds or removes an agent. Send carries `tags` (each
 * `{ host, session }`): one thread with every agent in it.
 *
 * The badge is there, quiet, once To has an agent (one agent swarms too: `/swarm`'s one text has it propose the team). A second agent
 * added, or a new agent being started, plays its Gather once; then it rests off. Its state IS "the words carry the
 * `/swarm` skill": a press puts `/swarm` in the words or takes it out, and typing `/swarm` turns it on the same way
 * (swarmSkillWords.ts). The Send pastes the skill's text, filled with `skill`'s agents, and the server makes the
 * thread a swarm from it.
 *
 * Which computers: `swarmCanJoin` alone says (today the first pick's own: an agent cannot yet be woken for, or reply
 * into, a thread another computer holds; inbox-mcp-far-read.ts `farReplyRefusal`).
 */
export function useSwarmPicks(input: {
  /** The first pick in To, if it is a running session. */
  first: { session: string; machineKey: string; target: ComposeTarget } | null;
  /** A new session To starts at Send ("Claude Code", its folder, the computer it starts on). */
  starting: { name: string; where: string | null; machineKey: string } | null;
  machines: readonly ToMachine[];
  home: string | null;
  phone: boolean;
  host: HTMLElement | null;
  /** Back to the words after a pick. */
  after: () => void;
  /** The words being written, and how to change them (the badge's press). */
  words: string;
  setWords: (change: (words: string) => string) => void;
  /** Agents on other computers can work in the thread (`SWARM_ACROSS_COMPUTERS`; a test sets it). */
  across?: boolean;
}) {
  const [picks, setPicks] = useState<SwarmPick[]>([]);
  const [open, setOpen] = useState(false);
  const firstSession = input.first?.session ?? null;
  const key = input.first?.machineKey ?? input.starting?.machineKey ?? null;
  const anchor = !!input.first || !!input.starting;
  const across = input.across ?? SWARM_ACROSS_COMPUTERS;
  const on = carriesSwarm(input.words);

  // The first pick moved (another agent, another computer, or To emptied): picks that can't work in its thread go.
  useEffect(() => {
    setPicks((had) => {
      const kept = anchor ? had.filter((p) => p.target.session !== firstSession && swarmCanJoin(key, p.machineKey, across)) : [];
      return kept.length === had.length ? had : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSession, key, anchor, across]);

  // The Gather once for a second agent added, and once for a new agent being started; then the badge rests.
  const [highlight, setHighlight] = useState(0);
  const had = useRef({ several: false, starting: false });
  const several = picks.length > 0;
  const starting = !!input.starting;
  // Before paint, so the badge never shows a frame of rest before its Gather.
  useLayoutEffect(() => {
    const before = had.current;
    had.current = { several, starting };
    if ((several && !before.several) || (starting && !before.starting)) setHighlight((n) => n + 1);
  }, [several, starting]);

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
  const tip = useSwarmTip(highlight > 0);
  const badge = anchor && (
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
  const send = picks.length > 0 ? { tags: picks.map((p) => ({ host: p.target.host, session: p.target.session })) } : {};

  /** Who the message goes to, for `/swarm`'s text: each agent by its kind, its folder and (another computer's) where. */
  const elsewhere = (machineKey: string) => {
    const m = input.machines.find((x) => x.key === machineKey);
    return m && !m.self ? m.name : null;
  };
  const named = (target: ComposeTarget, machineKey: string) => swarmAgentName(swarmAgentKind(target.host), [target.label ?? target.project.name, elsewhere(machineKey)]);
  const firstName = input.first
    ? named(input.first.target, input.first.machineKey)
    : input.starting
      ? swarmAgentName(input.starting.name, [input.starting.where, elsewhere(input.starting.machineKey)])
      : null;
  const skill: SwarmSkillContext = { agents: [...(firstName ? [firstName] : []), ...picks.map((p) => named(p.target, p.machineKey))] };
  return { row, phoneLine, picker, send, picks, on, machines, skill };
}
