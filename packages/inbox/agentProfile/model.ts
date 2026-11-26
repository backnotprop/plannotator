/**
 * Who the card and the profile are about, and what the profile lists (approval "inbox-agent-profile-card"). Pure,
 * from what the window already has: the agents list (this computer's and each linked one's, `useInboxAgents`), the
 * linked machines and the window's rows. No read of its own: a linked computer's agent comes through the same merged
 * list and rows as its sidebar row.
 */
import type { InboxAgent, InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';
import { agentFacts, agentHostName, agentListFilter, agentRowName, agentRowOf, namedAgents } from '../agents/model';
import { machineTakes, type MachinesModel } from '../machines';
import type { AgentMarkPicks } from '../agents/AgentMark';
import { rowTimeIso } from '../rowDelivery';
import { titleOf } from '../components/rowParts';
import { rowWaits } from '../agentsView/model';
import { momentWords } from '../thread/helpers';

export interface ProfileAgent {
  agent: InboxAgent;
  /** Its machine (an `ibx_` id) when machines are linked; null otherwise. */
  machine: string | null;
  /** Its name, as its sidebar row and the filtered list's title say it. */
  name: string;
}

/** The listed agent with this id (on any machine), or null: the list no longer names it. */
export function profileAgentOf(id: string, groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel): ProfileAgent | null {
  for (const { machine, agents } of namedAgents(groups, machines)) {
    const agent = agents.find((a) => a.id === id);
    if (agent) return { agent, machine, name: agentRowName(agent) };
  }
  return null;
}

/** Another computer's agent: that computer's name. */
export function otherMachineName(machine: string | null, machines: MachinesModel): string | null {
  return machine && machine !== machines.self ? (machines.names.get(machine) ?? null) : null;
}

/**
 * "Claude Code · harbor", and "· Studio" for an agent on the other computer (the card, as the Agents view names a
 * machine). `always`: the profile, which names this computer too while machines are linked.
 */
export function agentSubWords(who: ProfileAgent, machines: MachinesModel, always = false): string {
  const { host, project, machine } = agentSubParts(who, machines, always);
  return [host, project, machine].filter(Boolean).join(' · ');
}

/** The same, part by part: the card cuts the project first, so the computer's name stays whole (D1). */
export function agentSubParts(who: ProfileAgent, machines: MachinesModel, always = false): { host: string; project: string | null; machine: string | null } {
  const machine = always ? (machines.all.find((m) => m.id === who.machine)?.name ?? null) : otherMachineName(who.machine, machines);
  return { host: agentHostName(who.agent.host), project: who.agent.project?.name || null, machine: machine || null };
}

/** Which faces its mark offers (agentsView/AgentsList.tsx `picksOf`): all here, the shared ones for a machine that takes them. */
export function agentPicks(machine: string | null, machines: MachinesModel): AgentMarkPicks {
  return !machine || machine === machines.self ? 'all' : machineTakes({ machine }, machines, 'agent-face') ? 'shared' : 'none';
}

/** A new message can be addressed to it (the sidebar's rule): live, and started. */
export const agentTakesMessages = (agent: InboxAgent): boolean => agent.live && !agent.session.startsWith('launch:');

export interface ProfileThread {
  row: InboxListRow;
  title: string;
  /** Stopped on you, Holding up work or Waiting on you. */
  waits: boolean;
  unread: boolean;
  at: string;
}

/** Its threads (the list's agent filter's rule, `agentRowOf`), newest first. */
export function profileThreads(id: string, groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[]): ProfileThread[] {
  const filter = agentListFilter(id, groups, machines, rows);
  return rows
    .filter((row) => !row.snoozed && agentRowOf(row, filter, machines.self))
    .map((row) => {
      const waits = rowWaits(row.section);
      return { row, title: titleOf(row), waits, unread: row.unread && !waits, at: rowTimeIso(row) };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.row.thread_id.localeCompare(b.row.thread_id));
}

/** Heard from within this long reads "Just now" (B1). */
export const JUST_NOW_MS = 60_000;

/**
 * Details: Started, Last heard, Model, Context (and where it lives in Rex), as its sidebar hover card says them, but
 * for the times as the approval writes them (B1): Started "Today, 8:40 AM" (the thread's own moments, `momentWords`),
 * Last heard "Just now" within a minute, else its time.
 */
export function profileDetails(who: ProfileAgent, machines: MachinesModel, now: Date = new Date()): [string, string][] {
  const view = machines.all.find((m) => m.id === who.machine) ?? null;
  const { started_at: started, last_seen_at: heard, launch } = who.agent;
  return agentFacts({ agent: who.agent, machine: who.machine, name: who.name, thread: null }, view, now).rows.map(([term, value]): [string, string] => {
    if (term === 'Started' && started && !launch) return [term, momentWords(started, now) || value];
    if (term === 'Last heard' && heard && now.getTime() - Date.parse(heard) < JUST_NOW_MS) return [term, 'Just now'];
    return [term, value];
  });
}
