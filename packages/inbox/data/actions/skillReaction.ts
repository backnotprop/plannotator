/**
 * A skill emoji's write (thread/skillReaction.ts): a reply to that very message (`POST /api/inbox/messages/:id/reply`)
 * with the words and feedback a reply typed as only `/<skill>` sends, plus the additive `skill_reaction` the thread
 * draws it from, and on an earlier message the reply quote ↩ would carry (`quote`). One key per press; no picks, no
 * other session aimed at, the reply draft untouched.
 */
import { inboxApi } from '../../api';
import { newUuid } from '../../uuid';

export function postSkillReaction(messageId: string, input: { words: string; feedback: string; emoji: string; skill: string; quote?: { of: string; time?: string } }): Promise<unknown> {
  const { words, feedback, emoji, skill, quote } = input;
  return inboxApi.reply(messageId, { idempotency_key: newUuid(), words, questions: [], ...(feedback ? { feedback } : {}), ...(quote ? { quote } : {}), skill_reaction: { emoji, skill } });
}
