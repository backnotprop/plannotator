/**
 * The message the person's words answer in a thread, and so the session they reach: one rule for the window's typed
 * reply (packages/inbox/sendTargets.ts `wordsMessage`) and Grid's Nudge (packages/server/inbox-grid-nudge.ts), so a
 * nudge goes where a reply typed in the thread would go.
 *
 * - A session that ended was replaced by a reply that took over (`took_over`), while no agent has written since: that
 *   session's latest reply (`inboxTookOverReply`).
 * - A thread handed to another session (approval "inbox-tag-handoff"): the new owner's latest message after the
 *   hand-off, else the hand-off reply itself (`inboxActiveHandoff`). The former owner writing again never takes it back.
 * - Otherwise the words rule (`inboxWordsDefault`): the latest agent message that is not a permission prompt's or a
 *   routine's change line, passing over a script's post; else the thread's first message.
 *
 * An agent the person removed from the thread is never the answer (core inbox-removed.ts). `messages`: the thread's
 * messages in thread order, its root first, none taken back. Pure.
 */
import { isInboxPermissionSession } from "./inbox-permission";
import { inboxRemovedFrom, inboxRemovedNow, type RemovalMessage } from "./inbox-removed";
import { inboxWordsDefault } from "./inbox-delivery";

/** The fields the rule reads (a stored message or the wire's). */
export interface WordsTargetMessage extends RemovalMessage {
  author: { kind: string; host?: string | null; session?: string | null; name?: string | null };
  to?: { host?: string | null; session: string } | null;
  wakes?: boolean;
  scheduled_change?: unknown;
  handoff?: { undone_at?: string | null } | null;
  took_over?: boolean;
}

/** The person's hand-off that holds the thread now; null when none does (undone, its new owner removed, or a later takeover). */
export function inboxActiveHandoff<M extends WordsTargetMessage>(messages: readonly M[]): M | null {
  // A hand-off to an agent the person removed from the thread since no longer holds it.
  const removed = inboxRemovedNow(messages);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.author.kind === "person" && message.handoff && !message.handoff.undone_at && message.to) return removed.has(message.to.session) ? null : message;
    // A later reply took over from the session that ended: the thread is no longer that hand-off's.
    if (message.took_over) return null;
  }
  return null;
}

/**
 * The person's reply that holds the thread now because a session that ended was replaced (`took_over`), while no agent
 * has written since: that session's latest reply. Null otherwise: a reply aimed elsewhere while the asker is live
 * never takes over.
 */
export function inboxTookOverReply<M extends WordsTargetMessage>(messages: readonly M[]): M | null {
  if (inboxActiveHandoff(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const m = messages[index]!;
    if (m.author.kind === "agent" && !isInboxPermissionSession(m.author.session) && !m.scheduled_change) return null;
    if (!m.took_over || !m.to) continue;
    // A session the person removed from the thread since holds it no more.
    if (inboxRemovedFrom(messages, m.to.session)) return null;
    // That session's latest since (the server's owner too): a stale tab's reply to another session does not take it.
    const owner = m.to.session;
    return messages.slice(index + 1).filter((later) => later.to?.session === owner).at(-1) ?? m;
  }
  return null;
}

/** The message the person's words answer (see the module note); null only for a thread with no message. */
export function inboxWordsMessage<M extends WordsTargetMessage>(messages: readonly M[], answersItself: (message: M) => boolean): M | null {
  const tookOver = inboxTookOverReply(messages);
  if (tookOver) return tookOver;
  const handoff = inboxActiveHandoff(messages);
  if (handoff) {
    const owner = handoff.to!.session;
    const after = messages.slice(messages.indexOf(handoff) + 1).filter((m) => m.author.kind === "agent" && m.author.session === owner);
    return after.at(-1) ?? handoff;
  }
  return inboxWordsDefault(messages, answersItself) ?? messages[0] ?? null;
}

/** The session a reply to `message` reaches: an agent's own session, or the session a message of the person's is addressed to. */
export function inboxWordsRecipient(message: WordsTargetMessage): { host: string | null; session: string } | null {
  if (message.author.kind === "agent") return message.author.session ? { host: message.author.host ?? null, session: message.author.session } : null;
  return message.to ? { host: message.to.host ?? null, session: message.to.session } : null;
}
