/**
 * Removing an agent from a thread (approval "inbox-remove-agent-from-thread", the owner 2026-11-23: "Build it this
 * way? Yes"). Who is in a thread is worked out from its messages (`InboxStore.participantsOf`, the window's
 * `threadParticipants`); a removal is the one stored mark that takes an agent out: `removed` on the thread's root, one
 * entry per press of Remove, written by the person only.
 *
 * The rule, the same on the server and in the window: a session is out of the thread while its latest removal stands,
 * and a removal stands until the person writes to that session again after it. Writing to it is a message of the
 * person's after the removal that goes to it: addressed to it (`to`, a hand-off included), a reply to one of its
 * messages (Reply on its message, an answer to its question), or a tag (`@`, "Tag another agent", a tick in the list).
 * The Inbox's own notes (a Mark read's set-aside note, a 👍's note, Tidy) are not the person writing, and the removed
 * agent's own posts never bring it back. The past stays: its messages, and what was sent to it before, are unchanged.
 */
import { isInboxPermissionSession } from "./inbox-permission";

/** One press of Remove on a thread's agent, kept on the thread's root (`InboxMessage.removed`). */
export interface InboxRemoval {
  host: string | null;
  session: string;
  /** The agent's own name when it gave one (`author.name`), for a reader that names it. */
  name?: string | null;
  /** When the person removed it. */
  at: string;
  /**
   * The thread's last message when it was removed: what the person writes after it can bring the agent back, and the
   * window draws "You removed … from this thread" after it.
   */
  after: string;
}

/** The fields of a message the rule reads (a stored message or the wire's). */
export interface RemovalMessage {
  id: string;
  thread_id: string;
  reply_to: string | null;
  created_at?: string;
  author: { kind: string; session?: string | null };
  to?: { session: string } | null;
  tags?: readonly { session: string; handed_away?: boolean | null }[] | null;
  removed?: readonly InboxRemoval[] | null;
  taken_back_at?: string | null;
  set_aside?: readonly string[] | null;
  moved_note?: { thread_id: string } | null;
  reopened?: readonly string[] | null;
  ack_of?: string | null;
  tidy?: unknown;
  scheduled_run?: { run?: number } | null;
  scheduled_change?: unknown;
  ship_note?: unknown;
}

/** One of the Inbox's own notes (core `isInboxNote`'s rule, read here without importing the types module). */
function isNote(message: RemovalMessage): boolean {
  return (
    (message.set_aside?.length ?? 0) > 0 ||
    !!message.ship_note ||
    !!message.moved_note ||
    (!!message.scheduled_run && message.scheduled_run.run === undefined) ||
    (message.reopened?.length ?? 0) > 0 ||
    (typeof message.ack_of === "string" && message.ack_of !== "") ||
    (typeof message.tidy === "object" && message.tidy !== null)
  );
}

/** The sessions a message of the person's goes to: its addressee, else the author of the message it answers, and its tags. */
function writesTo(message: RemovalMessage, byId: ReadonlyMap<string, RemovalMessage>): string[] {
  const out: string[] = [];
  if (message.to) out.push(message.to.session);
  else {
    const asked = message.reply_to ? byId.get(message.reply_to) : undefined;
    if (asked?.author.kind === "agent" && asked.author.session) out.push(asked.author.session);
  }
  for (const tag of message.tags ?? []) if (!tag.handed_away) out.push(tag.session);
  return out;
}

const cache = new WeakMap<readonly RemovalMessage[], Map<string, InboxRemoval>>();

/**
 * The sessions out of the thread now, each with the removal that stands (empty for a thread nobody was removed from).
 * `messages`: the thread's messages in thread order, its root first.
 */
export function inboxRemovedNow(messages: readonly RemovalMessage[]): ReadonlyMap<string, InboxRemoval> {
  const known = cache.get(messages);
  if (known) return known;
  const out = new Map<string, InboxRemoval>();
  const root = messages.find((m) => m.id === m.thread_id) ?? messages[0];
  for (const removal of root?.removed ?? []) out.set(removal.session, removal);
  if (out.size > 0) {
    const index = new Map(messages.map((m, at) => [m.id, at]));
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const [session, removal] of [...out]) {
      // A removal whose last message is no longer listed (taken back since) counts from its time.
      const from = index.get(removal.after) ?? messages.findIndex((m) => (m.created_at ?? "") > removal.at) - 1;
      if (from < -1) continue;
      for (let at = from + 1; at < messages.length; at++) {
        const message = messages[at]!;
        if (message.author.kind !== "person" || message.taken_back_at || isNote(message)) continue;
        if (writesTo(message, byId).includes(session)) {
          out.delete(session);
          break;
        }
      }
    }
  }
  cache.set(messages, out);
  return out;
}

/** Whether `session` is out of the thread now. */
export function inboxRemovedFrom(messages: readonly RemovalMessage[], session: string | null | undefined): boolean {
  return !!session && inboxRemovedNow(messages).has(session);
}

/**
 * The session a message can give the thread to (`InboxStore.threadOwner`'s candidates, one rule with
 * `inboxCanRemove`): an agent's own words (never a permission prompt, never a routine's change line), or the session a
 * message of the person's is addressed to (a thread the person started, a hand-off, a takeover). Null for any other.
 */
export function inboxHolderOf(message: RemovalMessage): string | null {
  if (message.author.kind === "agent") {
    const session = message.author.session ?? null;
    return session && !isInboxPermissionSession(session) && !message.scheduled_change ? session : null;
  }
  const to = message.to?.session ?? null;
  return to && !isInboxPermissionSession(to) ? to : null;
}

/**
 * Whether a session still holds the thread after `session` left it (`inboxHolderOf`): the last agent that could take
 * the person's reply is never removed, so a reply always has an agent to go to and the thread an owner.
 */
export function inboxCanRemove(messages: readonly RemovalMessage[], session: string): boolean {
  const out = inboxRemovedNow(messages);
  if (out.has(session)) return false;
  return messages.some((message) => {
    const other = inboxHolderOf(message);
    return other !== null && other !== session && !out.has(other);
  });
}

/**
 * Whether `messageId`, a post by `session`, is its first in the thread since its standing removal: only that post's
 * result carries the line that says it was removed (once per removal). False while it is not removed.
 */
export function inboxFirstPostSinceRemoval(messages: readonly RemovalMessage[], session: string, messageId: string): boolean {
  const removal = inboxRemovedNow(messages).get(session);
  if (!removal) return false;
  const index = messages.findIndex((m) => m.id === removal.after);
  const from = index >= 0 ? index + 1 : messages.findIndex((m) => (m.created_at ?? "") > removal.at);
  if (from < 0) return false;
  const first = messages.slice(from).find((m) => m.author.kind === "agent" && m.author.session === session);
  return first?.id === messageId;
}
