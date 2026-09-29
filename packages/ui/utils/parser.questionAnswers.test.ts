/**
 * Answers to `:::question` blocks in the three exporters.
 *
 * What regresses if this fails: answers get numbered as ordinary feedback
 * (the agent reads "Feedback on: <prompt>" instead of an answer), the count
 * line counts them, an answers-only session exports "No changes detected."
 * and the answers never reach the agent, or a document with unanswered
 * questions and no feedback stops exporting "No changes detected.".
 */
import { describe, expect, test } from 'bun:test';
import { indexQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import { AnnotationType, type Annotation } from '../types';
import { exportAnnotationEntry, exportAnnotations, exportLinkedDocAnnotations, parseMarkdownToBlocks } from './parser';
import { questionAnswerToAnnotation } from './questionAnswers';

const DOC = `# Offline sync

Queue writes locally and replay them on reconnect, with a 60s timer while active.

:::question
Where should losing conflict versions be kept?

- [ ] Local only, purged after 30 days
- [ ] Server-side per user

Recommended: Local only, purged after 30 days
:::

:::question-text
Describe the manual test.
:::
`;

const blocks = parseMarkdownToBlocks(DOC);
const [q1, q2] = indexQuestionBlocks(blocks);

const answer = (q: typeof q1, over: Partial<QuestionAnswer>): Annotation =>
  questionAnswerToAnnotation(q.blockId, {
    v: 1,
    key: q.question.key,
    kind: q.question.kind,
    prompt: q.question.prompt,
    selected: [],
    sourceLine: q.line,
    ...over,
  }, 1);

const comment: Annotation = {
  id: 'c1',
  blockId: blocks[1].id,
  startOffset: 0,
  endOffset: 10,
  type: AnnotationType.COMMENT,
  text: 'Why 60s?',
  originalText: 'a 60s timer while active',
  createdA: 2,
};

describe('exportAnnotations with question answers', () => {
  test('answers come first and are not counted as feedback', () => {
    const out = exportAnnotations(blocks, [comment, answer(q1, { selected: ['Local only, purged after 30 days'], note: 'keep the log' })]);
    expect(out).toBe(`# Plan Feedback

## Answers to your questions

1 of 2 questions answered.

### Q1. Where should losing conflict versions be kept? (line 6)
Answer: Local only, purged after 30 days (your recommendation)
Note: keep the log

### Unanswered
- Q2. Describe the manual test. (line 15)

I've reviewed this plan and have 1 piece of feedback:

## 1. (line 3) Feedback on: "a 60s timer while active"
> Why 60s?

---
`);
  });

  test('an answers-only export still carries the answers', () => {
    const out = exportAnnotations(blocks, [answer(q2, { text: 'Two phones' })]);
    expect(out).toContain('## Answers to your questions');
    expect(out).toContain('### Q2. Describe the manual test. (line 15)\nAnswer:\n> Two phones\n');
    expect(out).not.toContain("I've reviewed");
  });

  test('questions with no answers and no feedback are still "No changes detected."', () => {
    expect(exportAnnotations(blocks, [])).toBe('No changes detected.');
  });

  test('a malformed questionAnswer stays ordinary feedback rather than vanishing', () => {
    const broken = { ...answer(q1, { selected: ['x'] }), questionAnswer: { v: 9 } } as unknown as Annotation;
    const out = exportAnnotations(blocks, [broken]);
    expect(out).not.toContain('Answers to your questions');
    expect(out).toContain('have 1 piece of feedback');
  });
});

describe('exportLinkedDocAnnotations with question answers', () => {
  test('each document gets its own answers section, located against its own blocks', () => {
    const docs = new Map([
      ['notes/round.md', { annotations: [answer(q1, { skipped: true })], globalAttachments: [], markdown: DOC }],
    ]);
    const out = exportLinkedDocAnnotations(docs);
    expect(out).toContain('## notes/round.md\n\n### Answers to your questions\n\n0 of 2 questions answered.');
    expect(out).toContain('#### Q1. Where should losing conflict versions be kept? (line 6)\nSkipped\n');
    expect(out).not.toContain("I've reviewed this document");
  });
});

describe('exportAnnotationEntry with a question answer', () => {
  test('prints the question and the answer', () => {
    expect(exportAnnotationEntry(answer(q1, { selected: ['Server-side per user'] }))).toBe(
      'Answer to the question "Where should losing conflict versions be kept?"\nAnswer: Server-side per user\n',
    );
  });
});
