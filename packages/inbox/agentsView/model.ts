/**
 * The list's Agents view (the owner, 2026-11-19: "the thread list could just be a list of your agents, and under it
 * … a list of all their actual threads"; design A "Agents that open"): the threads the list draws, grouped under the
 * agents they belong to. Pure: from the sections the list hands its rows (held and filtered already, so a filter or a
 * search composes as in the other views, and an agent with no thread left is not drawn), the list's agents and the
 * kept faces' chains. No read of its own.
 *
 * Whose thread: the agent it was sent to (`addressee`), else the one that wrote it (`author`), else its first
 * participant; a launch's thread is its launch's agent's before that agent writes there. A thread with several agents
 * is drawn once, under that agent; the others are its row's small icons (`others`). A thread with none of these is
 * under "No agent".
 *
 * Which agent: one the list names (agents/model.ts `namedAgents`, the ended ones too: the server lists those heard
 * from in the last days), found by its session and those its conversation had before (`continues`). One the list
 * does not name (it ended before that, or the Inbox restarted) is rebuilt from the row's session: one agent with
 * every session its kept face names (agents/agentFaces.ts `agentFaceChains`), named by the session's label (a name
 * the person gave it, else its host's), else its host. On a machine whose agents the list names it has ended; on one
 * it names none of (an older Inbox), its state is not known.
 *
 * The order: agents with something for the person first (the list's urgency order: Priority, Stopped on you, Holding
 * up work, Waiting on you, New), then the others alike, each run by the latest activity; inside an agent, plain newest
 * first by the time its row prints (`rowTimeIso`: its last message, the person's or the agent's), whatever its group
 * (the owner, 2026-11-22: no urgency groups there, and Priority gets no special place).
 * Ended agents sit under their own band. An agent with something for the person starts open.
 *
 * Held order (held.ts, as List keeps its places, listView.ts `flatRows`): everything above is worked out when the list
 * is sorted whole (`ListSort`: Show, a close, a refresh, another folder). Between two sorts each row keeps its agent and
 * its place while it keeps its group, and each agent keeps its place, its band and whether it starts open: an agent
 * that ends changes only its state words until the list settles. A row or an agent that is new takes its place by
 * the rule. The open thread (`ListSort.keep`) keeps its place through a sort, and so does the agent it is under.
 */
import type { InboxAgent, InboxAgentsGroup, InboxListGroupId, InboxListRow, InboxListSection, InboxParticipant } from '@plannotator/core/inbox-types';
import { INBOX_SNOOZED_BAND } from '@plannotator/core/inbox-snooze';
import { agentHostName, agentRowName, agentSessions, namedAgents } from '../agents/model';
import type { MachinesModel } from '../machines';
import type { ListSort } from '../listView';
import { rowTimeIso } from '../rowDelivery';

/** The list's urgency order: a row's group, most urgent first; anything else after. It orders the agents, never the rows under one. */
export const AGENT_ROW_ORDER: readonly InboxListGroupId[] = ['priority', 'stopped', 'holding', 'waiting', 'new', 'sent', 'quiet'];
/** Up to here a row is for the person: its agent comes first and starts open. */
export const FOR_YOU = AGENT_ROW_ORDER.indexOf('new');
/** Up to here a row waits on the person (Priority, Stopped, Holding up work, Waiting on you): it opens a folded agent. */
export const WAITS = AGENT_ROW_ORDER.indexOf('waiting');
const rankOf = (group: InboxListGroupId): number => {
  const at = AGENT_ROW_ORDER.indexOf(group);
  return at < 0 ? AGENT_ROW_ORDER.length : at;
};
export const rowWaits = (group: InboxListGroupId): boolean => rankOf(group) <= WAITS;

/** One agent as the view draws it. */
export interface ViewAgent {
  /** Unique in the view: its machine and its id. */
  key: string;
  /** The id its face is kept by (`InboxAgent.id`, a kept face's key, else its session). */
  id: string;
  /** What a face choice names (agentFaces.ts `AgentFaceRef`). */
  ref: Pick<InboxAgent, 'id' | 'session' | 'continues'>;
  sessions: readonly string[];
  host: string | null;
  name: string;
  project: string | null;
  /** Its machine (an `ibx_` id) on a merged list; null otherwise. */
  machine: string | null;
  /** What it is doing; null when the list cannot know (a machine whose agents it does not name). */
  state: InboxAgent['state'] | null;
  /** Live, on a host that never says when it works: no state words. */
  turnsUnknown: boolean;
  /** When it was last heard, for an ended one ("Ended 4:10 PM"); null when not known. */
  endedAt: string | null;
  /** The list names it (else it was rebuilt from a row's session). */
  listed: boolean;
}

