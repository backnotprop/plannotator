/**
 * What a swarm's agents are handed (docs/agent-guides/inbox-swarm.md), on top of the wake the Inbox builds for any
 * item (inbox.ts `replyCommand`), with no new field on the wake: every connection already words it.
 *
 * - Words in a ghost thread (another member's `swarm say`, or the person's from the ghost pane): a notice
 *   (`moved` with its own first line, `notice`), so it never reads as the person's reply and asks for no answer in
 *   the thread (`SWARM_WORDS.wake`: answer in the ghost thread only when asked or needed, never only to acknowledge).
 * - The person's message that started a swarm (its skills block names `/swarm`): the words, then the join line with
 *   the thread's id (`swarmJoinLine`), so each agent can run it as it is.
 */

import type { InboxMessage } from "@plannotator/core/inbox-types";
import { swarmJoinLine } from "@plannotator/core/swarm-skill";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_WORDS } from "@plannotator/shared/inbox/swarm";
import { inboxMessageStartsSwarm } from "@plannotator/shared/inbox/swarm-start";

/** The notice line words in a ghost thread are handed with (`SWARM_WORDS.wake`, or the person's); null outside one. */
export function swarmNoticeOf(store: InboxStore, message: InboxMessage): string | null {
  if (!store.ghostParentOf(message.thread_id)) return null;
  const notice = message.author.kind === "agent" ? SWARM_WORDS.wake(message.author.name ?? "An agent") : SWARM_WORDS.wakePerson;
  return notice.length <= 300 ? notice : SWARM_WORDS.wakePerson;
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
  if (reply.thread_id === reply.id && inboxMessageStartsSwarm(reply) && (store.swarmOf(reply.id)?.on ?? true)) {
    return { ...command, body: `${command.body}\n\n${swarmJoinLine(reply.id)}` };
  }
  return command;
}
