import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxSwarmMemberWire, InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';
import { HostMark, Icon } from '../icons';
import { inboxAgentsFlat, useInboxAgents } from '../agentsList';
import { linkedMachineFacts, machineOf, selfMachineName } from '../inboxUrl';
import { relativeWords, useRelativeClock } from '../relativeTime';
import { SwarmBadgeLook } from './SwarmBadge';
import { GhostGlyph } from './GhostGlyph';
import { swarmApi } from './swarmApi';
import { swarmEscapeIsOurs } from './escape';
import { swarmMemberComputer, swarmMemberTree, swarmStateWords, swarmSummaryWords } from './swarmModel';
import { SwarmAddList } from './SwarmAddList';
import { SwipeToRemove } from '../components/SwipeToRemove';
import { removeSwarmAgent, type SwarmRemoveHost } from './swarmRemove';
import type { TagOption } from '../tags';

/** The most marks the row draws. */
const ROW_MARKS = 4;

/**
 * A swarm thread's summary row, under its title where "N sessions" sits on any other thread (approval
 * "inbox-swarm-thread-ui", B2 "Under the title"; shots 3-folded and 4-status-view): the Swarm chip, then one pressable
 * row with the members' marks, "N agents · X working · Y waiting on you" and a chevron. A press opens the status view
 * in place: each member with where it runs (its project · its computer), its state as quiet words, its `doing` line and
 * when, a sub-agent indented under the member it works for, and Remove on a member (main's, on hover and focus; a
 * phone's row swipes left); its foot holds Add an agent (the agents the thread reaches: a pick hands that agent the
 * thread with the `/swarm` skill, and it shows as not joined yet), Ghost thread with its count, and Turn off. No task line in this piece; the plan is its own card in the thread
 * (SwarmPlanCard.tsx), never in the status view.
 */
export function SwarmSummary({
  threadId,
  swarm,
  phone,
  host,
  onGhost,
}: {
  threadId: string;
  swarm: InboxThreadSwarm;
  phone: boolean;
  /** Its toast (Remove's, with Undo) and the thread's read again after Add or Remove. */
  host: Omit<SwarmRemoveHost, 'threadId'>;
  /** "Ghost thread": the ghost pane. */
  onGhost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const words = swarmSummaryWords(swarm);
  const label = [words.count, words.working, words.waiting, words.off ? 'off' : null].filter(Boolean).join(', ');

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !swarmEscapeIsOurs(event, box.current)) return;
      // This Escape closes the view, never the thread under it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  const marks = swarm.members.filter((m, i, all) => all.findIndex((o) => o.session === m.session) === i).slice(0, ROW_MARKS);
  return (
    <div ref={box} className="ib-swarm-line" data-swarm-summary="" data-open={open ? '' : undefined} data-phone={phone ? '' : undefined} data-off={words.off ? '' : undefined}>
      <SwarmBadgeLook />
      <button type="button" className="ib-swarm-tog" aria-expanded={open} aria-label={`Swarm: ${label}. ${open ? 'Close' : 'Show'} who does what`} onClick={() => setOpen((was) => !was)} data-swarm-toggle="">
        <span className="ib-ss-pile" aria-hidden="true">
          {marks.map((m) => (
            <HostMark key={m.session} host={m.host} agent={m.session} />
          ))}
        </span>
        <span className="ib-swarm-sum" aria-hidden="true">
          {words.count}
          {words.working && <> · {words.working}</>}
          {words.waiting && (
            <>
              {' · '}
              <b data-swarm-sum-state="waiting">{words.waiting}</b>
            </>
          )}
          {words.off && <> · off</>}
        </span>
        <Icon name={open ? 'chevU' : 'chevD'} size={14} />
      </button>
      {open && (
        <SwarmStatus
          threadId={threadId}
          swarm={swarm}
          phone={phone}
          host={host}
          onGhost={() => {
            setOpen(false);
            onGhost();
          }}
        />
      )}
    </div>
  );
}