export interface AgentRow {
  row: InboxListRow;
  /** The group the held list draws it in: what its actions read, and its urgency. */
  drawn: InboxListGroupId;
}

export interface AgentBlock {
  agent: ViewAgent;
  rows: AgentRow[];
  /** It starts open (something is for the person), as of the last sort. */
  open: boolean;
  /** Its newest row's time (ISO). */
  last: string;
}

export interface AgentsLayout {
  live: AgentBlock[];
  ended: AgentBlock[];
  /** Threads with no agent, newest first. */
  none: AgentRow[];
  /** What the next call keeps (`agentsLayout`'s `places`). */
  places: AgentPlaces;
}

/** Each row's agent and sort key, and each agent's band, sort key and start, as of the last sort. */
export interface AgentPlaces {
  epoch: number;
  rows: ReadonlyMap<string, { agent: string | null; group: InboxListGroupId; rank: number; at: string }>;
  agents: ReadonlyMap<string, { ended: boolean; rank: number; at: string; open: boolean; agent: ViewAgent }>;
}

export interface AgentsInputs {
  sections: readonly InboxListSection[];
  groups: readonly InboxAgentsGroup[] | null;
  machines: MachinesModel;
  /** Each session's own name (sessionLabels.ts: a given name, else its label, else its host's title). */
  labels?: Readonly<Record<string, string>>;
  /** Kept faces' chains by each of their ids (agentFaces.ts `agentFaceChains`). */
  chains?: ReadonlyMap<string, { id: string; sessions: readonly string[] }>;
}

/** The session a row belongs to: sent to, else written by, else its first participant; null: no agent. */
export function rowAgentSession(row: InboxListRow): { session: string; host: string | null; name: string | null } | null {
  if (row.addressee?.session) return { session: row.addressee.session, host: row.addressee.host ?? null, name: null };
  if (row.author.kind === 'agent' && row.author.session) return { session: row.author.session, host: row.author.host, name: row.author.name };
  const first = row.participants?.[0];
  return first ? { session: first.session, host: first.host, name: first.name ?? null } : null;
}

/** The thread's other agents (its participants not of `agent`), for the row's small icons. */
export function otherAgents(row: InboxListRow, sessions: readonly string[]): InboxParticipant[] {
  return (row.participants ?? []).filter((p) => !sessions.includes(p.session));
}

/** Finds a row's agent: the listed ones by launch and session, else one rebuilt from the session. */
function agentFinder({ groups, machines, labels = {}, chains }: AgentsInputs): (row: InboxListRow) => ViewAgent | null {
  const self = machines.self;
  const machineOf = (row: InboxListRow) => (machines.all.length === 0 ? null : (row.machine ?? self ?? null));
  const known = new Map<string | null, boolean>();
  const byLaunch = new Map<string, ViewAgent>();
  const bySession = new Map<string, ViewAgent>();
  const at = (machine: string | null, id: string) => `${machine ?? ''}\u0000${id}`;
  for (const { machine, known: listed, agents } of namedAgents(groups, machines)) {
    known.set(machine, listed);
    const others = new Set(agents.map((agent) => agent.session));
    for (const agent of agents) {
      const sessions = agentSessions(agent, others);
      const view: ViewAgent = {
        key: at(machine, agent.id),
        id: agent.id,
        ref: agent,
        sessions,
        host: agent.host,
        name: agentRowName(agent),
        project: agent.project?.name ?? null,
        machine: machines.all.length === 0 ? null : machine,
        state: agent.state,
        turnsUnknown: agent.turns_unknown === true,
        endedAt: agent.state === 'ended' ? agent.last_seen_at : null,
        listed: true,
      };
      if (agent.launch) byLaunch.set(at(machine, agent.launch.thread_id), view);
      for (const session of sessions) if (!bySession.has(at(machine, session))) bySession.set(at(machine, session), view);
    }
  }
  const rebuilt = new Map<string, ViewAgent>();
  return (row) => {
    const machine = machineOf(row);
    const launched = byLaunch.get(at(machine, row.thread_id));
    if (launched) return launched;
    const who = rowAgentSession(row);
    if (!who) return null;
    const listed = bySession.get(at(machine, who.session));
    if (listed) return listed;
    const chain = chains?.get(who.session);
    const id = chain?.id ?? who.session;
    const key = at(machine, id);
    const kept = rebuilt.get(key);
    if (kept) return kept;
    const sessions = chain ? [...new Set([who.session, ...chain.sessions])] : [who.session];
    const own = sessions.map((session) => (Object.hasOwn(labels, session) ? labels[session]?.trim() : '')).find(Boolean);
    const view: ViewAgent = {
      key,
      id,
      ref: { id, session: who.session, continues: sessions.filter((session) => session !== who.session && session !== id) },
      sessions,
      host: who.host,
      name: own || who.name?.trim() || agentHostName(who.host),
      project: row.project?.name ?? null,
      machine,
      state: (known.get(machine) ?? false) ? 'ended' : null,
      turnsUnknown: false,
      endedAt: null,
      listed: false,
    };
    rebuilt.set(key, view);
    return view;
  };
}

