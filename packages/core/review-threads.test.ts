import { describe, expect, test } from 'bun:test';
import { newSideLines } from './line-anchor';
import { checkReviewAnchor, reviewAnchorBlock, reviewAnchorNow, reviewBatchBlock, reviewConversations, type InboxReviewAnchor } from './review-threads';

const fileAt = (lines: string[]) => new Map(lines.map((text, i) => [i + 1, text] as const));

const round1 = ['import x from "x";', '', 'export function charge(amount) {', '  if (amount < 0) throw new Error("neg");', '  return stripe.charge(amount);', '}', '', 'export const retries = 3;'];
const anchor: InboxReviewAnchor = {
  file: 'src/billing.ts',
  side: 'new',
  line_start: 4,
  line_end: 5,
  code: [round1[3]!, round1[4]!],
  context_before: [round1[1]!, round1[2]!],
  context_after: [round1[5]!, round1[6]!],
  head: 'abc1234def',
};

describe('a thread follows its code to the next commit', () => {
  test('the same lines at the same place stay put', () => {
    expect(reviewAnchorNow(anchor, fileAt(round1))).toEqual({ place: 'here', line_start: 4, line_end: 5 });
  });

  test('lines pushed down by an edit above move with their text', () => {
    const round2 = ['import x from "x";', 'import y from "y";', 'import z from "z";', ...round1.slice(1)];
    expect(reviewAnchorNow(anchor, fileAt(round2))).toEqual({ place: 'moved', line_start: 6, line_end: 7 });
  });

  test('lines the agent rewrote stay on the shifted place, marked changed', () => {
    const round2 = ['import x from "x";', 'import y from "y";', '', 'export function charge(amount) {', '  if (amount <= 0) throw new RangeError("amount");', '  return stripe.charge(amount, { idempotencyKey });', '}', '', 'export const retries = 3;'];
    expect(reviewAnchorNow(anchor, fileAt(round2))).toEqual({ place: 'changed', line_start: 5, line_end: 6 });
  });

  test('a file rewritten past recognition is not placed on a guess', () => {
    expect(reviewAnchorNow(anchor, fileAt(['totally', 'different']))).toMatchObject({ place: 'unknown' });
  });

  test('a new commit read from its patch re-anchors the same way', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' import x from "x";', '+import y from "y";', ' ', ' export function charge(amount) {', '@@ -4,2 +5,2 @@', ' ' + round1[3], ' ' + round1[4]].join('\n');
    expect(reviewAnchorNow(anchor, newSideLines(patch))).toEqual({ place: 'moved', line_start: 5, line_end: 6 });
  });
});

describe('the anchor the window sends', () => {
  test('keeps what it can and refuses a range that cannot be one', () => {
    expect(checkReviewAnchor({ ...anchor, head: 'ABC1234' }).head).toBe('abc1234');
    expect(() => checkReviewAnchor({ ...anchor, line_start: 6, line_end: 5 })).toThrow('line_start');
    expect(() => checkReviewAnchor({ ...anchor, file: 'a\nb' })).toThrow('file');
    expect(() => checkReviewAnchor({ ...anchor, code: Array(81).fill('x') })).toThrow('at most 80');
  });
});

describe('what the agent reads', () => {
  test('one comment names its lines, shows the code and how to answer on them', () => {
    expect(reviewAnchorBlock({ id: 'msg_1', review_anchor: anchor })).toBe(
      ['(A review comment on `src/billing.ts` lines 4-5 (new side, at abc1234):', '```', round1[3], round1[4], '```', 'Answer it with reply_to msg_1.)'].join('\n'),
    );
  });

  test('code holding a fence gets a longer one', () => {
    expect(reviewAnchorBlock({ id: 'm', review_anchor: { ...anchor, line_end: 4, code: ['const s = "```";'] } })).toContain('````\nconst s');
  });

  test('a review sent all at once lists every comment by its own id', () => {
    const text = reviewBatchBlock({ id: 'msg_lead' }, [
      { id: 'msg_a', body: 'Negative amounts: use RangeError.', review_anchor: anchor },
      { id: 'msg_b', body: 'Why 3?', review_anchor: { ...anchor, line_start: 8, line_end: 8, code: ['export const retries = 3;'], context_before: undefined, context_after: undefined } },
    ]);
    expect(text.startsWith('(A code review of 2 comments.')).toBe(true);
    expect(text).toContain('reply_to msg_lead');
    expect(text).toContain('Comment msg_a on `src/billing.ts` lines 4-5');
    expect(text).toContain('Comment msg_b on `src/billing.ts` line 8 (new side, at abc1234):\n```\nexport const retries = 3;\n```\nWhy 3?');
  });
});

describe('conversations', () => {
  test('replies at any depth join the comment they answer; the rest of the thread is no conversation', () => {
    const at = '2026-11-14T00:00:00Z';
    const messages = [
      { id: 'root', reply_to: null, created_at: at },
      { id: 'c1', reply_to: 'root', created_at: at, review_anchor: anchor },
      { id: 'a1', reply_to: 'c1', created_at: at },
      { id: 'p1', reply_to: 'a1', created_at: at },
      { id: 'a2', reply_to: 'p1', created_at: at, review_addressed: { at, session: 's', host: 'pi', commit: 'def5678' } },
      { id: 'other', reply_to: 'root', created_at: at },
    ];
    const [only, ...rest] = reviewConversations(messages);
    expect(rest).toEqual([]);
    expect(only!.id).toBe('c1');
    expect(only!.messages.map((m) => m.id)).toEqual(['c1', 'a1', 'p1', 'a2']);
    expect(only!.addressed?.commit).toBe('def5678');
  });
});
