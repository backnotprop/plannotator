/**
 * Re-ask all (the owner's ask, 2026-11-21: "re-ask all … make sure the questions still matter. It gives the agent an
 * opportunity to tidy things as well"): a group's menu in the Inbox list sends, for each of its threads, the thread's
 * own Re-ask (approval "inbox-reask", `InboxStore.sendReask`) to every session there with a question open, so the
 * agent withdraws what no longer matters (`supersedes`), asks again what does (`Replaces:`), and archives a thread
 * with nothing left. The note is the Re-ask note, delivered and woken as one; it only adds the tidy line.
 *
 * Which sessions a thread takes is the thread's Re-ask rule (`reaskTargets`, @plannotator/core/inbox-reask): one
 * note per session, none to a session whose note still waits (so a second Re-ask all stacks nothing), none right
 * after that session answered one, none for a session with only picks (a Send is the person's), never a permission
 * prompt. A session that cannot be woken any more (`reachable` false: its waking connection went quiet, past the
 * grace) gets nothing: a note there would put the thread in Sent with nobody to answer it. It is counted instead.
 */

import { reaskTargets } from "@plannotator/core/inbox-reask";
import type { InboxMessageWire } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import type { InboxStore } from "./store";

/** One session of a thread a Re-ask all reached or could not. */
export interface ReaskAllSession {
  host: string | null;
  session: string | null;
}

export interface ThreadReaskAll {
  thread_id: string;
  /** The sessions asked, each with its note (`reply_id`); a replayed `key` answers the same notes. */
  asked: (ReaskAllSession & { message_id: string; reply_id: string })[];
  /** The sessions with a question open that can no longer be woken: nothing was written for them. */
  unreached: ReaskAllSession[];
}

/** A replay key: what the window sends once per press (`batch_id`), 1 to 128 of `[A-Za-z0-9_-]`. */
export const REASK_ALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Re-ask all on one thread. `key` is the press's own (a retry with it answers the notes already written, never a
 * second one); `reachable(message)` says whether the session that wrote `message` can still be woken.
 */
export function reaskThreadAll(store: InboxStore, threadId: string, key: string, reachable: (message: InboxMessageWire) => boolean): ThreadReaskAll {
  if (!REASK_ALL_KEY.test(key)) throw new InboxError("validation_error", "batch_id: 1 to 128 of A-Z, a-z, 0-9, _ and -.", { field: "batch_id" });
  const thread = store.windowThread(threadId);
  if (!thread || thread.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
  const out: ThreadReaskAll = { thread_id: threadId, asked: [], unreached: [] };
  // An archived thread is asked about only for what an agent wrote after the archive (it came back), as the thread's own Re-ask.
  const archived = thread.resolved_at !== null;
  const archiveSeq = thread.archive_seq ?? null;
  const live = (m: InboxMessageWire) => !archived || (archiveSeq !== null && (m.seq ?? 0) > archiveSeq);
  const noteKey = `reask-all-${key}`;
  // A retry of the same press: the notes it already wrote are its answer (their sessions now wait, so none is taken again).
  for (const note of thread.messages) {
    if (note.author.kind !== "person" || note.idempotency_key !== noteKey || !note.reply_to) continue;
    const asked = store.message(note.reply_to);
    if (asked?.author.kind !== "agent") continue;
    out.asked.push({ host: asked.author.host ?? null, session: asked.author.session ?? null, message_id: asked.id, reply_id: note.id });
  }
  for (const target of reaskTargets(thread.messages, live)) {
    if (target.kind !== "reask") continue;
    const who = { host: target.host, session: target.session };
    if (!reachable(target.message)) {
      out.unreached.push(who);
      continue;
    }
    try {
      const { reply } = store.sendReask(target.message.id, { idempotency_key: noteKey, tidy: true });
      out.asked.push({ ...who, message_id: target.message.id, reply_id: reply.id });
    } catch (error) {
      // Answered, superseded or archived between the read and the write: nothing left to ask that session.
      if (error instanceof InboxError && (error.code === "nothing_to_reask" || error.code === "thread_resolved")) continue;
      throw error;
    }
  }
  return out;
}
