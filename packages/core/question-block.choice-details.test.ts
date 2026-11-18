/**
 * Lines that describe a choice (`Why:`, `Trade-off:`, `Pros:`, `Cons:`),
 * written under it as a plain indented line or a nested bullet, belong to
 * that choice: never a choice of their own, never part of its label. And a
 * pick-one `Recommended:` line that begins with a choice's label and then
 * gives its reasons (or a number) names that choice.
 *
 * What regresses if this fails: a `- Trade-off: …` bullet under a choice
 * shows as one more answer, a plain `Why:` line is glued onto the label, or
 * `Recommended: B, because …` turns into an extra answer row.
 */
import { describe, expect, test } from 'bun:test';
import { parseQuestionBlock } from './question-block';
import { parseInboxQuestionBlocks } from './inbox-questions';

const recommendedOf = (body: string, kind = 'question') =>
  parseQuestionBlock(kind, body)!.choices.filter((c) => c.recommended).map((c) => c.label);

describe('choice details', () => {
  test('nested detail bullets under plain-bullet choices stay with their choice', () => {
    const body = ['Which drawer?', '- A', '  - Trade-off: slower', '- B', '  - Why: cheaper', '  - Pros:', '    - fast', '    - small', '', 'Recommended: B'].join('\n');
    const q = parseQuestionBlock('question', body)!;
    expect(q.choices.map((c) => c.label)).toEqual(['A', 'B']);
    expect(q.choices[0]).toMatchObject({ description: 'Trade-off: slower', details: ['Trade-off: slower'] });
    expect(q.choices[1]).toMatchObject({ recommended: true, details: ['Why: cheaper', 'Pros: fast; small'] });
    expect(q.context).toBe('');
    // The key is the prompt's: unchanged by where the lines go.
    expect(q.key).toBe(parseQuestionBlock('question', 'Which drawer?\n- A\n- B')!.key);
  });

  test('a plain detail line is never glued onto the label; the old label stays a name an answer may quote', () => {
    const q = parseQuestionBlock('question', ['Which drawer?', '- A', '  Trade-off: slower', '  on a phone', '- B — the total first', '  Why: it never scrolls away'].join('\n'))!;
    expect(q.choices.map((c) => c.label)).toEqual(['A', 'B']);
    expect(q.choices[0]).toMatchObject({ details: ['Trade-off: slower on a phone'], description: 'Trade-off: slower on a phone' });
    expect(q.choices[0]!.aliases).toContain('A Trade-off: slower on a phone');
    expect(q.choices[1]).toMatchObject({ description: 'the total first Why: it never scrolls away', details: ['Why: it never scrolls away'] });
  });

  test('under a task-list choice: a nested bullet is a detail; with option lines, Pros and Cons are read from it', () => {
    const body = ['Which drawer?', '- [ ] A — today', '  - Pros:', '    - fast', '    - cheap', '  - Cons: slow', '  - Why: the team knows it', '- [ ] B'].join('\n');
    const plain = parseQuestionBlock('question', body)!;
    expect(plain.choices.map((c) => c.label)).toEqual(['A', 'B']);
    expect(plain.choices[0]).toMatchObject({ description: 'today Pros: fast; cheap Cons: slow Why: the team knows it', details: ['Pros: fast; cheap', 'Cons: slow', 'Why: the team knows it'] });
    const read = parseQuestionBlock('question', body, { optionLines: true })!;
    expect(read.choices[0]).toMatchObject({ pros: ['fast', 'cheap'], cons: ['slow'], description: 'today Why: the team knows it', details: ['Why: the team knows it'] });
  });

  test('plain-bullet choices get Pros and Cons too (the Inbox), and keep them on the record', () => {
    const [q] = parseInboxQuestionBlocks(':::question\nWhich?\n- Fixed delay\n  - Pros: simple\n  - Cons: thundering herd\n- Backoff\n:::');
    expect(q!.parsed.choices.map((c) => c.label)).toEqual(['Fixed delay', 'Backoff']);
    expect(q!.parsed.choices[0]).toMatchObject({ pros: ['simple'], cons: ['thundering herd'] });
  });

  test('bullets that are not the choices keep every line in the context, word for word', () => {
    const q = parseQuestionBlock('question', ['Which?', '- Note one', '  - Why: because', '- [ ] Yes', '- [ ] No'].join('\n'))!;
    expect(q.choices.map((c) => c.label)).toEqual(['Yes', 'No']);
    expect(q.context).toBe('- Note one\n  - Why: because');
  });

  test('a nested bullet that is not a detail is still a choice, as before', () => {
    const q = parseQuestionBlock('question', ['Which?', '- A', '  - A2', '- B'].join('\n'))!;
    expect(q.choices.map((c) => c.label)).toEqual(['A', 'A2', 'B']);
  });
});

describe('a pick-one Recommended: line names the choice it begins', () => {
  const choices = ['- [ ] Ship it', '- [ ] Wait'];
  const body = (line: string, list = choices) => ['Which?', ...list, '', `Recommended: ${line}`].join('\n');

  test('the label, then its reasons', () => {
    expect(recommendedOf(body('Ship it, because the tests pass'))).toEqual(['Ship it']);
    expect(recommendedOf(body('Wait (the freeze starts Monday)'))).toEqual(['Wait']);
    expect(recommendedOf(body('**Wait** because the freeze starts Monday'))).toEqual(['Wait']);
    expect(parseQuestionBlock('question', body('Ship it, because the tests pass'))!.suggestedText).toBeUndefined();
  });

  test('the longest label it begins wins; the same words without a pause name nothing', () => {
    const list = ['- [ ] Yes', '- [ ] Yes, but later', '- [ ] No'];
    expect(recommendedOf(body('Yes, but later, after the freeze', list))).toEqual(['Yes, but later']);
    expect(recommendedOf(body('Yes, now', list))).toEqual(['Yes']);
    const none = parseQuestionBlock('question', body('No strong preference', list))!;
    expect(none.choices.some((c) => c.recommended)).toBe(false);
    expect(none.suggestedText).toBe('No strong preference');
  });

  test('a numbered recommendation names the choice its words name', () => {
    expect(recommendedOf(['Which?', '1. [ ] Ship it', '2. [ ] Wait', '', 'Recommended: 2. Wait'].join('\n'))).toEqual(['Wait']);
  });

  test('pick any is unchanged: a line with a part that names nothing stays a suggested answer', () => {
    const q = parseQuestionBlock('question-multi', body('Ship it, because the tests pass'))!;
    expect(q.choices.some((c) => c.recommended)).toBe(false);
    expect(q.suggestedText).toBe('Ship it, because the tests pass');
  });
});
