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
  const machine = always ? (machines.all.find((m) => m.id === who.machine)?.name ?? null) : otherMachineName(who.machine, machines);
  return [agentHostName(who.agent.host), who.agent.project?.name, machine].filter(Boolean).join(' · ');
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

/** Details: Started, Last heard, Model, Context (and where it lives in Rex), as its sidebar hover card says them. */
export function profileDetails(who: ProfileAgent, machines: MachinesModel, now: Date = new Date()): [string, string][] {
  const view = machines.all.find((m) => m.id === who.machine) ?? null;
  return agentFacts({ agent: who.agent, machine: who.machine, name: who.name, thread: null }, view, now).rows;
}
