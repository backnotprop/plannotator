/**
 * Combine across linked computers (approval "inbox-combine-across-computers"): the picks may be on this computer and
 * on a linked one. "Who writes it" lists the running agents of each computer that wrote in its picked threads (each
 * computer is asked about its own picks), and the chosen agent's computer is where the Combine runs and the new
 * thread lives: it reads the other computer's threads there and archives them there. Pure.
 */
import type { InboxCombineAgent, InboxListRow } from '@plannotator/core/inbox-types';
import { rowMachine, type MachinesModel } from './machines';

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

/** Each computer's agents in one list, as one computer orders its own: most picked threads first, then the one that wrote last. */
export function mergeCombineAgents(lists: readonly { machine: string | null; agents: readonly InboxCombineAgent[] }[]): CombineAgent[] {
  const all = lists.flatMap(({ machine, agents }) => agents.map((agent, order) => ({ agent: { ...agent, machine }, order })));
  if (lists.length < 2) return all.map((a) => a.agent);
  return all.sort((a, b) => b.agent.threads - a.agent.threads || (b.agent.wrote_at ?? '').localeCompare(a.agent.wrote_at ?? '') || a.order - b.order).map((a) => a.agent);
}

/** One agent among every computer's: its session on its computer. */
export const combineAgentKey = (agent: Pick<CombineAgent, 'machine' | 'session'>) => `${agent.machine ?? ''}/${agent.session}`;

/** The computer an agent runs on, as the dialog names it under the agent: this one by its own name. */
export function combineMachineName(machine: string | null, machines: MachinesModel): string {
  return machine === null ? (machines.all.find((m) => m.self)?.name ?? 'this computer') : (machines.names.get(machine) ?? 'another machine');
}
