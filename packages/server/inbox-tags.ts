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
import type { createInboxLiveSessions } from "./inbox-sessions";

/** One session the person may tag, as the window reads it. */
export interface InboxTaggableSession {
  session: string;
  host: string | null;
  /** `live`: its connection polls (woken); `mcp`: it reads the Inbox only (not woken). */
  kind: "live" | "mcp";
  /** The name an MCP agent gave itself; null otherwise. */
  name: string | null;
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
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createInboxTagsRoute(options: {
  store: InboxStore;
  serverSession: string;
  live: ReturnType<typeof createInboxLiveSessions>;
  json: (body: unknown, status?: number) => Response;
}) {
  const { store, live, json } = options;

  /** The thread's owner now: the session it was last handed to, else its latest agent writer, else the session a thread the person started is addressed to. */
  // A hand-off (approval "inbox-tag-handoff") makes its new owner the owner, whoever writes after it.
  const ownerOf = (threadId: string): { host: string | null; session: string } | null => (store.thread(threadId) ? store.threadOwner(threadId) : null);

  const taggable = (threadId: string): { owner: { host: string | null; session: string } | null; sessions: InboxTaggableSession[] } => {
    const thread = store.thread(threadId);
    if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const owner = ownerOf(threadId);
    const writers = new Set(thread.messages.flatMap((m) => (m.author.kind === "agent" && m.author.session ? [m.author.session] : [])));
    const lastThreads = store.lastThreadsBySession();
    const projectOfRoot = (root: string | null, session: string): InboxTaggableSession["project"] => {
      if (root !== null) {
        const known = store.projectByRoot(root);
        return known ? { id: known.id, name: known.name, root } : { id: null, name: basename(root) || root, root };
      }
      const wrote = lastThreads.get(session);
      const project = wrote ? store.project(wrote.project_id) : null;
      return project ? { id: project.id, name: project.name, root: project.root } : null;
    };
    const liveRows: (InboxTaggableSession & { rank: number; activity: number })[] = live.allLive().map((entry) => {
      const project = projectOfRoot(entry.root, entry.session);
      const isOwner = owner?.session === entry.session;
      const sameProject = project?.id === thread.project.id;
      return {
        session: entry.session,
        host: entry.host,
        kind: "live" as const,
        name: null,
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

  /** The route; null when the path is not it. */
  const route = (req: Request, path: string): Response | null => {
    const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/taggable$/.exec(path);
    if (!match) return null;
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    return json({ serverSession: options.serverSession, ...taggable(match[1]!) });
  };

  return { route, taggable, ownerOf };
}
