/**
 * Plannotator Inbox: who the person can tag with `@` in a reply or a comment
 * (approval "inbox-tag-agents", Lines variant; design record not in this repo).
 *
 *   GET /api/inbox/threads/:id/taggable
 *
 * Every live session in any project (its connection polls the bridge) and,
 * apart, every agent that reads the Inbox through MCP only (it is never woken
 * and sees a tag the next time it reads the thread). The thread's owner (the
 * session the person's next plain Send goes to: the latest agent writer, or
 * the session a thread the person started is addressed to) comes first and is
 * marked, because it gets the reply anyway. A live session whose connection
 * does not understand tags (`tags` on its poll) is listed with `taggable:
 * false`: the window says to update Plannotator to tag it, and the reply route
 * refuses it (`tag_needs_update`).
 *
 * Read only, the window's own read guards (same origin; the Inbox runs every
 * route behind them). Tags themselves ride the reply route (`tags`), checked
 * by `tagTargets` in inbox-sessions.ts.
 */

import { basename } from "node:path";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { FAR_WOKEN_HOSTS } from "./inbox-far-host-wakes";
import { syncSection } from "./inbox-perf";
import type { createInboxLiveSessions } from "./inbox-sessions";

/** One session the person may tag, as the window reads it. */
export interface InboxTaggableSession {
  session: string;
  host: string | null;
  /** `live`: its connection polls (woken); `mcp`: it reads the Inbox only (not woken). */
  kind: "live" | "mcp";
  /** The name an MCP agent gave itself; null otherwise. */
  name: string | null;
  /**
   * A live session's label as its latest poll sent it (issue #2450: the To picker's label, from `/rename` or
   * the transcript's title in Claude Code, and Pi's and OpenCode's session names). On the window's route, for
   * every reader; absent when it has none, so an unnamed session reads as before.
   */
  label?: string;
  /** Where it works, or where it last wrote; null when unknown. */
  project: { id: string | null; name: string; root: string | null } | null;
  /** A live session's start; null for an MCP agent. */
  started_at: string | null;
  /** When it last polled, wrote or called a tool. */
  last_at: string;
  busy: boolean | null;
  idle_since: string | null;
  /** It can be tagged: false for a live session on an older Plannotator (update it to tag it). */
  taggable: boolean;
  /** The session the reply goes to anyway. */
  owner: boolean;
  /** It wrote in this thread. */
  wrote_thread: boolean;
  /** Its connection takes Send now (a reply into the running turn): in a far computer's list (`taggable-agents`) only. */
  send_now?: boolean;
  /** A session on another linked computer (inbox-far-tags.ts): that computer's Inbox id and its name here. */
  machine?: string;
  machine_name?: string;
}

