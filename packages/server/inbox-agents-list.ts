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
 *  - every session that ended in the last `INBOX_AGENTS_ENDED_DAYS` days (it was heard from since that day's midnight on
 *    this machine's clock; kept in memory, so an Inbox restart forgets those): the window's sidebar leaves them out,
 *    and the list's Agents view names their threads' agent with them;
 *  - every session the Inbox launched whose launch is not deleted and whose thread is not archived (of a scheduled
 *    thread, only its newest run's: an earlier run's session is listed only while live). One that is
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
 * The order is fixed (owner, 2026-11-15: "each agent stays where it first appeared"): the newest first seen first,
 * ties by session id, never by state or by when it was last heard. First seen is the earliest of what this machine
 * knows of it and of the sessions its conversation continues (a resumed session keeps its place): the first start its
 * connection said or kept (a plugin reload's later start never moves it), its launch, the first message it wrote or
 * got, and what was kept on disk (inbox-first-seen.ts, so an Inbox restart moves nothing). Each machine orders its own
 * agents, so every window, linked machine and phone shows a machine's group in the same order.
 *
 * The cap: at most `INBOX_AGENTS_LISTED_MAX` per machine, `total` counting them all and `ended_today` those of them
 * that ended today (`InboxAgentsEvidence.today`). Past it the
 * agents waiting on the person stay, then the newest live ones, then the newest ended; the kept ones keep their
 * order. Another machine's group comes from its own list (the door's `threads`, read by its PeerLink), capped again
 * here, so a merged list is never longer than the cap per machine.
 *
 * Names (the window's ladder, packages/inbox/agents/model.ts `agentRowName`): `label`, `title` (the host's own title
 * for the session) and `first_thread` (the thread it got first, with that thread's name as it read when first kept: a
 * rename or deletion of the thread later changes neither).
 */

import { basename } from "node:path";
import type { InboxFirstSeen } from "./inbox-first-seen";
import { INBOX_AGENT_FACES_KEPT, INBOX_AGENTS_LISTED_MAX, inboxAgentNamesChecked, readInboxAgentFaces, type InboxAgent, type InboxAgentsGroup, type InboxRunState } from "@plannotator/core/inbox-types";
import { contextPercentOf, effortLevelOf, modelIdOf, type InboxAgentSession } from "./inbox-sessions";
import { withAgentStatusMark } from "./inbox-agent-mark";

/** A launched session (inbox-launch.ts `agents`). */
export interface InboxAgentLaunch {
  launch_id: string;
  session: string;
  thread_id: string;
  host: string;
  project_id: string;
  started_at: string;
  /** The host started it (`session_ref`). */
  started: boolean;
  run: InboxRunState | null;
  /** Its scratch folder's name; null in a project. */
  scratch: string | null;
  /** A routine's run (its root is a run divider). */
  scheduled?: boolean;
  /** It runs in a Rex tab whose pane the Inbox never learned, so it offers no Stop. */
  rex?: boolean;
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
  /** The live sessions, and the ended ones heard from in the last `INBOX_AGENTS_ENDED_DAYS` days (`live.agentSessions`). */
  sessions: InboxAgentSession[];
  /** The start of today (ms): an ended session last heard before it ended on an earlier day (`ended_today`). Absent: today's only were given. */
  today?: number;
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
  /** The thread the first of `sessions` to get one got first (`store.firstThreadsBySession`), with that message's time; null when none. */
  firstThreadOf?: (sessions: readonly string[]) => { id: string; name: string | null; at: string } | null;
  /** A thread's name as the list shows it (its short name, else its subject); null when unknown. */
  threadNameOf?: (threadId: string) => string | null;
  /**
   * What is kept of each session across restarts (inbox-first-seen.ts): read for each listed agent and the sessions
   * its conversation continues, and given what this list worked out. Absent: nothing kept.
   */
  kept?: Pick<InboxFirstSeen, "get" | "note">;
  /** Now (epoch ms), for `kept`. Default Date.now. */
  now?: () => number;
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

/** How many days of ended sessions the agents list keeps, today included (the list's Agents view names them). */
export const INBOX_AGENTS_ENDED_DAYS = 7;

/** The start of the first day the agents list keeps ended sessions from: `INBOX_AGENTS_ENDED_DAYS - 1` days before today's. */
export function inboxAgentsEndedSince(now: number): number {
  const day = new Date(inboxStartOfDay(now));
  day.setDate(day.getDate() - (INBOX_AGENTS_ENDED_DAYS - 1));
  return day.getTime();
}

/** A folder's project as the person reads it: `id` null and the folder's name when the Inbox has none. */
export function inboxFolderProject(root: string): { id: null; name: string } {
  return { id: null, name: basename(root) || root };
}

const STATES: ReadonlySet<string> = new Set<InboxAgent["state"]>(["waiting", "working", "idle", "ended"]);
const ms = (at: string | null | undefined) => {
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};
const earliest = (...times: (number | null | undefined)[]) => {
  const known = times.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return known.length > 0 ? Math.min(...known) : null;
};
/** Who stays past the cap: waiting on the person, then live, then ended. */
const keepRank = (agent: InboxAgent) => (agent.state === "waiting" ? 0 : agent.state === "ended" ? 2 : 1);

/** This machine's agents (one group, no `machine`): who is listed, how, and in what order, capped. */
export function inboxAgentsGroup(evidence: InboxAgentsEvidence, cap = INBOX_AGENTS_LISTED_MAX): InboxAgentsGroup {
  const bySession = new Map<string, InboxAgent>();
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  /** First seen (ms) by the agent's key in `bySession`; absent: only its threads say. */
  const seen = new Map<string, number>();

  for (const entry of evidence.sessions) {
    const continues = entry.live ? evidence.continuesOf(entry.session) : [];
    bySession.set(entry.session, {
      id: entry.session,
      session: entry.session,
      ...(continues.length > 0 ? { continues } : {}),
      host: entry.host,
      ...(evidence.labels && entry.label ? { label: entry.label } : {}),
      ...(evidence.labels && entry.title ? { title: entry.title } : {}),
      project: evidence.projectOf(entry.root, entry.session),
      state: !entry.live ? "ended" : entry.busy === true ? "working" : "idle",
      waiting: 0,
      live: entry.live,
      started_at: iso(entry.startedAt),
      last_seen_at: iso(entry.lastSeen),
      ...(entry.live && entry.model !== null ? { model: entry.model } : {}),
      ...(entry.live && entry.effort !== null ? { effort: entry.effort } : {}),
      ...(entry.live && entry.context !== null ? { context: entry.context } : {}),
    });
    seen.set(entry.session, entry.firstSeen ?? entry.startedAt);
  }

  // The session a listed one's conversation goes on as: a live, listed session standing in for it.
  const nowAs = (session: string): string => {
    const heir = evidence.continuedBy(session);
    return heir !== null && bySession.get(heir)?.live ? heir : session;
  };
  // An old id whose conversation goes on is no agent of its own.
  for (const entry of evidence.sessions) if (!entry.live && nowAs(entry.session) !== entry.session) bySession.delete(entry.session);

  // A routine is one agent however many runs it has: its newest run's. An earlier run's session is listed
  // only while it is live.
  const newestRun = new Map<string, InboxAgentLaunch>();
  for (const launch of evidence.launches) {
    const was = launch.scheduled ? newestRun.get(launch.thread_id) : undefined;
    if (launch.scheduled && (!was || launch.started_at > was.started_at)) newestRun.set(launch.thread_id, launch);
  }

  for (const launch of evidence.launches) {
    const session = nowAs(launch.session);
    const known = bySession.get(session);
    if (launch.scheduled && newestRun.get(launch.thread_id) !== launch) {
      if (!known?.live) bySession.delete(session);
      continue;
    }
    // A launch that is done (its thread archived) is listed only while its session is still live.
    if (evidence.archived.has(launch.thread_id) && !known?.live) {
      bySession.delete(session);
      continue;
    }
    const run = launch.run;
    // Stopped by the person: its last polls may still say working for a while, which it no longer is.
    const working = run === "starting" || run === "working" || run === "cloning" || (run !== "stopped" && known?.state === "working");
    const ended = !known?.live && (run === "failed" || run === "missing" || run === "clone_failed" || run === "clone_cancelled");
    bySession.set(session, {
      ...(known ?? { host: launch.host, project: evidence.projectById(launch.project_id), started_at: launch.started_at, last_seen_at: null }),
      id: launch.launch_id,
      session,
      launch: { id: launch.launch_id, thread_id: launch.thread_id, started: launch.started, run, scratch: launch.scratch, ...(launch.rex ? { rex: true as const } : {}) },
      host: known?.host ?? launch.host,
      state: working ? "working" : ended ? "ended" : "idle",
      waiting: 0,
      // A stopped launch is idle: a reply starts it again.
      live: !ended,
    });
    const first = earliest(seen.get(session), ms(launch.started_at));
    if (first !== null) seen.set(session, first);
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

  const firstSeen = new Map<InboxAgent, number>();
  for (const [key, agent] of bySession) {
    // Its own session and the ones its conversation continues (a resumed session keeps the place it had).
    const sessions = [agent.session, ...(agent.continues ?? [])];
    const kept = sessions.flatMap((session) => evidence.kept?.get(session) ?? []).sort((a, b) => a.first - b.first);
    const first = evidence.firstThreadOf?.(sessions) ?? null;
    const launched = agent.launch ? { id: agent.launch.thread_id, name: evidence.threadNameOf?.(agent.launch.thread_id) ?? null } : null;
    const named = launched ?? first;
    // The first thread's name as it read when first kept: a rename or deletion of that thread later changes nothing.
    const thread = kept.find((k) => k.thread)?.thread ?? (named?.name ? { id: named.id, name: named.name } : null);
    // Never heard start (it only owns a waiting thread): its first message, else when it last wrote.
    let at = earliest(seen.get(key), ...sessions.map((session) => seen.get(session)), kept[0]?.first, ms(first?.at), ms(agent.started_at)) ?? ms(agent.last_seen_at) ?? 0;
    if (evidence.kept && at > 0) at = evidence.kept.note(agent.session, at, (evidence.now ?? Date.now)(), thread).first;
    if (thread) agent.first_thread = thread;
    firstSeen.set(agent, at);
  }
  const order = (a: InboxAgent, b: InboxAgent) => firstSeen.get(b)! - firstSeen.get(a)! || a.session.localeCompare(b.session) || a.id.localeCompare(b.id);
  const all = [...bySession.values()].sort(order);
  const kept = all.length <= cap ? all : (() => {
    const stay = new Set([...all].sort((a, b) => keepRank(a) - keepRank(b) || order(a, b)).slice(0, cap));
    return all.filter((agent) => stay.has(agent));
  })();
  // Each agent's status mark (inbox-agent-mark.ts), from what its session's connection says now.
  const facts = new Map(evidence.sessions.map((entry) => [entry.session, { busy: entry.busy, blocked: entry.blocked ?? null }] as const));
  const marked = kept.map((agent) => withAgentStatusMark(agent, facts.get(agent.session) ?? null));
  // Ended on an earlier day: heard from last before today (only an ended session the evidence gave is dated).
  const earlier = new Set(evidence.today === undefined ? [] : evidence.sessions.filter((entry) => !entry.live && entry.lastSeen < evidence.today!).map((entry) => entry.session));
  return { agents: marked, total: all.length, ended_today: all.filter((agent) => agent.state === "ended" && !earlier.has(agent.session)).length };
}

/** The merged view's agents: this Inbox's group first, named by its id, then each linked machine's (`machines.agents`). */
export function inboxMergedAgents(self: string, own: InboxAgentsGroup, machines: readonly InboxAgentsGroup[]): InboxAgentsGroup[] {
  return [{ machine: self, ...own }, ...machines.filter((group) => group.machine !== self)];
}

function sessionFactsChecked(agent: InboxAgent): InboxAgent {
  const { model, effort, context, ...rest } = agent;
  const checked = { model: modelIdOf(model), effort: effortLevelOf(effort), context: contextPercentOf(context) };
  return {
    ...rest,
    ...(checked.model === null ? {} : { model: checked.model }),
    ...(checked.effort === null ? {} : { effort: checked.effort }),
    ...(checked.context === null ? {} : { context: checked.context }),
  };
}

/**
 * Another machine's group as its list sent it (`agents`, one group): only what parses, capped, named by `machine`.
 * Null when its list has none (an older Inbox): the window then knows nothing of its agents.
 */
export function inboxPeerAgentsGroup(value: unknown, machine: string, cap = INBOX_AGENTS_LISTED_MAX): InboxAgentsGroup | null {
  const group = Array.isArray(value) ? value[0] : null;
  if (!group || typeof group !== "object" || !Array.isArray((group as InboxAgentsGroup).agents)) return null;
  const raw = group as Partial<InboxAgentsGroup>;
  // Where it lives in that machine's Rex, its pane's status and mark, as that machine's Inbox read them (checked as
  // sent). Show in Rex as that machine offers it to a linked machine's reader: only while a Rex app is attached to its
  // Rex from another computer, never for its own screen's app (an older Inbox there offers none).
  const agents = raw.agents!.filter((agent): agent is InboxAgent => !!agent && typeof agent === "object" && typeof agent.id === "string" && typeof agent.session === "string" && STATES.has(agent.state)).slice(0, cap).map((agent) => sessionFactsChecked(inboxAgentNamesChecked(agent, { show: true })));
  const count = (n: unknown, floor: number) => (typeof n === "number" && Number.isSafeInteger(n) && n >= floor ? n : floor);
  // Its agents' faces and given names live there (inbox-linked-marks): passed through as that machine sent them.
  const faces = raw.faces !== undefined ? { faces: Object.fromEntries(Object.entries(readInboxAgentFaces(raw.faces)).slice(-INBOX_AGENT_FACES_KEPT)), faces_rev: count(raw.faces_rev, 0) } : {};
  // Whether it keeps a tile choice (approval "inbox-generated-agent-icons"): only when it says so, never assumed.
  const tiles = raw.faces !== undefined && raw.face_tiles === true ? { face_tiles: true as const } : {};
  return { machine, agents, total: count(raw.total, agents.length), ended_today: count(raw.ended_today, 0), ...faces, ...tiles };
}
