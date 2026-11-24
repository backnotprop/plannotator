/**
 * A skill emoji pressed (approval "inbox-reactions-every-message", item 8): a reply to that message whose words are
 * exactly what a reply typed as only `/<skill>` sends today: the words `/<skill>` and, as the Send's feedback, the
 * skills block the reply box composes for them (skills.ts, the reply wording), from this window's own skills, so a
 * linked computer's thread gets them through the reply's usual forward. The additive `skill_reaction` only tells the
 * thread to draw the reply as one line ("You 😵‍💫 /bro"); the agent reads nothing new.
 */
import { INBOX_REPLY_SKILL_AUDIENCE } from '@plannotator/core/skill-reference-block';
import { inboxThreadHadReview } from '@plannotator/core/inbox-review';
import type { InboxMessageWire, InboxReaction, InboxThread } from '@plannotator/core/inbox-types';
import { postSkillReaction } from '../data/actions/skillReaction';
import { machineSkillSources } from '../data/machineSkills';
import { whenTime } from '../format';
import { machineOf } from '../inboxUrl';
import { arrowQuotesWhole, quoteToSend } from '../replyQuote';
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

/**
 * The words and feedback a typed `/<skill>` reply sends, from this computer's skills as the reply box reads them. The
 * saved emoji are one set on every linked machine, so on a linked machine's thread (`machine`) a skill this computer
 * does not have is read from that machine, where the agent runs, and its text travels in the feedback all the same.
 * `known` is false when neither has it now: the reply goes as the words alone.
 */
export async function skillReactionWords(skill: string, machine: string | null = null, reviewed = false): Promise<{ words: string; feedback: string; known: boolean }> {
  const words = `/${skill}`;
  // The thread's own rule, as its reply box's: a skill that needs a reviewed thread counts only once a review happened.
  const read = async (filter: ReturnType<typeof inboxSkillFilter>) => {
    const here = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE, undefined, filter);
    return here === '' && machine ? inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE, machineSkillSources(machine), filter) : here;
  };
  const block = await read(inboxSkillFilter(reviewed));
  // Not counted here yet (it needs a review first) is not gone: no "isn't on this computer" for it.
  const known = block !== '' || (!reviewed && (await read(inboxSkillFilter(true))) !== '');
  return { words, feedback: withSkillsBlock('', block), known };
}

/**
 * The quote a skill reaction carries: ↩'s own rule (`arrowQuotesWhole`), so on a message an agent wrote after, the
 * agent reads which message "/bro" is about (the reply quote's existing lead); on the newest, none, as a plain reply.
 */
export function skillReactionQuote(messages: readonly InboxMessageWire[], message: InboxMessageWire): { of: string; time?: string } | undefined {
  return arrowQuotesWhole(messages, message.id) ? quoteToSend({ of: message.id }, messages, whenTime) : undefined;
}

export async function sendSkillReaction(message: InboxMessageWire, reaction: InboxReaction & { skill: string }, agent: string, host: SkillReactionHost, thread: InboxThread): Promise<boolean> {
  const key = `${message.id}/${reaction.emoji}`;
  if (sending.has(key)) return false;
  sending.add(key);
  try {
    const { words, feedback, known } = await skillReactionWords(reaction.skill, machineOf(message.id), inboxThreadHadReview(thread.messages));
    const quote = skillReactionQuote(thread.messages, message);
    await postSkillReaction(message.id, { words, feedback, emoji: reaction.emoji, skill: reaction.skill, ...(quote ? { quote } : {}) });
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
