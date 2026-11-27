/**
 * The list's Agents view as drawn (design A "Agents that open"; the model is agentsView/model.ts): each agent its row
 * (AgentHead.tsx); open, its threads follow one line each (LineRow.tsx, through the list's own `renderRow`), the first
 * `AGENT_ROWS_SHOWN`, then "N more". Then the "Ended" band with the agents that ended (faces grey), then "No agent".
 * A click on an agent's row opens or folds it, remembered per agent (folds.ts); a folded agent draws no rows, so a long
 * list stays light. A fold gives way to a new thread that waits on the person, and Show opens the agents its rows land
 * under, as it opens groups (the owner, 2026-11-08).
 *
 * Every agent is its own `.ib-group` straight in the list's body, its rows straight in it, as the groups' rows are:
 * the row menu, a phone's swipe, the keys and a settle's slide find them there. The rows drawn are told to the list
 * (`onDrawn`): Select all picks those, never a folded agent's or the rows behind "N more".
 */
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import type { AgentMarkPicks } from '../agents/AgentMark';
import { agentFaceChains, useAgentFaceChainsRev } from '../agents/agentFaces';
import { useInboxAgents } from '../agentsList';
import { useSessionLabels, type SessionLabels } from '../sessionLabels';
import { usePictureWorld } from '../pictureWorld';
import { machineTakes, type MachinesModel } from '../machines';
import { GroupBand } from '../components/GroupBand';
import type { ListSort } from '../listView';
import { agentsLayout, rowWaits, type AgentBlock, type AgentPlaces, type AgentRow, type AgentsLayout, type ViewAgent } from './model';
import { ENDED_BAND, NONE_BAND, agentFoldKey, foldHash, useAgentFolds } from './folds';
import { AgentHead, agentMarks } from './AgentHead';
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
  /** Moves on each Show: the agents its rows land under open. */
  shows?: number;
  /** The rows drawn, in order, whenever they change (Select all picks only these). */
  onDrawn?: (ids: readonly string[]) => void;
  /** Agents (their ids) folded by the caller, never kept: the view choice's picture folds its demo agents (viewChoiceFolds.ts). */
  folded?: ReadonlySet<string>;
}

const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };
const NO_LABELS: SessionLabels = {};
const NO_CHAINS: ReturnType<typeof agentFaceChains> = new Map();

/** The rows an agent shows: none folded; open, the first few (and the open thread past them), or all after "N more". */
function shownRows(rows: readonly AgentRow[], open: boolean, more: boolean, selected: string | null): readonly AgentRow[] {
  if (!open) return [];
  if (more || rows.length <= AGENT_ROWS_SHOWN) return rows;
  const at = rows.findIndex((r) => r.row.thread_id === selected);
  return at >= AGENT_ROWS_SHOWN ? [...rows.slice(0, AGENT_ROWS_SHOWN), rows[at]!] : rows.slice(0, AGENT_ROWS_SHOWN);
}

/** Its newest thread that waits on the person (ms), 0 for none: one after a fold opens the agent again. */
function waitsSince(rows: readonly AgentRow[]): number {
  let out = 0;
  for (const { row, drawn } of rows) if (rowWaits(drawn)) out = Math.max(out, Date.parse(row.last_agent_at ?? row.last_at) || 0);
  return out;
}

/** The same `sessions` array for an agent while its sessions are the same: the rows' context (LineAgent) holds, so they do not draw again. */
function keepSessions(layout: AgentsLayout, kept: Map<string, readonly string[]>): AgentsLayout {
  const keep = (block: AgentBlock): AgentBlock => {
    const was = kept.get(block.agent.key);
    const now = block.agent.sessions;
    if (was && was.length === now.length && was.every((s, i) => s === now[i])) return { ...block, agent: { ...block.agent, sessions: was } };
    kept.set(block.agent.key, now);
    return block;
  };
  return { ...layout, live: layout.live.map(keep), ended: layout.ended.map(keep) };
}

