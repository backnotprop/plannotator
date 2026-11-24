/**
 * What a swarm's agents are handed (docs/agent-guides/inbox-swarm.md), on top of the wake the Inbox builds for any
 * item (inbox.ts `replyCommand`), with no new field on the wake: every connection already words it.
 *
 * - Words in a ghost thread (another member's `swarm say`, or the person's from the ghost pane): a notice
 *   (`moved` with its own first line, `notice`), so it never reads as the person's reply and asks for no answer in
 *   the thread: "<Name> wrote in the swarm's ghost thread. Answer there with plannotator inbox swarm say ...".
 * - The person's message that started a swarm (its skills block names `/swarm`): the words, then the join line with
 *   the thread's id (`swarmJoinLine`), so each agent can run it as it is.
 */

import type { InboxMessage } from "@plannotator/core/inbox-types";
import { swarmJoinLine } from "@plannotator/core/swarm-skill";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { SWARM_WORDS } from "@plannotator/shared/inbox/swarm";
import { inboxMessageStartsSwarm } from "@plannotator/shared/inbox/swarm-start";

export function swarmWakeOf(store: InboxStore, reply: InboxMessage, command: InboxReplyCommand, on: boolean): InboxReplyCommand {
  if (!on) return command;
  const parent = store.ghostParentOf(reply.thread_id);
  if (parent) {
    const notice = reply.author.kind === "agent" ? SWARM_WORDS.wake(reply.author.name ?? "An agent") : SWARM_WORDS.wakePerson;
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
      notice: notice.length <= 300 ? notice : SWARM_WORDS.wakePerson,
      ...(command.now ? { now: true } : {}),
    };
  }
  if (reply.thread_id === reply.id && store.swarmOf(reply.id)?.on && inboxMessageStartsSwarm(reply)) {
    return { ...command, body: `${command.body}\n\n${swarmJoinLine(reply.id)}` };
  }
  return command;
}
