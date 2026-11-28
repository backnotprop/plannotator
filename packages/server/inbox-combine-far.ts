/**
 * Combine across linked computers (approval "inbox-combine-across-computers", the owner, 2026-11-21): the picked
 * threads may live on this computer and on a linked one. The Combine runs on the computer of the agent the person
 * chose (inbox-combine.ts): the new thread lives there. A picked thread on the other computer is:
 *
 *  - read there when the Combine starts, through the agents' far read (`agent-read`, `format=full`; the link is the
 *    permission, inbox-far-read.ts), for the wake's line and its open questions. Nothing of the thread is kept on disk
 *    here. The agent reads it itself with read_thread, which reaches it the same way.
 *  - marked busy there while the Combine waits (`POST combine/hold`), so that computer does not combine it too.
 *  - its files and pictures copied in (`agent-file`, the far fetch's own checks), so they open on the combined thread
 *    while that computer is off.
 *  - archived there once the new thread arrives, and brought back by Undo, as the person's own Archive of a linked
 *    machine's row is: `POST messages/<root>/resolve` through the outbox (inbox-outbox.ts), under a key made from the
 *    Combine's id and the thread's, so a restart, a retry or a machine asleep sends each one once and in order (one
 *    queue per machine). The archive carries what the read saw (inbox-combine-guard.ts), so one that lands late on a
 *    thread that moved on is skipped there.
 * Every one of these writes is this Inbox's own (`auto` in the outbox): the window never lists them as the person's.
 */

import { inboxRowArchived, type InboxListRow } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { oneLine, type FarReadAnswer } from "./inbox-far-read";
import { FAR_READ_REFUSALS } from "./inbox-machine-agent-read";
import type { OutboxEntry } from "./inbox-outbox";

/** A file of a far picked thread: the message it is on and its id there, as `agent-file` takes them. */
export interface InboxCombineFarFile {
  message: string;
  file: string;
  name: string;
  size: number;
}

/** A picked thread on a linked machine, as the Combine needs it. */
export interface InboxCombineFarThread {
  id: string;
  /** The linked machine's id (its Inbox id). */
  machine: string;
  subject: string;
  project: string;
  /** Its messages, the Inbox's notes left out (as a local thread's count). */
  messages: number;
  open: { ref: string; prompt: string }[];
  /** Archived there before the Combine: it stays archived, and Undo leaves it there. */
  archived: boolean;
  /** Archived once and written in since (`back_from_archive`): archived again with a new archive line, as a local one. */
  reopened: boolean;
  /** The last message the read saw: a later one there skips the archive (inbox-combine-guard.ts). */
  seen: string;
  /** Every question the read saw (`<message>/<key>`): its open ones are in the wake; one closed then was not open to carry. */
  questions: string[];
  /** That computer's store cursor when it was read: an Unarchive there after it skips the archive (inbox-combine-guard.ts). */
  cursor?: number;
  /** Its attached files and the pictures its messages show, in thread order. */
  files: InboxCombineFarFile[];
}

/** What the Combine asks of the linked machines. */
export interface InboxCombineFar {
  /** A thread this store does not hold, read on the linked machine that does. Throws, with why and `machine`, when it cannot be. */
  thread: (threadId: string) => Promise<InboxCombineFarThread>;
  /**
   * A write of this Inbox's own on that machine, held in the outbox under the body's key; how it stands after `waitMs`.
   * `own`: the write it undoes, sent only once that one may have landed (`follows`); when it stops being worth sending (`send_by`).
   */
  write: (machine: string, route: string, body: Record<string, unknown>, thread: string | null, waitMs: number, own?: { follows?: string; send_by?: string }) => Promise<OutboxEntry | null>;
  /** How a held write stands, by its key (null: never held). */
  entry: (key: string) => OutboxEntry | null;
  /** Take back a held write that never left, or one past its `send_by` with no request on its way. */
  cancel: (key: string) => OutboxEntry | null;
  /** Whether the thread is open there as that machine's list last said (not listed: false); null while no list of it is held. */
  openThere: (machine: string, threadId: string) => boolean | null;
  /** One file of a far message, streamed, after the far fetch's refusals (a dotenv name, past 100 MB). */
  fetchFile: (args: { message_id: string; file: string }) => Promise<Response>;
  /** Whether that machine can be reached now (its files are copied only then). */
  online: (machine: string) => boolean;
}

