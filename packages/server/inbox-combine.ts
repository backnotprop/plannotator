/**
 * Combine's routes (approval "inbox-multi-select", 4A; packages/core/inbox-combine.ts):
 *
 * - `GET /api/inbox/combine?threads=<id>,<id>`: the running sessions that can be asked (each wrote in at least one of
 *   the picked threads, so it reads them on this machine), and the Combines worth showing. Without `threads`: those only.
 * - `POST /api/inbox/combine { thread_ids, session, words?, idempotency_key }`: asks the session, with one wake (a
 *   Tidy note whose run is the Combine's id). A replay of the key answers the Combine it made.
 * - `POST /api/inbox/combine/:id/cancel`: the person stops a Combine still waiting; an undelivered wake is withdrawn.
 * - `POST /api/inbox/combine/:id/undo`: the picked threads come back from the archive.
 *
 * The picked threads are archived (the person's archive) only once the new thread arrives: a root message from the
 * asked session whose `idempotency_key` is the Combine's id, and nothing else (another new thread of that session is
 * its own work). A session that ends, ends its turn without one, or never gets to it fails the Combine; nothing is
 * archived, and a thread with the key that still comes settles it then.
 * Bun only, like the rest of the Inbox; the records live in `inbox/combines.json`, outside the event log.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  INBOX_COMBINE_WORDS_MAX,
  INBOX_HOST_NAMES,
  inboxCombineAgentLabel,
  inboxCombineInstruction,
  inboxCombineSessionLine,
  inboxCombineThreadLines,
  inboxCombineWordsLine,
  inboxId,
  inboxSessionRef,
  inboxTidyWords,
  isInboxId,
  type InboxCombineAgent,
  type InboxCombinePlan,
  type InboxCombineRecord,
  type InboxCombineWakeThread,
  type InboxTidyReach,
} from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_TIDY_WITHDRAWN_HOST } from "@plannotator/shared/inbox/tidy";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";

const COMBINES_FILE = "combines.json";
const COMBINES_KEPT = 50;
/** A settled Combine is shown (its toast, once per window) for this long. */
const SHOWN_MS = 24 * 60 * 60_000;
/** Undelivered this long: the session never got to it. */
const UNDELIVERED_MS = 24 * 60 * 60_000;
/** Delivered this long without the thread, and no idle to say the turn ended: it is not coming. */
const DELIVERED_MS = 2 * 60 * 60_000;
/** Idle after delivery for this long without the thread: the turn ended without it. */
const IDLE_GRACE_MS = 20_000;
const CHECK_MS = 10_000;
/** After a start, sessions this long to connect again before a missing one counts as ended (connections live in memory). */
const RECONNECT_GRACE_MS = 2 * 60_000;
const PICKED_MAX = 50;

export interface InboxCombineDeps {
  store: InboxStore;
  serverSession: string;
  /** How a session is reached now (Tidy's `reachFor`); null when it ended. */
  reachFor: () => (session: string) => InboxTidyReach | null;
  /** Since when a session is idle (its last idle transition), or null. */
  idleSince: (session: string) => number | null;
  /** A session's title (the sidebar's Agents name), when it has one. */
  titleOf?: (session: string) => string | null;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  now?: () => number;
}

interface Stored extends InboxCombineRecord {
  key: string;
  /** The wake note (the first of the Tidy notes it wrote). */
  wake: string;
  /** Kept by an older run; never read. */
  projects?: string[];
}

const hostName = (host: string | null) => (host ? (INBOX_HOST_NAMES[host] ?? host) : "An agent");