const byRank = (a: { rank: number; at: string }, b: { rank: number; at: string }) => a.rank - b.rank || b.at.localeCompare(a.at);
/** An agent's threads: newest first, ties by id. */
const byNewest = (a: { at: string; row: InboxListRow }, b: { at: string; row: InboxListRow }) => b.at.localeCompare(a.at) || a.row.thread_id.localeCompare(b.row.thread_id);

/**
 * The view's agents, their rows and the threads with no agent, each in its place (above). `places`: what the last call
 * returned; `sort`: when the list was last sorted whole. Pure.
 */
export function agentsLayout(inputs: AgentsInputs, places: AgentPlaces | null, sort: ListSort): AgentsLayout {
  const sorted = places === null || places.epoch !== sort.epoch;
  const find = agentFinder(inputs);
  const rowPlaces = new Map<string, { agent: string | null; group: InboxListGroupId; rank: number; at: string }>();
  const agentPlaces = new Map<string, { ended: boolean; rank: number; at: string; open: boolean; agent: ViewAgent }>();
  const found = new Map<string, ViewAgent>();
  const rowsOf = new Map<string | null, Array<AgentRow & { rank: number; at: string }>>();
  for (const section of inputs.sections) {
    if (section.id === INBOX_SNOOZED_BAND.id) continue;
    for (const row of section.threads) {
      const old = places?.rows.get(row.thread_id);
      const holds = old !== undefined && old.group === section.id && (!sorted || row.thread_id === sort.keep);
      let agent: string | null;
      if (holds) {
        agent = old.agent;
        // The agent's words as the list names it now; one it no longer names keeps its words, its state as now.
        const now = find(row);
        const was = agent === null ? undefined : places?.agents.get(agent)?.agent;
        if (agent !== null && now?.key === agent) found.set(agent, now.listed || !was?.listed ? now : { ...was, state: now.state });
      } else {
        const now = find(row);
        agent = now?.key ?? null;
        if (now) found.set(now.key, now);
      }
      const place = holds ? old : { agent, group: section.id, rank: rankOf(section.id), at: rowTimeIso(row) };
      rowPlaces.set(row.thread_id, place);
      const list = rowsOf.get(agent) ?? [];
      list.push({ row, drawn: section.id, rank: place.rank, at: place.at });
      rowsOf.set(agent, list);
    }
  }
  const live: Array<AgentBlock & { rank: number; at: string }> = [];
  const ended: Array<AgentBlock & { rank: number; at: string }> = [];
  for (const [key, list] of rowsOf) {
    list.sort(byNewest);
    if (key === null) continue;
    const old = places?.agents.get(key);
    const agent = found.get(key) ?? old?.agent;
    if (!agent) continue;
    const last = list.reduce((max, r) => (r.row.last_at > max ? r.row.last_at : max), '');
    const keep = old !== undefined && (!sorted || (sort.keep !== null && list.some((r) => r.row.thread_id === sort.keep)));
    // Its most urgent thread (its rows are newest first). Agents with nothing for the person rank alike, so they go by
    // their newest thread (an old Sent never tops a fresh Quiet).
    const rank = list.reduce((min, r) => Math.min(min, r.rank), FOR_YOU + 1);
    const place = keep ? { ...old, agent } : { ended: agent.state === 'ended', rank, at: last, open: agent.state !== 'ended' && rank <= FOR_YOU, agent };
    agentPlaces.set(key, place);
    (place.ended ? ended : live).push({ agent, rows: list.map(({ row, drawn }) => ({ row, drawn })), open: place.open, last, rank: place.rank, at: place.at });
  }
  const order = (a: AgentBlock & { rank: number; at: string }, b: AgentBlock & { rank: number; at: string }) => byRank(a, b) || a.agent.key.localeCompare(b.agent.key);
  live.sort(order);
  ended.sort(order);
  const strip = ({ agent, rows, open, last }: AgentBlock) => ({ agent, rows, open, last });
  const none = (rowsOf.get(null) ?? []).sort(byNewest).map(({ row, drawn }) => ({ row, drawn }));
  return { live: live.map(strip), ended: ended.map(strip), none, places: { epoch: sort.epoch, rows: rowPlaces, agents: agentPlaces } };
}