export interface InboxCombineFarDeps {
  /** The agents' far read (inbox-machine-agent-read.ts): null when no linked machine holds the id. */
  readThread: (ask: { thread_id: string; format: "full" }) => Promise<{ machine: string; answer: FarReadAnswer } | null>;
  /** A linked machine's row for the thread, as its list last said (null: not listed, an archived one). */
  rowOf: (threadId: string) => (Pick<InboxListRow, "resolved_at" | "back_from_archive"> & { machine?: string }) | null;
  /** A write held in the outbox for that machine (inbox-machines.ts `holdWrite`); null when it is not linked. */
  hold: (machine: string, route: string, body: Record<string, unknown>, thread: string | null, waitMs: number, own?: { follows?: string; send_by?: string }) => Promise<OutboxEntry | null> | null;
  heldWrite: (key: string) => OutboxEntry | null;
  /** That machine's rows as its list last said (inbox-machines.ts `listedRows`), or null while none is held. */
  listedRows: (machine: string) => readonly Pick<InboxListRow, "thread_id" | "resolved_at" | "back_from_archive">[] | null;
  cancelHeld: (key: string) => OutboxEntry | null;
  fetchFile: (args: { message_id: string; file: string }) => Promise<Response>;
  online: (machine: string) => boolean;
}

type FarRecord = { id?: unknown; name?: unknown; size?: unknown };
type FarMessage = { id?: unknown; author?: { kind?: unknown }; tidy?: unknown; attachments?: FarRecord[]; inline_images?: FarRecord[]; questions?: { key?: unknown; state?: unknown; orphaned?: unknown; prompt?: unknown }[] };

/** The far read's records as the wake lists them: its subject, project, message count, open questions and files. */
export function farCombineThread(id: string, machine: string, answer: FarReadAnswer, row: Pick<InboxListRow, "resolved_at" | "back_from_archive"> | null): InboxCombineFarThread {
  if (!("full" in answer) || answer.thread_id !== id) throw new InboxError("machine_answer_unreadable", FAR_READ_REFUSALS.notHere(id), { machine });
  const full = answer.full as { subject?: unknown; project?: { name?: unknown }; resolved_at?: unknown; messages: FarMessage[] };
  const cursor = (answer as { cursor?: unknown }).cursor;
  const all = full.messages.filter((m): m is FarMessage => !!m && typeof m === "object");
  const messages = all.filter((m) => !m.tidy);
  const open: InboxCombineFarThread["open"] = [];
  const files: InboxCombineFarFile[] = [];
  const questions: string[] = [];
  for (const m of messages) {
    if (typeof m.id !== "string") continue;
    for (const record of [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.inline_images) ? m.inline_images : [])]) {
      if (record && typeof record.id === "string" && typeof record.name === "string") files.push({ message: m.id, file: record.id, name: record.name, size: typeof record.size === "number" ? record.size : 0 });
    }
    if (m.author?.kind !== "agent") continue;
    for (const q of m.questions ?? []) {
      if (typeof q?.key === "string") questions.push(`${m.id}/${q.key}`);
      if (q?.state === "open" && !q.orphaned && typeof q.key === "string") open.push({ ref: `${oneLine(m.id)}/${oneLine(q.key)}`, prompt: oneLine(String(q.prompt ?? "")).replace(/\s+/g, " ") });
    }
  }
  const last = [...all].reverse().find((m) => typeof m.id === "string");
  if (!last) throw new InboxError("machine_answer_unreadable", FAR_READ_REFUSALS.notHere(id), { machine });
  const resolved = typeof full.resolved_at === "string" && full.resolved_at !== "";
  const archived = row ? inboxRowArchived(row) : resolved;
  return {
    id,
    machine,
    subject: oneLine(typeof full.subject === "string" ? full.subject : "") || "(no subject)",
    project: oneLine(typeof full.project?.name === "string" ? full.project.name : ""),
    messages: messages.length,
    open,
    archived,
    reopened: !archived && resolved,
    seen: last.id as string,
    questions,
    ...(typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0 ? { cursor } : {}),
    files,
  };
}

export function createInboxCombineFar(deps: InboxCombineFarDeps): InboxCombineFar {
  return {
    thread: async (threadId) => {
      let read: Awaited<ReturnType<InboxCombineFarDeps["readThread"]>>;
      try {
        read = await deps.readThread({ thread_id: threadId, format: "full" });
      } catch (error) {
        // Which computer could not be asked, for the window's own words about it.
        const machine = deps.rowOf(threadId)?.machine;
        if (error instanceof InboxError && machine) throw new InboxError(error.code, error.message, { ...error.details, machine });
        throw error;
      }
      // Deleted, or never there: the words a Combine says of a thread this computer does not hold.
      if (!read) throw new InboxError("thread_not_found", `No thread ${threadId} on this machine.`, { field: "thread_ids" });
      return farCombineThread(threadId, read.machine, read.answer, deps.rowOf(threadId));
    },
    write: async (machine, route, body, thread, waitMs, own) => (await deps.hold(machine, route, body, thread, waitMs, own)) ?? null,
    entry: deps.heldWrite,
    cancel: deps.cancelHeld,
    openThere: (machine, threadId) => {
      const rows = deps.listedRows(machine);
      if (!rows) return null;
      const row = rows.find((r) => r.thread_id === threadId);
      return !!row && !inboxRowArchived(row);
    },
    fetchFile: deps.fetchFile,
    online: deps.online,
  };
}
