import { memo, useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useInboxAgents } from '../agentsList';
import { Icon } from '../icons';
import { awayLine, isAway, machineNotice, type MachinesModel } from '../machines';
import type { MachineView } from '../api';
import { MachineSidebarWord } from '../components/MachineUpdate';
import { Tip } from '../components/Tip';
import { AgentMark } from './AgentMark';
import { GOGGLES_FRAME, GOGGLES_LENSES, GOGGLES_MOUTH } from './goggles';
import { agentFacts, agentHostName, agentsGroups, type AgentEntry } from './model';

export interface AgentsSectionProps {
  machines: MachinesModel;
  rows: readonly InboxListRow[];
  machineId: string | null;
  agentId: string | null;
  page: string;
  closed: boolean;
  onToggle: () => void;
  labelId: string;
  bodyId: string;
  header: (icon: ReactNode) => ReactNode;
  onMachine?: (machineId: string) => void;
  onMachineUpdate?: (machineId: string) => void;
  onAgentFilter: (agentId: string | null) => void;
  onMessageAgent: (session: string, opener: HTMLElement) => void;
  onAddAgent: (opener: HTMLElement) => void;
  onAddMachine?: () => void;
  pick: (go: () => void) => () => void;
}

export function GogglesMark() {
  return (
    <svg className="ib-ic ib-agents-mk" viewBox="142 141.6 740 740" aria-hidden="true" focusable="false">
      <g transform="scale(0.5)">
        <path fillRule="evenodd" d={GOGGLES_FRAME} />
      </g>
      {[...GOGGLES_LENSES, GOGGLES_MOUTH].map(([x, y, width, height]) => (
        <rect key={x} x={x} y={y} width={width} height={height} />
      ))}
    </svg>
  );
}

function LaptopPlus() {
  return (
    <svg className="ib-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon="laptopPlus">
      <path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM2 20h20M12 7.5v5M9.5 10h5" />
    </svg>
  );
}

