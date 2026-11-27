/**
 * Grid's input (approval "inbox-agent-grid"): each list row the window holds, with its agent, its PRs and its
 * checklist, as `GridThreadIn` (packages/shared/inbox/grid.ts holds the rules). The list is the merged one, so a
 * linked computer's threads, agents, PRs, checklists and looks come the same way as this computer's, with no read of
 * Grid's own: every PR's times, checks and review ride the row's PR summary (`pulls.items`).
 *
 * One line per piece of work: a PR put on two threads is the work of the thread it was put on first (then the lower
 * thread id), so it is one line and counts once; a thread with several PRs is one line over all of them.
 *
 * A linked computer's times are read on this computer's clock: its `clock_ms` (how far its clock runs ahead, measured
 * when its list arrived) is taken off each of them, so a clock 20 minutes off does not make its work look quiet.
 * Pure.
 */
import type { InboxAgent, InboxAgentsGroup, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { GridPullIn, GridThreadIn } from '../../shared/inbox/grid';
import { agentFinder, type ViewAgent } from '../agentsView/model';
import type { MachinesModel } from '../machines';
import { rowMachine } from '../machines';
import { labelOfKey } from '../threadPulls/model';
import { titleOf } from '../components/rowParts';

/** Each row once (a starred or Priority row is also in its own section), in the list's order. */
export function gridRows(sections: readonly InboxListSection[]): InboxListRow[] {
  const seen = new Set<string>();
  const out: InboxListRow[] = [];
  for (const section of sections) for (const row of section.threads) if (!seen.has(row.thread_id)) seen.add(row.thread_id), out.push(row);
  return out;
}

const terminalOf = (agent: ViewAgent | null): GridThreadIn['terminal'] => {
  const mark = agent?.listed ? (agent.ref as InboxAgent).status_mark : undefined;
  return mark?.state === 'blocked' && mark.where === 'terminal' && mark.kind ? mark.kind : null;
};

/** A row's PRs as the summary has them; an older Inbox's summary names only its headline. */
function rowPulls(row: InboxListRow): GridPullIn[] {
  const summary = row.pulls;
  if (!summary) return [];
  const items = summary.items ?? [{ key: summary.headline.key, state: summary.headline.state, added_at: null, read_at: null, checks: null, review: null }];
  return items.map((item) => ({ key: item.key, label: labelOfKey(item.key), state: item.state, added_at: item.added_at, read_at: item.read_at, checks: item.checks, review: item.review }));
}

/** The thread each PR is the work of: the one it was put on first. */
function pullOwners(rows: readonly InboxListRow[]): Map<string, string> {
  const first = new Map<string, { thread: string; at: string }>();
  for (const row of rows) {
    for (const item of row.pulls?.items ?? []) {
      const was = first.get(item.key);
      if (!was || item.added_at < was.at || (item.added_at === was.at && row.thread_id < was.thread)) first.set(item.key, { thread: row.thread_id, at: item.added_at });
    }
  }
  return new Map([...first].map(([key, v]) => [key, v.thread]));
}

export interface GridInputs {
  sections: readonly InboxListSection[];
  groups: readonly InboxAgentsGroup[] | null;
  machines: MachinesModel;
  labels?: Readonly<Record<string, string>>;
  /** The look this sitting compares with, per thread (the page keeps the first it read; grid/gridSeen.ts). */
  seenOf: (row: InboxListRow) => InboxListRow['grid_seen'] | undefined;
}

export function gridThreads({ sections, groups, machines, labels, seenOf }: GridInputs): GridThreadIn[] {
  const rows = gridRows(sections);
  const find = agentFinder({ sections, groups, machines, labels });
  const agents = rows.map((row) => find(row));
  const owners = pullOwners(rows);
  const clocks = new Map(machines.linked.flatMap((m) => (m.clock_ms ? [[m.id, m.clock_ms] as const] : [])));
  // The thread each agent moved in last: where its turn, or its terminal prompt, is.
  const latest = new Map<string, { at: number; thread: string }>();
  rows.forEach((row, i) => {
    const agent = agents[i];
    if (!agent) return;
    const at = Date.parse(row.last_agent_at ?? row.last_at) || 0;
    const was = latest.get(agent.key);
    if (!was || at > was.at) latest.set(agent.key, { at, thread: row.thread_id });
  });
  return rows.flatMap((row, i): GridThreadIn[] => {
    // Every row comes in; whether it is work is `gridIsWork`'s to say (packages/shared/inbox/grid.ts).
    const agent = agents[i] ?? null;
    const machine = rowMachine(row, machines);
    const clock = (machine && clocks.get(machine)) || 0;
    const local = <T extends string | null | undefined>(iso: T): T => (clock && iso ? (new Date(Date.parse(iso) - clock).toISOString() as T) : iso);
    const headline = row.pulls?.headline.key;
    const pulls = rowPulls(row)
      .filter((pull) => (owners.get(pull.key) ?? row.thread_id) === row.thread_id)
      .map((pull) => (clock ? { ...pull, added_at: local(pull.added_at), read_at: local(pull.read_at) } : pull))
      .sort((a, b) => Number(b.key === headline) - Number(a.key === headline));
    const seen = seenOf(row);
    const steps = row.steps_progress;
    return [
      {
        id: row.thread_id,
        name: titleOf(row),
        machine,
        agent: agent ? { key: agent.key, name: agent.name, host: agent.host } : null,
        agentState: agent?.state ?? null,
        agentHere: agent ? latest.get(agent.key)?.thread === row.thread_id : false,
        agentEndedAt: local(agent?.endedAt ?? null),
        terminal: terminalOf(agent),
        running: row.run === 'working' || row.run === 'starting',
        created_at: local(row.created_at),
        last_agent_at: local(row.last_agent_at ?? null),
        section: row.section,
        waiting_since: local(row.waiting_since),
        prompt: row.questions.prompt,
        open: row.questions.open,
        actions: row.questions.actions ?? 0,
        sent: row.sent ? { at: local(row.sent.at), checked_at: local(row.sent.checked_at) } : null,
        session_ended: row.session_ended === true,
        pulls,
        steps: steps ? { done: steps.done, total: steps.total, doing: steps.doing, at: local(steps.at) } : null,
        seen: seen ? { through: seen.through - clock, at: seen.at - clock } : null,
      },
    ];
  });
}

/** A linked computer's clock against this one's (ms ahead; 0 for this computer's own threads). */
export function gridClockOf(machine: string | null, machines: MachinesModel): number {
  return (machine && machines.linked.find((m) => m.id === machine)?.clock_ms) || 0;
}