/** What the rows looked like before a Show: each row's time of its latest agent message, No agent's rows included. */
const timesOf = (layout: AgentsLayout | null) =>
  new Map((layout ? [...[...layout.live, ...layout.ended].flatMap((b) => b.rows), ...layout.none] : []).map(({ row }) => [row.thread_id, row.last_agent_at ?? row.last_at]));

export function AgentsList({ sections, sort, machines = NO_MACHINES, selectedThreadId, phone, remember, renderRow, shows = 0, onDrawn, folded }: AgentsListProps) {
  const groups = useInboxAgents();
  // In a picture (pictureWorld.ts, the view choice's demo): its own agents, no name or face chain the person gave.
  const world = usePictureWorld();
  const givenLabels = useSessionLabels();
  const labels = world ? NO_LABELS : givenLabels;
  const chainsRev = useAgentFaceChainsRev();
  const folds = useAgentFolds(remember);
  const [more, setMore] = useState<ReadonlySet<string>>(() => new Set());
  // Each row's agent and place until the list is sorted whole (model.ts, held order), as List keeps its places.
  const places = useRef<AgentPlaces | null>(null);
  const sessions = useRef(new Map<string, readonly string[]>());
  const epoch = sort?.epoch;
  const keep = sort?.keep ?? null;
  const layout = useMemo(
    () => keepSessions(agentsLayout({ sections, groups, machines, labels, chains: world ? NO_CHAINS : agentFaceChains() }, epoch === undefined ? null : places.current, { epoch: epoch ?? 0, keep }), sessions.current),
    // `chainsRev`: a kept face's chain changed (agentFaceChains), read again.
    [sections, groups, machines, labels, epoch, keep, chainsRev, world],
  );
  const foldKey = (agent: ViewAgent) => agentFoldKey(agent, machines.self);
  const openOf = (block: AgentBlock) => !folded?.has(block.agent.id) && folds.open(foldKey(block.agent), block.open, waitsSince(block.rows));
  const endedOpen = folds.open(ENDED_BAND, true);
  const noneOpen = folds.open(NONE_BAND, false);

  // Show: the agents (and bands) its rows land under open, and "N more" opens where a row lands past it.
  const seen = useRef<{ layout: AgentsLayout | null; shows: number; before: Map<string, string> | null; epoch: number }>({ layout: null, shows, before: null, epoch: 0 });
  useLayoutEffect(() => {
    const s = seen.current;
    if (shows !== s.shows) {
      // A Show sorts the list whole in the same render (App.tsx settleList); one that did not has nothing to open,
      // and never waits for a later, unrelated sort.
      s.shows = shows;
      s.epoch = s.layout?.places.epoch ?? layout.places.epoch;
      s.before = layout.places.epoch !== s.epoch ? timesOf(s.layout) : null;
    }
    if (s.before && layout.places.epoch !== s.epoch) {
      const before = s.before;
      s.before = null;
      const brought = (row: InboxListRow) => {
        const was = before.get(row.thread_id);
        return was === undefined || (row.last_agent_at ?? row.last_at) > was;
      };
      const open: string[] = [];
      const deeper: string[] = [];
      for (const [band, blocks] of [[null, layout.live], [ENDED_BAND, layout.ended]] as const) {
        for (const block of blocks) {
          const at = block.rows.findIndex(({ row }) => brought(row));
          if (at < 0) continue;
          if (!openOf(block)) open.push(foldKey(block.agent));
          if (band && !endedOpen) open.push(band);
          if (block.rows.slice(AGENT_ROWS_SHOWN).some(({ row }) => brought(row))) deeper.push(block.agent.key);
        }
      }
      if (!noneOpen && layout.none.some(({ row }) => brought(row))) open.push(NONE_BAND);
      folds.openAll(open);
      if (deeper.length > 0) setMore((was) => new Set([...was, ...deeper]));
    }
    s.layout = layout;
    places.current = layout.places;
  });

  // The rows drawn, for Select all.
  const drawn: string[] = [];
  const shownOf = new Map<string, readonly AgentRow[]>();
  for (const block of [...layout.live, ...(endedOpen ? layout.ended : [])]) {
    const rows = shownRows(block.rows, openOf(block), more.has(block.agent.key), selectedThreadId);
    shownOf.set(block.agent.key, rows);
    for (const { row } of rows) drawn.push(row.thread_id);
  }
  if (noneOpen) for (const { row } of layout.none) drawn.push(row.thread_id);
  const drawnKey = drawn.join('\n');
  useLayoutEffect(() => onDrawn?.(drawnKey ? drawnKey.split('\n') : []), [drawnKey, onDrawn]);

  // "N more": focus goes to the first row it shows (the button goes away).
  const focusAfter = useRef<{ group: HTMLElement; before: Set<string> } | null>(null);
  useLayoutEffect(() => {
    const pending = focusAfter.current;
    if (!pending) return;
    focusAfter.current = null;
    const next = [...pending.group.querySelectorAll<HTMLElement>('[data-thread-id]')].find((el) => !pending.before.has(el.getAttribute('data-thread-id')!));
    next?.focus({ preventScroll: true });
  }, [more]);
  const onMore = (key: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    const group = event.currentTarget.parentElement;
    if (group) focusAfter.current = { group, before: new Set((shownOf.get(key) ?? []).map(({ row }) => row.thread_id)) };
    setMore((was) => new Set(was).add(key));
  };

  // A stable toggle, so an agent's row draws again only when what it shows changes (AgentHead is memoized).
  const blocks = useRef(new Map<string, AgentBlock>());
  blocks.current = new Map([...layout.live, ...layout.ended].map((block) => [block.agent.key, block]));
  const latest = useRef({ folds, foldKey });
  latest.current = { folds, foldKey };
  const onToggle = useCallback((key: string) => {
    const block = blocks.current.get(key);
    if (!block) return;
    const { folds: f, foldKey: k } = latest.current;
    f.toggle(k(block.agent), block.open, waitsSince(block.rows));
  }, []);

  const uid = useId();
  const groupId = (block: AgentBlock) => `${uid}-ag-${foldHash(block.agent.key)}`;
  const picksOf = (agent: ViewAgent): AgentMarkPicks => (!agent.machine || agent.machine === machines.self ? 'all' : machineTakes({ machine: agent.machine }, machines, 'agent-face') ? 'shared' : 'none');
  const group = (block: AgentBlock, ended: boolean) => {
    const { agent, rows } = block;
    const open = openOf(block);
    const shown = shownOf.get(agent.key) ?? [];
    const hidden = open ? rows.length - shown.length : 0;
    const machine = agent.machine && agent.machine !== machines.self ? (machines.names.get(agent.machine) ?? null) : null;
    return (
      <div key={agent.key} id={ended ? groupId(block) : undefined} className="ib-group ib-ag" data-section-id={`agent:${agent.key}`} data-agent={agent.id} data-agent-ended={ended ? '' : undefined} role="group" aria-label={agent.name}>
        <AgentHead
          agentKey={agent.key}
          agent={agent}
          project={agent.project}
          machine={machine}
          picks={picksOf(agent)}
          open={open}
          last={block.last}
          marks={open ? null : agentMarks(rows)}
          count={rows.length}
          phone={phone}
          onToggle={onToggle}
        />
        {shown.length > 0 && <LineAgent.Provider value={agent.sessions}>{shown.map((r) => renderRow(r.row, r.drawn))}</LineAgent.Provider>}
        {hidden > 0 && (
          <button type="button" className="ib-agmore" data-agent-more="" onClick={(event) => onMore(agent.key, event)}>
            {formatCount(hidden)} more
          </button>
        )}
      </div>
    );
  };
  return (
    <>
      {layout.live.map((block) => group(block, false))}
      {layout.ended.length > 0 && (
        // The ended agents are their own groups straight in the body (the rows' place); the band's group owns them.
        <div className="ib-group ib-agband" data-section-id="agents-ended" role="group" aria-label="Ended" aria-owns={endedOpen ? layout.ended.map(groupId).join(' ') : undefined}>
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
