/**
 * Lines that describe a choice (`Why:`, `Trade-off:`, `Pros:`, `Cons:`),
 * written under it as a plain indented line or a nested bullet, belong to
 * that choice: never a choice of their own, never part of its label; a
 * bullet beside such a line is still a choice. And a pick-one
 * `Recommended:` line names a choice by its label or its number only: any
 * other text is one more answer, as agents are told.
 *
 * What regresses if this fails: a `- Trade-off: …` bullet under a choice
 * shows as one more answer, a plain `Why:` line is glued onto the label, a
 * choice after a `Why:` line disappears into it, or `Recommended: Yes, but
 * only on weekdays` quietly becomes a plain Yes.
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

  test('a bullet beside a detail is a choice, not part of the detail; one nested under the detail continues it', () => {
    const q = parseQuestionBlock('question', ['Which?', '- A', '  - Why: x', '  - A2', '- B'].join('\n'))!;
    expect(q.choices.map((c) => c.label)).toEqual(['A', 'A2', 'B']);
    expect(q.choices[0]).toMatchObject({ details: ['Why: x'] });
    const under = parseQuestionBlock('question', ['Which?', '- A', '  - Pros:', '    - fast', '  - A2', '- B'].join('\n'))!;
    expect(under.choices.map((c) => c.label)).toEqual(['A', 'A2', 'B']);
    expect(under.choices[0]).toMatchObject({ details: ['Pros: fast'] });
    // Under a task-list choice a bullet beside the detail stays the choice's own words, never the detail's.
    const task = parseQuestionBlock('question', ['Which?', '- [ ] A', '  - Why: x', '  - also cheap', '- [ ] B'].join('\n'))!;
    expect(task.choices.map((c) => c.label)).toEqual(['A', 'B']);
    expect(task.choices[0]!.details).toEqual(['Why: x']);
  });
});

describe('a pick-one Recommended: line names a choice by its label or its number only', () => {
  const choices = ['- [ ] Ship it', '- [ ] Wait'];
  const body = (line: string, list = choices) => ['Which?', ...list, '', `Recommended: ${line}`].join('\n');

  test('the label, exactly or in any case', () => {
    expect(recommendedOf(body('Wait'))).toEqual(['Wait']);
    expect(recommendedOf(body('ship IT'))).toEqual(['Ship it']);
  });

  test('a number names the choice at that place; its words, when given, must be that choice', () => {
    for (const line of ['2', '2.', '2)', '2. Wait']) expect(recommendedOf(body(line)), line).toEqual(['Wait']);
    for (const line of ['2. Ship it', '3', '0']) {
      const q = parseQuestionBlock('question', body(line))!;
      expect(q.choices.some((c) => c.recommended), line).toBe(false);
      expect(q.suggestedText).toBe(line);
    }
  });

  test('any other text is one more answer, tagged Recommended: its qualifier is never dropped', () => {
    const list = ['- [ ] Yes', '- [ ] No'];
    for (const line of ['Yes, but only on weekdays', 'No, unless the freeze slips', 'Yes, because the tests pass']) {
      const q = parseQuestionBlock('question', body(line, list))!;
      expect(q.choices.some((c) => c.recommended), line).toBe(false);
      expect(q.suggestedText).toBe(line);
    }
  });
});
