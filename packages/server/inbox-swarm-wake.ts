/**
 * What a swarm's agents are handed (docs/agent-guides/inbox-swarm.md), on top of the wake the Inbox builds for any
 * item (inbox.ts `replyCommand`), with no new field on the wake: every connection already words it.
 *
 * - Words in a ghost thread (another member's `swarm say`, or the person's from the ghost pane): a notice
 *   (`moved` with its own first line, `notice`), so it never reads as the person's reply and asks for no answer in
 *   the thread (`SWARM_WORDS.wake`: answer in the ghost thread only when asked or needed, never only to acknowledge).
 * - The person's message that started a swarm (its skills block names `/swarm`), or a later one of theirs that names it
 *   in a swarm's thread (Add an agent): the words, then the join line with the thread's id (`swarmJoinLine`), so each
 *   agent can run it as it is.
 */

import type { InboxMessage } from "@plannotator/core/inbox-types";
import { swarmJoinLine } from "@plannotator/core/swarm-skill";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_WORDS } from "@plannotator/shared/inbox/swarm";
import { inboxMessageStartsSwarm } from "@plannotator/shared/inbox/swarm-start";

/** A notice is one line of at most this many characters. */
const NOTICE_MAX = 300;

/** The notice line words in a ghost thread are handed with (`SWARM_WORDS.wake`, or the person's); null outside one. */
export function swarmNoticeOf(store: InboxStore, message: InboxMessage): string | null {
  if (!store.ghostParentOf(message.thread_id)) return null;
  const author = message.author;
  if (author.kind !== "agent") return SWARM_WORDS.wakePerson;
  const name = author.name ?? "An agent";
  const notice = SWARM_WORDS.wake(name);
  if (notice.length <= NOTICE_MAX) return notice;
  // A name too long for the line is shortened, never read as the person's words; `--to` then takes the member's
  // session, which `swarm say` takes as it takes a name.
  const to = author.session && author.session.length <= 80 ? author.session : undefined;
  const chars = [...name];
  const line = () => SWARM_WORDS.wake(`${chars.join("")}…`, to ?? `${chars.join("")}…`);
  while (chars.length > 1 && line().length > NOTICE_MAX) chars.pop();
  return line();
}

export function swarmWakeOf(store: InboxStore, reply: InboxMessage, command: InboxReplyCommand, on: boolean): InboxReplyCommand {
  if (!on) return command;
  const parent = store.ghostParentOf(reply.thread_id);
  if (parent) {
    const notice = swarmNoticeOf(store, reply)!;
    const subject = store.threadSubject(parent);
    return {
      type: "reply",
      id: reply.id,
      thread_id: reply.thread_id,
      reply_to: reply.reply_to,
      subject: `Ghost thread${subject ? ` · ${subject}` : ""}`,
      body: reply.body,
      url: command.url,
      moved: true,
      notice,
      ...(command.now ? { now: true } : {}),
    };
  }
  // Decided from the root itself, never from whether the swarm's record is written yet: a held poll or a far member's
  // wake builds this inside the very write that starts it (inbox.ts). Only a swarm the person turned off says no.
  // A later message of the person's that names `/swarm` in a swarm's thread (Add an agent's) carries it the same way.
  const swarm = store.swarmOf(reply.thread_id);
  if (inboxMessageStartsSwarm(reply) && (reply.thread_id === reply.id ? (swarm?.on ?? true) : !!swarm?.on)) {
    return { ...command, body: `${command.body}\n\n${swarmJoinLine(reply.thread_id)}` };
  }
  return command;
}
