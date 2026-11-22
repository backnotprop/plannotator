/**
 * Combine across linked computers (approval "inbox-combine-across-computers"): the picks may be on this computer and
 * on a linked one. "Who writes it" lists every running agent of both computers ("Any running agent on either computer,
 * always", the owner), also with every pick on one of them, so the person can hand the work to another agent: each
 * computer is asked about the picks, and the chosen agent's computer is where the Combine runs and the new thread
 * lives: it reads the other computer's threads there and archives them there. Pure.
 */
import type { InboxCombineAgent, InboxListRow } from '@plannotator/core/inbox-types';
import { InboxApiError } from './apiError';
import { isAway, rowMachine, type MachinesModel } from './machines';

/** An agent the dialog offers, with the computer it runs on (null: this one). */
export type CombineAgent = InboxCombineAgent & { machine: string | null };

/** The picked threads by the computer that holds them, in the order first picked. */
export function combineGroups(rows: readonly InboxListRow[], machines: MachinesModel): { machine: string | null; ids: string[] }[] {
  const groups = new Map<string | null, string[]>();
  for (const row of rows) {
    const machine = rowMachine(row, machines);
    groups.set(machine, [...(groups.get(machine) ?? []), row.thread_id]);
  }
  return [...groups].map(([machine, ids]) => ({ machine, ids }));
}

/**
 * The computers asked who can write it: each that holds picks, and with every pick on one computer, the other one too
 * (each linked computer that is there and combines across computers, when the picks are here; this one, when they are
 * all on a linked one that does). `holds`: whether it holds picks (one that holds none and cannot be read is left out).
 */
export function combineAsks(groups: readonly { machine: string | null; ids: string[] }[], machines: MachinesModel): { machine: string | null; ids: string[]; holds: boolean }[] {
  const asks = groups.map((g) => ({ ...g, holds: true }));
  if (groups.length !== 1) return asks;
  const ids = groups[0]!.ids;
  const across = (id: string) => machines.linked.some((m) => m.id === id && !isAway(m) && (m.marks ?? []).includes('combine-across'));
  const held = groups[0]!.machine;
  if (held === null) for (const m of machines.linked) if (across(m.id)) asks.push({ machine: m.id, ids, holds: false });
  if (held !== null && across(held)) asks.push({ machine: null, ids, holds: false });
  return asks;
}

/**
 * Each computer's agents in one list, as one computer orders its own: most picked threads first, then the one that wrote
 * last. With picks on two computers each lists every running agent (`all=1`): the ones that wrote in no pick (0) last.
 */
export function mergeCombineAgents(lists: readonly { machine: string | null; agents: readonly InboxCombineAgent[] }[]): CombineAgent[] {
  const all = lists.flatMap(({ machine, agents }) => agents.map((agent, order) => ({ agent: { ...agent, machine }, order })));
  if (lists.length < 2) return all.map((a) => a.agent);
  return all.sort((a, b) => b.agent.threads - a.agent.threads || (b.agent.wrote_at ?? '').localeCompare(a.agent.wrote_at ?? '') || a.order - b.order).map((a) => a.agent);
}

/** One agent among every computer's: its session on its computer. */
export const combineAgentKey = (agent: Pick<CombineAgent, 'machine' | 'session'>) => `${agent.machine ?? ''}/${agent.session}`;

/** The computer an agent runs on, as the dialog names it under the agent: this one by its own name. */
export function combineMachineName(machine: string | null, machines: MachinesModel): string {
  // This computer's own id (a refusal or a record from the other computer names it so) is this computer.
  return machine === null || machine === machines.self ? (machines.all.find((m) => m.self)?.name ?? 'this computer') : (machines.names.get(machine) ?? 'another machine');
}

/** The dialog's words for a computer that cannot be asked now, and for one too old to take this Combine. */
export const combineAwayLine = (name: string) => `${name} can’t be asked now: it is away.`;
export const combineOlderLine = (name: string) => `${name} runs an older Plannotator: update it to combine its threads.`;

/**
 * Picks on two linked computers neither of which is this one, or on three or more: no computer can be asked about them
 * all (a Combine reads only its own computer's picks and one linked computer's). Main's words for picks on two machines.
 */
export function combineSpread(held: readonly (string | null)[], machines: MachinesModel): string | null {
  if (held.length < 3 && (held.length < 2 || held.includes(null))) return null;
  const names = held.map((machine) => combineMachineName(machine, machines));
  return `These threads are on ${names.length === 2 ? 'two' : names.length} machines, ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. An agent reads only the threads on its own machine: pick threads from one machine to combine them.`;
}

const AWAY = new Set(['machine_offline', 'machine_answer_unreadable', 'machine_conflict']);
const OLDER = new Set(['machine_needs_update', 'device_route_not_found']);

/**
 * The person's words for a failed read or start that is about a computer (asleep, unreachable or too old), never the
 * server's refusal, which is written for agents. `asked`: the computer the request went to, named when the refusal
 * names none. Null: not about a computer; the dialog shows the Inbox's own words as before.
 */
export function combineFailure(cause: unknown, asked: string | null, machines: MachinesModel): string | null {
  if (!(cause instanceof InboxApiError)) return null;
  // A thread deleted there is not away: the Inbox's own words say it is not there.
  const away = AWAY.has(cause.code);
  if (!away && !OLDER.has(cause.code)) return null;
  const name = combineMachineName(cause.machineId ?? asked, machines);
  return away ? combineAwayLine(name) : combineOlderLine(name);
}