export function createInboxCombine(deps: InboxCombineDeps) {
  const { store } = deps;
  const now = () => deps.now?.() ?? Date.now();
  const startedAt = now();
  const path = () => join(store.dir, COMBINES_FILE);

  const read = (): Stored[] => {
    try {
      const value = JSON.parse(readFileSync(path(), "utf8")) as { combines?: unknown };
      return Array.isArray(value.combines) ? (value.combines as Stored[]).filter((c) => c && isInboxId("cmb", c.id)) : [];
    } catch {
      return [];
    }
  };
  let combines = read();
  const save = () => {
    combines = combines.slice(-COMBINES_KEPT);
    mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    const temp = `${path()}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, combines })}\n`, { mode: 0o600 });
    renameSync(temp, path());
  };
  const wire = ({ key: _key, wake: _wake, projects: _projects, ...record }: Stored): InboxCombineRecord => record;
  const shown = (): InboxCombineRecord[] =>
    combines.filter((c) => c.state === "asked" || now() - Date.parse(c.settled_at ?? c.at) <= SHOWN_MS).map(wire);

  const pickedOf = (value: unknown, min: number): string[] => {
    const ids = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
    if (!ids || ids.length < min || ids.length > PICKED_MAX || ids.some((id) => typeof id !== "string" || !isInboxId("msg", id))) {
      throw new InboxError("validation_error", `thread_ids: ${min} to ${PICKED_MAX} thread ids.`, { field: "thread_ids" });
    }
    const out = [...new Set(ids as string[])];
    for (const id of out) {
      const root = store.message(id);
      if (!root || root.thread_id !== id) throw new InboxError("thread_not_found", `No thread ${id} on this machine.`, { field: "thread_ids" });
      if (root.resolved_at !== null) throw new InboxError("thread_archived", `${store.threadSubject(id) ?? id} is archived.`, { field: "thread_ids" });
    }
    return out;
  };

  /** Running sessions that wrote in a picked thread. */
  const agentsFor = (threadIds: readonly string[]): InboxCombineAgent[] => {
    const reachOf = deps.reachFor();
    const found = new Map<string, InboxCombineAgent>();
    const last = new Map<string, string>();
    for (const threadId of threadIds) {
      const seen = new Set<string>();
      for (const id of store.threadMessageIds(threadId)) {
        const m = store.message(id);
        const session = m?.author.kind === "agent" ? m.author.session : null;
        if (!m || m.author.kind !== "agent" || !session || isInboxPermissionSession(session) || seen.has(session) || reachOf(session) === null) continue;
        seen.add(session);
        const agent = found.get(session) ?? { session, host: m.author.host ?? null, name: hostName(m.author.host ?? null), threads: 0 };
        agent.threads += 1;
        const title = deps.titleOf?.(session);
        if (title) agent.title = title;
        const newest = [...store.threadMessageIds(threadId)].reverse().map((mid) => store.message(mid)).find((w) => w?.author.kind === "agent" && w.author.session === session);
        if (newest && newest.created_at > (last.get(session) ?? "")) {
          last.set(session, newest.created_at);
          agent.thread = store.threadSubject(threadId) ?? undefined;
          agent.project = store.project(store.message(threadId)?.project_id ?? "")?.name ?? undefined;
          agent.wrote_at = newest.created_at;
        }
        found.set(session, agent);
      }
    }
    // Most picked threads first; between equals, the one that wrote last.
    const agents = [...found.values()];
    const lastOf = (a: InboxCombineAgent) => last.get(a.session) ?? "";
    return agents.sort((a, b) => b.threads - a.threads || lastOf(b).localeCompare(lastOf(a)) || inboxCombineAgentLabel(a, agents).localeCompare(inboxCombineAgentLabel(b, agents)));
  };

  const wakeThreads = (threadIds: readonly string[]): InboxCombineWakeThread[] =>
    threadIds.map((threadId) => {
      const ids = store.threadMessageIds(threadId);
      const open: InboxCombineWakeThread["open"] = [];
      for (const id of ids) {
        const m = store.message(id);
        if (!m || m.author.kind !== "agent") continue;
        for (const q of store.questionsOf(id)) if (q.state === "open" && !q.orphaned) open.push({ ref: `${id}/${q.key}`, prompt: q.prompt.replace(/\s+/g, " ").trim() });
      }
      const root = store.message(threadId)!;
      return { id: threadId, subject: store.threadSubject(threadId) ?? "(no subject)", project: store.project(root.project_id)?.name ?? "", messages: ids.filter((id) => !store.message(id)?.tidy).length, open };
    });

  const start = (body: Record<string, unknown>): InboxCombineRecord => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key || key.length > 128) throw new InboxError("validation_error", "idempotency_key: required, at most 128 characters.", { field: "idempotency_key" });
    const replay = combines.find((c) => c.key === key);
    if (replay) return wire(replay);
    const threadIds = pickedOf(body.thread_ids, 2);
    const session = typeof body.session === "string" ? body.session : "";
    const agents = agentsFor(threadIds);
    const agent = agents.find((a) => a.session === session);
    if (!agent) throw new InboxError("session_not_live", "That agent cannot be asked now: it ended, or it never wrote in these threads.", { field: "session" });
    const words = inboxTidyWords(body.words).slice(0, INBOX_COMBINE_WORDS_MAX);
    // Once a thread is in a Combine still waiting, it is not asked about in another.
    const busy = threadIds.find((id) => combines.some((c) => c.state === "asked" && c.threads.some((t) => t.id === id)));
    if (busy) throw new InboxError("already_combining", `${store.threadSubject(busy) ?? busy} is already being combined.`, { field: "thread_ids" });
    const id = inboxId("cmb");
    const ref = inboxSessionRef(agent.host, agent.session);
    const text = [inboxCombineInstruction(id), ...(words ? [inboxCombineWordsLine(words)] : []), ...(ref ? [inboxCombineSessionLine(ref)] : []), ...inboxCombineThreadLines(wakeThreads(threadIds))].join("\n\n");
    const { notes } = store.sendTidy({ run: id, to: { host: agent.host ?? "agent", session: agent.session }, threadIds, body: text, idempotency_key: key });
    const record: Stored = {
      id,
      key,
      wake: notes[0]!.id,
      threads: threadIds.map((t) => ({ id: t, subject: store.threadSubject(t) ?? "(no subject)" })),
      session: agent.session,
      host: agent.host,
      name: inboxCombineAgentLabel(agent, agents),
      ...(words ? { words } : {}),
      at: new Date(now()).toISOString(),
      state: "asked",
    };
    combines.push(record);
    save();
    return wire(record);
  };

  const settle = (record: Stored, patch: Partial<InboxCombineRecord>) => {
    Object.assign(record, patch, { settled_at: new Date(now()).toISOString() });
    save();
  };
  /** An undelivered wake is withdrawn, so a session that comes back later is not asked any more. */
  const withdraw = (record: Stored) => {
    const note = store.message(record.wake);
    if (note && !note.delivery) {
      try {
        store.recordTidyWithdrawn(record.wake, INBOX_TIDY_WITHDRAWN_HOST);
      } catch {
        // Gone with a reload: nothing left to withdraw.
      }
    }
  };
  const archive = (record: Stored, resolved: boolean) => {
    for (const thread of record.threads) {
      try {
        store.resolveThread(thread.id, resolved, "person");
      } catch {
        // A thread deleted since: the others still go.
      }
    }
  };

  /** The new thread: the Combine's key on a root message of the asked session. One that failed meanwhile still settles. */
  const arrived = (record: Stored, message: { id: string; thread_id: string; project_id: string; created_at: string; idempotency_key?: string | null; author: { kind: string; session?: string | null } }) => {
    if ((record.state !== "asked" && record.state !== "failed") || message.author.kind !== "agent" || message.author.session !== record.session || message.id !== message.thread_id) return false;
    if (message.created_at < record.at || record.threads.some((t) => t.id === message.id)) return false;
    return message.idempotency_key === record.id;
  };
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message") return;
    const message = line.record;
    const record = combines.find((c) => arrived(c, message));
    if (!record) return;
    settle(record, { state: "done", reason: undefined, thread: { id: message.id, subject: store.threadSubject(message.id) ?? message.subject ?? "(no subject)" } });
    // After the line that told us: the archive is its own writes.
    queueMicrotask(() => archive(record, true));
  });

  /** A Combine still waiting whose session ended, ended its turn without the thread, or never got to it. */
  const check = () => {
    const waiting = combines.filter((c) => c.state === "asked");
    if (waiting.length === 0) return;
    const reachOf = deps.reachFor();
    const t = now();
    for (const record of waiting) {
      const note = store.message(record.wake);
      const at = note?.delivery?.at ? Date.parse(note.delivery.at) : null;
      const idle = deps.idleSince(record.session);
      // Just after a start (an Update, a restart) no session has polled yet: not having one says nothing so soon.
      const reason =
        !note || (reachOf(record.session) === null && t - startedAt >= RECONNECT_GRACE_MS)
          ? "ended"
          : at !== null && idle !== null && idle > at && t - idle >= IDLE_GRACE_MS
            ? "nothing"
            : (at === null && t - Date.parse(record.at) >= UNDELIVERED_MS) || (at !== null && t - at >= DELIVERED_MS)
              ? "timeout"
              : null;
      if (!reason) continue;
      withdraw(record);
      settle(record, { state: "failed", reason });
    }
  };
  const timer = setInterval(check, CHECK_MS);
  (timer as { unref?: () => void }).unref?.();

  const change = (id: string, action: "cancel" | "undo"): InboxCombineRecord => {
    const record = combines.find((c) => c.id === id);
    if (!record) throw new InboxError("combine_not_found", `No Combine ${id}.`);
    if (action === "cancel") {
      if (record.state !== "asked") return wire(record);
      withdraw(record);
      settle(record, { state: "stopped" });
    } else {
      if (record.state !== "done") return wire(record);
      archive(record, false);
      settle(record, { state: "undone" });
    }
    return wire(record);
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== "/api/inbox/combine" && !url.pathname.startsWith("/api/inbox/combine/")) return null;
    if (req.method === "GET" && url.pathname === "/api/inbox/combine") {
      // Another site's page must not read who works on what.
      if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
        return deps.json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
      }
      check();
      const threads = url.searchParams.get("threads");
      const plan: InboxCombinePlan = { serverSession: deps.serverSession, ...(threads ? { agents: agentsFor(pickedOf(threads, 1)) } : {}), combines: shown() };
      return deps.json(plan);
    }
    if (req.method !== "POST") return deps.json({ error: "Use GET or POST." }, 405);
    const body = await deps.readBody(req);
    if (checkServerSession(body, deps.serverSession) === "mismatch") return deps.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (url.pathname === "/api/inbox/combine") return deps.json({ serverSession: deps.serverSession, combine: start(body) });
    const match = /^\/api\/inbox\/combine\/(cmb_[0-9A-HJKMNP-TV-Z]{26})\/(cancel|undo)$/.exec(url.pathname);
    if (!match) return deps.json({ error: "Not found.", code: "not_found" }, 404);
    return deps.json({ serverSession: deps.serverSession, combine: change(match[1]!, match[2] as "cancel" | "undo") });
  };

  const close = () => {
    clearInterval(timer);
    unsubscribe();
  };

  return { route, check, close, list: shown };
}
