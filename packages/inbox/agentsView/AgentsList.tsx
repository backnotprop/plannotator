/**
 * The list's Agents view as drawn (design A "Agents that open"; the model is agentsView/model.ts): each agent a row
 * with its face at 44 (the animated mark, AgentMark.tsx, its picker included), its name, one line "project ·
 * [machine ·] state" and its newest time; open, its threads follow one line each (LineRow.tsx, through the list's own
 * `renderRow`), the first `AGENT_ROWS_SHOWN`, then "N more". Folded, it shows what waits on the person with the same
 * counts the rows draw, else how many threads it has. Then the "Ended" band with the agents that ended (faces grey),
 * then "No agent". A click on an agent's row opens or folds it, remembered per agent (folds.ts); a folded agent draws
 * no rows, so a long list stays light.
 *
 * Every agent is its own `.ib-group` straight in the list's body, its rows straight in it, as the groups' rows are:
 * the row menu, a phone's swipe, the keys and a settle's slide find them there.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { formatCount, shortTime } from '../format';
import { AgentMark, type AgentMarkPicks } from '../agents/AgentMark';
import { agentFaceChains } from '../agents/agentFaces';
import { useInboxAgents } from '../agentsList';
import { useSessionLabels } from '../sessionLabels';
import { machineTakes, type MachinesModel } from '../machines';
import { GroupBand } from '../components/GroupBand';
import { ActionBadge, QuestionMark, rowMarks, type RowMarks, type WaitStep } from '../components/RowBadge';
import type { ListSort } from '../listView';
import { agentsLayout, type AgentBlock, type AgentPlaces, type AgentRow, type ViewAgent } from './model';
import { ENDED_BAND, NONE_BAND, useAgentFolds } from './folds';
import { LineAgent } from './LineRow';

/** How many of an open agent's threads show before "N more". */
export const AGENT_ROWS_SHOWN = 5;

export interface AgentsListProps {
  sections: readonly InboxListSection[];
  sort?: ListSort;
  machines?: MachinesModel;
  selectedThreadId: string | null;
  phone: boolean;
  /** False in the tour: no fold is kept. */
  remember: boolean;
  renderRow: (row: InboxListRow, drawn: InboxListGroupId) => ReactNode;
}

const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };

/** "Waiting on you", "Working", "Idle", "Ended 4:10 PM"; nothing for a state the list cannot know or say. */
export function agentStateWords(agent: Pick<ViewAgent, 'state' | 'turnsUnknown' | 'endedAt'>): string | null {
  switch (agent.state) {
    case 'waiting':
      return 'Waiting on you';
    case 'working':
      return 'Working';
    case 'idle':
      return agent.turnsUnknown ? null : 'Idle';
    case 'ended':
      return agent.endedAt ? `Ended ${shortTime(agent.endedAt)}` : 'Ended';
    default:
      return null;
  }
}

/** The agent's one line: its project, its machine when it is another one, its state. */
export function agentLine(agent: ViewAgent, machines: MachinesModel): string {
  const machine = agent.machine && agent.machine !== machines.self ? (machines.names.get(agent.machine) ?? null) : null;
  return [agent.project, machine, agentStateWords(agent)].filter(Boolean).join(' · ');
}

const STEPS: readonly WaitStep[] = ['open', 'hold', 'stop'];
const higher = (a: WaitStep, b: WaitStep) => (STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b);

/** What waits on the person across an agent's threads: the rows' marks added up, each at its strongest step. */
export function agentMarks(rows: readonly AgentRow[]): RowMarks | null {
  const out: RowMarks = { questions: 0, question: 'open', actions: 0, action: 'open' };
  for (const { row } of rows) {
    const marks = rowMarks(row);
    if (marks.questions > 0) {
      out.questions += marks.questions;
      out.question = higher(out.question, marks.question);
    }
    if (marks.actions > 0) {
      out.actions += marks.actions;
      out.action = higher(out.action, marks.action);
    }
  }
  return out.questions > 0 || out.actions > 0 ? out : null;
}

function FoldedCounts({ rows, tip }: { rows: readonly AgentRow[]; tip: boolean }) {
  const marks = agentMarks(rows);
  if (!marks) {
    return (
      <span className="ib-agh-c" data-agent-threads={rows.length}>
        {formatCount(rows.length)}
        <span className="ib-sr">{rows.length === 1 ? ' thread' : ' threads'}</span>
      </span>
    );
  }
  return (
    <span className="ib-agh-marks">
      <ActionBadge row={rows[0]!.row} marks={marks} tip={tip} />
      <QuestionMark row={rows[0]!.row} marks={marks} tip={tip} />
    </span>
  );
}

interface AgentGroupProps {
  block: AgentBlock;
  line: string;
  picks: AgentMarkPicks;
  open: boolean;
  ended: boolean;
  more: boolean;
  phone: boolean;
  selectedThreadId: string | null;
  onToggle: (key: string, byDefault: boolean) => void;
  onMore: (key: string) => void;
  renderRow: AgentsListProps['renderRow'];
}

