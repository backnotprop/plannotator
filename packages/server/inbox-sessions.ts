/**
 * Plannotator Inbox: New message (PLAN step 8; owner Q4, "just another button
 * next to reply", built as a try).
 *
 * The live sessions: every agent connection long-polls the bridge for its
 * session (packages/server/inbox.ts, `bridgePoll`), and a poll says where the
 * session works (`project_path`), when it started and whether a turn runs; a
 * `state` event says when that changes. A session is live while it polled
 * within `INBOX_SESSION_LIVE_MS`, or holds a poll open now. Kept in memory
 * only: after an Inbox restart a session is live again at its next poll.
 *
 * A session is in a thread's project when its `project_path` resolves to the
 * project's root (realpath, then git toplevel, as send_message does), or, for
 * a connection that does not say where it works, when it wrote in that
 * project.
 *
 * The window's two routes (same origin and the page's serverSession, as every
 * window route):
 *   GET  /api/inbox/threads/:id/sessions  the project's live sessions, the
 *        thread's own writers first;
 *   POST /api/inbox/threads/:id/message   `{ session, body, idempotency_key }`:
 *        the person's message, addressed to that session while it is live
 *        (409 `session_not_live` otherwise, nothing written). Its connection
 *        is handed it on its next poll and delivers it like a reply.
 *
 * Replying when the asking session has ended (design record "replying when
 * the asking agent's session has ended", not in this repo): the sessions
 * route also answers whether the session that asked (`?asker=<session>`) is
 * still there (`asker: { session, live }`), with a grace of
 * `INBOX_ASKER_GRACE_MS` so a short gap, or an Inbox that just started and
 * has not heard from its sessions yet, never reads as ended. The reply route
 * (packages/server/inbox.ts) takes `to: { host, session }` and checks it with
 * `replyTarget`, as New message does.
 */

import { homedir } from "node:os";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** One live session as the window reads it. */
export interface InboxLiveSession {
  session: string;
  host: string;
  started_at: string;
  last_seen_at: string;
  /** A turn runs now; null when the connection does not say. */
  busy: boolean | null;
  /** Idle since then; null while busy or when the connection does not say. */
  idle_since: string | null;
  /** It wrote in this thread. */
  wrote_thread: boolean;
}

interface SeenSession {
  host: string;
  /** The project root its `project_path` resolved to; null when it sent none. */
  root: string | null;
  startedAt: number;
  lastSeen: number;
  /** Polls held open now. */
  holding: number;
  busy: boolean | null;
  idleSince: number | null;
}

/**
 * How long the session that asked may go without a poll before the window
 * says it has ended: twice the live window, so a slept laptop or a slow poll
 * does not show the note for a moment.
 */
export const INBOX_ASKER_GRACE_MS = 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const finiteMs = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

