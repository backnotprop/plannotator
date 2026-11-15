/**
 * Tidy on every machine the window shows (approval "inbox-multi-select": one experience across devices): each
 * machine's own sessions are asked about its own threads, since only they can read them. The window reads each
 * machine's plan through its door (mark `tidy`), shows one list of agents, and sends each machine its own part.
 * A machine that is away, or too old to take Tidy, is named instead of asked. Pure, but `readAcross` / `startAcross`.
 */
import type { InboxListRow, InboxTidyAgent, InboxTidyPlan, InboxTidyRun } from '@plannotator/core/inbox-types';
import { isAway, rowMachine, type MachinesModel } from './machines';
import { PressKeys } from './pressKeys';

/** A plan's agent, with the machine that asks it (null: this one) and that machine's name for the picker's row. */
export interface TidyAcrossAgent extends InboxTidyAgent {
  machine: string | null;
  machineName: string | null;
}

/** One plan for every machine read; `unasked`: the machines whose part could not be read, and how many picked threads were there. */
export interface TidyAcrossPlan extends Omit<InboxTidyPlan, 'agents'> {
  agents: TidyAcrossAgent[];
  unasked?: { name: string; threads: number }[];
}

/** Where each machine stands for Tidy: `null` for this machine; a linked one that takes it, else why not. */
export interface TidyTarget {
  machine: string | null;
  name: string | null;
  /** Picked threads on that machine (a selection's Tidy); undefined for the whole list. */
  threads?: string[];
  /** It cannot be asked now (asleep, or too old to take Tidy). */
  out?: true;
}

/** The whole list's: this machine and each linked one, those away or without the mark left out. */
export function listTargets(model: MachinesModel): TidyTarget[] {
  return [{ machine: null, name: null }, ...model.linked.filter((m) => !isAway(m) && (m.marks ?? []).includes('tidy')).map((m) => ({ machine: m.id, name: m.name }))];
}

/** Picked rows, by the machine that holds them (this one first); a machine away or without the mark is `out`. */
export function pickTargets(rows: readonly InboxListRow[], model: MachinesModel): TidyTarget[] {
  const by = new Map<string | null, string[]>();
  for (const row of rows) {
    const id = rowMachine(row, model);
    by.set(id, [...(by.get(id) ?? []), row.thread_id]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
    .map(([machine, threads]) => {
      if (machine === null) return { machine, name: null, threads };
      const view = model.linked.find((m) => m.id === machine);
      const out = !view || isAway(view) || !(view.marks ?? []).includes('tidy');
      return { machine, name: model.names.get(machine) ?? null, threads, ...(out ? { out: true as const } : {}) };
    });
}

/** Several machines' runs as one: every asked agent, the latest start. */
function mergeRuns(runs: readonly InboxTidyRun[]): InboxTidyRun | null {
  if (runs.length <= 1) return runs[0] ?? null;
  const latest = [...runs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]!;
  return {
    id: latest.id,
    at: latest.at,
    agents: runs.flatMap((run) => run.agents),
    done: runs.reduce((n, run) => n + run.done, 0),
    updated: runs.reduce((n, run) => n + run.updated, 0),
    ...(latest.words ? { words: latest.words } : {}),
  };
}

/** The machines' plans as one. A run started together on several machines is one run; an older one elsewhere is not shown. */
export function mergePlans(parts: readonly { target: TidyTarget; plan: InboxTidyPlan | null }[]): TidyAcrossPlan | null {
  const own = parts.find((p) => p.target.machine === null)?.plan ?? parts.find((p) => p.plan)?.plan ?? null;
  if (!own) return null;
  const read = parts.filter((p): p is { target: TidyTarget; plan: InboxTidyPlan } => p.plan !== null);
  const agents = read
    .flatMap(({ target, plan }) => plan.agents.map((agent) => ({ ...agent, machine: target.machine, machineName: target.name })))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  // A linked machine's agents say its name in the run too.
  const runs = read.flatMap(({ target, plan }) => (plan.run ? [{ ...plan.run, agents: plan.run.agents.map((agent) => (target.name ? { ...agent, machineName: target.name } : agent)) }] : []));
  const newest = runs.length > 0 ? Math.max(...runs.map((r) => Date.parse(r.at))) : 0;
  // Parts of one press start within a few seconds of each other.
  const together = runs.filter((r) => newest - Date.parse(r.at) < 60_000);
  const unreached = read.reduce(
    (sum, { plan }) => (plan.unreached ? { ended: sum.ended + plan.unreached.ended, asked: sum.asked + plan.unreached.asked } : sum),
    { ended: 0, asked: 0 },
  );
  const unasked = parts.filter((p) => p.target.machine !== null && (p.plan === null || p.target.out)).map((p) => ({ name: p.target.name ?? 'Another machine', threads: p.target.threads?.length ?? 0 }));
  const picking = parts.some((p) => p.target.threads);
  return {
    serverSession: own.serverSession,
    count: read.reduce((n, { plan }) => n + plan.count, 0),
    agents,
    run: mergeRuns(together),
    ...(own.combine ? { combine: own.combine } : {}),
    ...(own.combine_loading ? { combine_loading: own.combine_loading } : {}),
    ...(own.recent ? { recent: own.recent } : {}),
    ...(picking ? { unreached } : {}),
    ...(unasked.length > 0 ? { unasked } : {}),
  };
}

/** Reads every target's plan; a part that cannot be read (asleep, refused) is null. */
export async function readAcross(targets: readonly TidyTarget[], read: (target: TidyTarget) => Promise<InboxTidyPlan>): Promise<TidyAcrossPlan | null> {
  const parts = await Promise.all(targets.map(async (target) => ({ target, plan: target.out ? null : await read(target).catch(() => null) })));
  if (parts.every((p) => p.plan === null) && parts.some((p) => p.target.machine === null)) throw new Error('Tidy could not be read.');
  return mergePlans(parts);
}

/** Asks the ticked agents, each machine its own part under its own key. Null when every part went, else the first refusal. */
export async function startAcross(
  agents: readonly TidyAcrossAgent[],
  key: string | PressKeys,
  send: (machine: string | null, sessions: string[], key: string) => Promise<unknown>,
): Promise<string | null> {
  const keys = typeof key === 'string' ? new PressKeys('tidy', key) : key;
  const by = new Map<string | null, string[]>();
  for (const agent of agents) by.set(agent.machine, [...(by.get(agent.machine) ?? []), agent.session]);
  const results = await Promise.allSettled([...by.entries()].map(([machine, sessions]) => send(machine, sessions, keys.for(machine)).catch((cause: unknown) => {
    keys.failed(machine, cause);
    throw cause;
  })));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!failed) return null;
  return failed.reason instanceof Error ? failed.reason.message : 'Tidy did not start.';
}
