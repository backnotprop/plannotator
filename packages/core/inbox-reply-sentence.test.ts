// The reply's first line counts skips apart from answers, by the same rule as
// the answers section's "x of y answered" line. A Send made only of skips used
// to open with "Answered 3 questions." above "0 of 3 questions answered.".
import { describe, expect, test } from 'bun:test';
import { composeInboxReplyBody } from './inbox-questions';
import type { InboxQuestionRecord } from './inbox-types';
import type { QuestionAnswer } from './question-block';

const question = (key: string, settled = false): InboxQuestionRecord =>
  ({
    key,
    position: Number(key.slice(1)),
    kind: 'single',
    prompt: `Question ${key}`,
    parsed: {
      line: 2,
      suggested_text: null,
      aliases: [null, null],
      choices: [
        { label: 'Yes', recommended: false, settled },
        { label: 'No', recommended: false, settled: false },
      ],
    },
  }) as unknown as InboxQuestionRecord;

const answer = (key: string, extra: Partial<QuestionAnswer>): QuestionAnswer => ({
  v: 1,
  key,
  kind: 'single',
  prompt: `Question ${key}`,
  selected: [],
  ...extra,
});

function body(questions: InboxQuestionRecord[], sent: QuestionAnswer[]) {
  const text = composeInboxReplyBody({ questions, sent, earlier: [], words: undefined });
  const first = text.split('\n')[0]!;
  const sectionAnswered = Number(/(\d+) of \d+ questions? answered/.exec(text)?.[1]);
  const sentenceAnswered = Number(/^Answered (\d+)/.exec(first)?.[1] ?? 0);
  return { first, sectionAnswered, sentenceAnswered };
}

describe('the reply sentence', () => {
  const qs = [question('q1'), question('q2'), question('q3')];
  test('skips only', () => {
    expect(body(qs, [answer('q1', { skipped: true }), answer('q2', { skipped: true }), answer('q3', { skipped: true })]).first).toBe('Skipped 3 questions.');
  });
  test('answers only', () => {
    expect(body(qs, [answer('q1', { selected: ['Yes'] }), answer('q2', { selected: ['No'] })]).first).toBe('Answered 2 questions.');
  });
  test('both', () => {
    expect(body(qs, [answer('q1', { selected: ['Yes'] }), answer('q2', { skipped: true }), answer('q3', { skipped: true })]).first).toBe('Answered 1 question, skipped 2.');
  });

  // Every combination: the first line's "Answered N" equals the section's "N of M answered".
  const cases: Array<[string, InboxQuestionRecord[], QuestionAnswer[]]> = [
    ['note only, open question', [question('q1')], [answer('q1', { note: 'later' })]],
    ['note only, settled question', [question('q1', true)], [answer('q1', { note: 'still yes' })]],
    ['skipped with a note', [question('q1')], [answer('q1', { skipped: true, note: 'no time' })]],
    ['skipped and selected', [question('q1')], [answer('q1', { skipped: true, selected: ['Yes'] })]],
    ['other text', [question('q1')], [answer('q1', { other: 'Neither' })]],
    ['settled question skipped', [question('q1', true)], [answer('q1', { skipped: true })]],
    ['mixed', qs, [answer('q1', { note: 'hm' }), answer('q2', { selected: ['Yes'] }), answer('q3', { skipped: true })]],
  ];
  for (const [name, questions, sent] of cases) {
    test(`agrees with the section: ${name}`, () => {
      const r = body(questions, sent);
      expect(r.sentenceAnswered).toBe(r.sectionAnswered);
      if (r.sectionAnswered === 0) expect(r.first.startsWith('Answered')).toBe(false);
    });
  }
});