export function createInboxLiveSessions(options: {
  store: InboxStore;
  serverSession: string;
  resolveRoot: (path: string) => Promise<string>;
  now?: () => number;
}) {
  const { store, serverSession } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const sessions = new Map<string, SeenSession>();
  /**
   * MCP activity per agent session: when a tool call last named it, and the
   * wait_for_reply calls it holds open now. Presence only (a session that
   * asked is not "ended" while it talks to the Inbox); it never makes a
   * session live for New message, which needs a connection that wakes it.
   */
  const mcpSeen = new Map<string, { lastSeen: number; holding: number }>();
  const mcpEntry = (session: string) => {
    let entry = mcpSeen.get(session);
    if (!entry) {
      entry = { lastSeen: now(), holding: 0 };
      mcpSeen.set(session, entry);
    }
    return entry;
  };
  /** A tool call named this agent session. */
  const seenOverMcp = (session: string) => {
    if (session) mcpEntry(session).lastSeen = now();
  };
  /** A wait_for_reply for this session is open: present until it answers. */
  const holdOverMcp = (session: string): (() => void) => {
    const entry = mcpEntry(session);
    entry.holding += 1;
    entry.lastSeen = now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holding = Math.max(0, entry.holding - 1);
      entry.lastSeen = now();
    };
  };
  /** project_path to its root, resolved once per path (it spawns git). */
  const roots = new Map<string, Promise<string | null>>();

  const rootOf = (path: unknown): Promise<string | null> => {
    if (typeof path !== "string" || !path) return Promise.resolve(null);
    let pending = roots.get(path);
    if (!pending) {
      pending = options.resolveRoot(path).catch(() => null);
      roots.set(path, pending);
    }
    return pending;
  };

  const applyState = (entry: SeenSession, body: Record<string, unknown>, at: number) => {
    if (typeof body.busy !== "boolean") return;
    if (body.busy) {
      entry.busy = true;
      entry.idleSince = null;
    } else {
      entry.idleSince = entry.busy === false && entry.idleSince !== null ? entry.idleSince : (finiteMs(body.idle_since) ?? at);
      entry.busy = false;
    }
  };

  /** A poll arrived: the session is live, and says where it works. Returns the call to make when the poll answers. */
  const pollStarted = async (session: string, host: string, body: Record<string, unknown>): Promise<() => void> => {
    const at = now();
    const root = await rootOf(body.project_path);
    const entry = sessions.get(session) ?? { host, root, startedAt: finiteMs(body.started_at) ?? at, lastSeen: at, holding: 0, busy: null, idleSince: null };
    entry.host = host;
    if (root !== null) entry.root = root;
    entry.startedAt = finiteMs(body.started_at) ?? entry.startedAt;
    entry.lastSeen = at;
    entry.holding += 1;
    applyState(entry, body, at);
    sessions.set(session, entry);
    return () => {
      entry.holding = Math.max(0, entry.holding - 1);
      entry.lastSeen = now();
    };
  };

  /** A `state` event: a turn started or ended. */
  const stateChanged = (session: string, host: string, body: Record<string, unknown>) => {
    const entry = sessions.get(session);
    if (!entry) return;
    const at = now();
    entry.host = host;
    entry.lastSeen = at;
    applyState(entry, body, at);
  };

  const isLive = (entry: SeenSession) => entry.holding > 0 || now() - entry.lastSeen <= INBOX_SESSION_LIVE_MS;

  /**
   * Whether the session that asked is still there, with the grace above: it
   * holds a poll or an MCP wait_for_reply, or polled or called an MCP tool
   * within `INBOX_ASKER_GRACE_MS`, or this Inbox started less than that long
   * ago (sessions are kept in memory only). The window asks only about a
   * session whose message came through a connection that wakes it
   * (`InboxMessage.wakes`).
   */
  const askerLive = (session: string): boolean => {
    const recent = (entry: { holding: number; lastSeen: number } | undefined) =>
      !!entry && (entry.holding > 0 || now() - entry.lastSeen <= INBOX_ASKER_GRACE_MS);
    if (recent(sessions.get(session)) || recent(mcpSeen.get(session))) return true;
    return now() - startedAt <= INBOX_ASKER_GRACE_MS;
  };

  /**
   * The reply route's `to`: the live session of the thread's project it
   * names (the host, when given, must match), or null when it is not live.
   */
  const replyTarget = (threadId: string, to: unknown): { host: string; session: string } | null => {
    if (!to || typeof to !== "object" || Array.isArray(to)) {
      throw new InboxError("validation_error", "to: { host, session } of a live session.", { field: "to" });
    }
    const { host, session } = to as Record<string, unknown>;
    if (typeof session !== "string" || !session) throw new InboxError("validation_error", "to.session: the live session to send to.", { field: "to.session" });
    if (host !== undefined && typeof host !== "string") throw new InboxError("validation_error", "to.host: a string.", { field: "to.host" });
    const target = liveFor(threadId).sessions.find((candidate) => candidate.session === session) ?? null;
    if (!target || (host !== undefined && target.host !== host)) return null;
    return { host: target.host, session: target.session };
  };

  /** The live sessions of a thread's project: its writers first (the latest writer first), then by start. */
  const liveFor = (threadId: string): { project: InboxProject; sessions: InboxLiveSession[] } => {
    const thread = store.thread(threadId);
    if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const project = thread.project;
    const lastWrote = new Map<string, number>();
    thread.messages.forEach((message, index) => {
      if (message.author.kind === "agent" && message.author.session) lastWrote.set(message.author.session, index);
    });
    let wroteInProject: Set<string> | null = null;
    const out: (InboxLiveSession & { order: number; started: number })[] = [];
    for (const [session, entry] of sessions) {
      if (!isLive(entry)) continue;
      if (entry.root !== null) {
        if (entry.root !== project.root) continue;
      } else {
        wroteInProject ??= new Set(
          store
            .threadsOf(project.id)
            .flatMap((summary) => store.thread(summary.thread_id)?.messages ?? [])
            .flatMap((message) => (message.author.kind === "agent" && message.author.session ? [message.author.session] : [])),
        );
        if (!wroteInProject.has(session)) continue;
      }
      out.push({
        session,
        host: entry.host,
        started_at: iso(entry.startedAt),
        last_seen_at: iso(entry.lastSeen),
        busy: entry.busy,
        idle_since: entry.busy === false && entry.idleSince !== null ? iso(entry.idleSince) : null,
        wrote_thread: lastWrote.has(session),
        order: lastWrote.get(session) ?? -1,
        started: entry.startedAt,
      });
    }
    out.sort((a, b) => b.order - a.order || a.started - b.started);
    return { project, sessions: out.map(({ order: _order, started: _started, ...session }) => session) };
  };

  /**
   * Every live session in any project (compose), with the root its
   * `project_path` resolved to (null when its connection sends none).
   */
  const allLive = (): { session: string; host: string; root: string | null; startedAt: number; lastSeen: number; busy: boolean | null; idleSince: number | null }[] => {
    const out = [];
    for (const [session, entry] of sessions) {
      if (!isLive(entry)) continue;
      out.push({ session, host: entry.host, root: entry.root, startedAt: entry.startedAt, lastSeen: entry.lastSeen, busy: entry.busy, idleSince: entry.busy === false ? entry.idleSince : null });
    }
    return out;
  };

  /** Whether a session is live now (no grace: compose sends only to a session that polls). */
  const isSessionLive = (session: string): boolean => {
    const entry = sessions.get(session);
    return !!entry && isLive(entry);
  };

  /** `{ host?, session }` naming a live session in any project, or null when it is not live (compose's Send). */
  const composeTarget = (to: unknown): { host: string; session: string; root: string | null } | null => {
    if (!to || typeof to !== "object" || Array.isArray(to)) {
      throw new InboxError("validation_error", "to: { host, session } of a live session.", { field: "to" });
    }
    const { host, session } = to as Record<string, unknown>;
    if (typeof session !== "string" || !session) throw new InboxError("validation_error", "to.session: the live session to send to.", { field: "to.session" });
    if (host !== undefined && typeof host !== "string") throw new InboxError("validation_error", "to.host: a string.", { field: "to.host" });
    const entry = sessions.get(session);
    if (!entry || !isLive(entry) || (host !== undefined && entry.host !== host)) return null;
    return { host: entry.host, session, root: entry.root };
  };

  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });

  /** The window's routes; null when the path is not one of them. */
  const route = async (req: Request, path: string): Promise<Response | null> => {
    const sessionsMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/sessions$/.exec(path);
    if (sessionsMatch) {
      if (req.method !== "GET") return answer({ error: "Use GET." }, 405);
      const live = liveFor(sessionsMatch[1]!);
      const asker = new URL(req.url).searchParams.get("asker");
      return answer({
        serverSession,
        home: homedir(),
        project: live.project,
        sessions: live.sessions,
        ...(asker ? { asker: { session: asker, live: askerLive(asker) } } : {}),
      });
    }
    const messageMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/message$/.exec(path);
    if (!messageMatch) return null;
    if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
    if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.session !== "string" || !body.session) {
      throw new InboxError("validation_error", "session: the live session to write to.", { field: "session" });
    }
    const threadId = messageMatch[1]!;
    const target = liveFor(threadId).sessions.find((candidate) => candidate.session === body.session) ?? null;
    const result = store.sendNewMessage(threadId, {
      body: body.body,
      idempotency_key: body.idempotency_key,
      to: target ? { host: target.host, session: target.session } : null,
    });
    return answer({ message: result.message, replayed: result.replayed });
  };

  return { pollStarted, stateChanged, liveFor, askerLive, replyTarget, seenOverMcp, holdOverMcp, route, allLive, isSessionLive, composeTarget };
}