/** The status view: who does what, and the foot. */
function SwarmStatus({ threadId, swarm, phone, host, onGhost }: { threadId: string; swarm: InboxThreadSwarm; phone: boolean; host: Omit<SwarmRemoveHost, 'threadId'>; onGhost: () => void }) {
  const agents = inboxAgentsFlat(useInboxAgents());
  const now = useRelativeClock(true);
  const [ghostCount, setGhostCount] = useState<number | null>(null);
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const closeAdd = useCallback(() => setAdding(false), []);
  const add = (option: TagOption) => {
    setAdding(false);
    setError(null);
    swarmApi.add(threadId, { session: option.id, host: option.host, ...(option.machine ? { machine: option.machine } : {}), label: option.label }).then(
      () => void host.changed?.(),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  const remove = (m: InboxSwarmMemberWire) => void removeSwarmAgent({ threadId, ...host }, m.session, m.name);
  // The ghost thread's count: its whole length, read when the view opens and again each time the thread is read again
  // (the stream's swarm event, a ghost message included, reads it: a new `swarm`).
  useEffect(() => {
    let live = true;
    swarmApi.read(threadId).then(
      (read) => live && setGhostCount(read.ghost.length),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [threadId, swarm]);

  const threadMachine = machineOf(threadId);
  /** Where a member runs: its project (as the agents list says it) and its computer. */
  const whereOf = (m: InboxSwarmMemberWire): string => {
    const project = agents.find((a) => a.session === m.session)?.project?.name ?? null;
    const computer = swarmMemberComputer(m, () => (threadMachine ? (linkedMachineFacts(threadMachine)?.name ?? null) : selfMachineName()));
    return [project, computer].filter(Boolean).join(' · ');
  };
  const turn = (on: boolean) => {
    setTurning(true);
    setError(null);
    swarmApi.turn(threadId, on).then(
      () => setTurning(false),
      (cause: unknown) => {
        setTurning(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <div className="ib-swarm-pop" role="group" aria-label="Who does what" data-swarm-status="">
      <ul className="ib-swarm-rows">
        {swarmMemberTree(swarm.members).map(({ member: m, depth }) => {
          const state = swarmStateWords(m);
          const where = whereOf(m);
          const row = (
            <div className="ib-swarm-row" data-depth={depth} data-state={m.joined ? (m.state ?? 'unknown') : 'not_joined'} data-swarm-member={m.session}>
              <span className="ib-swarm-mk" aria-hidden="true">
                <HostMark host={m.host} agent={m.session} />
              </span>
              <span className="ib-swarm-nm">
                <bdi>{m.name}</bdi>
                {where && <span className="ib-swarm-wh">{where}</span>}
              </span>
              <span className="ib-swarm-se">
                <span className="ib-swarm-st" data-swarm-state="">
                  {state}
                </span>
                {!phone && (
                  <button type="button" className="ib-rpick-rm ib-swarm-rm" data-swarm-remove={m.session} aria-label={`Remove ${m.name} from this thread`} onClick={() => remove(m)}>
                    Remove
                  </button>
                )}
              </span>
              {m.doing && (
                <span className="ib-swarm-now" data-swarm-doing="">
                  <bdi>{m.doing.text}</bdi>
                  <span className="ib-swarm-when"> · {relativeWords(m.doing.at, now)}</span>
                </span>
              )}
            </div>
          );
          return (
            <li key={m.session} className="ib-swarm-li">
              {phone ? (
                <SwipeToRemove session={m.session} onRemove={() => remove(m)}>
                  {row}
                </SwipeToRemove>
              ) : (
                row
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="ib-swarm-err" role="alert">
          {error}
        </p>
      )}
      <div className="ib-swarm-foot">
        <span className="ib-swarm-addwrap">
          <button type="button" className="ib-swarm-fb" aria-expanded={adding} onClick={() => setAdding((was) => !was)} data-swarm-add="">
            <Icon name="plus" size={15} />
            <span>Add an agent</span>
          </button>
          {adding && <SwarmAddList threadId={threadId} members={new Set(swarm.members.map((m) => m.session))} onPick={add} onClose={closeAdd} />}
        </span>
        <button type="button" className="ib-swarm-fb" onClick={onGhost} data-swarm-ghost="">
          <GhostGlyph size={16} />
          <span>Ghost thread</span>
          {ghostCount !== null && ghostCount > 0 && <span className="ib-swarm-fn">{ghostCount}</span>}
          <Icon name="chevR" size={13} />
        </button>
        <span className="ib-swarm-sp" />
        <button type="button" className="ib-swarm-fb" disabled={turning} onClick={() => turn(!swarm.on)} data-swarm-turn={swarm.on ? 'off' : 'on'}>
          {swarm.on ? 'Turn off' : 'Turn on'}
        </button>
      </div>
    </div>
  );
}
