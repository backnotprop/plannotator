/**
 * Plannotator Inbox: each machine's agents, for the sidebar's Agents section (design record "Agents sidebar
 * section", Option A, PR 1 of 4: the data only). Pure: the list model (packages/server/inbox.ts `listModel`)
 * gathers the evidence from the live sessions (inbox-sessions.ts), the launches (inbox-launch.ts) and its own rows,
 * and this decides who is listed, in which state, and in what order.
 *
 * Who is an agent:
 *  - every live session;
 *  - every session that owns a thread waiting on the person (Stopped on you, Holding up work, Waiting on you), ended
 *    or not: the thread's owner as a plain reply would reach it (`store.threadOwner`);
 *  - every session that ended today (it was heard from since this machine's midnight; kept in memory, so an Inbox
 *    restart forgets those);
 *  - every session the Inbox launched whose launch is not deleted and whose thread is not archived. One that is
 *    stopped is idle (a reply starts it again); one whose start failed or whose CLI is gone has ended.
 *
 * A launched agent's id is its launch's id, so it keeps its place while its session moves from the placeholder
 * (`launch:<id>`) to the real one; every other agent's id is its session.
 *
 * One conversation, one agent: a conversation that goes on under a new session id (inbox-continuations.ts, a poll's
 * `continues`) is listed once, as the live session that stands in for the old id. The old id's launch and its
 * waiting threads are that agent's, and an old id that no longer polls is no agent of its own (nor "ended today":
 * it did not end). The agent says which ids its conversation continues (`continues`), so the window finds its
 * threads under them. An old id that still polls keeps its own row here (both conversations may go on).
 *
 * The cap: at most `INBOX_AGENTS_LISTED_MAX` per machine, waiting first, then working, idle and ended, `total` and
 * `ended_today` counting them all. Another machine's group comes from its own list (the door's `threads`, read by
 * its PeerLink), capped again here, so a merged list is never longer than the cap per machine.
 */

import { basename } from "node:path";
import { INBOX_AGENTS_LISTED_MAX, type InboxAgent, type InboxAgentsGroup, type InboxRunState } from "@plannotator/core/inbox-types";
import type { InboxAgentSession } from "./inbox-sessions";

/** A launched session (inbox-launch.ts `agents`). */
export interface InboxAgentLaunch {
  launch_id: string;
  session: string;
  thread_id: string;
  host: string;
  project_id: string;
  started_at: string;
  run: InboxRunState | null;
}

/** One thread waiting on the person, by the session that owns it. */
export interface InboxAgentWait {
  thread_id: string;
  session: string;
  host: string | null;
  project: { id: string; name: string };
  /** The thread's latest agent activity (ISO). */
  at: string;
}

export interface InboxAgentsEvidence {
  /** The live sessions, and the ended ones heard from today (`live.agentSessions`). */
  sessions: InboxAgentSession[];
  launches: InboxAgentLaunch[];
  /** The threads in Stopped on you, Holding up work or Waiting on you, with their owner. */
  waits: InboxAgentWait[];
  /** Launched threads that are archived: their agent is done, and not listed unless it is live. */
  archived: ReadonlySet<string>;
  /** A session's project from its root (`id` null for a folder with no project), or from where it last wrote; null when unknown. */
  projectOf: (root: string | null, session: string) => { id: string | null; name: string } | null;
  /** A project by id, as the person sees it (a combined project's head). */
  projectById: (id: string) => { id: string; name: string } | null;
  /** When this Inbox last heard from a session it does not hold in memory (an Inbox tool call); null when never. */
  lastHeardOf: (session: string) => number | null;
  /** The live session standing in for `session` (its conversation goes on there); null when it is live itself or nobody continues it. */
  continuedBy: (session: string) => string | null;
  /** Every session id `session`'s conversation continues, nearest first. */
  continuesOf: (session: string) => string[];
  /** Labels are shown (this computer's owner). */
  labels: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The start of the day `now` falls in, on this machine's clock (ms). */
export function inboxStartOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** A folder's project as the person reads it: `id` null and the folder's name when the Inbox has none. */
export function inboxFolderProject(root: string): { id: null; name: string } {
  return { id: null, name: basename(root) || root };
}

const STATE_ORDER: Record<InboxAgent["state"], number> = { waiting: 0, working: 1, idle: 2, ended: 3 };
const heardMs = (agent: InboxAgent) => (agent.last_seen_at ? Date.parse(agent.last_seen_at) : 0);

/** The listing order: waiting first (most waiting first), then working, idle and ended; the most recently heard first. */
export function compareInboxAgents(a: InboxAgent, b: InboxAgent): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.waiting - a.waiting || heardMs(b) - heardMs(a) || a.id.localeCompare(b.id);
}

