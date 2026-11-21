/**
 * The words of the held list's line (the owner, 2026-11-18: "the text changes are approved"; the designer's table:
 * docs/agent-guides/inbox-window.md, "What the line says"). The line says what came, not only how many:
 *
 *  - one arrival: "Claude Code replied in “Checkout redesign”", "Codex asked in “Invoice dates”",
 *    "New from Codex: “Node 22 upgrade”";
 *  - several: "2 replies from Claude Code", "2 replies from Claude Code and Codex", "5 replies from 3 agents";
 *  - mixed: "1 new thread, 1 reply from Codex" (new threads, then questions, then replies);
 *  - in a project or filter view, news elsewhere: "Codex replied in billing-svc", "2 new in billing-svc",
 *    "2 new in other projects", with "Show all".
 *
 * Always one line (HeldNoticeLine.tsx, inbox.css): `lead` and the action never shrink; `name` (the thread's or the
 * project's) is the one part cut with "…"; `from` is left off whole when the line has no room for it. `full` is the
 * whole sentence, uncut: the button's accessible name, the tooltip while anything is cut, the live region. Pure.
 */
import { inboxAgentName, type InboxListRow } from '@plannotator/core/inbox-types';

/** What came on a thread: a thread new to the list, an agent's question, an agent's reply, or a snoozed thread back. */
export type ArrivalKind = 'thread' | 'question' | 'reply' | 'back';

export interface Arrival {
  id: string;
  kind: ArrivalKind;
  /** The agent that wrote, as the product names it (the host's display name, or the name the agent gave itself). */
  agent: string;
  /** The thread's name as its row titles it. */
  title: string;
  projectId: string;
  /** The project's window name. */
  project: string;
}

export interface NewsLine {
  /** Never cut: "Claude Code replied in", "2 replies", "2 new in". */
  lead: string;
  /** The thread's name in quotes, or a project's name: the one part cut with "…". */
  name?: string;
  /** "from Claude Code and Codex": left off whole when the line has no room for it, never cut. */
  from?: string;
  /** The whole sentence, uncut. */
  full: string;
  /** What the press does: Show (this list), Show all (leaves the project or filter view). */
  action: 'Show' | 'Show all';
}

function agentAt(row: InboxListRow): string | null {
  if (row.last_agent_at !== undefined) return row.last_agent_at;
  return row.last_author === 'agent' ? row.last_at : null;
}

/** The agent that wrote last: the row's `last_agent` when several are in the thread, else the row's one agent. */
function writer(row: InboxListRow): string {
  if (row.last_agent) return inboxAgentName({ kind: 'agent', host: row.last_agent.host, name: row.last_agent.name ?? null });
  // A thread the person started: its agent is the one it is addressed to (InboxList's `rowAgent`).
  if (row.addressee) return inboxAgentName({ kind: 'agent', host: row.addressee.host, name: null });
  return inboxAgentName(row.author);
}

/**
 * One arrival from its row now and the row the list on screen has (`was`; undefined when the list lacks the thread:
 * a new thread, or one back from the archive). `names`: the window's project names by id.
 */
export function arrivalOf(row: InboxListRow, was: InboxListRow | undefined, names?: ReadonlyMap<string, string>): Arrival {
  let kind: ArrivalKind;
  if (!was) kind = 'thread';
  else if (row.snooze_back && row.snooze_back !== was.snooze_back && !((agentAt(row) ?? '') > (agentAt(was) ?? was.last_at))) kind = 'back';
  else if (row.questions.open > was.questions.open) kind = 'question';
  else kind = 'reply';
  return {
    id: row.thread_id,
    kind,
    agent: writer(row),
    title: row.thread_name?.trim() ? row.thread_name : (row.subject ?? '(no subject)'),
    projectId: row.project.id,
    project: names?.get(row.project.id) ?? row.project.name,
  };
}

const plural = new Intl.PluralRules('en-US');
const NOUNS: Record<Exclude<ArrivalKind, 'back'>, readonly [string, string]> = {
  thread: ['new thread', 'new threads'],
  question: ['question', 'questions'],
  reply: ['reply', 'replies'],
};
const ORDER = ['thread', 'question', 'reply'] as const;

function counted(n: number, one: string, many: string): string {
  return `${n} ${plural.select(n) === 'one' ? one : many}`;
}

/** "from Codex", "from Claude Code and Codex", "from 3 agents". */
function fromWords(agents: readonly string[]): string {
  if (agents.length === 1) return `from ${agents[0]}`;
  if (agents.length === 2) return `from ${agents[0]} and ${agents[1]}`;
  return `from ${counted(agents.length, 'agent', 'agents')}`;
}

const quoted = (title: string) => `“${title}”`;

function line(lead: string, action: NewsLine['action'], name?: string, from?: string): NewsLine {
  const full = [lead, name, from].filter(Boolean).join(' ');
  return { lead, ...(name ? { name } : {}), ...(from ? { from } : {}), full, action };
}

/** The words the line had before it said what came: "N new in <project>", or "N new" across projects. */
export function countLine(count: number, project: string | null, action: NewsLine['action'] = 'Show'): NewsLine {
  return project ? line(`${count} new in`, action, project) : line(`${count} new`, action);
}

function oneProject(arrivals: readonly Arrival[]): string | null {
  const ids = new Set(arrivals.map((a) => a.projectId));
  return ids.size === 1 ? arrivals[0]!.project : null;
}

/** The line for news in the list on screen (Show), or null when none waits. */
export function hereLine(arrivals: readonly Arrival[]): NewsLine | null {
  if (arrivals.length === 0) return null;
  // A snoozed thread back by the clock: no agent wrote, so the line says only how many came.
  if (arrivals.some((a) => a.kind === 'back')) return countLine(arrivals.length, oneProject(arrivals));
  if (arrivals.length === 1) {
    const [a] = arrivals as [Arrival];
    if (a.kind === 'thread') return line(`New from ${a.agent}:`, 'Show', quoted(a.title));
    return line(`${a.agent} ${a.kind === 'question' ? 'asked in' : 'replied in'}`, 'Show', quoted(a.title));
  }
  const parts = ORDER.map((kind) => {
    const n = arrivals.filter((a) => a.kind === kind).length;
    return n > 0 ? counted(n, ...NOUNS[kind]) : null;
  }).filter((part): part is string => part !== null);
  const agents = [...new Set(arrivals.map((a) => a.agent))];
  return line(parts.join(', '), 'Show', undefined, fromWords(agents));
}

const VERB: Record<ArrivalKind, string> = { thread: 'wrote in', question: 'asked in', reply: 'replied in', back: '' };

/** The line for news outside the project or filter view on screen (Show all), or null when none. */
export function elsewhereLine(arrivals: readonly Arrival[]): NewsLine | null {
  if (arrivals.length === 0) return null;
  const project = oneProject(arrivals);
  if (project === null) return line(`${arrivals.length} new in other projects`, 'Show all');
  const [a] = arrivals as [Arrival];
  if (arrivals.length === 1 && a.kind !== 'back') return line(`${a.agent} ${VERB[a.kind]}`, 'Show all', project);
  return countLine(arrivals.length, project, 'Show all');
}
