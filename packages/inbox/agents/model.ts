/**
 * The sidebar's Agents section, in words and groups (approval "inbox-agents-section", APPROVED STATE 2026-11-09).
 * Pure: what each machine's group holds, each agent's name, the thread its row opens and the facts its hover card
 * says, from data the window already has (the list's `agents`, its rows and the linked machines). No read of its own.
 */
import { INBOX_HOST_NAMES, type InboxAgent, type InboxAgentsGroup, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';
import type { MachineView } from '../api';
import { awayLine, isAway, type MachinesModel } from '../machines';

export interface AgentEntry {
  agent: InboxAgent;
  /** The machine it runs on; null when no machine is linked (one flat list). */
  machine: string | null;
  /** Its name on the row: its title, else its thread's name, else its project, else its host. */
  name: string;
  /** The thread its row opens: its launch's, else its newest thread (one waiting on the person first). */
  thread: { id: string; subject: string } | null;
}

export interface AgentsGroup {
  /** The machine; null for the one flat list (no machine linked). */
  machine: MachineView | null;
  agents: AgentEntry[];
}

/** An agent's host in words ("Claude Code"); "An agent" when nothing said. */
export const agentHostName = (host: string | null): string => (host ? (INBOX_HOST_NAMES[host] ?? host) : 'An agent');

const rowName = (row: InboxListRow) => (row.thread_name ?? row.subject ?? '').trim();

/** Whether a row is a thread of one of `sessions`: it wrote it, the person addressed it, or it took part. */
function rowOf(row: InboxListRow, sessions: readonly string[]): boolean {
  if (row.author.kind === 'agent' && !!row.author.session && sessions.includes(row.author.session)) return true;
  if (row.addressee && sessions.includes(row.addressee.session)) return true;
  return (row.participants ?? []).some((p) => sessions.includes(p.session));
}

/**
 * The thread an agent's row opens: its launch's thread; else, of the rows the window has (its machine's only), one
 * waiting on the person first, then the newest. Null when the window has none of its threads. Its threads are its
 * session's and those of the session ids its conversation had before (`continues`), but for the ones in `others`:
 * a session listed as an agent of its own keeps its threads.
 */
export function agentThread(agent: InboxAgent, machine: string | null, self: string | null, rows: readonly InboxListRow[], others?: ReadonlySet<string>): AgentEntry['thread'] {
  const mine = (row: InboxListRow) => (row.machine ?? self ?? null) === (machine ?? self ?? null);
  const sessions = agentSessions(agent, others);
  if (agent.launch) {
    const row = rows.find((r) => r.thread_id === agent.launch!.thread_id && mine(r));
    return { id: agent.launch.thread_id, subject: row ? rowName(row) : '' };
  }
  let best: InboxListRow | null = null;
  for (const row of rows) {
    if (!mine(row) || !rowOf(row, sessions)) continue;
    if (!best) best = row;
    else if (row.waiting_on_person !== best.waiting_on_person) best = row.waiting_on_person ? row : best;
    else if ((row.last_agent_at ?? row.last_at) > (best.last_agent_at ?? best.last_at)) best = row;
  }
  return best ? { id: best.thread_id, subject: rowName(best) } : null;
}

/** An agent's sessions: the one it runs as and those its conversation had before, but for the ones in `others` (listed as agents of their own). */
function agentSessions(agent: InboxAgent, others?: ReadonlySet<string>): string[] {
  return [agent.session, ...(agent.continues ?? []).filter((old) => !others?.has(old))];
}

/** An agent's name on its row: its title, else its thread's name, else its project, else its host. */
export function agentRowName(agent: InboxAgent, thread: AgentEntry['thread']): string {
  return agent.label?.trim() || thread?.subject || agent.project?.name || agentHostName(agent.host);
}

/**
 * The section's groups. No machine linked: one flat group of this Inbox's agents. Linked: one group per machine in
 * the machines' order (this one first), each with its agents, a machine with none keeping its label (it is the
 * machine's filter). An ended agent is not listed (the owner dropped "N ended today"); one that still waits on the
 * person is `waiting`, not ended, and stays.
 *
 * One conversation, one row: the Inbox lists a conversation that got a new session id once, unless the old id still
 * polls (`InboxAgent.continues`). Then both are listed, and when both open the same thread it is one conversation to
 * the person, so only the continuing one is drawn. Two agents that share a thread and do not continue one another
 * stay two rows.
 */
export function agentsGroups(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[]): AgentsGroup[] {
  return sectionGroups(groups, machines).map(({ group, machine, view }) => ({ machine: view, agents: groupEntries(group, machine, machines.self, rows).shown }));
}

/** Each group the section draws: one flat group of this Inbox's agents with no machine linked, else one per machine. */
function sectionGroups(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel): { group: InboxAgentsGroup | undefined; machine: string | null; view: MachineView | null }[] {
  const self = machines.self;
  if (machines.all.length === 0) return [{ group: groups?.find((g) => !g.machine || g.machine === self), machine: null, view: null }];
  return machines.all.map((view) => ({ group: groups?.find((g) => (g.machine ?? self) === view.id), machine: view.id, view }));
}

/** `entry` is the older session of `later`'s conversation and opens the same thread: one row, `later`'s. */
const drawnAs = (entry: AgentEntry, later: AgentEntry) =>
  later !== entry && !!entry.thread && later.thread?.id === entry.thread.id && (later.agent.continues ?? []).includes(entry.agent.session) && !(entry.agent.continues ?? []).includes(later.agent.session);

/** One machine's listed agents (`all`, the ended left out) and the rows drawn for them (`shown`, one per conversation). */
function groupEntries(group: InboxAgentsGroup | undefined, machine: string | null, self: string | null, rows: readonly InboxListRow[]): { all: AgentEntry[]; shown: AgentEntry[]; others: Set<string> } {
  const listed = (group?.agents ?? []).filter((agent) => agent.state !== 'ended');
  const others = new Set(listed.map((agent) => agent.session));
  const all = listed.map((agent) => {
    const thread = agentThread(agent, machine, self, rows, others);
    return { agent, machine, name: agentRowName(agent, thread), thread };
  });
  return { all, shown: all.filter((entry) => !all.some((later) => drawnAs(entry, later))), others };
}

/**
 * The list's agent filter (a click on an agent in the sidebar, `#agent=<id>`): the threads its row stands for. Its
 * sessions (`agentSessions`: the one it runs as and the ones its conversation had before, but for one listed as an
 * agent of its own), and those of every older session drawn as this same row (`drawnAs`), on its machine; its
 * launch's thread too. `machine` undefined: an agent the list no longer names (ended, or a link from before), matched
 * by its id as a session on any machine.
 */
export interface AgentListFilter {
  id: string;
  /** Its row's name, the list's title while the filter is on. */
  name: string;
  machine?: string | null;
  sessions: readonly string[];
  /** Threads its launches opened (a launch's thread is its own before its agent writes there). */
  launches: readonly string[];
}

export function agentListFilter(id: string, groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[]): AgentListFilter {
  const self = machines.self;
  for (const { group, machine } of sectionGroups(groups, machines)) {
    if (!group?.agents.some((agent) => agent.id === id)) continue;
    const { all, shown, others } = groupEntries(group, machine, self, rows);
    const entry = shown.find((e) => e.agent.id === id);
    if (!entry) {
      // Ended (not listed), or an older session drawn as another row: its own sessions.
      const agent = group.agents.find((a) => a.id === id)!;
      const thread = agentThread(agent, machine, self, rows, others);
      return { id, name: agentRowName(agent, thread), machine, sessions: agentSessions(agent, others), launches: agent.launch ? [agent.launch.thread_id] : [] };
    }
    const one = [entry, ...all.filter((older) => drawnAs(older, entry))];
    return {
      id,
      name: entry.name,
      machine,
      sessions: [...new Set(one.flatMap((e) => agentSessions(e.agent, others)))],
      launches: one.flatMap((e) => (e.agent.launch ? [e.agent.launch.thread_id] : [])),
    };
  }
  return { id, name: agentHostName(null), sessions: [id], launches: [] };
}

/** Whether a list row is one of the filter's agent's threads (`rowOf`, as its row finds its thread). */
export function agentRowOf(row: InboxListRow, filter: AgentListFilter, self: string | null): boolean {
  if (filter.machine !== undefined && (row.machine ?? self ?? null) !== (filter.machine ?? self ?? null)) return false;
  return filter.launches.includes(row.thread_id) || rowOf(row, filter.sessions);
}

/** The list one agent's filter shows. The sections stay, empty ones included, as a machine's filter leaves them. */
export function filterAgentRows(sections: readonly InboxListSection[], filter: AgentListFilter | null, self: string | null): InboxListSection[] {
  if (!filter) return sections as InboxListSection[];
  return sections.map((section) => ({ ...section, threads: section.threads.filter((row) => agentRowOf(row, filter, self)) }));
}

/** What an agent's hover card says, line by line; a fact the window does not have is left out. */
export interface AgentFacts {
  title: string;
  /** "Claude Code · billing-svc · Studio" */
  sub: string;
  state: string;
  rows: [string, string][];
}

export function agentFacts(entry: AgentEntry, machine: MachineView | null, now: Date = new Date()): AgentFacts {
  const { agent } = entry;
  const sub = [agentHostName(agent.host), agent.project?.name, machine?.name].filter(Boolean).join(' · ');
  const away = machine && isAway(machine) ? awayLine(machine, now) : null;
  const state =
    away ??
    (agent.state === 'waiting'
      ? agent.waiting > 1
        ? `${agent.waiting} threads waiting on you`
        : 'Waiting on you'
      : agent.state === 'working'
        ? 'Working'
        : agent.state === 'idle'
          ? 'Idle'
          : 'Ended');
  const rows: [string, string][] = [];
  if (agent.started_at) rows.push(['Started', agent.launch ? `From the Inbox, ${whenTime(agent.started_at, now)}` : whenTime(agent.started_at, now)]);
  else if (agent.launch) rows.push(['Started', 'From the Inbox']);
  if (agent.last_seen_at) rows.push(['Last heard', whenTime(agent.last_seen_at, now)]);
  if (entry.thread?.subject && entry.thread.subject !== entry.name) rows.push(['Thread', entry.thread.subject]);
  return { title: entry.name, sub, state, rows };
}
