/**
 * Combine's routes (approval "inbox-multi-select", 4A; packages/core/inbox-combine.ts):
 *
 * - `GET /api/inbox/combine?threads=<id>,<id>`: the running sessions that wrote in at least one of the picked threads,
 *   and with `all=1` (the window's) every other running session after them, and the Combines worth showing. Without
 *   `threads`: those only.
 * - `POST /api/inbox/combine { thread_ids, session, words?, idempotency_key }`: asks the session, any running one
 *   (approval "inbox-combine-across-computers": "Any running agent on either computer, always"), with one wake (a
 *   Tidy note whose run is the Combine's id). A replay of the key answers the Combine it made.
 * - `POST /api/inbox/combine/:id/cancel`: the person stops a Combine still waiting; an undelivered wake is withdrawn.
 * - `POST /api/inbox/combine/:id/undo`: the picked threads come back from the archive, but those archived before it.
 *
 * The picked threads are archived (the person's archive) only once the new thread arrives: a root message from the
 * asked session whose `idempotency_key` is the Combine's id, and nothing else (another new thread of that session is
 * its own work). A session that ends, ends its turn without one, or never gets to it fails the Combine; nothing is
 * archived, and a thread with the key that still comes settles it then.
 * Bun only, like the rest of the Inbox; the records live in `inbox/combines.json`, outside the event log.
 *
 * Across linked computers (approval "inbox-combine-across-computers"): a picked thread this store does not hold is
 * one on a linked machine (inbox-combine-far.ts). It is read there at the start, listed in the wake like a local one,
 * and archived there (and brought back by Undo) through the outbox; the Combine, its wake and the new thread are this
 * computer's, the chosen agent's.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  inboxRowArchived,
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
import type { InboxCombineFar, InboxCombineFarThread } from "./inbox-combine-far";
import { createCombineAcross, type CombineFile, type FarPick } from "./inbox-combine-across";
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
/** How long Undo waits for the other computer to bring its threads back: under the forward's own wait, when it came through one. */
const FAR_UNDO_WAIT_MS = 2_000;

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
  /** The linked machines, once they are up (inbox-combine-far.ts): null while none can be asked. */
  far?: () => InboxCombineFar | null;
  /** Every running session on this computer (picks on two computers offer any of them). */
  liveSessions?: () => readonly { session: string; host: string | null; root?: string | null }[];
  /** A linked machine's name (the words of a refusal about it). */
  nameOf?: (machine: string) => string;
  /** The linked machine a request came from through its door, or null (a window, a phone, an agent). */
  doorMachine?: (req: Request) => string | null;
  /** The most bytes of the other computer's files one Combine copies in (inbox-combine-across.ts `FILES_MAX_BYTES`). */
  filesMaxBytes?: number;
}

interface Stored extends InboxCombineRecord {
  key: string;
  /** The wake note (the first of the Tidy notes it wrote). */
  wake: string;
  /** Kept by an older run; never read. */
  projects?: string[];
  /** The picked threads on a linked machine, by id: that machine, and what its archive there carries (inbox-combine-across.ts). */
  far?: Record<string, FarPick>;
  /** The other computer's files, copied in for the new thread. */
  files?: CombineFile[];
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
  const across = createCombineAcross({ store, far: () => deps.far?.() ?? null, now, save: () => save(), nameOf: (machine) => deps.nameOf?.(machine) ?? "another computer", ...(deps.filesMaxBytes !== undefined ? { filesMaxBytes: deps.filesMaxBytes } : {}) });
  const wire = ({ key: _key, wake: _wake, projects: _projects, far: _far, files: _files, ...record }: Stored): InboxCombineRecord => {
    // Its archive or Undo on the other computer still on the way: the window waits for it before it says so.
    const waiting = record.state === "done" || record.state === "undone" ? across.waitingOn({ ...record, far: _far }) : [];
    return waiting.length > 0 ? { ...record, waiting_on: waiting } : record;
  };
  const shown = (): InboxCombineRecord[] =>
    combines.filter((c) => c.state === "asked" || now() - Date.parse(c.settled_at ?? c.at) <= SHOWN_MS).map(wire);

