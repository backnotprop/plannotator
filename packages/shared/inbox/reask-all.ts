/**
 * Re-ask all (the owner's ask, 2026-11-21: "re-ask all … make sure the questions still matter. It gives the agent an
 * opportunity to tidy things as well"): a group's menu in the Inbox list sends, for each of its threads, the thread's
 * own Re-ask (approval "inbox-reask", `InboxStore.sendReask`) to every session there with a question open, so the
 * agent withdraws what no longer matters (`supersedes`) and asks again what does (`Replaces:`). The note is the Re-ask
 * note, byte for byte, delivered and woken as one: nothing more is added, and nothing asks the agent to archive (the
 * owner, 2026-11-21: "I don't think I'd ever expect re-ask to archive. In the instance when things don't need the
 * human anymore, the question should just be cleared out").
 *
 * Which sessions a thread takes is the thread's Re-ask rule (`reaskTargets`, @plannotator/core/inbox-reask): one
 * note per session, none to a session whose note still waits (so a second Re-ask all stacks nothing), none right
 * after that session answered one, none for a session with only picks, never a permission prompt. A session that
 * cannot be woken any more (`reachable` false: its waking connection went quiet, past the grace) gets nothing: a note
 * there would put the thread in Sent with nobody to answer it. It is counted instead.
 *
 * One rule of its own, since the person is in the list and sees neither the thread nor its picks: the picks the
 * person made and did not send stay as they are (`leave_picks`): a Send is the person's. A picked question is not in
 * the note either (the thread's own note never lists one as open: it sends it as an answer), so the agent neither
 * withdraws nor asks again what the person already picked an answer for. No pick is read or written, so a pick being
 * saved from an open thread at the same time cannot be half sent: it lands before the note (left out of it) or after
 * (as any pick after a Re-ask).
 */

import { itemsOf, reaskSessionKey, reaskTargets } from "@plannotator/core/inbox-reask";
import { isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import type { InboxMessageWire, InboxSentFrom } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import type { InboxReaskInput, InboxStore } from "./store";

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
  /** The sessions whose note could not be written (an unexpected refusal); the others were still asked. */
  failed: ReaskAllSession[];
  /** The sessions with a question open left out because they were asked again already (a note waits, or they just answered one). */
  already: number;
}

/** A replay key: what the window sends once per press (`batch_id`), 1 to 128 of `[A-Za-z0-9_-]`. */
export const REASK_ALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** What the server knows of a session's waking, for `reaskAllReachable`. */
export interface ReaskAllWakes {
  /** A T3 session known gone, or a cloud session dead. */
  gone(session: string): boolean;
  /** The session's waking connection is live (with the grace). */
  askerLive(session: string): boolean;
  /** A launched session a reply starts again. */
  resumes(threadId: string, session: string): boolean;
}

/** Whether the session that wrote `message` can still be woken to take a note. */
export function reaskAllReachable(message: InboxMessageWire, threadId: string, wakes: ReaskAllWakes): boolean {
  const session = message.author.kind === "agent" ? message.author.session : null;
  // No session named (an MCP agent): it reads the thread when it looks, as a reply to it waits.
  if (!session) return true;
  if (wakes.gone(session)) return false;
  // Only a waking connection can be told ended (the thread's own rule, ReplyRoute.tsx `askerCanEnd`).
  return message.wakes !== true || wakes.askerLive(session) || wakes.resumes(threadId, session);
}

/**
 * The per-message Re-ask route's input (`POST /api/inbox/messages/:id/reask`): the key and `to` only. Re-ask all's
 * `leave_picks`, or any other field, is never taken from a request body.
 */
export function messageReaskInput(body: Record<string, unknown>, to: InboxReaskInput["to"] | undefined): InboxReaskInput {
  return { idempotency_key: body.idempotency_key as string, ...(to === undefined ? {} : { to }) };
}

/**
 * Re-ask all on one thread. `key` is the press's own (a retry with it answers the notes already written, never a
 * second one); `reachable(message)` says whether the session that wrote `message` can still be woken. `sentFrom`: where
 * the person pressed it, as the server told it from the request (inbox-sent-from.ts), on every note, as a single Re-ask.
 */
export function reaskThreadAll(store: InboxStore, threadId: string, key: string, reachable: (message: InboxMessageWire) => boolean, sentFrom: InboxSentFrom | null = null): ThreadReaskAll {
  if (!REASK_ALL_KEY.test(key)) throw new InboxError("validation_error", "batch_id: 1 to 128 of A-Z, a-z, 0-9, _ and -.", { field: "batch_id" });
  const thread = store.windowThread(threadId);
  if (!thread || thread.thread_id !== threadId) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
  const out: ThreadReaskAll = { thread_id: threadId, asked: [], unreached: [], failed: [], already: 0 };
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
  const targets = reaskTargets(thread.messages, live);
  const taken = new Set(targets.map((t) => reaskSessionKey(t.message)));
  // Sessions with an item open the rule left out: asked again already (never a permission prompt).
  const left = new Set<string>();
  for (const m of thread.messages) {
    if (m.author.kind !== "agent" || !live(m) || isInboxPermissionSession(m.author.session) || !itemsOf(m).some((q) => q.state === "open")) continue;
    if (!taken.has(reaskSessionKey(m))) left.add(reaskSessionKey(m));
  }
  out.already = left.size;
  const asking = targets.filter((t) => t.kind === "reask");
  const reached = asking.filter((t) => reachable(t.message));
  for (const t of asking) if (!reached.includes(t)) out.unreached.push({ host: t.host, session: t.session });
  let firstError: unknown = null;
  for (const target of reached) {
    const who = { host: target.host, session: target.session };
    try {
      const { reply } = store.sendReask(target.message.id, { idempotency_key: noteKey, leave_picks: true, sent_from: sentFrom });
      out.asked.push({ ...who, message_id: target.message.id, reply_id: reply.id });
    } catch (error) {
      // Answered, superseded or archived between the read and the write: nothing left to ask that session.
      if (error instanceof InboxError && (error.code === "nothing_to_reask" || error.code === "thread_resolved")) continue;
      // Another refusal: the notes already written stand (their agents are woken), so they are answered with it.
      out.failed.push(who);
      firstError ??= error;
    }
  }
  // Nothing written at all: the refusal is the answer.
  if (firstError !== null && out.asked.length === 0) throw firstError;
  return out;
}
