// The reply's first line counts skips apart from answers. A Send made only of
// skips used to open with "Answered 3 questions." above "0 of 3 questions
// answered.", which contradicted itself.
import { describe, expect, test } from 'bun:test';
import { composeInboxReplyBody } from './inbox-questions';
import type { QuestionAnswer } from './question-block';

const answer = (key: string, extra: Partial<QuestionAnswer>): QuestionAnswer => ({
  v: 1,
  key,
  kind: 'single',
  prompt: `Question ${key}`,
  selected: [],
  ...extra,
});
const first = (sent: QuestionAnswer[]) => composeInboxReplyBody({ questions: [], sent, earlier: [], words: undefined }).split('\n')[0];

describe('the reply sentence', () => {
  test('skips only', () => {
    expect(first([answer('a', { skipped: true }), answer('b', { skipped: true }), answer('c', { skipped: true })])).toBe('Skipped 3 questions.');
  });
  test('answers only', () => {
    expect(first([answer('a', { selected: ['Yes'] }), answer('b', { selected: ['No'] })])).toBe('Answered 2 questions.');
  });
  test('both', () => {
    expect(first([answer('a', { selected: ['Yes'] }), answer('b', { skipped: true }), answer('c', { skipped: true })])).toBe('Answered 1 question, skipped 2.');
  });
  test('one skip', () => {
    expect(first([answer('a', { skipped: true })])).toBe('Skipped 1 question.');
  });
});