/** The far part of the route (inbox-far-tags.ts): each linked computer's agents this Inbox can wake there. */
export interface InboxTaggableFar {
  rows: (threadId: string, owner: string | null, writers: ReadonlySet<string>) => Promise<InboxTaggableSession[]>;
  /** This computer, named as its linked computers name it; null while nothing is linked. */
  self: () => { id: string; name: string } | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createInboxTagsRoute(options: {
  store: InboxStore;
  serverSession: string;
  live: ReturnType<typeof createInboxLiveSessions>;
  json: (body: unknown, status?: number) => Response;
  far?: InboxTaggableFar;
  /** A session with no poll this Inbox wakes itself, so a linked computer's tag reaches it. Default: Codex, Qwen, T3, Antigravity. */
  wokenHere?: (session: string, host: string) => boolean;
}) {
  const { store, live, json } = options;

  /** The thread's owner now: the session it was last handed to, else its latest agent writer, else the session a thread the person started is addressed to. */
  // A hand-off (approval "inbox-tag-handoff") makes its new owner the owner, whoever writes after it.
  const ownerOf = (threadId: string): { host: string | null; session: string } | null => (store.thread(threadId) ? store.threadOwner(threadId, (session) => live.askerLive(session)) : null);

  const taggable = (threadId: string, withLabels = false): { owner: { host: string | null; session: string } | null; sessions: InboxTaggableSession[] } => {
    const thread = store.thread(threadId);
    if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const owner = ownerOf(threadId);
    const writers = new Set(thread.messages.flatMap((m) => (m.author.kind === "agent" && m.author.session ? [m.author.session] : [])));
    const lastThreads = store.lastThreadsBySession();
    const projectOfRoot = (root: string | null, session: string): InboxTaggableSession["project"] => {
      if (root !== null) {
        const known = store.projectByRoot(root);
        // The head's id: the thread's project reads as the head, so a session in another folder of it is "here".
        return known ? { id: store.canonicalProjectId(known.id), name: known.name, root } : { id: null, name: basename(root) || root, root };
      }
      const wrote = lastThreads.get(session);
      const project = wrote ? store.project(wrote.project_id) : null;
      return project ? { id: project.id, name: project.name, root: project.root } : null;
    };
    const liveRows: (InboxTaggableSession & { rank: number; activity: number })[] = live.allLive().map((entry) => {
      const project = projectOfRoot(entry.root, entry.session);
      const isOwner = owner?.session === entry.session;
      const sameProject = !!project?.id && store.sameProject(project.id, thread.project.id);
      return {
        session: entry.session,
        host: entry.host,
        kind: "live" as const,
        name: null,
        ...(withLabels && entry.label ? { label: entry.label } : {}),
        project,
        started_at: iso(entry.startedAt),
        last_at: iso(entry.lastSeen),
        busy: entry.busy,
        idle_since: entry.idleSince === null ? null : iso(entry.idleSince),
        taggable: entry.tags,
        owner: isOwner,
        wrote_thread: writers.has(entry.session),
        rank: isOwner ? 0 : writers.has(entry.session) ? 1 : sameProject ? 2 : 3,
        activity: entry.startedAt,
      };
    });
    liveRows.sort((a, b) => a.rank - b.rank || b.activity - a.activity || a.session.localeCompare(b.session));
    const liveIds = new Set(liveRows.map((row) => row.session));
    const mcpRows: InboxTaggableSession[] = live
      .mcpAgents()
      .filter((agent) => !liveIds.has(agent.session))
      .map((agent) => {
        const project = agent.project_id ? store.project(agent.project_id) : null;
        return {
          session: agent.session,
          host: agent.host,
          kind: "mcp" as const,
          name: agent.name,
          project: project ? { id: project.id, name: project.name, root: project.root } : null,
          started_at: null,
          last_at: agent.last_at,
          busy: null,
          idle_since: null,
          taggable: true,
          owner: owner?.session === agent.session,
          wrote_thread: writers.has(agent.session),
        };
      })
      // The owner first, then the ones that wrote here, then the newest.
      .sort((a, b) => Number(b.owner) - Number(a.owner) || Number(b.wrote_thread) - Number(a.wrote_thread));
    return { owner, sessions: [...liveRows.map(({ rank: _rank, activity: _activity, ...row }) => row), ...mcpRows] };
  };

  /**
   * This Inbox's own sessions a linked computer may tag in one of its threads (`GET taggable-agents` on the door,
   * inbox-far-tags.ts): the live ones whose connection polls here, and the ones this Inbox wakes itself (Codex, Qwen,
   * T3, Antigravity, a cloud agent with a wake: their wakes send a far wake as a local tag, inbox-far-host-wakes.ts),
   * so each gets that computer's wake.
   */
  const wokenHere = options.wokenHere ?? ((_session: string, host: string) => FAR_WOKEN_HOSTS.has(host));
  const liveHere = (): InboxTaggableSession[] =>
    live
      .allLive()
      .filter((entry) => entry.polls || wokenHere(entry.session, entry.host))
      .map((entry) => {
        const known = entry.root !== null ? store.projectByRoot(entry.root) : null;
        const project = entry.root !== null ? { id: null, name: known?.name ?? (basename(entry.root) || entry.root), root: null } : null;
        return {
          session: entry.session,
          host: entry.host,
          kind: "live" as const,
          name: null,
          ...(entry.label ? { label: entry.label } : {}),
          project,
          started_at: iso(entry.startedAt),
          last_at: iso(entry.lastSeen),
          busy: entry.busy,
          idle_since: entry.idleSince === null ? null : iso(entry.idleSince),
          taggable: entry.tags,
          ...(entry.sendNow ? { send_now: true } : {}),
          owner: false,
          wrote_thread: false,
        };
      })
      .sort((a, b) => b.started_at.localeCompare(a.started_at) || a.session.localeCompare(b.session));

  /** The route; null when the path is not it. With linked computers, their agents follow this Inbox's own. */
  const route = (req: Request, path: string): Response | Promise<Response> | null => {
    const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/taggable$/.exec(path);
    if (!match) return null;
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    const here = syncSection("taggable", () => taggable(match[1]!, true));
    const far = options.far;
    const self = far?.self() ?? null;
    if (!far || !self) return json({ serverSession: options.serverSession, ...here });
    const writers = new Set(store.thread(match[1]!)?.messages.flatMap((m) => (m.author.kind === "agent" && m.author.session ? [m.author.session] : [])) ?? []);
    return far.rows(match[1]!, here.owner?.session ?? null, writers).then((rows) => {
      const mine = new Set(here.sessions.map((s) => s.session));
      const farRows = rows.filter((row) => !mine.has(row.session));
      return json({ serverSession: options.serverSession, ...here, sessions: [...here.sessions, ...farRows], ...(farRows.length > 0 ? { machine: self } : {}) });
    });
  };

  return { route, taggable, ownerOf, liveHere };
}
