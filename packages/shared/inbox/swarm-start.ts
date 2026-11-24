/**
 * Swarm mode's ONE rule for "this message makes its thread a swarm" (docs/agent-guides/inbox-compose.md, "Swarm"):
 * a person's message, a New message or a reply alike, whose skills block names the built-in `/swarm` skill
 * (@plannotator/core/swarm-skill). The Swarm badge only puts `/swarm` in the words; the window pastes the skill's
 * text into the body at Send, so the agents read what to do in the message itself, with no other block. The server
 * reads this on every person message its store writes (inbox.ts), so a message from this window, the phone, or a
 * linked computer's forward to the computer holding the thread turns swarm on there.
 */

import { splitInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import { SWARM_SKILL } from "@plannotator/core/swarm-skill";
import type { InboxListener } from "./store";

export function inboxMessageStartsSwarm(message: { author: { kind: string }; body: string; thread_id?: string }): boolean {
  if (message.author.kind !== "person" || !message.thread_id) return false;
  return splitInboxSkillsBlock(message.body)?.skills.some((skill) => skill.name === SWARM_SKILL.name) ?? false;
}

/**
 * Every message the store writes from now on that starts a swarm turns swarm on for its thread. Only when the message is
 * written (its line's time is its own `created_at`): a later rewrite of it (seen, delivered, an ack) never turns on
 * again a swarm the person turned off. Returns the unsubscribe.
 */
export function watchSwarmStarts(store: { subscribe(listener: InboxListener): () => void }, swarms: { setOn(threadId: string, on: boolean): unknown }): () => void {
  return store.subscribe((line) => {
    if (line.kind === "message" && line.at === line.record.created_at && inboxMessageStartsSwarm(line.record)) swarms.setOn(line.record.thread_id, true);
  });
}
