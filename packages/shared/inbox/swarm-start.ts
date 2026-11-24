/**
 * Swarm's ONE rule for "this message makes its thread a swarm" (docs/agent-guides/inbox-swarm.md): a person's message
 * whose skills block names the built-in `/swarm` skill (@plannotator/core/swarm-skill). The Swarm badge only puts
 * `/swarm` in the words; the window pastes the skill's text into the body at Send, so the agents read what to do in
 * the message itself. The server reads this on every person message its store writes (inbox-swarm-route.ts), so a
 * message from this window, the phone, or a linked computer's forward to the computer holding the thread starts it.
 */

import { splitInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import { SWARM_SKILL } from "@plannotator/core/swarm-skill";

/** send_message into a swarm's ghost thread (DRAFT, with SWARM_WORDS): refused, nothing written; `swarm say` writes there. */
export const SWARM_GHOST_SEND_REFUSED = "That is a swarm's ghost thread: nothing was sent. Write there with plannotator inbox swarm say.";

export function inboxMessageStartsSwarm(message: { author: { kind: string }; body: string; thread_id?: string; ghost_of?: string }): boolean {
  if (message.author.kind !== "person" || !message.thread_id || message.ghost_of) return false;
  return splitInboxSkillsBlock(message.body)?.skills.some((skill) => skill.name === SWARM_SKILL.name) ?? false;
}