function AgentTip({ entry, machine }: { entry: AgentEntry; machine: MachineView | null }) {
  const facts = agentFacts(entry, machine);
  return (
    <span className="ib-agtip" data-agent-tip="">
      <bdi className="ib-agtip-t">{facts.title}</bdi>
      <span className="ib-agtip-s">{facts.sub}</span>
      <span className="ib-agtip-st">{facts.state}</span>
      {facts.rows.length > 0 && (
        <span className="ib-agtip-dl">
          {facts.rows.map(([key, value]) => (
            <span key={key} className="ib-agtip-r">
              <span className="ib-agtip-k">{key}</span>
              <bdi className="ib-agtip-v">{value}</bdi>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

type AgentOpens = 'filter' | 'message' | 'none';

const AgentRow = memo(
  function AgentRow(props: { entry: AgentEntry; machine: MachineView | null; on: boolean; away: boolean; opens: AgentOpens; onOpen: (entry: AgentEntry, opener: HTMLElement) => void }) {
    const { entry, machine, on, away } = props;
    return (
      <div className="ib-sbagent" data-sidebar-agent={entry.agent.id} data-agent-state={entry.agent.state}>
        <Tip content={<AgentTip entry={entry} machine={machine} />} side="right" align="start">
          <button
            type="button"
            className={`ib-proj${on ? ' ib-on' : ''}${away ? ' ib-proj-quiet' : ''}`}
            aria-pressed={props.opens === 'filter' || on ? on : undefined}
            aria-haspopup={props.opens === 'message' && !on ? 'dialog' : undefined}
            onClick={(event) => props.onOpen(entry, event.currentTarget)}
            data-agent-open={props.opens}
          >
            <span className="am-slot" aria-hidden="true" />
            <span className="ib-name" dir="auto">
              {entry.name}
            </span>
            <span className="ib-sr">, {agentHostName(entry.agent.host)}</span>
          </button>
        </Tip>
        <AgentMark id={entry.agent.id} host={entry.agent.host} name={entry.name} agent={entry.agent} />
      </div>
    );
  },
  (a, b) =>
    a.entry.agent === b.entry.agent &&
    a.entry.name === b.entry.name &&
    a.entry.machine === b.entry.machine &&
    a.entry.thread?.id === b.entry.thread?.id &&
    a.entry.thread?.subject === b.entry.thread?.subject &&
    a.machine === b.machine &&
    a.on === b.on &&
    a.away === b.away &&
    a.opens === b.opens &&
    a.onOpen === b.onOpen,
);

export function AgentsSection(props: AgentsSectionProps) {
  const groupsRead = useInboxAgents();
  const groups = useMemo(() => agentsGroups(groupsRead, props.machines, props.rows), [groupsRead, props.machines, props.rows]);
  const filled = groups.filter((group) => group.agents.length > 0);
  const captions = filled.filter((group) => group.machine !== null).length > 1;
  const empty = filled.length === 0;
  const machineOn = (id: string) => props.page === 'inbox' && props.machineId === id;
  const agentOn = (entry: AgentEntry) => props.page === 'inbox' && props.agentId === entry.agent.id;
  const canMessage = (entry: AgentEntry) => entry.agent.live && !entry.agent.session.startsWith('launch:');
  const open = (entry: AgentEntry, opener: HTMLElement) => {
    if (agentOn(entry)) return props.pick(() => props.onAgentFilter(null))();
    if (entry.thread) return props.pick(() => props.onAgentFilter(entry.agent.id))();
    if (canMessage(entry)) return props.pick(() => props.onMessageAgent(entry.agent.session, opener))();
  };
  const openNow = useRef(open);
  openNow.current = open;
  const onOpen = useCallback((entry: AgentEntry, opener: HTMLElement) => openNow.current(entry, opener), []);
  return (
    <div className="ib-agentsec" data-agents-surface="" data-closed={props.closed ? '' : undefined}>
      <div className="ib-secrow" data-agents-head="" data-one-add={props.onAddMachine ? undefined : ""}>
        {props.header(<GogglesMark />)}
        {!props.closed && (
          <Tip content="Add agent">
            <button type="button" className="ib-proj-sort ib-agents-add" aria-label="Add agent" aria-haspopup="dialog" data-agents-add="agent" onClick={(event) => props.pick(() => props.onAddAgent(event.currentTarget))()}>
              <Icon name="plus" />
            </button>
          </Tip>
        )}
        {!props.closed && props.onAddMachine && (
          <Tip content="Add machine">
            <button type="button" className="ib-proj-sort ib-agents-add" aria-label="Add machine" data-agents-add="machine" onClick={props.pick(() => props.onAddMachine?.())}>
              <LaptopPlus />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-agents-body" id={props.bodyId} role="group" aria-labelledby={props.labelId} data-agents-section="" data-flat={captions ? undefined : ''} data-closed={props.closed ? '' : undefined}>
        {empty && !props.closed && <div className="ib-side-empty ib-agents-empty">Agents show here while they run.</div>}
        {/* Closed, nothing is drawn under the heading, whatever thread or machine is open. */}
        {(props.closed ? [] : filled).map((group) => {
          const machine = group.machine;
          const rows = group.agents;
          const captionOn = captions && !!machine && machineOn(machine.id);
          const away = machine ? isAway(machine) : false;
          const notice = machine && props.onMachineUpdate ? machineNotice(machine) : null;
          return (
            <div key={machine?.id ?? 'flat'} className="ib-agents-group" data-agents-machine={machine?.id ?? ''}>
              {machine && captions && (
                <div className="ib-mside ib-agents-cap" data-machine-notice={notice?.kind ?? undefined}>
                  <Tip content={machine.self ? 'This machine' : (awayLine(machine) ?? machine.name)} side="right">
                    <button
                      type="button"
                      className={`ib-proj ib-proj-quiet${captionOn ? ' ib-on' : ''}`}
                      onClick={props.pick(() => props.onMachine?.(machine.id))}
                      aria-current={captionOn ? 'page' : undefined}
                      data-machine={machine.id}
                      data-away={away ? '' : undefined}
                    >
                      <span className="ib-name" dir="auto">
                        {machine.name}
                      </span>
                      {away && <span className="ib-sr">, {awayLine(machine)}</span>}
                    </button>
                  </Tip>
                  {notice && <MachineSidebarWord notice={notice} name={machine.name} onPress={props.pick(() => props.onMachineUpdate?.(machine.id))} />}
                </div>
              )}
              {rows.map((entry) => (
                <AgentRow key={entry.agent.id} entry={entry} machine={machine} on={agentOn(entry)} away={away} opens={entry.thread ? 'filter' : canMessage(entry) ? 'message' : 'none'} onOpen={onOpen} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