  const isArchived = (threadId: string) => {
    const row = store.listRow(threadId);
    return !!row && inboxRowArchived(row);
  };
  /** Is this store's own thread (a message id that is not a root here is not a thread anywhere). */
  const holds = (id: string) => store.message(id) !== null;
  /** The picked ids, in order; with `far`, an id this store does not hold is left for a linked machine to answer. */
  const pickedOf = (value: unknown, min: number, far = false): string[] => {
    const ids = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
    if (!ids || ids.length < min || ids.length > PICKED_MAX || ids.some((id) => typeof id !== "string" || !isInboxId("msg", id))) {
      throw new InboxError("validation_error", `thread_ids: ${min} to ${PICKED_MAX} thread ids.`, { field: "thread_ids" });
    }
    const out = [...new Set(ids as string[])];
    for (const id of out) {
      if (far && !holds(id)) continue;
      const root = store.message(id);
      if (!root || root.thread_id !== id) throw new InboxError("thread_not_found", `No thread ${id} on this machine.`, { field: "thread_ids" });
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

  /**
   * Who can write it (approval "inbox-combine-across-computers": "Any running agent on either computer, always"): the
   * ones that wrote in a pick here first, as `agentsFor` orders them, then every other running session here. With no
   * pick here, only a session that has a thread here: its wake goes in its own last thread (`carrier`).
   */
  const everyone = (threadIds: readonly string[]): InboxCombineAgent[] => {
    const wrote = agentsFor(threadIds);
    const reachOf = deps.reachFor();
    const lastThreads = store.lastThreadsBySession();
    const others = (deps.liveSessions?.() ?? [])
      .filter((s, i, all) => !isInboxPermissionSession(s.session) && reachOf(s.session) !== null && !wrote.some((a) => a.session === s.session) && all.findIndex((x) => x.session === s.session) === i)
      .filter((s) => threadIds.length > 0 || carrier(s.session) !== null)
      .map((s): InboxCombineAgent => {
        const last = lastThreads.get(s.session);
        const project = s.root ? (store.projectByRoot(s.root)?.name ?? basename(s.root)) : undefined;
        const title = deps.titleOf?.(s.session);
        return { session: s.session, host: s.host, name: hostName(s.host), threads: 0, ...(title ? { title } : {}), ...(project ? { project } : {}), ...(last ? { thread: last.subject ?? undefined, wrote_at: last.at } : {}) };
      })
      .sort((a, b) => (b.wrote_at ?? "").localeCompare(a.wrote_at ?? ""));
    return [...wrote, ...others];
  };

  /** With no pick on this computer, the thread here that carries the wake: the session's own last thread, still here. */
  const carrier = (session: string): string | null => {
    const last = store.lastThreadsBySession().get(session)?.id ?? null;
    return last && store.message(last)?.thread_id === last ? last : null;
  };

  const wakeThreads = (threadIds: readonly string[], far: ReadonlyMap<string, InboxCombineFarThread> = new Map()): InboxCombineWakeThread[] =>
    threadIds.map((threadId) => {
      const there = far.get(threadId);
      if (there) return { id: threadId, subject: there.subject, project: there.project, messages: there.messages, open: there.open };
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

  /** A pick of this computer's files and pictures, in thread order, for the new thread (attached as they are, not copied). */
  const localFiles = (threadId: string) => ({
    local: true as const,
    files: store.threadMessageIds(threadId).flatMap((mid) => {
      const m = store.message(mid);
      return !m || m.tidy ? [] : [...(m.attachments ?? []), ...(m.inline_images ?? [])].map((a) => ({ message: m.id, file: a.id, name: a.name, size: a.size }));
    }),
  });

  const busyHere = (id: string) => combines.some((c) => c.state === "asked" && c.threads.some((t) => t.id === id));
  /** Once a thread is in a Combine still waiting, here or on a linked computer, it is not asked about in another. */
  const refuseBusy = (threadIds: readonly string[], subjectOf: (id: string) => string | null) => {
    const busy = threadIds.find((id) => busyHere(id) || across.held(id));
    if (busy) throw new InboxError("already_combining", `${subjectOf(busy) ?? busy} is already being combined.`, { field: "thread_ids" });
  };
  /** Presses of one key still reading the other computer's threads: a second answers the first's Combine. */
  const starting = new Map<string, Promise<InboxCombineRecord>>();

  const start = async (body: Record<string, unknown>): Promise<InboxCombineRecord> => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key || key.length > 128) throw new InboxError("validation_error", "idempotency_key: required, at most 128 characters.", { field: "idempotency_key" });
    const replay = combines.find((c) => c.key === key);
    if (replay) return wire(replay);
    const pending = starting.get(key);
    if (pending) return pending;
    const run = begin(key, body);
    starting.set(key, run);
    try {
      return await run;
    } finally {
      starting.delete(key);
    }
  };

  const begin = async (key: string, body: Record<string, unknown>): Promise<InboxCombineRecord> => {
    const far = deps.far?.() ?? null;
    const threadIds = pickedOf(body.thread_ids, 2, far !== null);
    const local = threadIds.filter(holds);
    const farIds = threadIds.filter((t) => !holds(t));
    const session = typeof body.session === "string" ? body.session : "";
    // Any session running here, whether or not it wrote in a pick: it then owns the new thread.
    const pool = () => everyone(local);
    const agents = pool();
    const agent = agents.find((a) => a.session === session);
    if (!agent) throw new InboxError("session_not_live", "That agent cannot be asked now: it ended.", { field: "session" });
    const words = inboxTidyWords(body.words).slice(0, INBOX_COMBINE_WORDS_MAX);
    refuseBusy(threadIds, (id) => store.threadSubject(id));
    // The other computer's threads, read there now: nothing is written before each one is read.
    const there = new Map<string, InboxCombineFarThread>();
    if (far) for (const thread of await Promise.all(farIds.map((t) => far.thread(t)))) there.set(thread.id, thread);
    const farMachines = [...new Set([...there.values()].map((t) => t.machine))];
    if (farMachines.length > 1) throw new InboxError("validation_error", "thread_ids: threads on this computer and one linked computer.", { field: "thread_ids" });
    // Read there meanwhile: another Combine may have taken one of them, or the session ended.
    refuseBusy(threadIds, (id) => there.get(id)?.subject ?? store.threadSubject(id));
    const id = inboxId("cmb");
    // Busy on the other computer too, before anything is written here; let go again if this start goes no further.
    if (farMachines[0]) await across.acquire(id, farMachines[0], farIds);
    const record = (() => {
      try {
        if (!pool().some((a) => a.session === agent.session)) throw new InboxError("session_not_live", "That agent cannot be asked now: it ended.", { field: "session" });
        refuseBusy(local, (t) => store.threadSubject(t));
        return write(id, key, agent, agents, words, threadIds, local, there);
      } catch (error) {
        if (farMachines[0]) across.release({ id, state: "failed", at: new Date(now()).toISOString(), threads: farIds.map((t) => ({ id: t })), far: Object.fromEntries(farIds.map((t) => [t, { machine: farMachines[0]!, seen: "", questions: [] }])) });
        throw error;
      }
    })();
    // Written: the holds there last as long as it may wait (a start that stopped before this lets go there soon).
    across.confirm(record);
    // Every pick's files: this computer's attached as they are, the other computer's copied in while it is surely on;
    // all of them on the new thread once it is here.
    void across.copyFiles(record, threadIds.map((t) => there.get(t) ?? localFiles(t))).catch(() => {});
    return wire(record);
  };

  /** The Combine's wake and record, once everything was read and held. */
  const write = (id: string, key: string, agent: InboxCombineAgent, agents: readonly InboxCombineAgent[], words: string, threadIds: readonly string[], local: readonly string[], there: ReadonlyMap<string, InboxCombineFarThread>): Stored => {
    const ref = inboxSessionRef(agent.host, agent.session);
    const text = [inboxCombineInstruction(id), ...(words ? [inboxCombineWordsLine(words)] : []), ...(ref ? [inboxCombineSessionLine(ref)] : []), ...inboxCombineThreadLines(wakeThreads(threadIds, there))].join("\n\n");
    const archived = new Set([...local.filter(isArchived), ...[...there.values()].filter((t) => t.archived).map((t) => t.id)]);
    // The notes, the wake first, go in this computer's picked threads, to the chosen session (it may have written in
    // none of them): the other computer's are only read. With none here, the wake goes in the session's own thread.
    const carried = local.length > 0 ? local : [carrier(agent.session)].filter((t): t is string => t !== null);
    const { notes } = store.sendTidy({ run: id, to: { host: agent.host ?? "agent", session: agent.session }, threadIds: carried, body: text, idempotency_key: key });
    if (!notes[0]) throw new InboxError("session_not_live", "That agent cannot be asked now: it ended.", { field: "session" });
    const record: Stored = {
      id,
      key,
      wake: notes[0]!.id,
      threads: threadIds.map((t) => ({ id: t, subject: there.get(t)?.subject ?? store.threadSubject(t) ?? "(no subject)", ...(archived.has(t) ? { archived: true as const } : {}) })),
      session: agent.session,
      host: agent.host,
      name: inboxCombineAgentLabel(agent, agents),
      ...(words ? { words } : {}),
      at: new Date(now()).toISOString(),
      state: "asked",
      ...(there.size > 0 ? { far: Object.fromEntries([...there.values()].map((t) => [t.id, { machine: t.machine, seen: t.seen, questions: t.questions, ...(t.cursor !== undefined ? { cursor: t.cursor } : {}), ...(t.reopened ? { reopened: true as const } : {}) }])) } : {}),
    };
    combines.push(record);
    save();
    return record;
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
      if (record.far?.[thread.id]) continue;
      if (resolved ? isArchived(thread.id) : thread.archived) continue;
      try {
        if (resolved && store.message(thread.id)?.resolved_at != null) store.resolveThread(thread.id, false, "person");
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
    // After the line that told us: the archive is its own writes. The other computer's go through the outbox.
    queueMicrotask(() => {
      archive(record, true);
      across.archive(record);
      void across.finish(record).catch(() => {});
    });
  });

  /** A Combine still waiting whose session ended, ended its turn without the thread, or never got to it. */
  const check = () => {
    across.check(combines);
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
      across.release(record);
    }
  };
  const timer = setInterval(check, CHECK_MS);
  (timer as { unref?: () => void }).unref?.();

  const change = async (id: string, action: "cancel" | "undo"): Promise<InboxCombineRecord> => {
    across.check(combines);
    const record = combines.find((c) => c.id === id);
    if (!record) throw new InboxError("combine_not_found", `No Combine ${id}.`);
    if (action === "cancel") {
      if (record.state !== "asked") return wire(record);
      withdraw(record);
      settle(record, { state: "stopped" });
      across.release(record);
    } else {
      if (record.state !== "done") return wire(record);
      archive(record, false);
      settle(record, { state: "undone" });
      // An archive there that never left is taken back; one that landed is undone, behind it in that machine's queue.
      // Waited for a moment; while it still waits, the record says so (`waiting_on`) and the window holds its words.
      await across.undo(record, FAR_UNDO_WAIT_MS);
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
      // `all=1` (the window's): every running session here is offered (approval "inbox-combine-across-computers").
      const all = url.searchParams.get("all") === "1";
      // Asked about picks it holds none of (the other computer's): its running agents, any of which may write it there.
      const picked = threads ? pickedOf(threads, 1, all && (deps.far?.() ?? null) !== null) : [];
      const plan: InboxCombinePlan = { serverSession: deps.serverSession, ...(threads ? { agents: all ? everyone(picked.filter(holds)) : agentsFor(picked) } : {}), combines: shown() };
      return deps.json(plan);
    }
    if (req.method !== "POST") return deps.json({ error: "Use GET or POST." }, 405);
    const body = await deps.readBody(req);
    if (checkServerSession(body, deps.serverSession) === "mismatch") return deps.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (url.pathname === "/api/inbox/combine") return deps.json({ serverSession: deps.serverSession, combine: await start(body) });
    // A linked computer's Combine marks this Inbox's threads busy while it waits (inbox-combine-across.ts): its door only.
    if (url.pathname === "/api/inbox/combine/hold") {
      const machine = deps.doorMachine?.(req) ?? null;
      if (!machine) return deps.json({ error: "Not found.", code: "not_found" }, 404);
      return deps.json({ serverSession: deps.serverSession, ...across.holdRoute(body, machine, busyHere) });
    }
    const match = /^\/api\/inbox\/combine\/(cmb_[0-9A-HJKMNP-TV-Z]{26})\/(cancel|undo)$/.exec(url.pathname);
    if (!match) return deps.json({ error: "Not found.", code: "not_found" }, 404);
    return deps.json({ serverSession: deps.serverSession, combine: await change(match[1]!, match[2] as "cancel" | "undo") });
  };

  const close = () => {
    clearInterval(timer);
    unsubscribe();
  };

  return { route, check, close, list: shown, uploads: () => across.uploads(combines) };
}
