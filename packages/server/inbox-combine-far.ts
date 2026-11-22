/**
 * Combine across linked computers (approval "inbox-combine-across-computers", the owner, 2026-11-21): the picked
 * threads may live on this computer and on a linked one. The Combine runs on the computer of the agent the person
 * chose (inbox-combine.ts): the new thread lives there. A picked thread on the other computer is:
 *
 *  - read there when the Combine starts, through the agents' far read (`agent-read`, `format=full`; the link is the
 *    permission, inbox-far-read.ts), for the wake's line and its open questions. Nothing of it is kept on disk here.
 *    The agent reads it itself with read_thread, which reaches it the same way.
 *  - archived there once the new thread arrives, and brought back by Undo, as the person's own Archive of a linked
 *    machine's row is: `POST messages/<root>/resolve` through the outbox (inbox-outbox.ts), under a key made from the
 *    Combine's id and the thread's, so a restart, a retry or a machine asleep sends each one once and in order (one
 *    queue per machine: an Undo queued behind an archive lands after it).
 */

import { inboxRowArchived, type InboxListRow } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { oneLine, type FarReadAnswer } from "./inbox-far-read";
import { FAR_READ_REFUSALS } from "./inbox-machine-agent-read";

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
}

/** What the Combine asks of the linked machines. */
export interface InboxCombineFar {
  /** A thread this store does not hold, read on the linked machine that does. Throws, with why, when it cannot be. */
  thread: (threadId: string) => Promise<InboxCombineFarThread>;
  /**
   * Archive (or bring back) a thread on its machine, through the outbox under `key`: held while that machine is away,
   * sent when it is back. Resolves once that machine answered, or after `waitMs` (0: at once).
   */
  resolve: (machine: string, threadId: string, resolved: boolean, key: string, waitMs?: number) => Promise<void>;
}

export interface InboxCombineFarDeps {
  /** The agents' far read (inbox-machine-agent-read.ts): null when no linked machine holds the id. */
  readThread: (ask: { thread_id: string; format: "full" }) => Promise<{ machine: string; answer: FarReadAnswer } | null>;
  /** A linked machine's row for the thread, as its list last said (null: not listed, an archived one). */
  rowOf: (threadId: string) => Pick<InboxListRow, "resolved_at" | "back_from_archive"> | null;
  /** A write held in the outbox for that machine (inbox-machines.ts `holdWrite`); null when it is not linked. */
  hold: (machine: string, route: string, body: Record<string, unknown>, thread: string, waitMs: number) => Promise<unknown> | null;
}

type FarMessage = { id?: unknown; author?: { kind?: unknown }; tidy?: unknown; questions?: { key?: unknown; state?: unknown; orphaned?: unknown; prompt?: unknown }[] };

/** The far read's records as the wake lists them: its subject, project, message count and open questions. */
export function farCombineThread(id: string, machine: string, answer: FarReadAnswer, row: Pick<InboxListRow, "resolved_at" | "back_from_archive"> | null): InboxCombineFarThread {
  if (!("full" in answer) || answer.thread_id !== id) throw new InboxError("machine_answer_unreadable", FAR_READ_REFUSALS.notHere(id));
  const full = answer.full as { subject?: unknown; project?: { name?: unknown }; resolved_at?: unknown; messages: FarMessage[] };
  const messages = full.messages.filter((m) => m && typeof m === "object" && !m.tidy);
  const open: InboxCombineFarThread["open"] = [];
  for (const m of messages) {
    if (m.author?.kind !== "agent" || typeof m.id !== "string") continue;
    for (const q of m.questions ?? []) {
      if (q?.state === "open" && !q.orphaned && typeof q.key === "string") open.push({ ref: `${oneLine(m.id)}/${oneLine(q.key)}`, prompt: oneLine(String(q.prompt ?? "")).replace(/\s+/g, " ") });
    }
  }
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
  };
}

export function createInboxCombineFar(deps: InboxCombineFarDeps): InboxCombineFar {
  return {
    thread: async (threadId) => {
      const read = await deps.readThread({ thread_id: threadId, format: "full" });
      if (!read) throw new InboxError("thread_not_found", FAR_READ_REFUSALS.notHere(threadId), { field: "thread_ids" });
      return farCombineThread(threadId, read.machine, read.answer, deps.rowOf(threadId));
    },
    resolve: async (machine, threadId, resolved, key, waitMs = 0) => {
      await deps.hold(machine, `messages/${encodeURIComponent(threadId)}/resolve`, { resolved, idempotency_key: key }, threadId, waitMs);
    },
  };
}