/** One agent: its row, and open, its threads. */
function AgentGroup({ block, line, picks, open, ended, more, phone, selectedThreadId, onToggle, onMore, renderRow }: AgentGroupProps) {
  const { agent, rows } = block;
  const at = rows.findIndex((r) => r.row.thread_id === selectedThreadId);
  const shown = !open ? [] : more || rows.length <= AGENT_ROWS_SHOWN ? rows : at >= AGENT_ROWS_SHOWN ? [...rows.slice(0, AGENT_ROWS_SHOWN), rows[at]!] : rows.slice(0, AGENT_ROWS_SHOWN);
  const hidden = open ? rows.length - shown.length : 0;
  return (
    <div className="ib-group ib-ag" data-section-id={`agent:${agent.key}`} data-agent={agent.id} data-agent-ended={ended ? '' : undefined} role="group" aria-label={agent.name}>
      <div className="ib-agh">
        <AgentMark id={agent.id} host={agent.host} name={agent.name} agent={agent.ref} picks={picks} size={44} />
        <button type="button" className="ib-agh-b" data-agent-head="" aria-expanded={open} onClick={() => onToggle(agent.key, block.open)}>
          <span className="ib-agh-1">
            <span className="ib-agh-n" dir="auto">
              {agent.name}
            </span>
            <span className="ib-t">{shortTime(block.last)}</span>
          </span>
          <span className="ib-agh-2">
            <span className="ib-agh-m" dir="auto">
              {line}
            </span>
            {!open && <FoldedCounts rows={rows} tip={!phone} />}
          </span>
        </button>
      </div>
      {shown.length > 0 && <LineAgent.Provider value={agent.sessions}>{shown.map((r) => renderRow(r.row, r.drawn))}</LineAgent.Provider>}
      {hidden > 0 && (
        <button type="button" className="ib-agmore" data-agent-more="" onClick={() => onMore(agent.key)}>
          {formatCount(hidden)} more
        </button>
      )}
    </div>
  );
}

export function AgentsList({ sections, sort, machines = NO_MACHINES, selectedThreadId, phone, remember, renderRow }: AgentsListProps) {
  const groups = useInboxAgents();
  const labels = useSessionLabels();
  const folds = useAgentFolds(remember);
  const [more, setMore] = useState<ReadonlySet<string>>(() => new Set());
  // Each row's agent and place until the list is sorted whole (model.ts, held order), as List keeps its places.
  const places = useRef<AgentPlaces | null>(null);
  const epoch = sort?.epoch;
  const keep = sort?.keep ?? null;
  const layout = useMemo(
    () => agentsLayout({ sections, groups, machines, labels, chains: agentFaceChains() }, epoch === undefined ? null : places.current, { epoch: epoch ?? 0, keep }),
    [sections, groups, machines, labels, epoch, keep],
  );
  useLayoutEffect(() => {
    places.current = layout.places;
  }, [layout]);
  const picksOf = (agent: ViewAgent): AgentMarkPicks => (!agent.machine || agent.machine === machines.self ? 'all' : machineTakes({ machine: agent.machine }, machines, 'agent-face') ? 'shared' : 'none');
  const onMore = (key: string) => setMore((was) => new Set(was).add(key));
  const group = (block: AgentBlock, ended: boolean) => (
    <AgentGroup
      key={block.agent.key}
      block={block}
      line={agentLine(block.agent, machines)}
      picks={picksOf(block.agent)}
      open={folds.open(block.agent.key, block.open)}
      ended={ended}
      more={more.has(block.agent.key)}
      phone={phone}
      selectedThreadId={selectedThreadId}
      onToggle={folds.toggle}
      onMore={onMore}
      renderRow={renderRow}
    />
  );
  const endedOpen = folds.open(ENDED_BAND, true);
  const noneOpen = folds.open(NONE_BAND, false);
  return (
    <>
      {layout.live.map((block) => group(block, false))}
      {layout.ended.length > 0 && (
        <div className="ib-group ib-agband" data-section-id="agents-ended" role="group" aria-label="Ended">
          <GroupBand open={endedOpen} onToggle={() => folds.toggle(ENDED_BAND, true)}>
            Ended <span className="ib-n">{formatCount(layout.ended.length)}</span>
          </GroupBand>
        </div>
      )}
      {endedOpen && layout.ended.map((block) => group(block, true))}
      {layout.none.length > 0 && (
        <div className="ib-group ib-agband" data-section-id="agents-none" role="group" aria-label="No agent">
          <GroupBand open={noneOpen} onToggle={() => folds.toggle(NONE_BAND, false)}>
            No agent <span className="ib-n">{formatCount(layout.none.length)}</span>
          </GroupBand>
          {noneOpen && layout.none.map((r) => renderRow(r.row, r.drawn))}
        </div>
      )}
    </>
  );
}
