/**
 * `/create-routine` grants (docs/agent-guides/inbox-routines.md): the person's own Send of a message that picks the
 * Inbox's built-in `/create-routine` is their approval of the routine it asks for. The owner: "If I create a routine,
 * I want it turned on." So that Send mints ONE grant on its thread, and the agent's next `routine create` with
 * `thread_id` naming that thread takes it: the routine is made approved and on. Without one, a create is as before:
 * off, and `on` / `run` answer `routine_not_approved` until the person turns it on.
 *
 * Who can mint one: the Send routes (a reply, New message, a new thread) call `noteSend` with what they wrote, and only
 * for the person's own call (inbox.ts `personsSend`: the window's Origin and serverSession, or a paired device through
 * the door, as a permission prompt's answer). An agent's bare call to those routes, an MCP tool and a run's divider (its
 * prompt is an agent's to edit) never mint. The message must be `author.kind === "person"`, whose body ends in the
 * skills block the window composes at the Send (`splitInboxSkillsBlock`) naming the BUILT-IN `create-routine` ("a
 * Plannotator Inbox skill", its instructions included); a skill of the person's own by that name does not.
 *
 * Lifetime: one hour from the Send (the device pairing offer lasts ten minutes; this one waits for the agent's turn,
 * which can be long), one routine each, kept in memory only: an Inbox that restarts forgets them, and a create then
 * arrives off as before. A replayed Send mints nothing. Consumed before the create is written and given back if the
 * create is refused.
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

export function createRoutineGrants(now: () => number = Date.now, lifetimeMs = ROUTINE_GRANT_MS) {
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
    /** Takes the oldest live grant on this thread, or null. Give it back with `restore` if the create is refused. */
    take(threadId: string | null | undefined): InboxRoutineGrant | null {
      open = open.filter(live);
      const grant = threadId ? open.find((g) => g.thread_id === threadId) : undefined;
      if (!grant) return null;
      open = open.filter((g) => g !== grant);
      return grant;
    },
    restore(grant: InboxRoutineGrant): void {
      if (live(grant) && !open.includes(grant)) open = [...open, grant].sort((a, b) => a.at - b.at);
    },
    /** Tests: the grants still open. */
    open: (): readonly InboxRoutineGrant[] => open.filter(live),
  };
}

export type InboxRoutineGrants = ReturnType<typeof createRoutineGrants>;