/** This machine's agents (one group, no `machine`): who is listed, how, and in what order, capped. */
export function inboxAgentsGroup(evidence: InboxAgentsEvidence, cap = INBOX_AGENTS_LISTED_MAX): InboxAgentsGroup {
  const bySession = new Map<string, InboxAgent>();
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

  for (const entry of evidence.sessions) {
    const continues = entry.live ? evidence.continuesOf(entry.session) : [];
    bySession.set(entry.session, {
      id: entry.session,
      session: entry.session,
      ...(continues.length > 0 ? { continues } : {}),
      host: entry.host,
      ...(evidence.labels && entry.label ? { label: entry.label } : {}),
      project: evidence.projectOf(entry.root, entry.session),
      state: !entry.live ? "ended" : entry.busy === true ? "working" : "idle",
      waiting: 0,
      live: entry.live,
      started_at: iso(entry.startedAt),
      last_seen_at: iso(entry.lastSeen),
      ...(entry.live && entry.context !== null ? { context: entry.context } : {}),
    });
  }

  // The session a listed one's conversation goes on as: a live, listed session standing in for it.
  const nowAs = (session: string): string => {
    const heir = evidence.continuedBy(session);
    return heir !== null && bySession.get(heir)?.live ? heir : session;
  };
  // An old id whose conversation goes on is no agent of its own.
  for (const entry of evidence.sessions) if (!entry.live && nowAs(entry.session) !== entry.session) bySession.delete(entry.session);

  for (const launch of evidence.launches) {
    const session = nowAs(launch.session);
    const known = bySession.get(session);
    // A launch that is done (its thread archived) is listed only while its session is still live.
    if (evidence.archived.has(launch.thread_id) && !known?.live) {
      bySession.delete(session);
      continue;
    }
    const run = launch.run;
    const working = run === "starting" || run === "working" || run === "cloning" || known?.state === "working";
    const ended = !known?.live && (run === "failed" || run === "missing" || run === "clone_failed" || run === "clone_cancelled");
    bySession.set(session, {
      ...(known ?? { host: launch.host, project: evidence.projectById(launch.project_id), started_at: launch.started_at, last_seen_at: null }),
      id: launch.launch_id,
      session,
      launch: { id: launch.launch_id, thread_id: launch.thread_id },
      host: known?.host ?? launch.host,
      state: working ? "working" : ended ? "ended" : "idle",
      waiting: 0,
      // A stopped launch is idle: a reply starts it again.
      live: !ended,
    });
  }

  for (const wait of evidence.waits) {
    const session = nowAs(wait.session);
    let agent = bySession.get(session);
    if (!agent) {
      const heard = evidence.lastHeardOf(session);
      agent = {
        id: session,
        session,
        host: wait.host,
        project: wait.project,
        state: "ended",
        waiting: 0,
        live: false,
        started_at: null,
        last_seen_at: heard === null ? null : iso(heard),
      };
      bySession.set(session, agent);
    }
    agent.waiting += 1;
    agent.state = "waiting";
    if (!agent.project) agent.project = wait.project;
    if (!agent.live) agent.last_seen_at = later(agent.last_seen_at, wait.at);
  }

  const all = [...bySession.values()].sort(compareInboxAgents);
  return { agents: all.slice(0, cap), total: all.length, ended_today: all.filter((agent) => agent.state === "ended").length };
}

/** The merged view's agents: this Inbox's group first, named by its id, then each linked machine's (`machines.agents`). */
export function inboxMergedAgents(self: string, own: InboxAgentsGroup, machines: readonly InboxAgentsGroup[]): InboxAgentsGroup[] {
  return [{ machine: self, ...own }, ...machines.filter((group) => group.machine !== self)];
}

/**
 * Another machine's group as its list sent it (`agents`, one group): only what parses, capped, named by `machine`.
 * Null when its list has none (an older Inbox): the window then knows nothing of its agents.
 */
export function inboxPeerAgentsGroup(value: unknown, machine: string, cap = INBOX_AGENTS_LISTED_MAX): InboxAgentsGroup | null {
  const group = Array.isArray(value) ? value[0] : null;
  if (!group || typeof group !== "object" || !Array.isArray((group as InboxAgentsGroup).agents)) return null;
  const raw = group as Partial<InboxAgentsGroup>;
  const agents = raw.agents!.filter((agent): agent is InboxAgent => !!agent && typeof agent === "object" && typeof agent.id === "string" && typeof agent.session === "string" && agent.state in STATE_ORDER).slice(0, cap);
  const count = (n: unknown, floor: number) => (typeof n === "number" && Number.isSafeInteger(n) && n >= floor ? n : floor);
  return { machine, agents, total: count(raw.total, agents.length), ended_today: count(raw.ended_today, 0) };
}
