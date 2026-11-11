import { INBOX_HOST_NAMES, type InboxAgent, type InboxAgentsGroup, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';
import type { MachineView } from '../api';
import { awayLine, isAway, type MachinesModel } from '../machines';

export interface AgentEntry {
  agent: InboxAgent;
  machine: string | null;
  name: string;
  thread: { id: string; subject: string } | null;
}

export interface AgentsGroup {
  machine: MachineView | null;
  agents: AgentEntry[];
}

export const agentHostName = (host: string | null): string => (host ? (INBOX_HOST_NAMES[host] ?? host) : 'An agent');

const rowName = (row: InboxListRow) => (row.thread_name ?? row.subject ?? '').trim();

function rowOf(row: InboxListRow, sessions: readonly string[]): boolean {
  if (row.author.kind === 'agent' && !!row.author.session && sessions.includes(row.author.session)) return true;
  if (row.addressee && sessions.includes(row.addressee.session)) return true;
  return (row.participants ?? []).some((p) => sessions.includes(p.session));
}

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

function agentSessions(agent: InboxAgent, others?: ReadonlySet<string>): string[] {
  return [agent.session, ...(agent.continues ?? []).filter((old) => !others?.has(old))];
}

export function agentRowName(agent: InboxAgent, thread: AgentEntry['thread']): string {
  return agent.label?.trim() || thread?.subject || agent.project?.name || agentHostName(agent.host);
}

export function agentsGroups(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[]): AgentsGroup[] {
  return sectionGroups(groups, machines).map(({ group, machine, view }) => ({ machine: view, agents: groupEntries(group, machine, machines.self, rows).shown }));
}

function sectionGroups(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel): { group: InboxAgentsGroup | undefined; machine: string | null; view: MachineView | null }[] {
  const self = machines.self;
  if (machines.all.length === 0) return [{ group: groups?.find((g) => !g.machine || g.machine === self), machine: null, view: null }];
  return machines.all.map((view) => ({ group: groups?.find((g) => (g.machine ?? self) === view.id), machine: view.id, view }));
}

const drawnAs = (entry: AgentEntry, later: AgentEntry) =>
  later !== entry && !!entry.thread && later.thread?.id === entry.thread.id && (later.agent.continues ?? []).includes(entry.agent.session) && !(entry.agent.continues ?? []).includes(later.agent.session);

function groupEntries(group: InboxAgentsGroup | undefined, machine: string | null, self: string | null, rows: readonly InboxListRow[]): { all: AgentEntry[]; shown: AgentEntry[]; others: Set<string> } {
  const listed = (group?.agents ?? []).filter((agent) => agent.state !== 'ended');
  const others = new Set(listed.map((agent) => agent.session));
  const all = listed.map((agent) => {
    const thread = agentThread(agent, machine, self, rows, others);
    return { agent, machine, name: agentRowName(agent, thread), thread };
  });
  return { all, shown: all.filter((entry) => !all.some((later) => drawnAs(entry, later))), others };
}

export interface AgentListFilter {
  id: string;
  name: string;
  machine?: string | null;
  sessions: readonly string[];
  launches: readonly string[];
}

export function agentListFilter(id: string, groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[]): AgentListFilter {
  const self = machines.self;
  for (const { group, machine } of sectionGroups(groups, machines)) {
    if (!group?.agents.some((agent) => agent.id === id)) continue;
    const { all, shown, others } = groupEntries(group, machine, self, rows);
    const entry = shown.find((e) => e.agent.id === id);
    if (!entry) {
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

export function agentRowOf(row: InboxListRow, filter: AgentListFilter, self: string | null): boolean {
  if (filter.machine !== undefined && (row.machine ?? self ?? null) !== (filter.machine ?? self ?? null)) return false;
  return filter.launches.includes(row.thread_id) || rowOf(row, filter.sessions);
}

export function filterAgentRows(sections: readonly InboxListSection[], filter: AgentListFilter | null, self: string | null): InboxListSection[] {
  if (!filter) return sections as InboxListSection[];
  return sections.map((section) => ({ ...section, threads: section.threads.filter((row) => agentRowOf(row, filter, self)) }));
}

export interface AgentFacts {
  title: string;
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
