/**
 * What regresses if this fails: an answer edit appends a second annotation
 * instead of replacing the first (the export then reports two answers), an
 * emptied answer lingers as an empty annotation, or a malformed row throws in
 * the Viewer instead of being ignored.
 */
import { describe, expect, test } from 'bun:test';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';
import { collectQuestionAnswers, upsertQuestionAnswerAnnotation } from './questionAnswers';

const KEY = 'q-0000000a';
const answer = (over: Partial<QuestionAnswer>): QuestionAnswer => ({
  v: 1, key: KEY, kind: 'single', prompt: 'Where?', selected: [], ...over,
});
const other: Annotation = {
  id: 'c1', blockId: 'block-0', startOffset: 0, endOffset: 1, type: AnnotationType.COMMENT, text: 'x', originalText: 'y', createdA: 0,
};

describe('upsertQuestionAnswerAnnotation', () => {
  test('adds, replaces in place keeping createdA, and removes when empty', () => {
    const added = upsertQuestionAnswerAnnotation([other], 'block-1', answer({ selected: ['A'] }), KEY);
    expect(added.map((a) => a.id)).toEqual(['c1', `ann-question-${KEY}`]);
    const createdA = added[1].createdA;

    const replaced = upsertQuestionAnswerAnnotation(added, 'block-1', answer({ selected: ['B'] }), KEY);
    expect(replaced).toHaveLength(2);
    expect(replaced[1].questionAnswer?.selected).toEqual(['B']);
    expect(replaced[1].createdA).toBe(createdA);

    expect(upsertQuestionAnswerAnnotation(replaced, 'block-1', answer({}), KEY)).toEqual([other]);
    expect(upsertQuestionAnswerAnnotation(replaced, 'block-1', null, KEY)).toEqual([other]);
  });

  test('removing an answer that does not exist returns the same list', () => {
    const list = [other];
    expect(upsertQuestionAnswerAnnotation(list, 'block-1', null, KEY)).toBe(list);
  });
});

describe('collectQuestionAnswers', () => {
  test('keys valid answers and skips malformed ones', () => {
    const good = upsertQuestionAnswerAnnotation([], 'block-1', answer({ selected: ['A'] }), KEY)[0];
    const bad = { ...other, id: 'bad', questionAnswer: { v: 1, key: 'nope' } } as unknown as Annotation;
    const map = collectQuestionAnswers([bad, good]);
    expect([...map.keys()]).toEqual([KEY]);
  });
});
