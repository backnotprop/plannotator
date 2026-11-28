/**
 * `/create-routine` grants (docs/agent-guides/inbox-routines.md): the person's own Send of a message that picks the
 * Inbox's built-in `/create-routine` is their approval of the routine it asks for. The owner: "If I create a routine,
 * I want it turned on." So that Send mints ONE grant on its thread, and the next `routine create` with `thread_id`
 * naming that thread, from a session the Send went to, takes it: the routine is made approved and on. Without one, a create is as before:
 * off, and `on` / `run` answer `routine_not_approved` until the person turns it on.
 *
 * Who can mint one: the Send routes (a reply, New message, a new thread) call `noteSend` with what they wrote, and only
 * for the person's own call (inbox.ts `personsSend`: the window's Origin and serverSession, or a paired device through
 * the door, as a permission prompt's answer). An agent's bare call to those routes, an MCP tool and a run's divider (its
 * prompt is an agent's to edit) never mint. The message must be `author.kind === "person"`, whose body ends in the
 * skills block the window composes at the Send (`splitInboxSkillsBlock`) naming the BUILT-IN `create-routine` ("a
 * Plannotator Inbox skill", its instructions included); a skill of the person's own by that name does not.
 *
 * Who can take one: only a session the Send went to, read from the stored message when the create comes, by the
 * store's own rule for who a person's message goes to (`recipientOf`: the session it is addressed to, else the agent
 * whose message it answers), each session the Send tags, and a launched thread's agent once it started (its root is
 * the Send, and its session is not known until then). Another session in the same thread, or a shell that names no
 * session, gets none and its create arrives off; a Send that went to no session can be taken by nobody.
 *
 * Lifetime: one hour from the Send (the device pairing offer lasts ten minutes; this one waits for the agent's turn,
 * which can be long), one routine each, kept in memory only: an Inbox that restarts forgets them, and a create then
 * arrives off as before. A replayed Send mints nothing. Consumed before the create is written, and given back only
 * when the create is refused before anything is saved (a field the server refuses).
 */
import { splitInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import type { InboxMessage } from "@plannotator/core/inbox-types";

/** How long a `/create-routine` Send stays a grant. */
export const ROUTINE_GRANT_MS = 60 * 60_000;

export interface InboxRoutineGrant {
  thread_id: string;
  message_id: string;
  /** The Send's time, ms. */
  at: number;
}

/** Whether a written message is the person's Send of the built-in `/create-routine`. */
export function mintsRoutineGrant(message: Pick<InboxMessage, "author" | "body" | "scheduled_run">): boolean {
  if (message.author?.kind !== "person" || message.scheduled_run || typeof message.body !== "string") return false;
  const split = splitInboxSkillsBlock(message.body);
  if (!split) return false;
  const skill = split.skills.find((s) => s.name === CREATE_ROUTINE_SKILL.name);
  if (!skill?.included) return false;
  // The built-in's own list line; a skill of the person's that shares the name reads otherwise.
  const line = split.block.split("\n").find((l) => l.startsWith(`- \`${CREATE_ROUTINE_SKILL.name}\``)) ?? "";
  return line.includes("(a Plannotator Inbox skill;");
}

/**
 * What `take` found: the grant, or none, and then whether this thread holds a live one that went to another session
 * (`for_another`), so the agent is told the truth about why its routine is off.
 */
export interface InboxRoutineGrantTake {
  grant: InboxRoutineGrant | null;
  for_another: boolean;
}

/**
 * The sessions a stored Send went to, read now: its owner by the store's rule (`recipientOf`), a launched thread's
 * agent once it started (`launch.session`; the Send is its root), and each session it tags. None for a message that
 * is gone, or one that went to no session.
 */
export function sendRecipients(store: {
  message(id: string): InboxMessage | null;
  recipientOf(message: InboxMessage): { session: string } | null;
}): (messageId: string) => string[] {
  return (messageId) => {
    const message = store.message(messageId);
    if (!message) return [];
    return [store.recipientOf(message)?.session, message.launch?.session, ...(message.tags ?? []).map((tag) => tag.session)].filter((session): session is string => !!session);
  };
}

/** `recipientsOf(messageId)`: the sessions that Send went to now (`sendRecipients`). */
export function createRoutineGrants(recipientsOf: (messageId: string) => readonly string[], now: () => number = Date.now, lifetimeMs = ROUTINE_GRANT_MS) {
  /** Unused grants, oldest first. */
  let open: InboxRoutineGrant[] = [];
  /** Every Send that minted one, used or not: the same message never mints twice. */
  const minted = new Set<string>();
  const live = (grant: InboxRoutineGrant) => now() - grant.at < lifetimeMs;
  return {
    /** The person's own Send, just written (not a replay): a `/create-routine` one mints a grant on its thread. */
    noteSend(message: InboxMessage): void {
      if (minted.has(message.id) || !mintsRoutineGrant(message)) return;
      minted.add(message.id);
      open = [...open.filter(live), { thread_id: message.thread_id, message_id: message.id, at: Date.parse(message.created_at) || now() }];
    },
    /**
     * Takes the oldest live grant on this thread whose Send went to `session`. A session of "" (a caller that names
     * none) never takes one. Give it back with `restore` if the create is refused before anything is saved.
     */
    take(threadId: string | null | undefined, session: string): InboxRoutineGrantTake {
      open = open.filter(live);
      const here = threadId ? open.filter((g) => g.thread_id === threadId) : [];
      const grant = session ? here.find((g) => recipientsOf(g.message_id).includes(session)) : undefined;
      if (!grant) return { grant: null, for_another: here.length > 0 };
      open = open.filter((g) => g !== grant);
      return { grant, for_another: false };
    },
    restore(grant: InboxRoutineGrant): void {
      if (live(grant) && !open.includes(grant)) open = [...open, grant].sort((a, b) => a.at - b.at);
    },
    /** Tests: the grants still open. */
    open: (): readonly InboxRoutineGrant[] => open.filter(live),
  };
}

export type InboxRoutineGrants = ReturnType<typeof createRoutineGrants>;
