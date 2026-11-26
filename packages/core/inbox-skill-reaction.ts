/**
 * How the person reads a skill emoji's reply (`InboxMessage.skill_reaction`, approval
 * "inbox-reactions-every-message"; the owner's pick, 2026-11-26: "As a normal reply with text"): as a reply they typed
 * whose words are the emoji and the skill, "🦃 /bro". The thread, its folded line, the list's preview and search all
 * read these words. The agent reads the body the window sent (`/bro` and its skills block), unchanged.
 */
import { splitInboxReplyQuoteLead } from './inbox-reply-quote';
import type { InboxSkillReaction } from './inbox-types';

type WithSkillReaction = { skill_reaction?: InboxSkillReaction | null };

/** "🦃 /bro" for a skill emoji's reply; null for any other message. */
export function skillReactionText(message: WithSkillReaction): string | null {
  const reaction = message.skill_reaction;
  return reaction ? `${reaction.emoji} /${reaction.skill}` : null;
}

/**
 * The body as the thread draws it: the emoji in front of the `/<skill>` words, after the lead a quoting reply opens
 * with, so the reply draws through the person's usual reply path (the skill's chip, the skills line). Any other
 * body, or one whose words are not where the window put them, as it is.
 */
export function skillReactionShownBody(message: WithSkillReaction & { body: string }): string {
  const reaction = message.skill_reaction;
  if (!reaction) return message.body;
  const lead = splitInboxReplyQuoteLead(message.body);
  const at = lead ? message.body.length - lead.rest.length : 0;
  const words = `/${reaction.skill}`;
  if (!message.body.startsWith(words, at)) return message.body;
  const after = message.body.charAt(at + words.length);
  if (after !== '' && !/\s/.test(after)) return message.body;
  return `${message.body.slice(0, at)}${reaction.emoji} ${message.body.slice(at)}`;
}
