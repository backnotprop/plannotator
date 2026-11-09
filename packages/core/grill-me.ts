/**
 * The grill-me note: a short reminder the Plannotator Inbox adds when the
 * person invokes a grill-me skill from its own skill UI (the reply box, New
 * message, a comment on an attached file), so the interview's questions come
 * back to the Inbox as `:::question` cards. The owner, 2026-11-08: "Literally
 * only in the reply box or the new thread box or comment box, wherever we have
 * the skill experience already in our UI. So if it's a skill ran from our UI,
 * that's it." Never added to a session's own `/grill-me`.
 *
 * It travels inside the message's "Skills referenced" block, as one delimited
 * section after the skills' own (`packages/inbox/skills.ts`
 * `composeInboxSkillsBlock`; read back by `splitInboxSkillsBlock` in
 * `skill-reference-block.ts`). Words approved by the owner (2026-11-08,
 * "good"), less the last bullet he dropped. Browser-safe, no dependencies.
 */

/** The words of a skill name: its last `:` part, camelCase split, lowercased. */
function grillMeWords(name: string): string[] {
  const base = name.trim().replace(/^[/$@]+/, '').split(':').pop() ?? '';
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a skill name is a grill-me interview, whoever wrote it: a name with
 * the words "grill me" (`grill-me`, `grill_me`, `grillme`, `GrillMe`,
 * `team:grill-me`, `grill-me-harder`, `odoo-grill-me`), or one that is only
 * `grill`, `grilling` or `grill-with-…` (Matt Pocock's `/grill-me` calls
 * `grilling`; `/grill-with-docs` runs it too). Never `grilled-cheese`.
 */
export function isGrillMeSkill(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const words = grillMeWords(name);
  if (words.length === 0) return false;
  if (words.includes('grillme')) return true;
  for (let i = 0; i + 1 < words.length; i++) if (words[i] === 'grill' && words[i + 1] === 'me') return true;
  if (words.length === 1 && (words[0] === 'grill' || words[0] === 'grilling')) return true;
  return words[0] === 'grill' && words[1] === 'with';
}

/** The note (fixed text). It points at the send_message `body` field for the question format instead of repeating it. */
export const GRILL_ME_NOTE_TEXT = [
  'Plannotator: this is a grill-me interview, and the person uses the Plannotator Inbox. The skill still leads; this is only about where and how you ask.',
  '- Ask through the Inbox: plannotator_inbox send_message, each question a `:::question` block (one decision per block, choices in their natural order, then `Recommended:` and a `Why:` line; picture choices when the options are visual). Its `body` field shows the format.',
  "- Keep the skill's pace: one question at a time, or a round of related questions in one message when the skill or the person wants them together.",
  '- Their answers come back here as a message. While you wait, look up in the code what it can answer instead of asking.',
].join('\n');
