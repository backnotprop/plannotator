/**
 * The sidebar's Agents section, in words and groups (approval "inbox-agents-section", APPROVED STATE 2026-11-09).
 * Pure: what each machine's group holds, each agent's name, the thread its row opens and the facts its hover card
 * says, from data the window already has (the list's `agents`, its rows and the linked machines). No read of its own.
 */
import { inboxHostName, type InboxAgent, type InboxAgentsGroup, type InboxListRow, type InboxListSection, type InboxParticipant } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';
import type { MachineView } from '../api';
import { awayLine, isAway, type MachinesModel } from '../machines';

export interface AgentEntry {
  agent: InboxAgent;
  /** The machine it runs on; null when no machine is linked (one flat list). */
  machine: string | null;
  /** Its name on the row (`agentRowName`). */
  name: string;
  /** The thread its row opens: its launch's, else its newest thread (one waiting on the person first). */
  thread: { id: string; subject: string } | null;
}

export interface AgentsGroup {
  /** The machine; null for the one flat list (no machine linked). */
  machine: MachineView | null;
  agents: AgentEntry[];
}

/** The status order used by the Agents sidebar when "Show agent status" is on. */
export function sortAgentEntries(entries: readonly AgentEntry[], statusOn: boolean): AgentEntry[] {
  if (!statusOn) return [...entries];
  const rank = (entry: AgentEntry): number => {
    if (entry.agent.status_mark?.state === 'blocked') return 0;
    if (entry.agent.status_mark?.state === 'working') return 1;
    return 2;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** An agent's host in words ("Claude Code"); "An agent" when nothing said. */
export const agentHostName = (host: string | null, runtime?: unknown): string => (host ? inboxHostName(host, runtime) : 'An agent');

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
export function agentSessions(agent: InboxAgent, others?: ReadonlySet<string>): string[] {
  return [agent.session, ...(agent.continues ?? []).filter((old) => !others?.has(old))];
}

/**
 * A session's own name, one ladder on every device (owner, 2026-11-15): the name the person gave it in the Inbox
 * (put on as `label`, agentsList.ts), else the name given in its host (`label`: Claude Code's /rename or --name,
 * Pi's, OpenCode's), else the title its host generated (`title`). Null when it has none of them.
 */
export function agentOwnName(agent: InboxAgent): string | null {
  return agent.label?.trim() || agent.title?.trim() || null;
}

/**
 * Where an agent is named. `list`: the sidebar's Agents list (its rows, hover card and the list's agent filter),
 * where nothing else says which agent it is. `thread`: inside a thread (the reply picker and its pill, a thread's
 * sessions), where the thread's own name would only repeat the title the person is reading.
 */
export type AgentNameContext = 'list' | 'thread';

/**
 * An agent's name: its own name (`agentOwnName`), else in the `list` the name of the thread it got first (frozen:
 * never the newest or the waiting one) and then its project, else its agent's name. Never its session id.
 */
export function agentRowName(agent: InboxAgent, context: AgentNameContext = 'list'): string {
  const fallback = context === 'list' ? agent.first_thread?.name.trim() || agent.project?.name : null;
  return agentOwnName(agent) || fallback || agentHostName(agent.host, agent.runtime);
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
export function agentsGroups(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[], statusOn = false): AgentsGroup[] {
  return sectionGroups(groups, machines).map(({ group, machine, view }) => ({
    machine: view,
    agents: sortAgentEntries(groupEntries(group, machine, machines.self, rows).shown, statusOn),
  }));
}

/** Each group the section draws: one flat group of this Inbox's agents with no machine linked, else one per machine. */
function sectionGroups(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel): { group: InboxAgentsGroup | undefined; machine: string | null; view: MachineView | null }[] {
  const self = machines.self;
  if (machines.all.length === 0) return [{ group: groups?.find((g) => !g.machine || g.machine === self), machine: null, view: null }];
  return machines.all.map((view) => ({ group: groups?.find((g) => (g.machine ?? self) === view.id), machine: view.id, view }));
}

/**
 * Every agent the list names, the ended ones too, per group the section draws (`sectionGroups`): the list's Agents
 * view (agentsView/model.ts) groups threads under them. `machine` null: no machine linked.
 */
export function namedAgents(groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel): { machine: string | null; view: MachineView | null; known: boolean; agents: readonly InboxAgent[] }[] {
  return sectionGroups(groups, machines).map(({ group, machine, view }) => ({ machine, view, known: group !== undefined, agents: group?.agents ?? [] }));
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
    return { agent, machine, name: agentRowName(agent), thread };
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
      return { id, name: agentRowName(agent), machine, sessions: agentSessions(agent, others), launches: agent.launch ? [agent.launch.thread_id] : [] };
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

/** What a Rex pane blocked on the person waits for (OSC 7501's `kind`), after "waiting on you in Rex". */
export const REX_WAITING_WORDS: Record<'permission' | 'question' | 'auth' | 'other', string> = {
  permission: ': a permission prompt',
  question: ': a question',
  auth: ': a sign-in',
  other: '',
};

/** Its Rex pane's word, where the Inbox had none of its own (the server folded it into `state`); null otherwise. */
function rexStateWords(agent: InboxAgent): string | null {
  const rex = agent.rex_status;
  if (agent.state === 'waiting' && agent.waiting === 0 && rex?.state === 'blocked') return `Waiting on you in Rex${REX_WAITING_WORDS[rex.kind ?? 'other']}`;
  if (agent.state === 'idle' && rex?.state === 'done') return 'Done';
  if (agent.state === 'idle' && rex?.state === 'error') return 'Stopped on an error';
  return null;
}

/**
 * A live agent whose host reports nothing about its turns (`turns_unknown`: Codex, Qwen Code, T3 Code, Antigravity, an
 * MCP-only agent): the card says so instead of "Idle", which the Inbox cannot know.
 */
export const TURNS_UNKNOWN_WORDS = "Doesn't say when it's working";

/** What an agent's hover card says, line by line; a fact the window does not have is left out. */
export interface AgentFacts {
  title: string;
  /** "Claude Code · billing-svc · Studio" */
  sub: string;
  state: string;
  rows: [string, string][];
}

export function modelName(id: string): string {
  const parts = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(id);
  if (!parts) return id;
  const family = parts[1]!.charAt(0).toUpperCase() + parts[1]!.slice(1);
  return `${family} ${parts[2]}${parts[3] ? `.${parts[3]}` : ''}`;
}

export function agentFacts(entry: AgentEntry, machine: MachineView | null, now: Date = new Date()): AgentFacts {
  const { agent } = entry;
  const sub = [agentHostName(agent.host, agent.runtime), agent.project?.name, machine?.name].filter(Boolean).join(' · ');
  const away = machine && isAway(machine) ? awayLine(machine, now) : null;
  const state =
    away ??
    rexStateWords(agent) ??
    (agent.state === 'waiting'
      ? agent.waiting > 1
        ? `${agent.waiting} threads waiting on you`
        : 'Waiting on you'
      : agent.state === 'working'
        ? 'Working'
        : agent.state === 'idle'
          ? agent.turns_unknown
            ? TURNS_UNKNOWN_WORDS
            : 'Idle'
          : 'Ended');
  const rows: [string, string][] = [];
  if (agent.started_at) rows.push(['Started', agent.launch ? `From the Inbox, ${whenTime(agent.started_at, now)}` : whenTime(agent.started_at, now)]);
  else if (agent.launch) rows.push(['Started', 'From the Inbox']);
  if (agent.last_seen_at) rows.push(['Last heard', whenTime(agent.last_seen_at, now)]);
  if (agent.live && agent.model) rows.push(['Model', agent.effort ? `${modelName(agent.model)} · ${agent.effort}` : modelName(agent.model)]);
  if (agent.live && typeof agent.context === 'number') rows.push(['Context', `${agent.context}% used`]);
  // Where it lives (a Rex pane, as Rex named it at the last read): a row of its own.
  if (agent.place?.line) rows.push(['Where', agent.place.line]);
  if (entry.thread?.subject && entry.thread.subject !== entry.name) rows.push(['Thread', entry.thread.subject]);
  return { title: entry.name, sub, state, rows };
}

/** What a session's line says it is doing: nothing for a live agent whose host reports no turns (never "idle"). */
export function agentSessionState(agent: InboxAgent): InboxAgent['state'] | null {
  return agent.turns_unknown && agent.state === 'idle' ? null : agent.state;
}

/**
 * One session of a thread as its header and its message lines name it (issue #3108). Found through the sidebar's
 * groups, so a conversation drawn as one row there is one session here. Two unnamed sessions of one agent both read
 * as the agent ("Claude Code"); the header's "2 sessions" says there are two.
 */
export interface ThreadSession {
  /** Its first session id in the thread: the id its face is found by. */
  session: string;
  /** Every session id of the thread that is this one agent (a conversation that went on under a new id). */
  sessions: string[];
  host: string | null;
  /** The machine whose agents name it (the list's `machine` on a merged Inbox); null on an Inbox that is not merging. */
  machine: string | null;
  /** The listed agent's id (the list's agent filter, `#agent=<id>`); null when the list does not name it. */
  agentId: string | null;
  name: string;
  /** What it is doing, from the list's agents; null when the Inbox lists no agents for its machine. */
  state: InboxAgent['state'] | null;
}

/**
 * A thread's sessions, first to join first, one per agent. `machine`: the thread's machine (null: this one).
 * `labels`: the sessions' labels (sessionLabels.ts), for a session the list no longer names. A session the list does
 * not name, on a machine whose agents it does list, is not running: `ended`.
 */
export function threadSessions(
  participants: readonly InboxParticipant[],
  groups: readonly InboxAgentsGroup[] | null,
  machines: MachinesModel,
  rows: readonly InboxListRow[],
  machine: string | null,
  labels: Readonly<Record<string, string>> = {},
): ThreadSession[] {
  const self = machines.self;
  const target = machine ?? self;
  const found = sectionGroups(groups, machines).find((g) => g.machine === null || g.machine === target);
  const group = found?.group;
  const { all, shown, others } = groupEntries(group, found?.machine ?? null, self, rows);
  const out: ThreadSession[] = [];
  for (const p of participants) {
    let agent: InboxAgent | null = null;
    const listed = all.find((e) => agentSessions(e.agent, others).includes(p.session));
    if (listed) {
      // An older session drawn as a later row is that row here too.
      const entry = shown.includes(listed) ? listed : (shown.find((later) => drawnAs(listed, later)) ?? listed);
      agent = entry.agent;
    } else {
      agent = group?.agents.find((a) => a.session === p.session || (a.continues ?? []).includes(p.session)) ?? null;
    }
    // Only a name the session has itself (`agentOwnName`, else the labels' same ladder), else its agent. Never the
    // sidebar's fallbacks (a thread's name, a project), which inside a thread read as the thread's own title.
    const own = Object.hasOwn(labels, p.session) ? labels[p.session]?.trim() : '';
    const name = (agent && agentOwnName(agent)) || own || p.name || agentHostName(p.host, agent?.runtime);
    const same = agent ? out.find((s) => s.agentId === agent!.id) : undefined;
    if (same) {
      if (!same.sessions.includes(p.session)) same.sessions.push(p.session);
      continue;
    }
    out.push({ session: p.session, sessions: [p.session], host: p.host, machine: group?.machine ?? null, agentId: agent?.id ?? null, name, state: agent ? agentSessionState(agent) : group ? 'ended' : null });
  }
  return out;
}
