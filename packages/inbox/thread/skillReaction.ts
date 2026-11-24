/**
 * A skill emoji pressed (approval "inbox-reactions-every-message", item 8): a reply to that message whose words are
 * exactly what a reply typed as only `/<skill>` sends today: the words `/<skill>` and, as the Send's feedback, the
 * skills block the reply box composes for them (skills.ts, the reply wording), from this window's own skills, so a
 * linked computer's thread gets them through the reply's usual forward. The additive `skill_reaction` only tells the
 * thread to draw the reply as one line ("You 😵‍💫 /bro"); the agent reads nothing new.
 */
import { INBOX_REPLY_SKILL_AUDIENCE } from '@plannotator/core/skill-reference-block';
import type { InboxMessageWire, InboxReaction } from '@plannotator/core/inbox-types';
import { postSkillReaction } from '../data/actions/skillReaction';
import { inboxSkillFilter, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { errorToast } from '../toastError';
import type { InboxToastModel } from '../components/Toast';

/** The messages a skill reaction is on its way to: a second press of the same one sends nothing until it lands. */
const sending = new Set<string>();

export interface SkillReactionHost {
  onToast?: (toast: Omit<InboxToastModel, 'id'>) => void;
  onChanged?: () => Promise<void> | void;
  /** Said to a screen reader once it went ("Sent /bro to Claude Code."). */
  announce?: (words: string) => void;
}

/** The words and feedback a typed `/<skill>` reply sends; `known` is false when this computer has no such skill now. */
export async function skillReactionWords(skill: string): Promise<{ words: string; feedback: string; known: boolean }> {
  const words = `/${skill}`;
  const block = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE, undefined, inboxSkillFilter(true));
  return { words, feedback: withSkillsBlock('', block), known: block !== '' };
}

export async function sendSkillReaction(message: InboxMessageWire, reaction: InboxReaction & { skill: string }, agent: string, host: SkillReactionHost): Promise<boolean> {
  const key = `${message.id}/${reaction.emoji}`;
  if (sending.has(key)) return false;
  sending.add(key);
  try {
    const { words, feedback, known } = await skillReactionWords(reaction.skill);
    await postSkillReaction(message.id, { words, feedback, emoji: reaction.emoji, skill: reaction.skill });
    if (!known) host.onToast?.({ icon: 'warn', lead: `/${reaction.skill} isn't on this computer any more.`, detail: 'Sent as words.' });
    host.announce?.(`Sent /${reaction.skill} to ${agent}.`);
  } catch (cause) {
    host.onToast?.(errorToast(cause, 'That did not work; try again.'));
    return false;
  } finally {
    sending.delete(key);
  }
  await host.onChanged?.();
  return true;
}
