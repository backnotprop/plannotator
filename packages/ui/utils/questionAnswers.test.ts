/**
 * What regresses if this fails: an answer edit appends a second annotation
 * instead of replacing the first (the export then reports two answers), an
 * emptied answer lingers as an empty annotation, or a malformed row throws in
 * the Viewer instead of being ignored.
 */
import { describe, expect, test } from 'bun:test';
import { indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';
import { parseMarkdownToBlocks } from './parser';
import {
  buildQuestionPanelRows,
  collectQuestionAnswers,
  nextOpenQuestionKey,
  questionAnswerToAnnotation,
  questionProgress,
  resolveQuestionAnswers,
  upsertQuestionAnswerAnnotation,
} from './questionAnswers';

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

// The Questions panel rows and the header chip read these. What regresses if
// they fail: the chip counts a settled or skipped question wrong, jumps to an
// answered one (or never wraps), or an answer whose prompt was edited drops
// out of the panel instead of listing as unanchored.
describe('buildQuestionPanelRows / questionProgress / nextOpenQuestionKey', () => {
  const DOC = `# Plan

:::question
First?

- [ ] A
- [ ] B
:::

:::question
Settled?

- [x] REST
- [ ] WS
:::

:::question-text
Third?
:::

:::question
Fourth?

- [ ] Yes
- [ ] No
:::
`;
  const blocks = parseMarkdownToBlocks(DOC);
  const index = indexQuestionBlocks(blocks);
  const answerFor = (n: number, over: Partial<QuestionAnswer>) => {
    const q = index[n];
    return questionAnswerToAnnotation(q.blockId, { v: 1, key: q.question.key, kind: q.question.kind, prompt: q.question.prompt, selected: [], ...over }, n);
  };

  test('one row per question in document order, statuses from the answers, orphans last', () => {
    const gone = questionAnswerToAnnotation('', { v: 1, key: 'q-deadbeef', kind: 'single', prompt: 'Gone?', selected: ['Yes'] }, 9);
    const rows = buildQuestionPanelRows(blocks, [
      answerFor(0, { selected: ['B'], note: 'why not' }),
      answerFor(2, { skipped: true }),
      gone,
    ]);
    expect(rows.map((r) => [r.number ?? null, r.status, r.answerText ?? null, r.hasNote, r.orphaned])).toEqual([
      [1, 'answered', 'B', true, false],
      [2, 'settled', 'REST (settled)', false, false],
      [3, 'skipped', 'Skipped', false, false],
      [4, 'open', null, false, false],
      [null, 'answered', 'Yes', false, true],
    ]);
    expect(rows[4].annotationId).toBe(gone.id);
    // Answered and settled count as done; the orphan does not count.
    expect(questionProgress(rows)).toEqual({ done: 2, total: 4 });
  });

  test('next open question skips answered, settled and skipped ones and wraps', () => {
    const rows = buildQuestionPanelRows(blocks, [answerFor(2, { text: 'done' })]);
    const [q1, , , q4] = index.map((q) => q.question.key);
    expect(nextOpenQuestionKey(rows)).toBe(q1);
    expect(nextOpenQuestionKey(rows, q1)).toBe(q4);
    expect(nextOpenQuestionKey(rows, q4)).toBe(q1);
    const all = buildQuestionPanelRows(blocks, [answerFor(0, { selected: ['A'] }), answerFor(2, { text: 'x' }), answerFor(3, { skipped: true })]);
    expect(nextOpenQuestionKey(all)).toBeNull();
  });

  test('a document without questions or answers has no rows', () => {
    expect(buildQuestionPanelRows(parseMarkdownToBlocks('# Plan\n\nText.\n'), [other])).toEqual([]);
  });
});

describe("resolveQuestionAnswers", () => {
  const stored = questionAnswerToAnnotation("block-1", answer({ selected: ["From annotation"] }));

  test("without host answers the cards read the annotation list", () => {
    expect(resolveQuestionAnswers([other, stored]).get(KEY)?.selected).toEqual(["From annotation"]);
  });

  test("host answers replace the annotation path, from a Map or a plain object", () => {
    const hostAnswer = answer({ selected: ["From host"] });
    for (const hostAnswers of [new Map([[KEY, hostAnswer]]), { [KEY]: hostAnswer }]) {
      const out = resolveQuestionAnswers([stored], hostAnswers);
      expect(out.get(KEY)?.selected).toEqual(["From host"]);
      expect(out.size).toBe(1);
    }
    // An empty host map is still the host speaking: no answers, not the annotation.
    expect(resolveQuestionAnswers([stored], {}).size).toBe(0);
  });

  test("a malformed host entry is dropped, not thrown on", () => {
    const out = resolveQuestionAnswers([], { [KEY]: { v: 2 } as unknown as QuestionAnswer, "q-0000000b": answer({ key: "q-0000000b", selected: ["B"] }) });
    expect([...out.keys()]).toEqual(["q-0000000b"]);
  });
});
