/**
 * Grid's input (approval "inbox-agent-grid"): each list row the window holds, with its agent and its headline PR,
 * as `GridThreadIn` (packages/shared/inbox/grid.ts holds the rules). The list is the merged one, so a linked
 * computer's threads and agents come the same way as this computer's. Pure.
 */
import type { InboxAgent, InboxAgentsGroup, InboxListRow, InboxListSection, InboxThreadPullWire } from '@plannotator/core/inbox-types';
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

/** The rows whose PRs Grid reads in full (its times, checks and review): those whose list summary names one. */
export function gridPullThreads(rows: readonly InboxListRow[]): { thread: string; key: string }[] {
  return rows.flatMap((row) => (row.pulls ? [{ thread: row.thread_id, key: `${row.pulls.headline.key}:${row.pulls.headline.state}:${row.pulls.count}` }] : []));
}

function pullOf(row: InboxListRow, read: readonly InboxThreadPullWire[] | undefined): GridPullIn | null {
  const headline = row.pulls?.headline;
  if (!headline) return null;
  const wire = read?.find((pull) => pull.pull === headline.key && !pull.removed_at);
  return {
    label: wire?.label ?? labelOfKey(headline.key),
    state: headline.state,
    added_at: wire?.added_at ?? null,
    read_at: wire?.read_at ?? null,
    checks: wire?.checks ?? null,
    review: wire?.review ?? null,
  };
}

const terminalOf = (agent: ViewAgent | null): GridThreadIn['terminal'] => {
  const mark = agent?.listed ? (agent.ref as InboxAgent).status_mark : undefined;
  return mark?.state === 'blocked' && mark.where === 'terminal' && mark.kind ? mark.kind : null;
};

export interface GridInputs {
  sections: readonly InboxListSection[];
  groups: readonly InboxAgentsGroup[] | null;
  machines: MachinesModel;
  labels?: Readonly<Record<string, string>>;
  /** Each thread's PRs as last read (gridPulls.ts); a thread not read yet has only its list summary. */
  pulls: ReadonlyMap<string, readonly InboxThreadPullWire[]>;
}

export function gridThreads({ sections, groups, machines, labels, pulls }: GridInputs): GridThreadIn[] {
  const rows = gridRows(sections);
  const find = agentFinder({ sections, groups, machines, labels });
  const agents = rows.map((row) => find(row));
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
    const agent = agents[i];
    if (!agent) return [];
    return [
      {
        id: row.thread_id,
        name: titleOf(row),
        machine: rowMachine(row, machines),
        agent: { key: agent.key, name: agent.name, host: agent.host },
        agentState: agent.state,
        agentHere: latest.get(agent.key)?.thread === row.thread_id,
        agentEndedAt: agent.endedAt,
        terminal: terminalOf(agent),
        running: row.run === 'working' || row.run === 'starting',
        created_at: row.created_at,
        last_agent_at: row.last_agent_at ?? null,
        section: row.section,
        waiting_since: row.waiting_since,
        prompt: row.questions.prompt,
        open: row.questions.open,
        actions: row.questions.actions ?? 0,
        sent: row.sent ? { at: row.sent.at, checked_at: row.sent.checked_at } : null,
        session_ended: row.session_ended === true,
        pull: pullOf(row, pulls.get(row.thread_id)),
      },
    ];
  });
}
