/**
 * The review skills in the reply box's "/" list (code review in the Inbox,
 * approval "inbox-code-review-direction"). What regresses:
 *
 *  - a review skill's instructions not reaching the agent with the reply that
 *    names it, or reaching it with a reply that does not;
 *  - `/review-recheck` offered (or matched at Send) in a thread where no
 *    review happened (the owner's rule: only after a verdict or review
 *    comments in that thread);
 *  - a typed review skill name turning into a reference while the catalog
 *    has none (Code review off: the Inbox lists no Plannotator skill);
 *  - a chapter diagram's line naming anything but Mermaid, or an overview
 *    drawing, reaching the agent;
 *  - a chapter diagram's line reaching the agent while Settings → Capabilities →
 *    Chapter diagrams is off.
 */
import { describe, expect, test } from 'bun:test';
import { INBOX_REPLY_SKILL_AUDIENCE, splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { INBOX_GUIDE_FEEDBACK_TITLE, INBOX_REVIEW_CURATE_DRAWING_LINE, INBOX_REVIEW_RECHECK_DRAWING_LINE, INBOX_REVIEW_SKILL_TEXTS, inboxThreadHadReview, type InboxReviewThreadMessage } from '@plannotator/core/inbox-review';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { inboxSkillFilter, inboxSkillsBlock, setReviewSkillsDiagrams } from './skills';

const ON: SkillCatalogEntry[] = [
  { name: 'review-curate', root: 'plannotator', humanOnly: true },
  { name: 'review-recheck', root: 'plannotator', humanOnly: true },
  { name: 'deploy', root: 'claude', humanOnly: false, dir: '/home/me/.claude/skills/deploy' },
];
const sources = (catalog: SkillCatalogEntry[]) => ({
  catalog: async () => catalog,
  // A Plannotator skill is never read from disk: a call here for one fails the test.
  content: async (name: string) => {
    throw new Error(`read ${name} from disk`);
  },
});

const agent = (id: string, review = false): InboxReviewThreadMessage => ({ id, author: { kind: 'agent' }, ...(review ? { guide: { review: true } } : {}) });
const person = (id: string, extra: Partial<InboxReviewThreadMessage> = {}): InboxReviewThreadMessage => ({ id, author: { kind: 'person' }, ...extra });

describe('a reply that names a review skill', () => {
  test("carries the skill's instructions, from the window's own text, and only that reply", async () => {
    const block = await inboxSkillsBlock(['/review-curate only the auth parts'], INBOX_REPLY_SKILL_AUDIENCE, sources(ON));
    const split = splitInboxSkillsBlock(`Words\n\n${block}`);
    expect(split?.skills).toHaveLength(1);
    expect(split?.skills[0]).toMatchObject({ name: 'review-curate', included: true });
    expect(block).toContain(INBOX_REVIEW_SKILL_TEXTS['review-curate']!.body);
    expect(block).not.toContain('Skill directory:');
    // A reply that names none carries nothing.
    expect(await inboxSkillsBlock(['Looks good, ship it.'], INBOX_REPLY_SKILL_AUDIENCE, sources(ON))).toBe('');
  });

  test('Code review off (no Plannotator skill listed): a typed name stays plain text', async () => {
    expect(await inboxSkillsBlock(['/review-curate please'], INBOX_REPLY_SKILL_AUDIENCE, sources(ON.slice(2)))).toBe('');
  });
});

describe('/review-recheck needs a review in the thread', () => {
  test('hidden where no review happened, offered once the person sent a verdict or review comments', () => {
    const hidden = inboxSkillFilter(false);
    expect(ON.filter(hidden).map((s) => s.name)).toEqual(['review-curate', 'deploy']);
    expect(ON.filter(inboxSkillFilter(true)).map((s) => s.name)).toEqual(['review-curate', 'review-recheck', 'deploy']);
    // A skill of the person's own with the name is never hidden.
    expect(hidden({ name: 'review-recheck', root: 'claude', humanOnly: false })).toBe(true);

    // No review at all; a review with no answer; a plain reply to it: no. (The server's marking of a real Send is
    // in packages/server/inbox-code-review.test.ts.)
    expect(inboxThreadHadReview([agent('m1'), person('m2')])).toBe(false);
    expect(inboxThreadHadReview([agent('m1', true)])).toBe(false);
    expect(inboxThreadHadReview([agent('m1', true), person('m2', { reply_to: 'm1', body: 'Thanks.' })])).toBe(false);
    // A verdict, or a reply the Inbox marked as carrying the review's comments (to whichever message): yes.
    expect(inboxThreadHadReview([agent('m1', true), person('m2', { reply_to: 'm1', review_verdict: { of: 'm1', verdict: 'approved', comments: 0 } })])).toBe(true);
    expect(inboxThreadHadReview([agent('m1', true), agent('m2'), person('m3', { reply_to: 'm2', review_comments_of: ['m1'] })])).toBe(true);
    // The feedback heading alone (comments on a plain guide, or typed words) is not a review.
    expect(inboxThreadHadReview([agent('m1', true), person('m2', { reply_to: 'm1', body: `# ${INBOX_GUIDE_FEEDBACK_TITLE}` })])).toBe(false);
  });

  test('at Send, a typed /review-recheck in a thread with no review stays plain text; after one it carries its instructions', async () => {
    const words = ['/review-recheck what changed'];
    expect(await inboxSkillsBlock(words, INBOX_REPLY_SKILL_AUDIENCE, sources(ON), inboxSkillFilter(false))).toBe('');
    const block = await inboxSkillsBlock(words, INBOX_REPLY_SKILL_AUDIENCE, sources(ON), inboxSkillFilter(true));
    expect(block).toContain(INBOX_REVIEW_SKILL_TEXTS['review-recheck']!.body);
  });
});

describe("the review skills' chapter diagram lines", () => {
  test('name Mermaid only, and no skill asks for an overview drawing', async () => {
    const block = await inboxSkillsBlock(['/review-curate', '/review-recheck'], INBOX_REPLY_SKILL_AUDIENCE, sources(ON), inboxSkillFilter(true));
    expect(block).toContain(INBOX_REVIEW_SKILL_TEXTS['review-curate']!.body);
    expect([block.includes(INBOX_REVIEW_CURATE_DRAWING_LINE), block.includes(INBOX_REVIEW_RECHECK_DRAWING_LINE), block.includes('overview.diagram'), /\bhtml\b|Mermaid preferred/i.test(block)]).toEqual([true, true, false, false]);
  });
});

describe("the review skills' chapter diagram lines ride Chapter diagrams", () => {
  test('off: the pasted skills hold no diagram word; on again: the lines are back', async () => {
    const words = ['/review-curate', '/review-recheck'];
    const reviewed = inboxSkillFilter(true);
    try {
      setReviewSkillsDiagrams(false);
      const off = await inboxSkillsBlock(words, INBOX_REPLY_SKILL_AUDIENCE, sources(ON), reviewed);
      // Both skills are pasted, with their other words.
      expect(off).toContain('Give one chapter to each comment you acted on');
      expect(off).toContain('Needs the person:');
      expect(/diagram|mermaid/i.test(off)).toBe(false);
      setReviewSkillsDiagrams(true);
      const on = await inboxSkillsBlock(words, INBOX_REPLY_SKILL_AUDIENCE, sources(ON), reviewed);
      expect([on.includes(INBOX_REVIEW_CURATE_DRAWING_LINE), on.includes(INBOX_REVIEW_RECHECK_DRAWING_LINE)]).toEqual([true, true]);
    } finally {
      setReviewSkillsDiagrams(true);
    }
  });
});
