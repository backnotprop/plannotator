import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { InboxSwarm } from '@plannotator/core/inbox-types';
import { inboxSwarmAlsoWords, inboxSwarmStateKind, inboxSwarmStateWords, inboxSwarmSummary, type InboxSwarmMember } from '@plannotator/core/inbox-swarm';
import type { ThreadSession } from '../agents/model';
import { useInboxAgents } from '../agentsList';
import { whenTime } from '../format';
import { HostMark } from '../icons';
import { SwarmBadge, SwarmBadgeLook } from './SwarmBadge';
import { swarmMembersOf } from './model';

export interface SwarmLineProps {
  threadId: string;
  swarm: InboxSwarm;
  sessions: readonly ThreadSession[];
  /** The computer that holds the thread (null: this one): its swarm is read and switched there. */
  machine: string | null;
  machineNames: ReadonlyMap<string, string>;
  self: string | null;
  phone: boolean;
  /** Turn swarm off or on; answers the record after it. */
  onSet: (on: boolean) => Promise<InboxSwarm | null>;
  /** Read the record again (an agent's line moved). */
  onRead: () => Promise<InboxSwarm | null>;
  /** The record changed here (a switch, a read): the header keeps it. */
  onChange: (swarm: InboxSwarm) => void;
}

/**
 * A swarm thread's line under the title (docs/agent-guides/inbox-compose.md, "Swarm"): the Swarm badge, the agents'
 * marks and "3 agents · 1 waiting on you". A press opens the status view in place (over the thread on a computer,
 * nothing under it moves; below the line on a phone, one agent per row): each agent's state from its live
 * connection, its own line, the file it last touched, and "also <agent>" where two share a file. Turn off at its foot;
 * off, the line is the quiet badge, and a press turns it back on.
 */
export function SwarmLine(props: SwarmLineProps) {
  const groups = useInboxAgents();
  const swarm = props.swarm;
  const latest = useRef(swarm);
  latest.current = swarm;
  const setSwarm = (next: InboxSwarm | ((had: InboxSwarm) => InboxSwarm)) => props.onChange(typeof next === 'function' ? next(latest.current) : next);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // The agents list is read again when any agent moves or a swarm line changes: the record is read with it.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let live = true;
    void props.onRead().then((next) => live && next && setSwarm(next), () => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const members = useMemo(() => swarmMembersOf(props.sessions, groups, swarm, props.machineNames, props.self), [props.sessions, groups, swarm, props.machineNames, props.self]);
  const set = (on: boolean) => {
    setSwarm((had) => ({ ...had, on }));
    if (!on) setOpen(false);
    void props.onSet(on).then((next) => next && setSwarm(next), () => setSwarm((had) => ({ ...had, on: !on })));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    // This Escape closes the view, never the thread under it.
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  };

  if (!swarm.on) {
    return (
      <div className="ib-swarm-line" data-swarm-line="off" data-phone={props.phone ? '' : undefined}>
        <SwarmBadge on={false} onToggle={() => set(true)} appear={false} />
      </div>
    );
  }
  const summary = inboxSwarmSummary(members);
  const now = new Date();
  return (
    <div ref={box} className="ib-swarm-line" data-swarm-line="on" data-open={open ? '' : undefined} data-phone={props.phone ? '' : undefined} onKeyDown={key}>
      <button ref={toggle} type="button" className="ib-swarm-tog" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <SwarmBadgeLook />
        <span className="ib-ss-pile" aria-hidden="true">
          {members.slice(0, 4).map((m) => (
            <HostMark key={m.session} host={m.host} agent={m.session} />
          ))}
        </span>
        <span className="ib-swarm-sum">
          {props.phone ? null : summary.count}
          {summary.more && (
            <>
              {props.phone ? '' : ' · '}
              <b data-swarm-sum-state={summary.more.includes('waiting') ? 'waiting' : 'working'}>{summary.more}</b>
            </>
          )}
          {props.phone && !summary.more ? summary.count : null}
        </span>
      </button>
      {open && (
        <div className="ib-swarm-pop" role="group" aria-label="Swarm">
          <ul className="ib-swarm-rows">
            {members.map((m) => (
              <SwarmRow key={m.session} member={m} now={now} />
            ))}
          </ul>
          <div className="ib-swarm-foot">
            <button type="button" className="ib-swarm-off" data-swarm-turn-off="" onClick={() => set(false)}>
              Turn off
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SwarmRow({ member, now }: { member: InboxSwarmMember; now: Date }) {
  const kind = inboxSwarmStateKind(member);
  const state = inboxSwarmStateWords(member, (iso) => whenTime(iso, now));
  const also = inboxSwarmAlsoWords(member.also);
  return (
    <li className="ib-swarm-row" data-session={member.session} data-state={kind}>
      <span className="ib-swarm-mk" aria-hidden="true">
        <HostMark host={member.host} agent={member.session} />
      </span>
      <span className="ib-swarm-nm">
        <bdi>{member.name}</bdi>
        {member.where && <span className="ib-swarm-wh">{member.where}</span>}
      </span>
      {state && (
        <span className="ib-swarm-st" data-swarm-state={kind}>
          {kind === 'working' && <i className="ib-swarm-spin" aria-hidden="true" />}
          {state}
        </span>
      )}
      {(member.doing || member.file) && (
        <span className="ib-swarm-now">
          {member.doing && <bdi data-swarm-doing="">{member.doing.text}</bdi>}
          {member.file && (
            <code data-swarm-file="">
              {member.doing ? ' · ' : ''}
              {member.file.path}
            </code>
          )}
          {also && <span className="ib-swarm-alsof" data-swarm-also="">{` · ${also}`}</span>}
        </span>
      )}
    </li>
  );
}
