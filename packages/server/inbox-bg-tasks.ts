/**
 * What a thread's agent still runs in the background (shells, monitors,
 * subagents), as its host reports it, for the strip above the thread's reply
 * box (packages/inbox/parts/TaskStrip.tsx).
 *
 * A host posts `{ session, host, type: "tasks", at?, tasks }` on the bridge
 * event route. `tasks: [{ id, kind, description, command?, agent_type?,
 * started_at, last_output_at }]` (times epoch ms or ISO) replaces the
 * session's list; `[]` clears it. A report older than the one kept (`at`, the
 * host's clock: two posts racing) changes nothing. A list expires
 * `INBOX_BG_TASKS_TTL_MS` after the report that carried it, so a host that
 * keeps reporting re-sends it within that time and a crashed session drops
 * out by itself. Memory only: a restart forgets it until the next report.
 *
 * `GET /api/inbox/threads/:id/tasks` answers `{ serverSession, thread_id,
 * tasks }`: the tasks of the thread's agent sessions, the latest writer first,
 * then the session a person-started thread is addressed to or launched, the
 * first that has any. The window polls it while the thread is open.
 */
import { inboxLaunchedSession } from "@plannotator/core/inbox-run-line";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** One background task of an agent session, as the strip reads it. Times ISO, null when unknown. */
export interface InboxBgTask {
  id: string;
  /** shell, monitor, agent, workflow, … as the host names it. */
  kind: string;
  description: string;
  command?: string;
  agent_type?: string;
  started_at: string | null;
  /** When its output (a shell's file, an agent's transcript) last moved; null: none yet; absent: the host cannot tell. */
  last_output_at?: string | null;
}

/** A list is dropped this long after the report that carried it. */
export const INBOX_BG_TASKS_TTL_MS = 5 * 60_000;
/** Tasks of one report, at most. */
export const INBOX_BG_TASKS_MAX = 50;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined;
const time = (value: unknown): string | null => {
  const ms = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

/** A `tasks` event's list. Entries without an id are dropped; a value that is not a list is refused. */
export function parseBgTasks(value: unknown): InboxBgTask[] {
  if (!Array.isArray(value)) throw new InboxError("validation_error", "tasks: a list of { id, kind, description, ... }.", { field: "tasks" });
  const tasks: InboxBgTask[] = [];
  for (const entry of value.slice(0, INBOX_BG_TASKS_MAX)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const id = text(raw.id, 100);
    if (!id) continue;
    const command = text(raw.command, 500);
    const agentType = text(raw.agent_type, 100);
    tasks.push({
      id,
      kind: text(raw.kind, 40) ?? "task",
      description: text(raw.description, 300) ?? "",
      ...(command ? { command } : {}),
      ...(agentType ? { agent_type: agentType } : {}),
      started_at: time(raw.started_at),
      ...("last_output_at" in raw ? { last_output_at: time(raw.last_output_at) } : {}),
    });
  }
  return tasks;
}

export interface InboxBgTasks {
  /** The session's tasks its hooks last reported, while within the TTL; [] when none or stale. */
  of(session: string): InboxBgTask[];
  /** The tasks of the thread's agent sessions (see the file comment), [] when none. */
  ofThread(threadId: string): InboxBgTask[];
  /** The bridge event route's answer to a `{ type: "tasks" }` event, null for any other type. */
  bridgeEvent(session: string, body: Record<string, unknown>): Response | null;
  /** `GET /api/inbox/threads/:id/tasks`'s answer, null for any other path. */
  route(req: Request, path: string, serverSession: string): Response | null;
}

export function createInboxBgTasks(store: InboxStore, options: { now?: () => number } = {}): InboxBgTasks {
  const now = options.now ?? Date.now;
  const bySession = new Map<string, { at: number; tasks: InboxBgTask[] }>();

  const of = (session: string): InboxBgTask[] => {
    const known = bySession.get(session);
    return known && known.tasks.length > 0 && now() - known.at <= INBOX_BG_TASKS_TTL_MS ? known.tasks : [];
  };

  const ofThread = (threadId: string): InboxBgTask[] => {
    const thread = store.thread(threadId);
    if (!thread) return [];
    const sessions: string[] = [];
    const add = (session: string | null | undefined) => {
      if (session && !sessions.includes(session)) sessions.push(session);
    };
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const author = thread.messages[i]!.author as { kind: string; session?: string | null };
      if (author.kind === "agent") add(author.session);
    }
    const root = store.message(threadId);
    if (root?.started_by_person) {
      add(root.to?.session);
      add(inboxLaunchedSession(root));
    }
    for (const session of sessions) {
      const tasks = of(session);
      if (tasks.length > 0) return tasks;
    }
    return [];
  };

  return {
    of,
    ofThread,
    bridgeEvent: (session, body) => {
      if (body.type !== "tasks") return null;
      const at = typeof body.at === "number" && Number.isFinite(body.at) && body.at > 0 ? body.at : now();
      const known = bySession.get(session);
      // A report that arrives after a newer one (two background posts racing) changes nothing.
      if (known && known.at > at) return Response.json({ ok: true, stale: true });
      const tasks = parseBgTasks(body.tasks);
      bySession.set(session, { at, tasks });
      return Response.json({ ok: true });
    },
    route: (req, path, serverSession) => {
      const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/tasks$/.exec(path);
      if (!match) return null;
      if (req.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405 });
      const threadId = store.message(match[1]!)?.thread_id ?? match[1]!;
      if (!store.thread(threadId)) return Response.json({ error: "No such thread.", code: "thread_not_found" }, { status: 404 });
      return Response.json({ serverSession, thread_id: threadId, tasks: ofThread(threadId) });
    },
  };
}
