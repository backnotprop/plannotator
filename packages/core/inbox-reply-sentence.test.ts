// The reply's first line counts skips apart from answers, by the same rule as
// the answers section's "x of y answered" line. A Send made only of skips used
// to open with "Answered 3 questions." above "0 of 3 questions answered.".
import { describe, expect, test } from 'bun:test';
import { composeInboxReplyBody, INBOX_STILL_OPEN_LINE } from './inbox-questions';
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

describe('a reply that answers nothing (approval inbox-words-only-reply)', () => {
  const open = (key: string): InboxQuestionRecord =>
    ({ ...question(key), answer: null, revision: 0, sent_revision: 0, superseded_by: null }) as unknown as InboxQuestionRecord;
  test('the words, then the still-open line; no first line, no answers section', () => {
    const text = composeInboxReplyBody({ questions: [open('q0'), open('q1')], sent: [], earlier: [], words: ' Later. ' });
    expect(text).toBe("Later.\n\nNo questions answered yet; all 2 are still open. Don't re-ask them; the person will answer in the Inbox.");
    expect(INBOX_STILL_OPEN_LINE.test(text.split('\n\n')[1]!)).toBe(true);
  });
  test('a superseded question is not counted; with none left open there is no line', () => {
    const gone = { ...open('q1'), superseded_by: { message_id: 'msg_x', key: null } } as unknown as InboxQuestionRecord;
    expect(composeInboxReplyBody({ questions: [open('q0'), gone], sent: [], earlier: [], words: 'Later.' })).toBe(
      "Later.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.",
    );
    expect(composeInboxReplyBody({ questions: [gone], sent: [], earlier: [], words: 'Later.' })).toBe('Later.');
  });
});
